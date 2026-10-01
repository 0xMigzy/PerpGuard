/**
 * What the trader is actually told.
 *
 * The first test here is the other half of the `sr 32` story. The actions layer
 * gets the verdict right; this is where getting the WORDS wrong would undo it. A
 * user told "your top-up failed" for a top-up that landed will add it again by
 * hand, and the venue will happily take the second one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionAvailability } from '@perpguard/shared';
import type { ActionCommand, ActionOutcome } from '@perpguard/backend/actions';
import { VenueActionExecutor } from './executor.ts';
import { dangerMessage, USER_ID } from './testSupport.ts';

const OPEN: ActionAvailability = { actionable: true, network: 'testnet', marketId: 16 };

/** A runner that answers with one programmed outcome and records the command. */
class FakeRunner {
  readonly seen: ActionCommand[] = [];
  outcome: (command: ActionCommand) => ActionOutcome = (command) => applied(command);

  async execute(command: ActionCommand): Promise<ActionOutcome> {
    this.seen.push(command);
    return this.outcome(command);
  }
}

/** The measured live run: 0.0557 -> 0.08316 AUSD, reported as rejected. */
function applied(command: ActionCommand): ActionOutcome {
  return {
    kind: 'applied',
    command,
    at: 1_000_000,
    reported: {
      status: 'rejected',
      reason: 'st: 7 Failed, sr: 32 OrderDescIdTooLow',
      venueRef: '4365423542272',
    },
    reconciliation: {
      verdict: 'applied',
      field: 'margin',
      requested: 27_460n,
      before: 55_700n,
      after: 83_160n,
      delta: 27_460n,
      detail: 'margin is now 83160 (was 55700): 27460 micros applied, 27460 requested — LANDED',
    },
    detail: 'add-margin on BTC LANDED. The venue reported it as rejected …',
  };
}

function harness(): { readonly executor: VenueActionExecutor; readonly runner: FakeRunner } {
  const runner = new FakeRunner();
  return {
    runner,
    executor: new VenueActionExecutor({ runner, availability: async () => OPEN }),
  };
}

const request = () => ({
  idempotencyKey: 'trader-1:1:custom:tok1',
  userId: USER_ID,
  action: dangerMessage().actions[0]!,
});

test('a top-up the venue called failed is reported to the user as done', async () => {
  const h = harness();
  const outcome = await h.executor.execute(request());

  assert.equal(outcome.kind, 'applied');
  assert.match(outcome.detail, /^Done — the margin is in\./);
  assert.match(outcome.detail, /went from 55700 to 83160 AUSD micros/);
  assert.match(outcome.detail, /exactly the 27460 that was sent/);
});

test('the user is never shown the venue’s reported failure for a top-up that landed', async () => {
  // It belongs in the action_log row and the server log, where somebody debugging
  // needs it. A trader reading "your margin is in, although the venue said it
  // failed" learns only that the tool is unsure — and it is not unsure, it looked.
  const h = harness();
  const outcome = await h.executor.execute(request());

  assert.doesNotMatch(outcome.detail, /sr: 32/);
  assert.doesNotMatch(outcome.detail, /failed/i);
  assert.doesNotMatch(outcome.detail, /rejected/i);
});

test('the exact amount and position id pass through untouched', async () => {
  // The button sends what the message showed. Re-deriving the amount here would
  // break that promise silently.
  const h = harness();
  await h.executor.execute(request());

  const command = h.runner.seen[0]!;
  assert.equal(command.kind, 'add-margin');
  assert.ok(command.kind === 'add-margin');
  assert.equal(command.amountCNS, 562_000_000n);
  assert.equal(typeof command.amountCNS, 'bigint');
  assert.equal(command.positionId, 4_242);
  assert.equal(command.marketId, 1);
  assert.equal(command.idempotencyKey, 'trader-1:1:custom:tok1');
  assert.equal(command.userId, USER_ID);
});

test('a top-up that did not land says so, and says no collateral moved', async () => {
  const h = harness();
  h.runner.outcome = (command) => ({
    kind: 'not-applied',
    command,
    at: 1,
    reported: { status: 'rejected', reason: 'st: 7 Failed', venueRef: undefined },
    reconciliation: {
      verdict: 'not-applied',
      field: 'margin',
      requested: 27_460n,
      before: 55_700n,
      after: 55_700n,
      delta: 0n,
      detail: 'margin is unchanged at 55700',
    },
    detail: 'add-margin on BTC did not land',
  });

  const outcome = await h.executor.execute(request());

  assert.equal(outcome.kind, 'not-applied');
  assert.match(outcome.detail, /Nothing was added/);
  assert.match(outcome.detail, /no collateral left your balance/);
});

