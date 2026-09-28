/**
 * Position metrics and the projections behind PerpGuard's action buttons.
 *
 * Pure. No I/O, no network, no clock. Every input is passed in, including the
 * mark price and the market config — nothing here reaches for a price.
 *
 * Money is integer AUSD micros throughout. Three returned values are `number`
 * because they are ratios with no integer form; each is marked FLOAT BOUNDARY
 * where it is computed.
 */
import {
  liquidationPricePNS,
  maintenanceMarginCNS,
  marginToReachBufferCNS,
  notionalCNS,
  unrealizedPnlCNS,
  type IsolatedPosition,
} from './liquidation.ts';
import { sideSign } from '../venues/types.ts';
import {
  maintMarginFracHdths,
  maintenanceMarginRatio,
  scaleOf,
  type MarketRiskConfig,
  type RiskPosition,
} from './position.ts';
import { numberToScaled } from '../units.ts';

const FRACTION_DECIMALS = 9;
const FRACTION_SCALE = 10n ** BigInt(FRACTION_DECIMALS);

/** The shape `liquidation.ts` works on, built from a RiskPosition. */
export function toIsolated(
  position: RiskPosition,
  config: MarketRiskConfig,
): IsolatedPosition {
  return {
    side: position.side,
    lotLNS: position.lotLNS,
    entryPricePNS: position.entryPricePNS,
    depositCNS: position.depositCNS,
    fundingCNS: position.fundingCNS,
    maintMarginFracHdths: maintMarginFracHdths(config),
  };
}

export interface PositionMetrics {
  /** Position value at the mark. */
  readonly notionalCNS: bigint;
  /** Position value at the entry price, which is what maintenance margin uses. */
  readonly entryNotionalCNS: bigint;
  readonly unrealisedPnlCNS: bigint;
  readonly maintenanceMarginCNS: bigint;
  /** Maintenance margin as a fraction of notional. FLOAT BOUNDARY, display only. */
  readonly maintenanceMarginRatio: number;
  /** Margin plus unrealised PnL less funding: what actually stands behind the position. */
  readonly equityCNS: bigint;
  /** Undefined for a zero-lot position, which has no liquidation price. */
  readonly liquidationPricePNS: bigint | undefined;
  /**
   * How far the mark is from the liquidation price, as a fraction of the mark.
   *
   * SIGNED, and undefined for a zero-lot position. The fixture's own formula is
   * `abs(markPrice - liqPrice) / markPrice`, and for any position that has not
   * already passed its liquidation price this returns exactly that. The sign is
   * the difference: a position already past its liquidation price reports a
   * NEGATIVE buffer rather than an absolute value that looks like room it does
   * not have. That is the position a kill switch has to order first.
   *
   * NOTE, deliberately unresolved: whether the venue divides by the mark or by
   * the entry price is still an open question on fixtures/position1.json, where
   * mark and entry differ by only 0.026% and the two denominators are 7e-6
   * apart — 70x inside the fixture's own tolerance, so it cannot be settled from
   * that position. A second ground-truth position on a non-BTC market is being
   * captured to decide it. Until then this uses the mark, per the fixture's
   * stated formula.
   *
   * FLOAT BOUNDARY.
   */
  readonly liqBufferPct: number | undefined;
  /**
   * Unrealised PnL as a fraction of posted margin. FLOAT BOUNDARY.
   * Undefined when no margin is posted, rather than dividing by zero.
   */
  readonly pnlPctOfMargin: number | undefined;
  /** True when equity has fallen to or below maintenance margin. */
  readonly isLiquidatable: boolean;
  /** Collateral needed right now to climb back to the maintenance threshold. */
  readonly marginToSurviveCNS: bigint;
}

export function positionMetrics(
  position: RiskPosition,
  markPricePNS: bigint,
  config: MarketRiskConfig,
): PositionMetrics {
  const scale = scaleOf(config);
  const isolated = toIsolated(position, config);

  const notional = notionalCNS(markPricePNS, position.lotLNS, scale);
  const entryNotional = notionalCNS(position.entryPricePNS, position.lotLNS, scale);
  const uPnl = unrealizedPnlCNS(
    position.side,
    position.lotLNS,
    position.entryPricePNS,
    markPricePNS,
    scale,
  );
  const mmr =
    position.lotLNS === 0n
      ? 0n
      : maintenanceMarginCNS(
          position.entryPricePNS,
          position.lotLNS,
          maintMarginFracHdths(config),
          scale,
        );
  const liq = liquidationPricePNS(isolated, scale);

  // FLOAT BOUNDARY. Prices are small integers in their own units, so neither
  // side of these divisions comes near the safe-integer limit.
  const liqBufferPct =
    liq === undefined || markPricePNS === 0n
      ? undefined
      : (Number(sideSign(position.side)) * Number(markPricePNS - liq)) / Number(markPricePNS);
  const pnlPctOfMargin =
    position.depositCNS === 0n ? undefined : Number(uPnl) / Number(position.depositCNS);

  const survive = marginToReachBufferCNS(isolated, markPricePNS, 0, scale);

  return {
    notionalCNS: notional,
    entryNotionalCNS: entryNotional,
    unrealisedPnlCNS: uPnl,
    maintenanceMarginCNS: mmr,
    maintenanceMarginRatio: maintenanceMarginRatio(config),
    equityCNS: position.depositCNS + uPnl - position.fundingCNS,
    liquidationPricePNS: liq,
    liqBufferPct,
    pnlPctOfMargin,
    isLiquidatable: survive > 0n,
    marginToSurviveCNS: survive,
  };
}

