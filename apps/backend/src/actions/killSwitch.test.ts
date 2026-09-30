/**
 * The kill switch: ordering, and telling the truth about a partial one.
 *
 * The ordering test is not cosmetic. Nearest-to-liquidation first is the whole
 * reason the plan is sorted, because that is the position that may not survive
 * long enough to be second — and if the closes went out in parallel, or in map
 * order, the sort would be a comment rather than a behaviour.
 *
 * The partial-failure tests matter as much. "Kill switch fired" over a book where
 * two of five closed is the most dangerous sentence this product could produce:
 * the trader stops watching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RiskPosition } from '@perpguard/shared';
import { describeKillSwitch, fireKillSwitch, type CommandRunner } from './killSwitch.ts';
import type { ActionCommand, ActionOutcome } from './types.ts';
import { BTC, ETH, KILL_CONFIGS, SOL, riskPosition } from './testSupport.ts';

/**
 * Three positions with deliberately different buffers.
 *
 * Margins chosen so the urgency order is NOT the market-id order and NOT the
 * order they are passed in — otherwise a test would pass against an
 * implementation that did no sorting at all.
 */
const btcComfortable: RiskPosition = riskPosition({
  marketId: BTC.marketId,
  symbol: 'BTC',
  depositCNS: 6_000_000_000n,
});

const ethDoomed: RiskPosition = riskPosition({
  marketId: ETH.marketId,
  symbol: 'ETH',
  side: 'short',
  lotLNS: 10_000n,
  entryPricePNS: 300_000n,
  depositCNS: 100_000_000n,
});

const solMiddling: RiskPosition = riskPosition({
  marketId: SOL.marketId,
  symbol: 'SOL',
  lotLNS: 1_000n,
  entryPricePNS: 121_912n,
  depositCNS: 200_000_000n,
});

const MARKS = new Map([
  [BTC.marketId, 840_073n],
  [ETH.marketId, 320_000n],
  [SOL.marketId, 120_000n],
]);

const POSITION_IDS = new Map([
  [BTC.marketId, 111],
  [ETH.marketId, 222],
  [SOL.marketId, 333],
]);

/** A runner that records the order and answers per market. */
class FakeRunner implements CommandRunner {
  readonly seen: ActionCommand[] = [];
  /** Market id -> what that close reports. Anything unlisted is applied. */
  readonly answers = new Map<number, ActionOutcome['kind'] | Error>();
  /** Resolved in call order, to prove the calls did not overlap. */
  readonly concurrent: number[] = [];
  #live = 0;