test('an unknown outcome carries the next step verbatim, and never suggests retrying', async () => {
  const h = harness();
  h.runner.outcome = (command) => ({
    kind: 'unknown',
    command,
    at: 1,
    reported: { status: 'timeout', reason: 'no outcome within 30000ms', venueRef: undefined },
    reconciliation: undefined,
    detail: 'the position left the set, so its margin cannot be compared.',
    nextStep: 'Read the position directly. Do NOT send this action again until you have.',
  });

  const outcome = await h.executor.execute(request());

  assert.equal(outcome.kind, 'unknown');
  assert.ok(outcome.kind === 'unknown');
  assert.equal(outcome.nextStep, 'Read the position directly. Do NOT send this action again until you have.');
  assert.match(outcome.detail, /I cannot tell you yet what it did/);
  // It must read as neither success nor failure.
  assert.doesNotMatch(outcome.detail, /^Done/);
  assert.doesNotMatch(outcome.detail, /Nothing was added/);
});

test('every refusal says nothing was sent, whichever code it carries', async () => {
  // The one thing a user must never be left guessing about. "Refused" with no
  // statement about whether money moved is the worst of both answers.
  const codes = [
    'already-in-flight',
    'feed-down',
    'positions-untrusted',
    'no-position',
    'no-position-id',
    'not-actionable',
    'not-implemented',
    'invalid-command',
  ] as const;

  for (const code of codes) {
    const h = harness();
    h.runner.outcome = (command) => ({
      kind: 'refused',
      command,
      at: 1,
      code,
      detail: `the layer's own account of ${code}`,
    });

    const outcome = await h.executor.execute(request());
    assert.equal(outcome.kind, 'refused', code);
    assert.match(outcome.detail, /not sent|nothing was sent|refusing/i, code);
  }
});

test('a refusal the layer explained is passed through rather than paraphrased', async () => {
  // These three carry a reason the actions layer or the venue wrote — a closed
  // market, an unmeasured frame, a bad amount — and it is more specific than
  // anything this adapter could say. Losing it would leave the user with a
  // refusal and no cause.
  for (const code of ['not-actionable', 'not-implemented', 'invalid-command'] as const) {
    const h = harness();
    h.runner.outcome = (command) => ({
      kind: 'refused',
      command,
      at: 1,
      code,
      detail: `BTC is not listed on testnet (${code})`,
    });

    const outcome = await h.executor.execute(request());
    assert.match(outcome.detail, /BTC is not listed on testnet/, code);
  }
});

test('a refusal only the bot can explain gets the bot’s own words', async () => {
  // These have no venue-supplied reason, so a pass-through would say nothing.
  // Each one has to tell the user what would make the action possible.
  const expectations: ReadonlyArray<readonly [string, RegExp]> = [
    ['already-in-flight', /Wait a moment, then open My positions/],
    ['feed-down', /My positions shows when it is back/],
    ['positions-untrusted', /My positions has the detail/],
    ['no-position', /nothing to add margin to/],
    ['no-position-id', /Open My positions — a fresh snapshot usually carries it/],
  ];

  for (const [code, pattern] of expectations) {
    const h = harness();
    h.runner.outcome = (command) => ({
      kind: 'refused',
      command,
      at: 1,
      code: code as 'feed-down',
      detail: 'terse internal reason',
    });

    const outcome = await h.executor.execute(request());
    assert.match(outcome.detail, pattern, code);
  }
});

test('an in-flight refusal explains why it is not queued', async () => {
  // The user has to understand that waiting is the correct move, or they will tap
  // again — which for this action is the dangerous one.
  const h = harness();
  h.runner.outcome = (command) => ({
    kind: 'refused',
    command,
    at: 1,
    code: 'already-in-flight',
    detail: 'an action on market 1 is already in flight',
  });

  const outcome = await h.executor.execute(request());
  assert.match(outcome.detail, /refusing rather than queueing/i);
  assert.match(outcome.detail, /how the same amount lands twice/);
});

test('an action type this adapter cannot express is not-implemented, not a command', async () => {
  const h = harness();
  const outcome = await h.executor.execute({
    ...request(),
    action: { ...dangerMessage().actions[0]!, type: 'close' as never },
  });

  assert.equal(outcome.kind, 'not-implemented');
  assert.equal(h.runner.seen.length, 0, 'nothing was invented for it');
});

test('availability is asked of the acting venue, unchanged', async () => {
  const asked: string[] = [];
  const executor = new VenueActionExecutor({
    runner: new FakeRunner(),
    availability: async (symbol) => {
      asked.push(symbol);
      return OPEN;
    },
  });

  assert.deepEqual(await executor.availability('BTC'), OPEN);
  assert.deepEqual(asked, ['BTC']);
});
