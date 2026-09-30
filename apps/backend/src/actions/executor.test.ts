/**
 * The executor, against a fake venue.
 *
 * The first test in this file is the one the whole layer exists for: a venue that
 * credits the collateral and then reports `st: 7 Failed, sr: 32
 * OrderDescIdTooLow` must produce `applied`, with exactly ONE send. That
 * combination — right answer, no resend — is what the live investigation got
 * wrong, at the cost of a trader's margin being committed twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedError } from '@perpguard/shared';
import { ActionsExecutor } from './executor.ts';
import { InFlightRegistry } from './inflight.ts';
import { InMemoryActionLog } from './log.pg.ts';
import type { ActionCommand, ActionOutcome } from './types.ts';
import {
  FakePositions,
  FakePrices,
  FakeVenue,
  RecordingLogger,
  confirmed,
  forwardingBlocked,
  position,
  rejected,
  timedOut,
} from './testSupport.ts';

const MARKET = 16;

interface Harness {
  readonly executor: ActionsExecutor;
  readonly venue: FakeVenue;
  readonly positions: FakePositions;
  readonly prices: FakePrices;
  readonly log: InMemoryActionLog;
  readonly inFlight: InFlightRegistry;
  readonly logger: RecordingLogger;
}

function harness(
  options: { readonly positions?: FakePositions; readonly settleTimeoutMs?: number } = {},
): Harness {
  const venue = new FakeVenue();
  const positions = options.positions ?? new FakePositions();
  const prices = new FakePrices();
  const log = new InMemoryActionLog();
  const logger = new RecordingLogger();
  const inFlight = new InFlightRegistry({ now: () => 1_000_000 });
  const executor = new ActionsExecutor({
    venue,
    positions,
    prices,
    log,
    inFlight,
    logger,
    // Short, so "it did not move" is established in milliseconds rather than
    // seconds. Nothing is abandoned when it expires: it is how long we watch.
    settleTimeoutMs: options.settleTimeoutMs ?? 25,
  });
  return { executor, venue, positions, prices, log, inFlight, logger };
}

const closeCmd = (overrides: Partial<ActionCommand> = {}): ActionCommand =>
  ({
    kind: 'close-position',
    idempotencyKey: 'close-1',
    userId: 'trader-1',
    marketId: MARKET,
    symbol: 'BTC',
    positionId: 4242,
    ...overrides,
  }) as ActionCommand;

const topUp = (overrides: Partial<ActionCommand> = {}): ActionCommand =>
  ({
    kind: 'add-margin',
    idempotencyKey: 'trader-1:16:custom:tok1',
    userId: 'trader-1',
    marketId: MARKET,
    symbol: 'BTC',
    positionId: 4242,
    amountCNS: 27_460n,
    ...overrides,
  }) as ActionCommand;

// ── the sr 32 case ──────────────────────────────────────────────────────────

test('a top-up that reports Failed while the collateral lands resolves to applied, with one send', async () => {
  const h = harness();
  // The live run: margin 0.0557 -> 0.08316 AUSD, 27460 micros, reported FAILED.
  h.venue.addMarginResult = rejected('st: 7 Failed, sr: 32 OrderDescIdTooLow');
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'applied');
  assert.equal(h.venue.sends.length, 1, 'THE requirement: exactly one send, never a resend');
  assert.ok(outcome.kind === 'applied');
  assert.equal(outcome.reconciliation.delta, 27_460n);
  assert.equal(outcome.reconciliation.before, 55_700n);
  assert.equal(outcome.reconciliation.after, 83_160n);
  // The venue's own answer is kept, and kept as what it is.
  assert.equal(outcome.reported.status, 'rejected');
  assert.match(outcome.reported.reason ?? '', /st: 7 Failed, sr: 32 OrderDescIdTooLow/);
  // And the report says out loud that the venue was wrong, so a reader who later
  // finds `st: 7` in the log knows it was seen rather than missed.
  assert.match(outcome.detail, /LANDED/);
  assert.match(outcome.detail, /reported it as rejected/);
  assert.match(outcome.detail, /normal report for a top-up that worked/);
  assert.match(outcome.detail, /nothing was re-sent/i);
});

test('the reported failure is never surfaced as the action having failed', async () => {
  // Telling someone their rescue failed when it worked is how they double it by
  // hand, which is the exact failure mode this layer was built after.
  //
  // Note what is NOT asserted: that the word "Failed" is absent. The detail QUOTES
  // `st: 7 Failed` on purpose — a reader who later finds that status in the log or
  // the explorer has to see that it was accounted for, not wonder whether the tool
  // missed it. What must never appear is the CLAIM that the top-up did not land.
  const h = harness();
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'applied');
  assert.doesNotMatch(outcome.detail, /did not land|was not applied|could not be resolved/i);
  // The quoted status is qualified in the same breath, never left to stand alone.
  const quoted = outcome.detail.indexOf('st: 7 Failed');
  assert.ok(quoted > 0, 'the raw status is quoted');
  assert.match(
    outcome.detail.slice(quoted),
    /normal report for a top-up that worked/,
    'and the sentence that quotes it goes on to say what it means',
  );
});

// ── timeouts ────────────────────────────────────────────────────────────────

test('a timeout resolves by reconciliation, not as a failure, and does not resend', async () => {
  const h = harness();
  // No `mt: 24` ever arrives — the venue throws — but the collateral was credited.
  h.venue.addMarginResult = timedOut(30_000);
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'applied');
  assert.equal(h.venue.sends.length, 1);
  assert.ok(outcome.kind === 'applied');
  assert.equal(outcome.reported.status, 'timeout');
  assert.match(outcome.detail, /never reported an outcome/);
  // And it was said plainly in the log, including that nothing was re-sent.
  assert.match(h.logger.warnings.join('\n'), /NOT re-sending/);
});

test('a timeout on an action that did NOT land is not-applied, still without a resend', async () => {
  const h = harness();
  h.venue.addMarginResult = timedOut(30_000);
  h.venue.applyOnSend = undefined; // nothing moves

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'not-applied');
  assert.equal(h.venue.sends.length, 1);
  assert.match(outcome.detail, /did not land/);
});

test('a timeout whose position vanished is unknown, and says what to do', async () => {
  const h = harness();
  h.venue.addMarginResult = timedOut(30_000);
  h.venue.applyOnSend = () => h.positions.remove(MARKET);

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'unknown');
  assert.ok(outcome.kind === 'unknown');
  assert.match(outcome.nextStep, /Do NOT send this action again/);
  assert.equal(h.venue.sends.length, 1);
});

// ── one in flight per position ──────────────────────────────────────────────

test('a second attempt on one position while another is pending is refused, not queued', async () => {
  const h = harness({ settleTimeoutMs: 60 });
  let release: (() => void) | undefined;
  // Hold the first send open so the second arrives while it is genuinely pending.
  h.venue.applyOnSend = () => {};
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.venue.addMargin.bind(h.venue);
  h.venue.addMargin = async (request) => {
    await slow;
    return original(request);
  };

  const first = h.executor.execute(topUp({ idempotencyKey: 'first' }));
  // Let the first get as far as the send before the second arrives.
  await Promise.resolve();
  await Promise.resolve();
  const second = await h.executor.execute(topUp({ idempotencyKey: 'second' }));

  assert.equal(second.kind, 'refused');
  assert.ok(second.kind === 'refused');
  assert.equal(second.code, 'already-in-flight');
  assert.match(second.detail, /already in flight \(first/);
  assert.match(second.detail, /Refusing rather than queueing/);

  release?.();
  await first;
  // The refusal never reached the venue, and never became a second send.
  assert.equal(h.venue.sends.length, 1);
  // Nor did it open a row: a refused action leaves no trace but a log line.
  assert.equal(h.log.rows.length, 1);
});

test('the lease is released even when the venue throws, so the position is not locked out', async () => {
  const h = harness();
  h.venue.addMarginResult = new Error('socket exploded');

  await h.executor.execute(topUp({ idempotencyKey: 'first' }));
  assert.equal(h.executor.inFlightOn(MARKET), undefined);

  // A second, genuine attempt is now possible: the position that most needs a
  // top-up must not be the one an abandoned lease locked out.
  h.venue.addMarginResult = rejected('st: 7 Failed, sr: 32 OrderDescIdTooLow');
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });
  const outcome = await h.executor.execute(topUp({ idempotencyKey: 'second' }));
  assert.equal(outcome.kind, 'applied');
});

test('actions on DIFFERENT positions do not block each other', async () => {
  const positions = new FakePositions([
    position({ marketId: 16, symbol: 'BTC' }),
    position({ marketId: 20, symbol: 'ETH', positionId: 77, marginCNS: 1_000_000n }),
  ]);
  const h = harness({ positions });
  h.venue.applyOnSend = (record) => {
    const marketId = record.symbol === 'BTC' ? 16 : 20;
    const current = positions.read(marketId)!;
    positions.patch(marketId, { marginCNS: current.marginCNS + 27_460n });
  };

  const [btc, eth] = await Promise.all([
    h.executor.execute(topUp({ idempotencyKey: 'a', marketId: 16, symbol: 'BTC' })),
    h.executor.execute(topUp({ idempotencyKey: 'b', marketId: 20, symbol: 'ETH' })),
  ]);

  assert.equal(btc.kind, 'applied');
  assert.equal(eth.kind, 'applied');
});

// ── the action_log ──────────────────────────────────────────────────────────

test('the row is opened BEFORE the send, and carries the before-figure', async () => {
  const h = harness();
  const openedWhenSent: number[] = [];
  h.venue.applyOnSend = () => {
    // Observed at send time: the row must already exist.
    openedWhenSent.push(h.log.rows.length);
    h.positions.patch(MARKET, { marginCNS: 83_160n });
  };

  await h.executor.execute(topUp());

  assert.deepEqual(openedWhenSent, [1], 'the row exists before the venue is called');
  const recorded = h.log.find('trader-1:16:custom:tok1');
  assert.equal(recorded?.row.before, 55_700n);
  assert.equal(recorded?.row.requested, 27_460n);
  assert.equal(recorded?.row.field, 'margin');
  assert.equal(recorded?.row.positionId, 4242);
  assert.equal(recorded?.row.network, 'testnet');
});

test('the settlement records what happened AND what the venue claimed, separately', async () => {
  const h = harness();
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });

  await h.executor.execute(topUp());

  const settlement = h.log.find('trader-1:16:custom:tok1')?.settlement;
  assert.equal(settlement?.outcome, 'applied');
  // The disagreement is preserved. A table with one status column would have to
  // pick one of these, and either choice loses the evidence.
  assert.equal(settlement?.reportedStatus, 'rejected');
  assert.match(settlement?.reportedReason ?? '', /sr: 32 OrderDescIdTooLow/);
  assert.equal(settlement?.after, 83_160n);
  assert.equal(settlement?.venueRef, '4365423542272');
});

test('a log failure does not change the reported outcome', async () => {
  // The action already happened. Losing the row is bad; inventing a different
  // answer because of it would be worse.
  const h = harness();
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });
  h.log.settle = async () => {
    throw new Error('postgres went away');
  };

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'applied');
  assert.match(h.logger.warnings.join('\n'), /could not record the settlement/);
  assert.match(h.logger.warnings.join('\n'), /row is left open/);
});

// ── refusals, before anything is sent ───────────────────────────────────────

test('a feed that is not connected refuses the action outright', async () => {
  const h = harness();
  h.prices.close('the price feed is disconnected; every price I hold is frozen');

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'refused');
  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'feed-down');
  assert.equal(h.venue.sends.length, 0);
  assert.equal(h.log.rows.length, 0, 'nothing was sent, so there is nothing to log');
});

test('an untrustworthy position set refuses, and says that rather than "no position"', async () => {
  // The wrong refusal here reads as "you have no position", which is the most
  // alarming thing this tool could say wrongly.
  const h = harness();
  h.positions.setStatus({
    state: 'stale',
    reason: 'the account socket closed.',
    lastUpdateMs: 900_000,
    ageMs: 100_000,
  });

  const outcome = await h.executor.execute(topUp());

  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'positions-untrusted');
  assert.match(outcome.detail, /the position set is stale/);
  assert.doesNotMatch(outcome.detail, /hold no position/);
});

test('a missing position id refuses: there is nothing to address the action to', async () => {
  const h = harness();
  const outcome = await h.executor.execute(topUp({ positionId: undefined }));
  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'no-position-id');
  assert.match(outcome.detail, /isolated margin/i);
  assert.equal(h.venue.sends.length, 0);
});

test('a position we do not hold refuses', async () => {
  const h = harness({ positions: new FakePositions([]) });
  const outcome = await h.executor.execute(topUp());
  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'no-position');
});

test('a non-positive top-up refuses before it can reach a frame builder', async () => {
  const h = harness();
  for (const amountCNS of [0n, -1n]) {
    const outcome = await h.executor.execute(topUp({ amountCNS } as Partial<ActionCommand>));
    assert.ok(outcome.kind === 'refused');
    assert.equal(outcome.code, 'invalid-command');
  }
  assert.equal(h.venue.sends.length, 0);
});

test('a market the acting venue will not take refuses, and names the network', async () => {
  const h = harness();
  h.venue.available = {
    actionable: false,
    network: 'testnet',
    code: 'market-closed',
    reason: 'the venue has BTC closed',
  };

  const outcome = await h.executor.execute(topUp());

  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'not-actionable');
  assert.match(outcome.detail, /not actionable on testnet: the venue has BTC closed/);
  assert.equal(h.venue.sends.length, 0);
});

test('an availability check that throws refuses rather than assuming permission', async () => {
  const h = harness();
  h.venue.availabilityError = new Error('venue lookup exploded');
  const outcome = await h.executor.execute(topUp());
  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'not-actionable');
  assert.equal(h.venue.sends.length, 0);
});

test('an account that does not allow forwarding refuses, and nothing is sent', async () => {
  const h = harness();
  h.venue.addMarginResult = forwardingBlocked();
  h.venue.applyOnSend = undefined;

  const outcome = await h.executor.execute(topUp());

  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'not-actionable');
  assert.match(outcome.detail, /fw` is false/);
  assert.match(outcome.detail, /Nothing was sent/);
});

test('an action the venue has not built refuses as not-implemented', async () => {
  const h = harness();
  h.venue.closeResult = new NotImplementedError('perpl', 'closePosition');

  const outcome = await h.executor.execute(closeCmd());

  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'not-implemented');
  assert.match(outcome.detail, /has not been measured/);
  // The row was opened before the attempt, so it is settled rather than left open.
  assert.equal(h.log.find('close-1')?.settlement?.outcome, 'refused');
});

// ── close and reduce ───────────────────────────────────────────────────────

test('a close that flattens the position is applied', async () => {
  const h = harness();
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { sizeLNS: 0n });

  const outcome = await h.executor.execute(closeCmd());

  assert.equal(outcome.kind, 'applied');
  assert.ok(outcome.kind === 'applied');
  assert.equal(outcome.reconciliation.field, 'size');
  assert.equal(outcome.reconciliation.after, 0n);
  assert.equal(h.venue.sends.length, 1);
});

test('a close names the POSITION’s side, not the order’s', async () => {
  // Closing a long sends CloseLong, which is itself a sell. Handing the venue the
  // order's direction reverses the trade and DOUBLES the position.
  const positions = new FakePositions([position({ side: 'short', sizeLNS: 5n })]);
  const h = harness({ positions });
  h.venue.applyOnSend = () => positions.patch(MARKET, { sizeLNS: 0n });

  await h.executor.execute(closeCmd());

  const sent = h.venue.sends[0]!;
  assert.equal(sent.positionSide, 'short');
  assert.equal(sent.sizeLNS, 5n, 'the whole position, as the position reports it');
  assert.equal(sent.positionId, 4242);
});

test('a close whose position merely vanished is unknown unless the venue confirmed it', async () => {
  // A liquidation looks exactly like a close from the outside. A kill switch
  // reporting "closed" for a position the venue liquidated would be the tool
  // taking credit for the disaster it existed to prevent.
  const h = harness();
  h.venue.closeResult = rejected('st: 7 Failed');
  h.venue.applyOnSend = () => h.positions.remove(MARKET);

  const outcome = await h.executor.execute(closeCmd());

  assert.equal(outcome.kind, 'unknown');
  assert.ok(outcome.kind === 'unknown');
  assert.match(outcome.nextStep, /Do NOT send this action again/);
});

test('a confirmed close whose position vanished IS applied: two pieces of evidence agreeing', async () => {
  const h = harness();
  h.venue.closeResult = confirmed();
  h.venue.applyOnSend = () => h.positions.remove(MARKET);

  const outcome = await h.executor.execute(closeCmd());

  assert.equal(outcome.kind, 'applied');
  assert.ok(outcome.kind === 'applied');
  assert.match(outcome.reconciliation.detail, /venue confirmed the close/);
});

test('a partial reduce that took the asked-for size off is applied', async () => {
  // Measured live: s:1 against a 3-unit long left it at 2 units, same pid,
  // mt: 27 st: 1 Open sr: 14 PositionDecreased.
  const positions = new FakePositions([position({ sizeLNS: 3n })]);
  const h = harness({ positions });
  h.venue.applyOnSend = () => positions.patch(MARKET, { sizeLNS: 2n });

  const outcome = await h.executor.execute({
    kind: 'reduce-position',
    idempotencyKey: 'reduce-1',
    userId: 'trader-1',
    marketId: MARKET,
    symbol: 'BTC',
    positionId: 4242,
    sizeLNS: 1n,
  });

  assert.equal(outcome.kind, 'applied');
  assert.ok(outcome.kind === 'applied');
  assert.equal(outcome.reconciliation.before, 3n);
  assert.equal(outcome.reconciliation.after, 2n);
  assert.equal(h.venue.sends[0]!.sizeLNS, 1n);
});

test('a reduce that took off less than asked is unknown, not applied', async () => {
  // An ImmediateOrCancel exit takes what the book offers and cancels the rest.
  const positions = new FakePositions([position({ sizeLNS: 10n })]);
  const h = harness({ positions });
  h.venue.applyOnSend = () => positions.patch(MARKET, { sizeLNS: 8n });

  const outcome = await h.executor.execute({
    kind: 'reduce-position',
    idempotencyKey: 'reduce-2',
    userId: 'trader-1',
    marketId: MARKET,
    symbol: 'BTC',
    positionId: 4242,
    sizeLNS: 5n,
  });

  assert.equal(outcome.kind, 'unknown');
  assert.match(outcome.detail, /2 lots closed of 5 requested/);
});

test('a non-positive reduce refuses before it can reach a frame builder', async () => {
  const h = harness();
  const outcome = await h.executor.execute({
    kind: 'reduce-position',
    idempotencyKey: 'reduce-3',
    userId: 'trader-1',
    marketId: MARKET,
    symbol: 'BTC',
    positionId: 4242,
    sizeLNS: 0n,
  });
  assert.ok(outcome.kind === 'refused');
  assert.equal(outcome.code, 'invalid-command');
  assert.equal(h.venue.sends.length, 0);
});

// ── the before-figure is re-read ────────────────────────────────────────────

test('the before-figure is re-read after the availability await, not reused', async () => {
  // The availability check awaits, so a fill can land in between. Judging against
  // a figure captured before that await would report the wrong delta.
  const h = harness();
  const venueGetAvailability = h.venue.getActionAvailability.bind(h.venue);
  h.venue.getActionAvailability = async (symbol) => {
    const answer = await venueGetAvailability(symbol);
    // Funding settles while we are asking.
    h.positions.patch(MARKET, { marginCNS: 60_000n });
    return answer;
  };
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 87_460n });

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'applied');
  assert.ok(outcome.kind === 'applied');
  assert.equal(outcome.reconciliation.before, 60_000n, 'the fresher figure');
  assert.equal(outcome.reconciliation.delta, 27_460n);
});

// ── going blind mid-action ──────────────────────────────────────────────────

test('a set that stops being trustworthy mid-action is unknown, never a verdict', async () => {
  // Reconciling against a frozen "after" would report not-applied for a top-up
  // that landed — the worst output this layer could produce.
  const h = harness();
  h.venue.applyOnSend = () => {
    h.positions.setStatus({
      state: 'stale',
      reason: 'a heartbeat gap means an update may have been missed.',
      lastUpdateMs: 900_000,
      ageMs: 1_000,
    });
  };

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'unknown');
  assert.ok(outcome.kind === 'unknown');
  assert.equal(outcome.reconciliation, undefined, 'we could not even look');
  assert.match(outcome.detail, /heartbeat gap/);
  assert.match(outcome.nextStep, /Do NOT send this action again/);
  assert.equal(h.venue.sends.length, 1);
});

// ── an unclassified throw still gets reconciled ─────────────────────────────

test('a thrown venue call is still reconciled against the position', async () => {
  // An error AFTER the collateral was credited must not stop us looking at the
  // margin, because the margin is the only thing that knows.
  const h = harness();
  h.venue.addMarginResult = new Error('socket closed while waiting');
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'applied');
  assert.ok(outcome.kind === 'applied');
  assert.equal(outcome.reported.status, 'threw');
  assert.match(outcome.detail, /venue call itself failed/);
  assert.equal(h.venue.sends.length, 1);
});

test('a thrown venue call on an unmoved position is not-applied', async () => {
  const h = harness();
  h.venue.addMarginResult = new Error('socket closed while waiting');

  const outcome = await h.executor.execute(topUp());

  assert.equal(outcome.kind, 'not-applied');
  assert.equal(h.venue.sends.length, 1);
});

// ── what reaches the venue ──────────────────────────────────────────────────

test('the amount reaches the venue as the exact bigint, and the position id with it', async () => {
  const h = harness();
  h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 1_000_555_700n });

  await h.executor.execute(topUp({ amountCNS: 1_000_500_000n } as Partial<ActionCommand>));

  const sent = h.venue.sends[0]!;
  assert.equal(sent.amountCNS, 1_000_500_000n);
  assert.equal(typeof sent.amountCNS, 'bigint');
  assert.equal(sent.positionId, 4242);
  assert.equal(sent.idempotencyKey, 'trader-1:16:custom:tok1');
});

// ── no retry exists ────────────────────────────────────────────────────────

test('no outcome, on any path, produces more than one send', async () => {
  // The structural assertion. Every way an action can go, once.
  const paths: ReadonlyArray<readonly [string, (h: Harness) => void]> = [
    ['reported failure, applied', (h) => {
      h.venue.addMarginResult = rejected('st: 7 Failed, sr: 32 OrderDescIdTooLow');
      h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });
    }],
    ['reported failure, not applied', (h) => {
      h.venue.addMarginResult = rejected('st: 7 Failed, sr: 32 OrderDescIdTooLow');
    }],
    ['confirmed', (h) => {
      h.venue.addMarginResult = confirmed();
      h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 83_160n });
    }],
    ['timeout', (h) => {
      h.venue.addMarginResult = timedOut();
    }],
    ['threw', (h) => {
      h.venue.addMarginResult = new Error('boom');
    }],
    ['partial delta', (h) => {
      h.venue.applyOnSend = () => h.positions.patch(MARKET, { marginCNS: 70_000n });
    }],
    ['position vanished', (h) => {
      h.venue.applyOnSend = () => h.positions.remove(MARKET);
    }],
    ['went blind', (h) => {
      h.venue.applyOnSend = () =>
        h.positions.setStatus({ state: 'stale', lastUpdateMs: 1, ageMs: 1 });
    }],
  ];

  for (const [name, setup] of paths) {
    const h = harness();
    setup(h);
    const outcome: ActionOutcome = await h.executor.execute(topUp());
    assert.equal(h.venue.sends.length, 1, `${name}: exactly one send`);
    assert.ok(
      ['applied', 'not-applied', 'unknown'].includes(outcome.kind),
      `${name}: a sent action must report one of the three, got ${outcome.kind}`,
    );
  }
});