/**
 * How much AUSD to add for the liquidation price to sit `targetBufferPct` away
 * from the mark. This is the number the rescue button shows: "add 1,400".
 *
 * Zero when the position already has that much room.
 */
export function marginToReachBuffer(
  position: RiskPosition,
  markPricePNS: bigint,
  targetBufferPct: number,
  config: MarketRiskConfig,
): bigint {
  return marginToReachBufferCNS(
    toIsolated(position, config),
    markPricePNS,
    targetBufferPct,
    scaleOf(config),
  );
}

export interface PositionProjection {
  readonly position: RiskPosition;
  readonly metrics: PositionMetrics;
  /** PnL the action itself realises. Zero when only margin moves. */
  readonly realisedPnlCNS: bigint;
  /** Margin the action returns to free balance. Zero unless margin is released. */
  readonly marginReleasedCNS: bigint;
}

/**
 * Where the position lands if `amountCNS` of margin is added now.
 *
 * Adding margin is the ONLY action that buys room without changing exposure:
 * size and entry price are untouched, so maintenance margin is untouched, and
 * the whole of the added collateral goes into pushing the liquidation price
 * away. Reducing proportionally does not do this — see the two reduce functions.
 */
export function afterAddMargin(
  position: RiskPosition,
  amountCNS: bigint,
  markPricePNS: bigint,
  config: MarketRiskConfig,
): PositionProjection {
  if (amountCNS < 0n) {
    throw new RangeError(`amountCNS must not be negative, got ${amountCNS}`);
  }
  const next: RiskPosition = { ...position, depositCNS: position.depositCNS + amountCNS };
  return {
    position: next,
    metrics: positionMetrics(next, markPricePNS, config),
    realisedPnlCNS: 0n,
    marginReleasedCNS: 0n,
  };
}

/** Rounds a bigint by a caller-supplied fraction, once, at a fixed precision. */
function scaleByFraction(value: bigint, fraction: number): bigint {
  // FLOAT BOUNDARY: the fraction is rounded to 9 decimal places here and the
  // rest of the arithmetic is integer.
  return (value * numberToScaled(fraction, FRACTION_DECIMALS)) / FRACTION_SCALE;
}

function assertFraction(fraction: number): void {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError(`fraction must be between 0 and 1, got ${fraction}`);
  }
}

/**
 * Reduce the position by `fraction`, releasing margin in proportion.
 *
 * This is what the exchange does on a partial close: size, posted margin and
 * accrued funding all shrink together, and the realised PnL goes to free
 * balance.
 *
 * THE LIQUIDATION PRICE DOES NOT MOVE. Every term in it scales by the same
 * factor, so it cancels exactly. Reducing this way cuts how fast the position
 * loses money; it buys no room at all. Only adding margin, or
 * `afterReduceKeepingMargin`, moves the liquidation price away.
 */
export function afterReduceReleasingMargin(
  position: RiskPosition,
  fraction: number,
  markPricePNS: bigint,
  config: MarketRiskConfig,
): PositionProjection {
  assertFraction(fraction);
  const keep = 1 - fraction;
  const nextLot = scaleByFraction(position.lotLNS, keep);
  const nextDeposit = scaleByFraction(position.depositCNS, keep);
  const next: RiskPosition = {
    ...position,
    lotLNS: nextLot,
    depositCNS: nextDeposit,
    fundingCNS: scaleByFraction(position.fundingCNS, keep),
  };
  const closedLot = position.lotLNS - nextLot;
  const realised =
    sideSign(position.side) === 1
      ? notionalCNS(markPricePNS - position.entryPricePNS, closedLot, scaleOf(config))
      : -notionalCNS(markPricePNS - position.entryPricePNS, closedLot, scaleOf(config));
  return {
    position: next,
    metrics: positionMetrics(next, markPricePNS, config),
    realisedPnlCNS: realised,
    marginReleasedCNS: position.depositCNS - nextDeposit,
  };
}

/**
 * Reduce the position by `fraction` but leave the margin posted.
 *
 * The rescue-shaped reduce: exposure falls while the collateral behind it does
 * not, so the liquidation price moves away. Costs the same realised PnL as
 * `afterReduceReleasingMargin`, and returns nothing to free balance.
 */
export function afterReduceKeepingMargin(
  position: RiskPosition,
  fraction: number,
  markPricePNS: bigint,
  config: MarketRiskConfig,
): PositionProjection {
  assertFraction(fraction);
  const released = afterReduceReleasingMargin(position, fraction, markPricePNS, config);
  const next: RiskPosition = { ...released.position, depositCNS: position.depositCNS };
  return {
    position: next,
    metrics: positionMetrics(next, markPricePNS, config),
    realisedPnlCNS: released.realisedPnlCNS,
    marginReleasedCNS: 0n,
  };
}
