/**
 * Whether to say anything, and which thing. Pure: no I/O, no clock, no state of
 * its own — the caller passes the history in and stores the history it gets back.
 *
 * The rules, in the order they are applied:
 *
 *   0. HARD GATE. While `heldOnStalePrice` is set, no reassuring message is
 *      producible. Not rate-limited, not deferred — impossible. See below.
 *   1. FEED_DOWN and POSITIONS_UNTRUSTED: once per outage, and the message names
 *      WHICH. They are different problems with different fixes.
 *   2. PAST_LIQUIDATION and DANGER: always, subject to cooldown.
 *   3. WATCH: once per entry.
 *   4. SAFE: the recovery message, and only from a fresh price.
 *
 * ESCALATION BYPASSES COOLDOWN. Getting worse is never rate-limited; only
 * repeating yourself is. That mirrors the risk state machine one layer down,
 * where escalation is immediate and only softening is gated — a warning is never
 * delayed, an all-clear is.
 */
import { SEVERITY, isBlind, type RiskAssessment, type RiskChange, type Severity } from '../risk/types.ts';
import { buildMessage } from './render.ts';
import {
  emptyHistory,
  isReassuring,
  type AlertDecision,
  type AlertHistory,
  type AlertKind,
  type AlertRuleContext,
} from './types.ts';

/**
 * THE STALE-PRICE CONTRACT, ASSERTED RATHER THAN REMEMBERED.
 *
 * `heldOnStalePrice` means the severity was not derived from fresh data: it is
 * being HELD, and the real market may have moved arbitrarily far since. A
 * position may hold its severity on an old price; it may never be SOFTENED by
 * one. So an all-clear built on one is not "unlikely" or "discouraged" — it is a
 * bug, and this throws on it.
 *
 * `decide` already returns early on exactly this condition. This exists because
 * that early return is one line that a later refactor can route around: add a new
 * reassuring kind, or a new send path, and the gate is silently gone. Every
 * message is built through here instead, so the contract holds by construction.
 * The cost of a false all-clear is a trader who stops watching a position that is
 * still dying, which is worse than no tool at all.
 */
export function assertNoReassuranceWhileHeld(
  assessment: RiskAssessment,
  kind: AlertKind,
): void {
  if (assessment.heldOnStalePrice && isReassuring(kind)) {
    throw new Error(
      `refusing to build a reassuring "${kind}" alert for ${assessment.symbol} ` +
        `(market ${assessment.marketId}) while heldOnStalePrice is set. The ` +
        `severity is being held on a price older than STALE_MS, so it was not ` +
        `derived from fresh data and cannot support an all-clear. ` +
        `heldOnStalePrice is a contract, not a diagnostic.`,
    );
  }
}

/** Which kind of message this state change calls for. */
export function kindFor(state: RiskAssessment['state']): AlertKind {
  switch (state) {
    case 'PAST_LIQUIDATION':
      return 'past-liquidation';
    case 'DANGER':
      return 'danger';
    case 'WATCH':
      return 'watch';
    case 'SAFE':
      return 'recovered';
    case 'FEED_DOWN':
      return 'feed-down';
    case 'POSITIONS_UNTRUSTED':
      return 'positions-untrusted';
  }
}

const suppress = (history: AlertHistory, reason: string): AlertDecision => ({
  send: false,
  message: undefined,
  suppressedReason: reason,
  history,
});

/**
 * Decide what to do about one risk state change.
 *
 * `history` is this POSITION's history, or undefined the first time it is seen.
 * The returned history is what the caller stores — always, including on a
 * suppressed tick, because suppression still changes what we know.
 */
