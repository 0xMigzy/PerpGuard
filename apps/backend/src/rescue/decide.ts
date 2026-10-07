/**
 * WHETHER A RESCUE RULE ACTS, NOW. Pure: one rule, one look at its position,
 * the facts around it, and an answer. No I/O, so every limit is a unit test.
 *
 * THE TRIGGER (approved 6 Oct 2026): the position's distance is at or below
 * the rule's trigger on TWO assessments AT LEAST ONE SECOND APART. One price
 * print is not a trend; a second look a second later is. The engine keeps
 * `belowSinceMs` (when it first saw the position at or below, cleared the
 * moment it is seen above) and this function judges it.
 *
 * Once triggered, EVERY LIMIT IS RE-CHECKED ON EVERY ATTEMPT, in this order:
 *
 *   1. the kill switch                       -> hold    (nothing automated acts)
 *   2. the feed / the position set           -> hold    (a frozen price decides nothing)
 *   3. rescues used, total added             -> exhausted (the handover)
 *   4. cooldown since the last attempt       -> hold
 *   5. free balance: known, and the floor
 *      minus the amount stays at or above
 *      the minimum never spent               -> hold    (STRICTLY: never a scaled-down amount)
 *
 * Only then `fire`. Max total is its own limit, never count x amount: a rule
 * whose next amount would take the total past it is exhausted, not trimmed.
 *
 * A POSITION IS GONE ONLY WHEN A FULLY LOADED POSITION LIST OMITS IT (owner,
 * 7 Oct 2026). Not when it has no risk reading: a quiet market after a
 * restart has no price yet, a market dropped from the context has no config,
 * and in both the position is still open. Saying "no longer open" about an
 * open position destroys trust in everything else the bot says, so the list
 * of open position ids decides, and a missing reading is a hold.
 */
import type { RiskAssessment } from '../risk/types.ts';
import type { RescueRule } from './store.ts';

export const RESCUE_CONFIRM_MS = 1_000;

export type HoldReason =
  | 'stopped'
  | 'feed-down'
  | 'positions-untrusted'
  /** The position is open, but there is no risk reading for it (no price yet, no market config). */
  | 'unassessed'
  /** The venue has the market closed (paused). Waits without writing an attempt row. */
  | 'market-closed'
  | 'cooldown'
  | 'balance-unknown'
  | 'balance-low'
  | 'no-session'
  | 'in-flight'
  | 'refused';

/** Reasons that clear themselves (a reconnect, a first snapshot): said only once they have lasted. */
export const TRANSIENT_HOLDS: ReadonlySet<HoldReason> = new Set<HoldReason>(['feed-down', 'positions-untrusted', 'unassessed', 'balance-unknown', 'no-session', 'in-flight']);

export type RescueDecision =
  /** Not at the trigger. `armed` is true when this look is the first at or below it. */
  | { readonly kind: 'idle' }
  | { readonly kind: 'arming' }
  /** Triggered, and something says not now. Said to the person once per reason. */
  | { readonly kind: 'hold'; readonly reason: HoldReason; readonly detail: string }
  /** Triggered, and the limits are spent: PerpGuard hands the position back. */
  | { readonly kind: 'exhausted'; readonly detail: string }
  /** The position this rule was for is gone (closed, liquidated, replaced). The rule ends. */
  | { readonly kind: 'ended'; readonly detail: string }
  | { readonly kind: 'fire'; readonly amountCNS: bigint };

export interface RescueFacts {
  readonly rule: RescueRule;
  /** The account's current risk reading of the rule's market. Undefined says nothing about whether the position is open. */
  readonly assessment: RiskAssessment | undefined;
  /**
   * The ids of every open position on the account, from a FULLY LOADED list
   * (the source is `live`). Undefined when the list is not fully loaded: then
   * nothing can be concluded about any position, and nothing is ended.
   */
  readonly openPositionIds: ReadonlySet<number> | undefined;
  /** When the engine first saw this position at or below the trigger, in this run. */
  readonly belowSinceMs: number | undefined;
  readonly automationStopped: boolean;
  readonly feedConnected: boolean;
  /** The free-balance FLOOR (`b - lb`) LESS this account's open reservations, or undefined when not known. */
  readonly freeFloorCNS: bigint | undefined;
  readonly nowMs: number;
}

