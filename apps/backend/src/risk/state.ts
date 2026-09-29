/**
 * The risk state machine. Pure: no I/O, no clock, no prices fetched.
 *
 * Two rules do all the work here, and both fail in the safe direction.
 *
 * 1. ESCALATION IS IMMEDIATE, DE-ESCALATION IS GATED. Getting worse uses the
 *    enter thresholds and ignores dwell time entirely. Getting better needs the
 *    exit threshold AND the dwell time. That alone stops flapping — a position
 *    cannot oscillate between two states if it cannot get back quickly — and it
 *    errs towards warning rather than reassuring.
 *
 * 2. NEVER GIVE AN ALL-CLEAR FROM A STALE PRICE. A position may hold its
 *    severity on an old price. It may never be softened by one. Escalation on
 *    fresh data only; de-escalation on fresh data only; stale means hold.
 */
import {
  DEFAULT_THRESHOLDS,
  SEVERITY,
  isBlind,
  type RiskState,
  type RiskThresholds,
  type Severity,
} from './types.ts';

export interface StateInput {
  /** Undefined the first time a position is seen. */
  readonly current: RiskState | undefined;
  /** When `current` was entered. Undefined alongside `current`. */
  readonly enteredAtMs: number | undefined;
  /**
   * Signed. Negative means the position is already past its liquidation price.
   * Undefined for a position with no size, which has no buffer at all.
   */
  readonly liqBufferPct: number | undefined;
  readonly priceIsOld: boolean;
  readonly nowMs: number;
  readonly thresholds?: RiskThresholds;
}

export interface StateDecision {
  readonly state: RiskState;
  readonly changed: boolean;
  /** When the returned state was entered: `nowMs` on a change, else unchanged. */
  readonly enteredAtMs: number;
  /** See the contract on RiskAssessment.heldOnStalePrice. */
  readonly heldOnStalePrice: boolean;
  /** A softening was due but the dwell time had not elapsed. */
  readonly heldOnDwell: boolean;
  readonly reason: string;
}

const isSeverity = (state: RiskState): state is Severity => !isBlind(state);

/**
 * Severity implied by the buffer using the ENTER thresholds: how bad things are
 * if we are allowed to say so.
 */
function escalationTarget(buffer: number, t: RiskThresholds): Severity {
  if (buffer < 0) return 'PAST_LIQUIDATION';
  if (buffer < t.dangerEnterPct) return 'DANGER';
  if (buffer < t.watchEnterPct) return 'WATCH';
  return 'SAFE';
}

/**
 * Severity implied by the buffer using the EXIT thresholds: how far things have
 * to have recovered before we are willing to say so.
 */
function deescalationTarget(buffer: number, t: RiskThresholds): Severity {
  if (buffer < 0) return 'PAST_LIQUIDATION';
  if (buffer < t.dangerExitPct) return 'DANGER';
  if (buffer < t.watchExitPct) return 'WATCH';
  return 'SAFE';
}

const hold = (
  state: RiskState,
  enteredAtMs: number,
  reason: string,
  flags: { stale?: boolean; dwell?: boolean } = {},
): StateDecision => ({
  state,
  changed: false,
  enteredAtMs,
  heldOnStalePrice: flags.stale === true,
  heldOnDwell: flags.dwell === true,
  reason,
});

/**
 * Decide the next state for one position.
 *
 * The BLIND states are not decided here — the loop sets them, because only the
 * loop knows the price connection is gone or the position set cannot be
 * believed. This function handles resuming from them: the severity held before
 * going blind comes back in as `current`.
 */
export function nextState(input: StateInput): StateDecision {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const { current, liqBufferPct: buffer, priceIsOld, nowMs } = input;
  const enteredAtMs = input.enteredAtMs ?? nowMs;

  // A position with no size has no buffer and no risk.
  if (buffer === undefined) {
    if (current === 'SAFE') return hold('SAFE', enteredAtMs, 'position has no size');
    return {
      state: 'SAFE',
      changed: current !== undefined,
      enteredAtMs: nowMs,
      heldOnStalePrice: false,
      heldOnDwell: false,
      reason: 'position has no size',
    };
  }

  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;

  // First sight of a position is a CLASSIFICATION, not a transition. There is
  // no prior severity to soften, so an old price is allowed to set the opening
  // one — a quiet market is the venue's current truth, and refusing to assess it
  // would leave the position showing nothing at all. Every subsequent CHANGE
  // needs fresh data.
  if (current === undefined) {
    const opening = escalationTarget(buffer, t);
    return {
      state: opening,
      changed: true,
      enteredAtMs: nowMs,
      heldOnStalePrice: priceIsOld,
      heldOnDwell: false,
      reason: priceIsOld
        ? `first assessment at buffer ${pct(buffer)}, on a price older than STALE_MS`
        : `first assessment at buffer ${pct(buffer)}`,
    };
  }

  if (!isSeverity(current)) {
    // Should not happen: the loop resumes from the remembered severity, never
    // from a blind state itself.
    return hold(current, enteredAtMs, `cannot assess: ${current}`);
  }

  const escalateTo = escalationTarget(buffer, t);
  const deescalateTo = deescalationTarget(buffer, t);
  const currentSeverity = SEVERITY[current];

  if (SEVERITY[escalateTo] > currentSeverity) {
    // Getting worse. Never gated by dwell — but still never derived from a
    // stale price, because the market may have moved either way since.
    if (priceIsOld) {
      return hold(
        current,
        enteredAtMs,
        `holding ${current}: buffer ${pct(buffer)} suggests ${escalateTo}, but the price is older than STALE_MS`,
        { stale: true },
      );
    }
    return {
      state: escalateTo,
      changed: true,
      enteredAtMs: nowMs,
      heldOnStalePrice: false,
      heldOnDwell: false,
      reason: `buffer ${pct(buffer)} fell to ${escalateTo}`,
    };
  }

  if (SEVERITY[deescalateTo] < currentSeverity) {
    // Getting better, which is the direction that has to earn it.
    if (priceIsOld) {
      return hold(
        current,
        enteredAtMs,
        `holding ${current}: no all-clear from a price older than STALE_MS`,
        { stale: true },
      );
    }
    const dwelledMs = nowMs - enteredAtMs;
    if (dwelledMs < t.minDwellMs) {
      return hold(
        current,
        enteredAtMs,
        `holding ${current} for another ${t.minDwellMs - dwelledMs}ms before softening to ${deescalateTo}`,
        { dwell: true },
      );
    }
    return {
      state: deescalateTo,
      changed: true,
      enteredAtMs: nowMs,
      heldOnStalePrice: false,
      heldOnDwell: false,
      reason: `buffer ${pct(buffer)} recovered to ${deescalateTo}`,
    };
  }

  // Inside the hysteresis band, or genuinely unchanged.
  return hold(current, enteredAtMs, `buffer ${pct(buffer)} holds ${current}`, {
    stale: priceIsOld,
  });
}
