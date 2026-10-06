/**
 * Ports and shapes for the actions layer — the only part of PerpGuard that moves
 * a trader's money.
 *
 * Every declaration here exists to make one class of lie unrepresentable. Read
 * the `sr 32` entry in CLAUDE.md and `docs/evidence.md` before changing any of
 * it: `t: 6` IncreasePositionCollateral comes back `st: 7 Failed,
 * sr: 32 OrderDescIdTooLow` on `mt: 24` while the collateral IS credited, by
 * exactly the amount sent. Measured four times across three testnet runs. A layer
 * that believed the reported status would tell a trader their rescue failed when
 * it worked, and they would then do it again by hand — which is exactly how the
 * investigation added the margin twice, 0.0559 -> 0.083584 -> 0.111268 AUSD.
 *
 * Three rules are structural rather than documentary:
 *
 *   THE OUTCOME IS WHAT THE POSITION SAYS, NOT WHAT THE VENUE SAYS. Which is why
 *   {@link ActionOutcome} carries a {@link Reconciliation} and the venue's own
 *   answer is filed under {@link ReportedStatus} — a name that cannot be mistaken
 *   for the result.
 *
 *   "UNKNOWN" IS A REAL OUTCOME. A partial delta, a vanished position, a
 *   position set that stopped being trustworthy mid-action: none of those are
 *   success and none are failure, and collapsing them into either is the failure
 *   mode this whole layer is built to avoid.
 *
 *   THERE IS NO RETRY ANYWHERE IN THIS LAYER. Not a disabled one, not a
 *   configurable one — none. A timeout and a reported failure both mean
 *   reconcile, and the way to guarantee nothing re-sends is for no code path to
 *   exist that could.
 */
import type {
  FeedHealth,
  NetworkName,
  PositionSourceStatus,
  Side,
  Unsubscribe,
} from '@perpguard/shared';
import type { PriceGate } from '../ingest/marketFeed.ts';

/** The actions this layer can take. Reduce and close are declared, not yet live. */
export type ActionKind = 'add-margin' | 'reduce-position' | 'close-position';

interface CommandBase {
  /**
   * The idempotency key. One per attempt, and the `action_log` row key.
   *
   * NOT a retry token. Nothing in this layer looks a key up to resume or replay
   * an action — it is here so a row can be found by a human and so a duplicate
   * submission is visible after the fact, never so one can be re-driven.
   */
  readonly idempotencyKey: string;
  readonly userId: string;
  /**
   * The account the position belongs to, as the CALLER asserts it. The
   * executor serving one account refuses a command naming another: that is
   * the second line of the isolation rule, behind the bot's request-time
   * link check, and it means a routing slip is a refusal rather than an
   * action on somebody else's position.
   */
  readonly accountId?: number;
  /** MARKET IDENTITY IS THE MARKET ID (CLAUDE.md). The symbol is for reading. */
  readonly marketId: number;
  readonly symbol: string;
  /**
   * The venue's handle for the position, `lp` on the wire.
   *
   * `undefined` is a REFUSAL, not a default. Isolated margin means an action goes
   * to one position, and there is nothing to fall back on: no account-level
   * top-up, and no way to derive the id from the market, since a market that goes
   * flat and reopens is a new position with a new id.
   */
  readonly positionId: number | undefined;
  /**
   * AUTOMATION ONLY: asked IMMEDIATELY BEFORE THE ONE SEND, after every await
   * of pre-flight. A reason means stop: the kill switch went on (or the rule
   * was switched off) while this action was in flight, and nothing is sent.
   * A person's own tap carries none: the kill switch stops automation, never
   * the person.
   */
  readonly stopCheck?: () => string | undefined;
}

/**
 * One thing to do to one position, in the venue's own integer units.
 *
 * A discriminated union rather than optional fields, so a close cannot carry an
 * amount and an add-margin cannot be missing one.
 */
export type ActionCommand =
  | (CommandBase & {
      readonly kind: 'add-margin';
      /** AUSD micros to ADD. Not the new total. Exact: never through a float. */
      readonly amountCNS: bigint;
    })
  | (CommandBase & {
      readonly kind: 'reduce-position';
      /** Lots to close, in the market's own lot scaling. */
      readonly sizeLNS: bigint;
    })
  | (CommandBase & { readonly kind: 'close-position' });

/** Which number reconciliation watched. */
export type WatchedField =
  /** The position's isolated margin, `c` on the wire. For a top-up. */
  | 'margin'
  /** The position's size in lots. For a reduce or a close. */
  | 'size';

