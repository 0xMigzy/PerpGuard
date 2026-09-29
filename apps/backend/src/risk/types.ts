/**
 * Ports and event shapes for the risk loop.
 *
 * The loop does the I/O. Everything it decides comes from the pure risk engine
 * in `@perpguard/shared/risk` and the pure state machine in `./state.ts`.
 */
import type {
  FeedConnectionState,
  MarketRiskConfig,
  PositionMetrics,
  PositionSourceState,
  PositionSourceStatus,
  Side,
  Unsubscribe,
  VenuePosition,
} from '@perpguard/shared';

/**
 * Risk severity for one position.
 *
 * `FEED_DOWN` and `POSITIONS_UNTRUSTED` are not severities — they are the
 * absence of one. Each means we cannot see, and a monitor that cannot see must
 * never look healthy.
 *
 * They are two states rather than one because they have different causes and
 * different fixes, and a message must be able to name the right one. "The price
 * feed is down" when in truth the account socket died is a false explanation,
 * which in a risk tool is its own kind of lie.
 *
 * `POSITIONS_UNTRUSTED`, not `POSITIONS_STALE`, on purpose. In this codebase
 * "stale" is the BENIGN word: a stale price is a quiet market and is perfectly
 * safe to act on. Nothing about an untrustworthy position set is benign, so it
 * does not borrow the word that means "fine, just old".
 */
export type RiskState =
  | 'SAFE'
  | 'WATCH'
  | 'DANGER'
  | 'PAST_LIQUIDATION'
  | 'FEED_DOWN'
  | 'POSITIONS_UNTRUSTED';

/** The states that mean "we cannot see", as opposed to a real severity. */
export type BlindState = 'FEED_DOWN' | 'POSITIONS_UNTRUSTED';

/** A real severity: something we actually assessed. */
export type Severity = Exclude<RiskState, BlindState>;

export function isBlind(state: RiskState): state is BlindState {
  return state === 'FEED_DOWN' || state === 'POSITIONS_UNTRUSTED';
}

/** Ordering of the real severities. The blind states sit outside this ladder. */
export const SEVERITY: Readonly<Record<Severity, number>> = {
  SAFE: 0,
  WATCH: 1,
  DANGER: 2,
  PAST_LIQUIDATION: 3,
};

/**
 * Where the state boundaries sit, and how hard it is to come back down.
 *
 * Enter and exit differ on purpose. A position sitting exactly on 3% would
 * otherwise flip between WATCH and DANGER on every tick, and an alert stream
 * that cries wolf every few seconds is worse than no alerts at all: people
 * learn to ignore it, and then the one that mattered is ignored too.
 *
 * The asymmetry runs one way only. ESCALATION IS NEVER GATED — not by the exit
 * threshold, not by dwell time. Only calming down is slowed. A warning is never
 * delayed; an all-clear is.
 */
export interface RiskThresholds {
  /** Fall below this buffer to enter WATCH. */
  readonly watchEnterPct: number;
  /** Rise above this buffer to return to SAFE. */
  readonly watchExitPct: number;
  /** Fall below this buffer to enter DANGER. */
  readonly dangerEnterPct: number;
  /** Rise above this buffer to leave DANGER. */
  readonly dangerExitPct: number;
  /** How long a state must hold before it is allowed to soften. */
  readonly minDwellMs: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = {
  watchEnterPct: 0.08,
  watchExitPct: 0.09,
  dangerEnterPct: 0.03,
  dangerExitPct: 0.04,
  minDwellMs: 60_000,
};

/**
 * One of the two top-ups PerpGuard offers, with where it lands.
 *
 * The projection travels WITH the amount on purpose. The alerts layer formats
 * this and nothing else — it must never add margin to a position and recompute a
 * liquidation price to put in a message, because then two code paths would be
 * deriving the number a trader acts on and they would eventually disagree.
 *
 * `amountCNS` is ZERO when the position already has that much room, which is the
 * signal to OMIT the option rather than to offer "add 0". A position at an 8%
 * buffer has nothing to gain from the clear-danger option.
 */
export interface TopUpOption {
  /** Extra collateral needed, in AUSD micros. Zero when already there. */
  readonly amountCNS: bigint;
  /** The buffer this option aims at, so a message can name it. */
  readonly targetBufferPct: number;
  /** Buffer after adding exactly `amountCNS`. Undefined for a zero-lot position. */
  readonly resultingBufferPct: number | undefined;
  /** Liquidation price after adding exactly `amountCNS`. */
  readonly resultingLiquidationPricePNS: bigint | undefined;
}

/**
 * The two top-ups, cheap first.
 *
 * `clearDanger` reaches `dangerExitPct` and NOTHING MORE. It is never the safe
 * option, and no message may describe it as one: it buys exactly enough room to
 * leave the danger band. `toSafe` reaches `watchExitPct`, the buffer at which a
 * position is allowed back to SAFE.
 *
 * Both are offered together so the trader chooses with the real trade-off in
 * front of them rather than being handed one number and told to trust it.
 */
export interface TopUpOptions {
  readonly clearDanger: TopUpOption;
  readonly toSafe: TopUpOption;
}

/**
 * One position's risk, with every number the alerts layer could want attached
 * so that nothing downstream recomputes anything.
 */
export interface RiskAssessment {
  readonly marketId: number;
  readonly symbol: string;
  /**
   * Long or short.
   *
   * Carried so a message can NAME WHICH POSITION IT IS ABOUT. A trader holding
   * both sides of the same market has two positions with the same symbol and
   * opposite exposure, and an alert that says only "BTC" tells them nothing about
   * which one is in trouble — or worse, sends them to add margin to the one that
   * is fine.
   *
   * Undefined only while blind on a position we never assessed, where there is no
   * side to report and inventing one would be the single worst thing this product
   * can do (see the two side encodings in CLAUDE.md).
   */
  readonly side: Side | undefined;
  /**
   * The venue's handle for this position, for addressing an action to it.
   * Undefined when the source did not publish one. See `VenuePosition.positionId`.
   */
  readonly positionId: number | undefined;
  readonly state: RiskState;
  /** Undefined on the very first assessment of a position. */
  readonly previousState: RiskState | undefined;
  /**
   * The severity this position held before the feed went down, kept so the UI
   * can show the last thing we knew instead of a blank.
   */
  readonly lastKnownState: RiskState | undefined;