/** True when the position's own figure is at or below the trigger. A negative buffer is below any trigger. */
export function atOrBelowTrigger(rule: Pick<RescueRule, 'triggerPct'>, assessment: Pick<RiskAssessment, 'liqBufferPct'> | undefined): boolean {
  const b = assessment?.liqBufferPct;
  return b !== undefined && b !== null && Number.isFinite(b) && b <= rule.triggerPct;
}

export function decide(f: RescueFacts): RescueDecision {
  const { rule, assessment } = f;
  // A list we cannot vouch for says nothing about whether the position is still
  // there: never END a rule, or act, on it.
  if (f.openPositionIds === undefined) return hold('positions-untrusted');

  // GONE ONLY ON PROOF: the fully loaded list omits the rule's position id. A
  // closed and reopened position has a new id, so the old rule ends with it.
  if (!f.openPositionIds.has(rule.positionId)) {
    return { kind: 'ended', detail: `the ${rule.symbol} position this rule was for is no longer open` };
  }
  // Open, but no reading for THIS position: wait. Never "closed".
  if (assessment === undefined || assessment.positionId !== rule.positionId) return hold('unassessed');

  if (assessment.state === 'POSITIONS_UNTRUSTED') return hold('positions-untrusted');
  if (!atOrBelowTrigger(rule, assessment)) return { kind: 'idle' };
  // Two looks at least a second apart: the first only arms.
  if (f.belowSinceMs === undefined || f.nowMs - f.belowSinceMs < RESCUE_CONFIRM_MS) return { kind: 'arming' };

  if (f.automationStopped) return hold('stopped');
  if (!f.feedConnected || assessment.state === 'FEED_DOWN') return hold('feed-down');

  if (rule.rescueCount >= rule.maxRescues) {
    return { kind: 'exhausted', detail: `all ${rule.maxRescues} rescue${rule.maxRescues === 1 ? '' : 's'} used` };
  }
  if (rule.totalRescuedCNS + rule.amountCNS > rule.maxTotalCNS) {
    return { kind: 'exhausted', detail: `another ${rule.amountCNS} would take the total past the cap of ${rule.maxTotalCNS}` };
  }

  if (rule.lastAttemptAtMs !== undefined && f.nowMs - rule.lastAttemptAtMs < rule.cooldownMs) {
    return hold('cooldown', rule.lastAttemptAtMs + rule.cooldownMs - f.nowMs);
  }

  if (f.freeFloorCNS === undefined) return hold('balance-unknown');
  if (f.freeFloorCNS - rule.amountCNS < rule.minRemainingCNS) return hold('balance-low');

  return { kind: 'fire', amountCNS: rule.amountCNS };
}

function hold(reason: HoldReason, waitMs?: number): RescueDecision {
  return { kind: 'hold', reason, detail: HOLD_DETAIL[reason](waitMs) };
}

const HOLD_DETAIL: Record<HoldReason, (waitMs?: number) => string> = {
  stopped: () => 'automation is stopped (the kill switch is on)',
  'feed-down': () => 'the price feed is not connected, so every price held is frozen',
  'positions-untrusted': () => 'the position list cannot be trusted right now',
  unassessed: () => 'the position is open, but I have no price or market details for it yet',
  'market-closed': () => 'the exchange has this market closed right now',
  cooldown: (w) => `the cooldown since the last rescue has ${Math.ceil((w ?? 0) / 60_000)} min left`,
  'balance-unknown': () => 'the free balance is not known',
  'balance-low': () => 'adding the amount would take the free balance below the minimum kept',
  'no-session': () => 'the account is not connected',
  'in-flight': () => 'another action on this position has not settled',
  refused: () => 'the action was refused before it was sent',
};

export const holdDetail = (reason: HoldReason): string => HOLD_DETAIL[reason]();