export function decide(
  event: RiskChange,
  context: AlertRuleContext,
  history: AlertHistory | undefined,
  nowMs: number,
): AlertDecision {
  const assessment = event.assessment;
  const existing = history ?? emptyHistory(assessment.marketId);
  const kind = kindFor(assessment.state);

  // ── 0. HARD GATE ──────────────────────────────────────────────────────────
  // Before cooldowns, before latches, before anything. A reassuring message
  // built on a held severity is not producible, so there is nothing further to
  // decide. The blind kinds pass here: they say we cannot see, which is the
  // opposite of an all-clear, even though the loop sets the flag for them too.
  if (assessment.heldOnStalePrice && isReassuring(kind)) {
    return suppress(
      existing,
      `no reassuring message while the severity is held on a stale price: ${assessment.reason}`,
    );
  }

  const send = (next: AlertHistory): AlertDecision => {
    assertNoReassuranceWhileHeld(assessment, kind);
    return {
      send: true,
      message: buildMessage(assessment, kind, context),
      suppressedReason: undefined,
      history: next,
    };
  };

  // ── 1. the two ways of being blind ────────────────────────────────────────
  if (isBlind(assessment.state)) {
    if (existing.announcedOutages.includes(assessment.state)) {
      // Once per outage, not per tick. The loop only emits on change, so this
      // rarely fires — but the rule lives here so it still holds if the engine
      // is ever driven from a poll instead.
      return suppress(existing, `${assessment.state} already announced for this outage`);
    }
    return send({
      ...existing,
      announcedOutages: [...existing.announcedOutages, assessment.state],
    });
  }

  // A real severity, so any outage is over: clear the latches. Recovery plus a
  // NEW outage is a new outage, and gets announced again.
  const severity: Severity = assessment.state;
  const afterOutage: AlertHistory = { ...existing, announcedOutages: [] };

  // Leaving WATCH ends that entry. Done for every severity that is not WATCH,
  // including on suppressed ticks, so the latch cannot stick.
  //
  // An OUTAGE IS NOT A NEW ENTRY: returning to WATCH after the feed came back is
  // the same stay in WATCH, and re-announcing it would mean an outage doubled as
  // a way to bypass the once-per-entry rule.
  const latched: AlertHistory =
    severity === 'WATCH' ? afterOutage : { ...afterOutage, watchAlertedThisEntry: false };

  const recorded = (): AlertHistory => ({
    ...latched,
    lastSentAtMs: { ...latched.lastSentAtMs, [severity]: nowMs },
    lastAlertedSeverity: severity,
    watchAlertedThisEntry: severity === 'WATCH' ? true : latched.watchAlertedThisEntry,
  });

  // ── 3. WATCH: once per entry ──────────────────────────────────────────────
  // Checked before the cooldown because it is the stricter rule: one WATCH per
  // stay, however long the stay lasts.
  if (severity === 'WATCH' && latched.watchAlertedThisEntry) {
    return suppress(latched, 'WATCH already announced for this entry');
  }

  // ── 4. SAFE is the recovery message ───────────────────────────────────────
  // First sight of a healthy position is a classification, not a recovery: there
  // is nothing to be relieved about, and "your position is fine" unprompted is
  // the noise that teaches people to ignore the channel.
  if (severity === 'SAFE' && event.previousState === undefined) {
    return suppress(latched, 'first assessment is SAFE: nothing to recover from');
  }

  // ── 2. cooldown, which escalation bypasses ────────────────────────────────
  const lastSentAtMs = latched.lastSentAtMs[severity];
  const cooldownMs = context.alerts.cooldownMs[severity];
  const withinCooldown = lastSentAtMs !== undefined && nowMs - lastSentAtMs < cooldownMs;
  // Nothing sent yet means nothing to escalate from, and nothing to rate-limit.
  const escalating =
    latched.lastAlertedSeverity === undefined ||
    SEVERITY[severity] > SEVERITY[latched.lastAlertedSeverity];

  if (withinCooldown && !escalating) {
    const remainingMs = cooldownMs - (nowMs - lastSentAtMs);
    return suppress(
      latched,
      `${severity} alerted ${nowMs - lastSentAtMs}ms ago; ${remainingMs}ms of cooldown left`,
    );
  }

  return send(recorded());
}