  readonly liqBufferPct: number | undefined;
  readonly liquidationPricePNS: bigint | undefined;
  readonly markPricePNS: bigint;
  /**
   * The two top-ups to offer, each with the liquidation price it buys.
   *
   * Undefined when there is nothing to project: a blind assessment, which has no
   * trustworthy price or position behind it, or a zero-lot position, which has no
   * liquidation price to move.
   */
  readonly topUp: TopUpOptions | undefined;
  /** Collateral needed just to stop being liquidatable. */
  readonly marginToSurviveCNS: bigint;
  readonly metrics: PositionMetrics;

  readonly feed: FeedConnectionState;
  /**
   * Health of the POSITION set this assessment was made over, asked separately
   * from the price feed. `live` means the set is the truth; anything else means
   * the position may not even still be open.
   */
  readonly positions: PositionSourceState;
  /** How old the position set is. Undefined before anything has arrived. */
  readonly positionsAgeMs: number | undefined;
  /** Undefined when the feed has never sent a price for this market. */
  readonly priceAgeMs: number | undefined;
  /** Age exceeds STALE_MS. A quiet market, not a broken one. */
  readonly priceIsOld: boolean;
  /**
   * THIS FLAG IS A CONTRACT, NOT A DIAGNOSTIC.
   *
   * True when this assessment rests on a price older than STALE_MS. While it is
   * true the severity is being HELD: it was not derived from fresh data, and the
   * real market may have moved since.
   *
   * The alerts layer MUST NOT send a reassuring message while this is true. No
   * "recovered", no "you're safe now", no all-clear of any kind. A position may
   * hold its severity on an old price; it may never be softened by one.
   */
  readonly heldOnStalePrice: boolean;
  /** Human-readable account of why the state is what it is. */
  readonly reason: string;
  readonly atMs: number;
}

/** Emitted only when `state` changes. */
export interface RiskChange {
  readonly assessment: RiskAssessment;
  readonly previousState: RiskState | undefined;
}

/**
 * Where open positions come from.
 *
 * A port rather than the venue itself: the loop must not name a venue — the risk
 * engine, bot and web all speak to interfaces, never to Perpl directly.
 *
 * `status()` IS REQUIRED, not optional. The set of open positions can be frozen
 * or incomplete with nothing about the set itself revealing it, so the loop has
 * to ask. An optional health question is one every caller forgets, and forgetting
 * it would silently mean "assume the set is fine" — which is exactly the
 * assumption that turns a dead socket into a confident all-clear.
 */
export interface PositionSource {
  snapshot(): readonly VenuePosition[];
  onSnapshot(listener: (positions: readonly VenuePosition[]) => void): Unsubscribe;
  /** Whether the set above reflects reality. See `positionsAreUsable`. */
  status(): PositionSourceStatus;
}

/** Market configs the risk engine needs, keyed by market id. */
export type MarketConfigs = ReadonlyMap<number, MarketRiskConfig>;
