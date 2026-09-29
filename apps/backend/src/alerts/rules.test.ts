/**
 * The alert rules, against real assessments from the real loop.
 *
 * `decide` is pure, so these drive it directly: the history goes in, the next
 * history comes out, and the clock is a number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RiskChange } from '../risk/types.ts';
import { assertNoReassuranceWhileHeld, decide, kindFor } from './rules.ts';
import { DEFAULT_ALERT_CONFIG, type AlertDecision, type AlertHistory, type AlertRuleContext } from './types.ts';
import {
  BTC,
  DANGER_ETH,
  FIXTURE_BTC,
  FIXTURE_BTC_MARK,
  SAFE_BTC,
  WATCH_BTC,
  assessOne,
  withOverrides,
} from './testSupport.ts';

const context: AlertRuleContext = { alerts: DEFAULT_ALERT_CONFIG, market: BTC };
const COOLDOWN_MS = DEFAULT_ALERT_CONFIG.cooldownMs.DANGER;

const T0 = 5_000_000;

/** Feeds a sequence of changes through `decide`, threading the history. */
class Sequence {
  history: AlertHistory | undefined;
  readonly decisions: AlertDecision[] = [];
  readonly ruleContext: AlertRuleContext;

  constructor(ruleContext: AlertRuleContext = context) {
    this.ruleContext = ruleContext;
  }

  at(nowMs: number, change: RiskChange): AlertDecision {
    const decision = decide(change, this.ruleContext, this.history, nowMs);
    this.history = decision.history;
    this.decisions.push(decision);
    return decision;
  }
}

/** A change with `previousState` set, for transitions the loop would emit. */
const from = (change: RiskChange, previousState: RiskChange['previousState']): RiskChange => ({
  assessment: change.assessment,
  previousState,
});

const danger = (): RiskChange => assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change;
const watch = (): RiskChange => assessOne(WATCH_BTC, FIXTURE_BTC_MARK).change;
const safe = (): RiskChange => assessOne(SAFE_BTC, FIXTURE_BTC_MARK).change;

// ── the states are classified as the right kind of message ───────────────────

test('each risk state maps to its own kind of message', () => {
  assert.equal(kindFor('PAST_LIQUIDATION'), 'past-liquidation');
  assert.equal(kindFor('DANGER'), 'danger');
  assert.equal(kindFor('WATCH'), 'watch');
  assert.equal(kindFor('SAFE'), 'recovered');
  assert.equal(kindFor('FEED_DOWN'), 'feed-down');
  assert.equal(kindFor('POSITIONS_UNTRUSTED'), 'positions-untrusted');
});

// ── cooldown ─────────────────────────────────────────────────────────────────

test('DANGER alerts, then holds for the cooldown, then alerts again', () => {
  const s = new Sequence();
  const change = danger();

  assert.equal(s.at(T0, change).send, true, 'the first DANGER goes out immediately');

  const held = s.at(T0 + 60_000, change);
  assert.equal(held.send, false);
  assert.match(held.suppressedReason!, /cooldown left/);

  // One millisecond before it expires it is still held.
  assert.equal(s.at(T0 + COOLDOWN_MS - 1, change).send, false);
  // And on expiry it speaks again.
  assert.equal(s.at(T0 + COOLDOWN_MS, change).send, true);
});

test('cooldown is per severity, so a WATCH does not silence a DANGER', () => {
  const s = new Sequence();
  assert.equal(s.at(T0, watch()).send, true);
  // DANGER has its own cooldown key and has never been sent.
  assert.equal(s.at(T0 + 1_000, from(danger(), 'WATCH')).send, true);
});

test('cooldown is configurable per severity', () => {
  const s = new Sequence({
    alerts: { ...DEFAULT_ALERT_CONFIG, cooldownMs: { ...DEFAULT_ALERT_CONFIG.cooldownMs, DANGER: 1_000 } },
    market: BTC,
  });
  const change = danger();
  assert.equal(s.at(T0, change).send, true);
  assert.equal(s.at(T0 + 500, change).send, false);
  assert.equal(s.at(T0 + 1_000, change).send, true, 'a one-second DANGER cooldown really is one second');
});

// ── escalation bypasses cooldown ─────────────────────────────────────────────