export type ReconciledVerdict = 'applied' | 'not-applied' | 'unknown';

/**
 * What the position itself says happened.
 *
 * THE ONLY EVIDENCE THIS LAYER TRUSTS. Produced by pure functions in
 * `reconcile.ts` from three integers and nothing else, so the judgement can be
 * unit-tested against the exact figures the live runs produced.
 */
export interface Reconciliation {
  readonly verdict: ReconciledVerdict;
  readonly field: WatchedField;
  /** What was asked for. Zero for a close, which asks for "all of it". */
  readonly requested: bigint;
  readonly before: bigint;
  /** `undefined` when the position was gone by the time we looked. */
  readonly after: bigint | undefined;
  /** `after - before`, or undefined when `after` is. */
  readonly delta: bigint | undefined;
  /** A sentence a human can read in a log months from now. */
  readonly detail: string;
}

/**
 * What the venue said, kept strictly separate from what happened.
 *
 * `rejected` IS THE NORMAL SUCCESSFUL PATH FOR A TOP-UP. That sentence is the
 * reason this type is not called `result`.
 */
export interface ReportedStatus {
  readonly status:
    | 'forwarded'
    | 'confirmed'
    /** What a `t: 6` reports while the collateral lands in full. */
    | 'rejected'
    /** No `mt: 24` arrived. Not a failure — see `ActionTimeoutError`. */
    | 'timeout'
    /** The call threw before or instead of reporting. */
    | 'threw';
  readonly reason: string | undefined;
  readonly venueRef: string | undefined;
}

/** Why an action was never sent. */
export type RefusalCode =
  /** The command names an account this executor does not serve. */
  | 'wrong-account'
  /** Another action on this position has not settled. Refused, never queued. */
  | 'already-in-flight'
  /** No `positionId`, so there is nothing to address the action to. */
  | 'no-position-id'
  /** We hold no position on this market, or the set says so. */
  | 'no-position'
  /** The position set cannot be believed, so neither can a before-figure. */
  | 'positions-untrusted'
  /** The price feed is not `connected`, so every price we hold is frozen. */
  | 'feed-down'
  /** The acting venue will not take actions on this market. */
  | 'not-actionable'
  /** The command itself is not sendable — a non-positive amount, say. */
  | 'invalid-command'
  /** The venue has no implementation for this action yet. */
  | 'not-implemented'
  /**
   * The `action_log` row could not be opened, so the send did not happen.
   *
   * The row is written BEFORE the send so an action nobody can account for can
   * be found afterwards; an action with no row would be exactly that action.
   * Refused, and certain: nothing reached the venue.
   */
  | 'not-recorded'
  /** Automation was stopped (kill switch, rule off) between the decision and the send. */
  | 'automation-stopped';

interface OutcomeBase {
  readonly command: ActionCommand;
  readonly at: number;
  /** A sentence for a human. Always present, always specific. */
  readonly detail: string;
}

/**
 * How an attempt ended.
 *
 * FOUR VARIANTS, and the split between the last two is load-bearing: `refused`
 * means WE NEVER SENT IT, so nothing happened and we are certain; `not-applied`
 * means we sent it, looked, and the position did not move. Both are "nothing
 * happened", and they are different facts about someone's money — one is a
 * decision we made, the other is something the venue did.
 */
export type ActionOutcome =
  /** Reconciled against the position, and the change is there. */
  | (OutcomeBase & {
      readonly kind: 'applied';
      readonly reported: ReportedStatus;
      readonly reconciliation: Reconciliation;
    })
  /** Reconciled, and the position did not change. */
  | (OutcomeBase & {
      readonly kind: 'not-applied';
      readonly reported: ReportedStatus;
      readonly reconciliation: Reconciliation;
    })
  /**
   * Sent, and reconciliation could not settle it.
   *
   * `nextStep` is mandatory. An unknown outcome that does not say what to do
   * about it is a dead end, and the one thing a reader must not conclude is
   * "so try again".
   */
  | (OutcomeBase & {
      readonly kind: 'unknown';
      readonly reported: ReportedStatus;
      readonly reconciliation: Reconciliation | undefined;
      readonly nextStep: string;
    })
  /** Never sent. `reported` is absent because there was nothing to report. */
  | (OutcomeBase & { readonly kind: 'refused'; readonly code: RefusalCode });

export type ActionOutcomeKind = ActionOutcome['kind'];

/** Whether an outcome means a trader's position actually moved. */
export function didApply(outcome: ActionOutcome): boolean {
  return outcome.kind === 'applied';
}

