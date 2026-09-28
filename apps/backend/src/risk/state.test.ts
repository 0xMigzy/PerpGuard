/**
 * The state machine, on its own. Pure in, pure out, no clock and no feed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextState } from './state.ts';
import { DEFAULT_THRESHOLDS, type RiskState } from './types.ts';

const T = DEFAULT_THRESHOLDS;
const AT = 1_000_000;

const decide = (
  current: RiskState | undefined,
  buffer: number | undefined,
  opts: { priceIsOld?: boolean; enteredAtMs?: number; nowMs?: number } = {},
) =>
  nextState({
    current,
    enteredAtMs: opts.enteredAtMs ?? AT,
    liqBufferPct: buffer,
    priceIsOld: opts.priceIsOld ?? false,
    nowMs: opts.nowMs ?? AT + T.minDwellMs,
    thresholds: T,
  });

// ── classification ───────────────────────────────────────────────────────────

test('a first sighting classifies by the enter thresholds', () => {
  assert.equal(decide(undefined, 0.5).state, 'SAFE');
  assert.equal(decide(undefined, 0.05).state, 'WATCH');
  assert.equal(decide(undefined, 0.02).state, 'DANGER');
  assert.equal(decide(undefined, -0.01).state, 'PAST_LIQUIDATION');
  assert.equal(decide(undefined, 0.5).changed, true);
});

test('a first sighting is allowed on an old price, because it softens nothing', () => {
  // There is no prior severity to give an all-clear from, and refusing to assess
  // a quiet market would leave the position showing nothing at all.
  const d = decide(undefined, 0.05, { priceIsOld: true });
  assert.equal(d.state, 'WATCH');
  assert.equal(d.changed, true);
  assert.equal(d.heldOnStalePrice, true, 'but it is still flagged as resting on an old price');
});

test('a position with no size is SAFE and has no buffer to speak of', () => {
  assert.equal(decide(undefined, undefined).state, 'SAFE');
  assert.equal(decide('DANGER', undefined).state, 'SAFE');
  assert.equal(decide('SAFE', undefined).changed, false);
});

// ── escalation ───────────────────────────────────────────────────────────────

test('escalation is immediate and ignores dwell time entirely', () => {
  const d = decide('SAFE', 0.02, { enteredAtMs: AT, nowMs: AT + 1 });
  assert.equal(d.state, 'DANGER');
  assert.equal(d.changed, true);
  assert.equal(d.heldOnDwell, false);
});

test('escalation skips intermediate states on a gap move', () => {
  const d = decide('SAFE', -0.05, { nowMs: AT + 1 });
  assert.equal(d.state, 'PAST_LIQUIDATION');
  assert.equal(d.changed, true);
});

test('escalation still refuses a stale price: the market may have moved either way', () => {
  const d = decide('SAFE', 0.02, { priceIsOld: true });
  assert.equal(d.state, 'SAFE');
  assert.equal(d.changed, false);
  assert.equal(d.heldOnStalePrice, true);
});

// ── de-escalation ────────────────────────────────────────────────────────────

test('leaving DANGER needs the exit threshold, not the enter one', () => {
  // 0.035 is above dangerEnter (0.03) but below dangerExit (0.04): still DANGER.
  const inBand = decide('DANGER', 0.035);
  assert.equal(inBand.state, 'DANGER');
  assert.equal(inBand.changed, false);

  const out = decide('DANGER', 0.045);
  assert.equal(out.state, 'WATCH');
  assert.equal(out.changed, true);
});

test('leaving WATCH needs the exit threshold too', () => {
  assert.equal(decide('WATCH', 0.085).state, 'WATCH');
  assert.equal(decide('WATCH', 0.095).state, 'SAFE');
});

test('de-escalation is blocked until the dwell time has elapsed', () => {
  const early = decide('DANGER', 0.5, { enteredAtMs: AT, nowMs: AT + T.minDwellMs - 1 });
  assert.equal(early.state, 'DANGER');
  assert.equal(early.changed, false);
  assert.equal(early.heldOnDwell, true);

  const late = decide('DANGER', 0.5, { enteredAtMs: AT, nowMs: AT + T.minDwellMs });
  assert.equal(late.state, 'SAFE');
  assert.equal(late.changed, true);
});

test('a big recovery goes straight to SAFE rather than stepping down', () => {
  assert.equal(decide('PAST_LIQUIDATION', 0.5).state, 'SAFE');
});

test('leaving PAST_LIQUIDATION needs a positive buffer and the dwell time', () => {
  assert.equal(decide('PAST_LIQUIDATION', -0.001).state, 'PAST_LIQUIDATION');
  const early = decide('PAST_LIQUIDATION', 0.02, { nowMs: AT + 1 });
  assert.equal(early.state, 'PAST_LIQUIDATION');
  assert.equal(early.heldOnDwell, true);
  assert.equal(decide('PAST_LIQUIDATION', 0.02).state, 'DANGER');
});

// ── the rule that matters most ───────────────────────────────────────────────

test('NEVER an all-clear from a stale price, however long it sits there', () => {
  for (const hours of [1, 6, 24, 24 * 30]) {
    const d = decide('DANGER', 0.9, {
      enteredAtMs: AT,
      nowMs: AT + hours * 3_600_000,
      priceIsOld: true,
    });
    assert.equal(d.state, 'DANGER', `still DANGER after ${hours}h on an old price`);
    assert.equal(d.changed, false, 'and no change event to carry a recovery');
    assert.equal(d.heldOnStalePrice, true);
  }
});

test('holding on a stale price flags it even when nothing would have changed', () => {
  const d = decide('WATCH', 0.05, { priceIsOld: true });
  assert.equal(d.state, 'WATCH');
  assert.equal(d.changed, false);
  assert.equal(d.heldOnStalePrice, true, 'the assessment rests on an old price either way');
});

// ── flapping ─────────────────────────────────────────────────────────────────

test('a price oscillating across the DANGER boundary produces ONE transition', () => {
  // Without hysteresis this series would flip state on all fourteen ticks.
  const series = [0.031, 0.029, 0.031, 0.029, 0.0305, 0.0295, 0.031, 0.029];
  let state: RiskState | undefined = 'WATCH';
  let enteredAtMs = AT;
  let transitions = 0;

  for (const [i, buffer] of series.entries()) {
    const d = nextState({
      current: state,
      enteredAtMs,
      liqBufferPct: buffer,
      priceIsOld: false,
      // Well past the dwell time, so only the thresholds are doing the work.
      nowMs: AT + T.minDwellMs * (i + 2),
      thresholds: T,
    });
    if (d.changed) transitions += 1;
    state = d.state;
    enteredAtMs = d.enteredAtMs;
  }

  assert.equal(transitions, 1, 'only the first dip below 3% should transition');
  assert.equal(state, 'DANGER', 'and it stays there: nothing reached 4%');
});

test('an oscillation that genuinely recovers past the exit threshold does transition', () => {
  const d = decide('DANGER', 0.041, { enteredAtMs: AT, nowMs: AT + T.minDwellMs });
  assert.equal(d.state, 'WATCH');
  assert.equal(d.changed, true);
});

test('dwell time alone stops flapping even with the thresholds set equal', () => {
  const flat = { ...T, dangerEnterPct: 0.03, dangerExitPct: 0.03, minDwellMs: 60_000 };
  let state: RiskState = 'DANGER';
  let enteredAtMs = AT;
  let transitions = 0;
  for (const [i, buffer] of [0.031, 0.029, 0.031, 0.029].entries()) {
    const d = nextState({
      current: state,
      enteredAtMs,
      liqBufferPct: buffer,
      priceIsOld: false,
      nowMs: AT + i * 1_000, // ticking every second, inside the dwell
      thresholds: flat,
    });
    if (d.changed) transitions += 1;
    state = d.state;
    enteredAtMs = d.enteredAtMs;
  }
  assert.equal(transitions, 0);
  assert.equal(state, 'DANGER');
});