test('escalation overrides a cooldown that is still running', () => {
  const s = new Sequence();

  // DANGER goes out, so DANGER's cooldown is now running.
  assert.equal(s.at(T0, danger()).send, true);
  // It softens to WATCH, which is a different severity and speaks.
  assert.equal(s.at(T0 + 60_000, from(watch(), 'DANGER')).send, true);

  // Back to DANGER two minutes into a fifteen-minute DANGER cooldown. This is an
  // ESCALATION from the last thing we said, so it is never rate-limited: a
  // warning is never delayed, only a repetition is.
  const escalated = s.at(T0 + 120_000, from(danger(), 'WATCH'));
  assert.equal(escalated.send, true);
  assert.equal(escalated.message!.state, 'DANGER');
  assert.ok(T0 + 120_000 - T0 < COOLDOWN_MS, 'and the cooldown really was still running');
});

test('PAST_LIQUIDATION escalating out of DANGER is never held', () => {
  const s = new Sequence();
  assert.equal(s.at(T0, danger()).send, true);

  const { harness } = assessOne(SAFE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000).price(BTC.marketId, 'BTC', 74_000);
  harness.evaluate();
  const doomed = from(harness.changeFor(BTC.marketId), 'DANGER');
  assert.equal(doomed.assessment.state, 'PAST_LIQUIDATION');

  const decision = s.at(T0 + 1_000, doomed);
  assert.equal(decision.send, true, 'the worst news is never rate-limited');
});

test('de-escalation does NOT bypass the cooldown', () => {
  const s = new Sequence();
  // WATCH goes out at T0.
  assert.equal(s.at(T0, watch()).send, true);
  // A second WATCH a minute later is neither an escalation nor a new entry.
  assert.equal(s.at(T0 + 60_000, watch()).send, false);
});

// ── WATCH once per entry ─────────────────────────────────────────────────────

test('WATCH is announced once per entry, and again on a new entry', () => {
  const s = new Sequence();
  const w = watch();

  assert.equal(s.at(T0, w).send, true);

  const repeat = s.at(T0 + COOLDOWN_MS * 2, w);
  assert.equal(repeat.send, false, 'even past the cooldown, one WATCH per stay');
  assert.match(repeat.suppressedReason!, /already announced for this entry/);

  // Leaving WATCH ends the entry, even on a tick that sends nothing.
  const left = s.at(T0 + COOLDOWN_MS * 2 + 1, from(safe(), 'WATCH'));
  assert.equal(left.history.watchAlertedThisEntry, false);

  // A new entry into WATCH speaks again.
  assert.equal(s.at(T0 + COOLDOWN_MS * 3, from(w, 'SAFE')).send, true);
});

test('the WATCH latch is cleared by a DANGER too, not only by a recovery', () => {
  const s = new Sequence();
  assert.equal(s.at(T0, watch()).send, true);
  assert.equal(s.at(T0 + 1_000, from(danger(), 'WATCH')).send, true);
  assert.equal(s.history!.watchAlertedThisEntry, false, 'escalating out of WATCH ends that entry');

  // Clearing the latch is not the same as speaking again. Coming straight back to
  // WATCH is a DE-ESCALATION, so the cooldown still applies to it — the latch
  // governs "once per stay", the cooldown governs "not too often", and a
  // position flapping DANGER/WATCH is exactly what the second one is for.
  const tooSoon = s.at(T0 + 2_000, from(watch(), 'DANGER'));
  assert.equal(tooSoon.send, false);
  assert.match(tooSoon.suppressedReason!, /cooldown left/);

  // Once the WATCH cooldown has run out, the fresh entry does speak.
  assert.equal(s.at(T0 + COOLDOWN_MS + 1, from(watch(), 'DANGER')).send, true);
});

// ── SAFE and recovery ────────────────────────────────────────────────────────

test('a recovery to SAFE is announced', () => {
  const s = new Sequence();
  assert.equal(s.at(T0, danger()).send, true);
  const recovered = s.at(T0 + 120_000, from(safe(), 'DANGER'));
  assert.equal(recovered.send, true);
  assert.equal(recovered.message!.kind, 'recovered');
});