/**
 * Whether an outcome leaves the position's true state unresolved.
 *
 * Only `unknown`. `refused` is certain — we did not send — and that certainty is
 * why the two are separate variants.
 */
export function needsHumanEyes(outcome: ActionOutcome): boolean {
  return outcome.kind === 'unknown';
}

// ── ports ───────────────────────────────────────────────────────────────────

/**
 * The position fields reconciliation compares, and nothing else.
 *
 * Deliberately not `VenuePosition`: that carries human `number` margins and
 * sizes, and this layer compares money in exact integers. The conversion happens
 * once, in the adapter that implements {@link PositionReader}.
 */
export interface ReconcilablePosition {
  readonly marketId: number;
  readonly symbol: string;
  readonly positionId: number | undefined;
  readonly side: Side;
  /** Isolated margin, `c` on the wire, in AUSD micros. */
  readonly marginCNS: bigint;
  /** Size in lots, in the market's own lot scaling. */
  readonly sizeLNS: bigint;
}

/**
 * Where the before- and after-state come from.
 *
 * `status()` IS NOT OPTIONAL, for the same reason it is not optional on the risk
 * loop's `PositionSource`: a frozen position set looks exactly like a live one,
 * and reconciling an action against a set we cannot believe would produce a
 * confident verdict from stale integers. An action reconciled against a frozen
 * "after" is the worst output this layer could produce — it would report
 * `not-applied` for a top-up that landed.
 */
export interface PositionReader {
  read(marketId: number): ReconcilablePosition | undefined;
  status(): PositionSourceStatus;
  /** Fires when the set changes, so a wait can be event-driven, not a poll. */
  onChange(listener: () => void): Unsubscribe;
}

/**
 * The slice of the acting venue this layer uses.
 *
 * A narrow structural port, satisfied by `PerplVenue`, so the tests can supply a
 * fake without a socket. The layer stays venue-agnostic: it names no message
 * type, no `rq` and no order type.
 */
export interface ActingVenue {
  readonly network: { readonly name: NetworkName };
  getActionAvailability(symbol: string): Promise<import('@perpguard/shared').ActionAvailability>;
  feedStatus(): FeedHealth;
  addMargin(request: import('@perpguard/shared').AddMarginRequest): Promise<
    import('@perpguard/shared').ActionResult
  >;
  reducePosition(request: import('@perpguard/shared').ReducePositionRequest): Promise<
    import('@perpguard/shared').ActionResult
  >;
  closePosition(request: import('@perpguard/shared').ClosePositionRequest): Promise<
    import('@perpguard/shared').ActionResult
  >;
}

/**
 * The price gate, asked per market.
 *
 * Takes the encoded rule from `MarketFeed.canAct` rather than re-deriving it:
 * acting is refused when the FEED is not connected, never because a price is
 * merely old. A quiet market is the venue's current truth. (CLAUDE.md.)
 */
export interface PriceGateSource {
  canAct(marketId: number): PriceGate;
}

/**
 * The `action_log` row as it is opened, BEFORE anything is sent.
 *
 * Written first on purpose. A row that only appears after the venue answers is a
 * row that does not exist for the one action nobody can account for — the one
 * where the process died between send and answer, which is precisely the action
 * a human needs to find.
 */
export interface ActionLogRow {
  readonly idempotencyKey: string;
  readonly userId: string;
  /** The account acted on. Absent only for rows written before accounts existed. */
  readonly accountId?: number;
  readonly kind: ActionKind;
  readonly marketId: number;
  readonly symbol: string;
  readonly positionId: number | undefined;
  readonly network: NetworkName;
  readonly field: WatchedField;
  /** What was asked for, in the units of `field`. */
  readonly requested: bigint;
  /** The figure the outcome will be judged against. */
  readonly before: bigint;
  readonly openedAtMs: number;
}

/** The same row, completed once the position has been looked at again. */
export interface ActionLogSettlement {
  readonly idempotencyKey: string;
  readonly outcome: ActionOutcomeKind;
  /** Verbatim, including the `st: 7 Failed` that means it worked. */
  readonly reportedStatus: string | undefined;
  readonly reportedReason: string | undefined;
  readonly venueRef: string | undefined;
  readonly after: bigint | undefined;
  readonly detail: string;
  readonly settledAtMs: number;
}

/**
 * Where actions are recorded.
 *
 * TWO CALLS, NOT ONE. `open` before the send and `settle` after the
 * reconciliation, because the interesting row is the one that never gets its
 * settlement.
 */
export interface ActionLog {
  open(row: ActionLogRow): Promise<void>;
  settle(settlement: ActionLogSettlement): Promise<void>;
}