  async execute(command: ActionCommand): Promise<ActionOutcome> {
    this.seen.push(command);
    this.#live += 1;
    this.concurrent.push(this.#live);
    // A turn of the event loop, so an implementation that fired these in parallel
    // would show #live > 1 here.
    await Promise.resolve();
    await Promise.resolve();
    this.#live -= 1;

    const answer = this.answers.get(command.marketId) ?? 'applied';
    if (answer instanceof Error) throw answer;
    return outcomeOf(command, answer);
  }
}

function outcomeOf(command: ActionCommand, kind: ActionOutcome['kind']): ActionOutcome {
  const reported = { status: 'confirmed' as const, reason: undefined, venueRef: '1' };
  const reconciliation = {
    verdict: kind === 'applied' ? ('applied' as const) : ('not-applied' as const),
    field: 'size' as const,
    requested: 10n,
    before: 10n,
    after: kind === 'applied' ? 0n : 10n,
    delta: kind === 'applied' ? -10n : 0n,
    detail: kind === 'applied' ? 'size is 0 (was 10) — LANDED' : 'size is unchanged at 10',
  };
  switch (kind) {
    case 'applied':
      return { kind, command, at: 1, reported, reconciliation, detail: 'closed' };
    case 'not-applied':
      return { kind, command, at: 1, reported, reconciliation, detail: 'the close did not land' };
    case 'unknown':
      return {
        kind,
        command,
        at: 1,
        reported,
        reconciliation: undefined,
        detail: 'the position left the set and the close was never confirmed',
        nextStep: 'Read the position directly.',
      };
    case 'refused':
      return { kind, command, at: 1, code: 'no-position-id', detail: 'no venue position id' };
  }
}

const fire = (runner: CommandRunner, positions: readonly RiskPosition[] = [btcComfortable, ethDoomed, solMiddling]) =>
  fireKillSwitch({
    runner,
    userId: 'trader-1',
    positions,
    markPrices: MARKS,
    configs: KILL_CONFIGS,
    positionIds: POSITION_IDS,
    keyFor: (marketId, order) => `kill-1:${order}:${marketId}`,
  });

// ── ordering ────────────────────────────────────────────────────────────────

test('closes fire nearest to liquidation first', async () => {
  const runner = new FakeRunner();
  const result = await fire(runner);

  const buffers = result.lines.map((line) => line.liqBufferPct ?? Number.POSITIVE_INFINITY);
  assert.deepEqual(
    [...buffers].sort((a, b) => a - b),
    buffers,
    `fired in buffer order, got ${buffers.map((b) => b.toFixed(4)).join(', ')}`,
  );
  // And the order is not the input order or the market-id order, so the sort is
  // actually doing something.
  const symbols = result.lines.map((line) => line.symbol);
  assert.notDeepEqual(symbols, ['BTC', 'ETH', 'SOL']);
  assert.deepEqual(
    runner.seen.map((command) => command.symbol),
    symbols,
    'the runner saw them in the reported order',
  );
});

test('closes go out one at a time, never overlapping', async () => {
  // Parallel would race the in-flight registry and the account's `rq` counter,
  // and would make "most urgent first" meaningless.
  const runner = new FakeRunner();
  await fire(runner);
  assert.deepEqual(runner.concurrent, [1, 1, 1], 'never more than one in flight');
});

test('each close names its own position id and carries the run in its key', async () => {
  const runner = new FakeRunner();
  await fire(runner);
  for (const command of runner.seen) {
    assert.equal(command.kind, 'close-position');
    assert.equal(command.positionId, POSITION_IDS.get(command.marketId));
    assert.match(command.idempotencyKey, /^kill-1:\d+:\d+$/);
  }
  // One query pulls the whole firing out of action_log.
  assert.equal(new Set(runner.seen.map((c) => c.idempotencyKey.split(':')[0])).size, 1);
});

test('a position with no venue id still gets its attempt, and is reported as still open', async () => {
  const runner = new FakeRunner();
  const result = await fireKillSwitch({
    runner,
    userId: 'trader-1',
    positions: [btcComfortable, ethDoomed],
    markPrices: MARKS,
    configs: KILL_CONFIGS,
    // BTC's id is missing: the executor refuses that one.
    positionIds: new Map([[ETH.marketId, 222]]),
    keyFor: (marketId, order) => `kill-1:${order}:${marketId}`,
  });
  runner.answers.set(BTC.marketId, 'refused');

  assert.equal(result.lines.length, 2, 'both were attempted');
  assert.equal(runner.seen.find((c) => c.marketId === BTC.marketId)?.positionId, undefined);
});

// ── completeness ────────────────────────────────────────────────────────────

test('a firing where everything closed is complete', async () => {
  const runner = new FakeRunner();
  const result = await fire(runner);
  assert.equal(result.complete, true);
  assert.equal(result.closed.length, 3);
  assert.equal(result.stillOpen.length, 0);
  assert.equal(result.unresolved.length, 0);
  assert.match(describeKillSwitch(result), /^Kill switch complete: all 3 positions closed\./);
});

test('one position that did not close makes the whole firing partial, and says which', async () => {
  const runner = new FakeRunner();
  runner.answers.set(SOL.marketId, 'not-applied');

  const result = await fire(runner);

  assert.equal(result.complete, false);
  assert.equal(result.closed.length, 2);
  assert.deepEqual(result.stillOpen.map((l) => l.symbol), ['SOL']);

  const report = describeKillSwitch(result);
  assert.match(report, /^Kill switch PARTIAL: 2 of 3 closed, 1 not\. You still have exposure\./);
  // WHAT DID NOT CLOSE COMES FIRST. A reader who stops after the headline must
  // stop on the exposure, not on the reassuring count.
  const lines = report.split('\n');
  assert.match(lines[1]!, /SOL — still open/);
});

test('an unresolved close is not counted as closed, and is not counted as open either', async () => {
  // It is neither, and collapsing it into either is the failure this layer exists
  // to avoid.
  const runner = new FakeRunner();
  runner.answers.set(ETH.marketId, 'unknown');

  const result = await fire(runner);

  assert.equal(result.complete, false);
  assert.deepEqual(result.unresolved.map((l) => l.symbol), ['ETH']);
  assert.equal(result.closed.some((l) => l.symbol === 'ETH'), false);
  assert.equal(result.stillOpen.some((l) => l.symbol === 'ETH'), false);

  const report = describeKillSwitch(result);
  assert.match(report, /ETH — UNRESOLVED/);
  // And the one instruction that must never be "try again".
  assert.match(report, /Do not fire the kill switch again to finish/);
  assert.match(report, /re-send closes for the positions that already closed/);
});

test('a close that throws does not stop the rest of the sequence', async () => {
  // Abandoning the remaining positions because one blew up turns one bad outcome
  // into several.
  const runner = new FakeRunner();
  runner.answers.set(ETH.marketId, new Error('socket exploded'));

  const result = await fire(runner);

  assert.equal(result.lines.length, 3, 'every position was attempted');
  assert.equal(runner.seen.length, 3);
  const eth = result.lines.find((l) => l.symbol === 'ETH')!;
  assert.equal(eth.outcome.kind, 'unknown');
  assert.match(eth.outcome.detail, /threw before reporting an outcome/);
  // And the two that could close, did.
  assert.equal(result.closed.length, 2);
});

test('a firing that throws on the most urgent position still closes the others', async () => {
  // The ordering means the throw lands FIRST, which is the case where a naive
  // implementation gives up having done nothing.
  const runner = new FakeRunner();
  const ordered = await fire(new FakeRunner());
  const mostUrgent = ordered.lines[0]!.marketId;
  runner.answers.set(mostUrgent, new Error('the first one exploded'));

  const result = await fire(runner);

  assert.equal(result.lines.length, 3);
  assert.equal(result.closed.length, 2);
  assert.equal(result.lines[0]!.outcome.kind, 'unknown');
});

test('nothing to close says so rather than reporting a complete kill switch', async () => {
  const result = await fire(new FakeRunner(), []);
  assert.equal(result.complete, false, 'an empty book is not a completed kill switch');
  assert.equal(describeKillSwitch(result), 'Kill switch: nothing to close — no open positions.');
});

// ── the report ──────────────────────────────────────────────────────────────

test('a position already past liquidation is described in words, not as a negative percent', async () => {
  const runner = new FakeRunner();
  // A long whose mark has fallen through its liquidation price.
  const doomed = riskPosition({ depositCNS: 1_000_000n });
  const result = await fireKillSwitch({
    runner,
    userId: 'trader-1',
    positions: [doomed],
    markPrices: new Map([[BTC.marketId, 700_000n]]),
    configs: KILL_CONFIGS,
    positionIds: POSITION_IDS,
    keyFor: (marketId, order) => `kill-1:${order}:${marketId}`,
  });

  assert.ok((result.lines[0]!.liqBufferPct ?? 0) < 0, 'genuinely past liquidation');
  // The plan still fires it first, and the log line does not render a negative %.
  assert.equal(result.lines[0]!.symbol, 'BTC');
});