test('first sight of a healthy position is not a recovery and says nothing', () => {
  const s = new Sequence();
  const first = s.at(T0, safe());
  assert.equal(first.send, false);
  assert.match(first.suppressedReason!, /nothing to recover from/);
});

// ── THE HARD GATE ────────────────────────────────────────────────────────────

test('no reassuring message is produced while the severity is held on a stale price', () => {
  // A SAFE assessment with heldOnStalePrice set. Today's state machine cannot
  // produce this — it refuses to soften on an old price — so it is built
  // directly. The gate exists for the refactor that changes that.
  const base = from(safe(), 'DANGER');
  const held = withOverrides(base, { heldOnStalePrice: true, priceIsOld: true });

  const decision = decide(held, context, undefined, T0);
  assert.equal(decision.send, false);
  assert.equal(decision.message, undefined);
  assert.match(decision.suppressedReason!, /no reassuring message/);
});

test('the gate holds even with no cooldown and a fresh history', () => {
  const noCooldown: AlertRuleContext = {
    alerts: { ...DEFAULT_ALERT_CONFIG, cooldownMs: { SAFE: 0, WATCH: 0, DANGER: 0, PAST_LIQUIDATION: 0 } },
    market: BTC,
  };
  const held = withOverrides(from(safe(), 'WATCH'), { heldOnStalePrice: true, priceIsOld: true });
  assert.equal(decide(held, noCooldown, undefined, T0).send, false);
});

test('the gate is an assertion, not just an early return', () => {
  // Belt and braces: if a future path reaches message construction with a
  // reassuring kind while the flag is set, it throws rather than sending.
  const held = withOverrides(from(safe(), 'DANGER'), { heldOnStalePrice: true });
  assert.throws(
    () => assertNoReassuranceWhileHeld(held.assessment, 'recovered'),
    /heldOnStalePrice is a contract, not a diagnostic/,
  );
});

test('a held severity may still WARN, it just may not reassure', () => {
  // The flag blocks softening, not speaking. A DANGER held on an old price is
  // still a DANGER and the user still hears about it.
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK, { ageMs: 4 * 60_000 });
  assert.equal(change.assessment.priceIsOld, true);
  assert.equal(change.assessment.state, 'DANGER');

  const decision = decide(change, context, undefined, T0);
  assert.equal(decision.send, true);
  assert.ok(decision.message!.text.includes('price is 4 minutes old'));
});

test('the blind kinds pass the gate, because they are not reassurance', () => {
  // The loop sets heldOnStalePrice on every blind assessment, so if the gate
  // keyed off the flag alone it would swallow the outage notice itself — the one
  // message a user most needs when the monitor has gone blind.
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.health = { state: 'disconnected', reconnectAttempt: 1 };
  harness.evaluate();
  const change = harness.changeFor(BTC.marketId);

  assert.equal(change.assessment.heldOnStalePrice, true);
  const decision = decide(change, context, undefined, T0);
  assert.equal(decision.send, true);
  assert.equal(decision.message!.kind, 'feed-down');
});

// ── the two outages ──────────────────────────────────────────────────────────

/** Drives a real outage of one cause and returns the change the loop emitted. */
function outage(cause: 'feed' | 'positions'): RiskChange {
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  if (cause === 'feed') harness.health = { state: 'disconnected', reconnectAttempt: 1 };
  else harness.positionsState = 'stale';
  harness.evaluate();
  return harness.changeFor(BTC.marketId);
}

test('FEED_DOWN is announced once per outage, not once per tick', () => {
  const s = new Sequence();
  const down = outage('feed');
  assert.equal(down.assessment.state, 'FEED_DOWN');

  assert.equal(s.at(T0, down).send, true);
  const repeat = s.at(T0 + 1_000, down);
  assert.equal(repeat.send, false);
  assert.match(repeat.suppressedReason!, /already announced for this outage/);
  // Not merely rate-limited: still silent long past any cooldown.
  assert.equal(s.at(T0 + COOLDOWN_MS * 5, down).send, false);
});

test('POSITIONS_UNTRUSTED is announced once per outage too', () => {
  const s = new Sequence();
  const lost = outage('positions');
  assert.equal(lost.assessment.state, 'POSITIONS_UNTRUSTED');

  assert.equal(s.at(T0, lost).send, true);
  assert.equal(s.at(T0 + 1_000, lost).send, false);
});

test('recovery then a NEW outage is announced again', () => {
  const s = new Sequence();
  const down = outage('feed');

  assert.equal(s.at(T0, down).send, true);
  assert.equal(s.at(T0 + 1_000, down).send, false, 'same outage, already said');

  // The feed comes back and the position is assessed again.
  const back = from(danger(), 'FEED_DOWN');
  assert.equal(s.at(T0 + 2_000, back).send, true);
  assert.deepEqual(s.history!.announcedOutages, [], 'the outage latch is cleared on recovery');

  // A second, genuinely new outage.
  assert.equal(s.at(T0 + 3_000, down).send, true);
});

test('the two causes are latched separately, so the second one is still said', () => {
  // The feed drops, and then the position set also goes bad. That is a different
  // problem with a different fix, and the user is told which they now have.
  const s = new Sequence();
  assert.equal(s.at(T0, outage('feed')).send, true);

  const alsoLost = s.at(T0 + 1_000, outage('positions'));
  assert.equal(alsoLost.send, true);
  assert.equal(alsoLost.message!.kind, 'positions-untrusted');
  assert.deepEqual(s.history!.announcedOutages, ['FEED_DOWN', 'POSITIONS_UNTRUSTED']);
});

test('an outage does not become a shortcut past the once-per-entry rule', () => {
  const s = new Sequence();
  assert.equal(s.at(T0, watch()).send, true);
  assert.equal(s.at(T0 + 1_000, outage('feed')).send, true);
  // Returning to the SAME stay in WATCH is not a new entry.
  const back = s.at(T0 + 2_000, from(watch(), 'FEED_DOWN'));
  assert.equal(back.send, false);
  assert.match(back.suppressedReason!, /already announced for this entry/);
});

// ── history is returned even when nothing is sent ────────────────────────────

test('a suppressed decision still returns the history to store', () => {
  const s = new Sequence();
  const change = danger();
  s.at(T0, change);
  const suppressed = s.at(T0 + 1_000, change);

  assert.equal(suppressed.send, false);
  assert.equal(suppressed.history.lastAlertedSeverity, 'DANGER');
  assert.equal(suppressed.history.lastSentAtMs.DANGER, T0, 'and the cooldown clock is not reset by it');
});

test('a suppressed tick that leaves WATCH still clears the latch', () => {
  const s = new Sequence();
  assert.equal(s.at(T0, watch()).send, true);

  // First sight of SAFE is suppressed — but it is still a departure from WATCH.
  const quiet = decide(safe(), context, s.history, T0 + 1_000);
  assert.equal(quiet.send, false);
  assert.equal(quiet.history.watchAlertedThisEntry, false);
});

test('the history for an unseen position starts empty rather than undefined', () => {
  const decision = decide(danger(), context, undefined, T0);
  assert.equal(decision.history.marketId, BTC.marketId);
  assert.equal(decision.history.lastAlertedSeverity, 'DANGER');
  assert.deepEqual(decision.history.announcedOutages, []);
});

// ── the message carries what the bot needs ───────────────────────────────────

test('a sent decision carries the structured actions and the position id', () => {
  const decision = decide(danger(), context, undefined, T0);
  assert.equal(decision.send, true);
  const message = decision.message!;
  assert.equal(message.positionId, 4242);
  assert.equal(message.marketId, BTC.marketId);
  assert.equal(message.actions.length, 2);
  assert.deepEqual(
    message.actions.map((a) => a.intent),
    ['clear-danger', 'to-safe'],
  );
});

test('another market decides on its own config, not BTC\'s', () => {
  const { change } = assessOne(DANGER_ETH, 3000);
  const decision = decide(
    change,
    { alerts: DEFAULT_ALERT_CONFIG, market: { ...BTC, ...{ marketId: 20, symbol: 'ETH', priceDecimals: 2, lotDecimals: 3, maintenanceMargin: 2000, initialMargin: 1000 } } },
    undefined,
    T0,
  );
  assert.equal(decision.send, true);
  assert.ok(decision.message!.text.includes('3,081.00'), decision.message!.text);
});
