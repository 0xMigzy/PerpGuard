/**
 * Isolated-margin liquidation maths.
 *
 * Every function here is pure and works in exact integers. No I/O, no floats:
 * these numbers decide whether we warn a trader, so they must not drift.
 *
 * Formulas are taken verbatim from
 * https://docs.perpl.xyz/exchange/liquidation.md
 *
 *   C_MMR = (P_Entry * L) / C_MMF
 *   P_Liq = P_Entry + s * (C_MMR - C_Deposit - C_Funding) / L      s = +1 long, -1 short
 *
 * Perpl uses ISOLATED margin, so `C_Deposit` is the collateral posted to THIS
 * position. Free account balance never enters any formula below — that is the
 * whole reason PerpGuard exists.
 *
 * Suffixes follow the contract's own naming:
 *   PNS = price, scaled by the market's `priceDecimals`
 *   LNS = lots,  scaled by the market's `lotDecimals`
 *   CNS = collateral (AUSD), scaled by `collateralDecimals`
 * None of those exponents may be hard-coded; they are read from the market.
 */

import { numberToScaled } from '../units.ts';
import { type Side, sideSign } from '../venues/types.ts';

/** The three scaling exponents a market's raw integers are expressed in. */
export interface MarketScale {
  readonly priceDecimals: number;
  readonly lotDecimals: number;
  readonly collateralDecimals: number;
}

/**
 * Sides are the venue-agnostic `Side` the rest of the codebase already uses, so
 * there is exactly one long/short vocabulary and one `sideSign`.
 */
export type { Side } from '../venues/types.ts';

function assertScale(scale: MarketScale): void {
  for (const [name, value] of [
    ['priceDecimals', scale.priceDecimals],
    ['lotDecimals', scale.lotDecimals],
    ['collateralDecimals', scale.collateralDecimals],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 30) {
      throw new RangeError(`${name} must be an integer in 0..30, got ${value}`);
    }
  }
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** The `s` of the docs' formula, as a bigint for the integer maths below. */
function s(side: Side): bigint {
  return BigInt(sideSign(side));
}

/**
 * price * size, expressed in collateral units.
 *
 * Truncates toward zero, so a notional is accurate to one collateral micro.
 * That is 0.000001 AUSD and never changes a decision.
 */
export function notionalCNS(pricePNS: bigint, lotLNS: bigint, scale: MarketScale): bigint {
  assertScale(scale);
  return (
    (pricePNS * lotLNS * pow10(scale.collateralDecimals)) /
    pow10(scale.priceDecimals + scale.lotDecimals)
  );
}

/**
 * Unrealized PnL at `markPricePNS`. Positive is profit, for either side.
 *
 *   uPnl = s * L * (P_Mark - P_Entry)
 */
export function unrealizedPnlCNS(
  side: Side,
  lotLNS: bigint,
  entryPricePNS: bigint,
  markPricePNS: bigint,
  scale: MarketScale,
): bigint {
  return s(side) * notionalCNS(markPricePNS - entryPricePNS, lotLNS, scale);
}

/**
 * The position's maintenance margin requirement.
 *
 *   C_MMR = (P_Entry * L) / C_MMF
 *
 * `maintMarginFracHdths` is the contract's `maintMarginFracHdths`: hundredths of
 * a leverage multiple. 2500 means 25x, i.e. a maintenance margin ratio of
 * 100/2500 = 0.04. Note the notional uses the ENTRY price, not the mark.
 */
export function maintenanceMarginCNS(
  entryPricePNS: bigint,
  lotLNS: bigint,
  maintMarginFracHdths: bigint,
  scale: MarketScale,
): bigint {
  if (maintMarginFracHdths <= 0n) {
    throw new RangeError(`maintMarginFracHdths must be positive, got ${maintMarginFracHdths}`);
  }
  return (notionalCNS(entryPricePNS, lotLNS, scale) * 100n) / maintMarginFracHdths;
}

/** Everything one isolated position needs for the maths below. */
export interface IsolatedPosition {
  readonly side: Side;
  readonly lotLNS: bigint;
  readonly entryPricePNS: bigint;
  /** Collateral posted to THIS position. */
  readonly depositCNS: bigint;
  /**
   * `C_Funding` of the docs' formula, subtracted from the deposit.
   *
   * The indexer passes 0n: the contract settles funding into the position on
   * each funding event, and does not publish a per-position accrual between
   * them, so there is nothing to carry. Callers that do know an outstanding
   * amount pass it with the docs' own sign convention.
   */
  readonly fundingCNS: bigint;
  readonly maintMarginFracHdths: bigint;
}

/**
 * The mark price at which this position is liquidated.
 *
 *   P_Liq = P_Entry + s * (C_MMR - C_Deposit - C_Funding) / L
 *
 * Returns undefined for a zero-lot position, which has no liquidation price.
 */
export function liquidationPricePNS(
  position: IsolatedPosition,
  scale: MarketScale,
): bigint | undefined {
  assertScale(scale);
  if (position.lotLNS === 0n) return undefined;
  const mmrCNS = maintenanceMarginCNS(
    position.entryPricePNS,
    position.lotLNS,
    position.maintMarginFracHdths,
    scale,
  );
  const shortfallCNS = mmrCNS - position.depositCNS - position.fundingCNS;
  // Invert notionalCNS: collateral per lot back into a price delta.
  const deltaPNS =
    (shortfallCNS * pow10(scale.priceDecimals + scale.lotDecimals)) /
    (position.lotLNS * pow10(scale.collateralDecimals));
  return position.entryPricePNS + s(position.side) * deltaPNS;
}

/** Scale used to carry a caller-supplied fraction into integer maths. */
const FRACTION_DECIMALS = 9;

/**
 * The mark price a position would have to be liquidated at for its liquidation
 * price to sit `bufferFraction` away from the CURRENT mark.
 *
 *   P_target = P_Mark * (1 - s * b)
 *
 * so a long's target sits below the mark and a short's above it, which is the
 * direction each one is in danger from.
 */
function targetLiquidationPricePNS(
  markPricePNS: bigint,
  side: Side,
  bufferFraction: number,
): bigint {
  if (!Number.isFinite(bufferFraction) || bufferFraction < 0) {
    throw new RangeError(`bufferFraction must be a non-negative number, got ${bufferFraction}`);
  }
  // FLOAT BOUNDARY: the caller's fraction is rounded to 9 decimal places once,
  // here, and everything after it is integer.
  const scaled = numberToScaled(bufferFraction, FRACTION_DECIMALS);
  const offsetPNS = (markPricePNS * scaled) / pow10(FRACTION_DECIMALS);
  return markPricePNS - s(side) * offsetPNS;
}

/**
 * The extra collateral this position needs for its liquidation price to sit
 * `bufferFraction` away from `markPricePNS`. Zero when it is already there.
 *
 *   X = C_MMR - C_Funding - C_Deposit - s * L * (P_target - P_Entry)
 *
 * At `bufferFraction` 0 the target is the mark itself and this collapses to
 *
 *   X = C_MMR - uPnl - C_Funding - C_Deposit
 *
 * which is `marginToSurviveCNS` below. That is the number behind the claim that
 * a liquidation was avoidable; a non-zero buffer is what the rescue button uses,
 * because surviving *at* the threshold is not surviving for long.
 */
export function marginToReachBufferCNS(
  position: IsolatedPosition,
  markPricePNS: bigint,
  bufferFraction: number,
  scale: MarketScale,
): bigint {
  if (position.lotLNS === 0n) return 0n;
  const mmrCNS = maintenanceMarginCNS(
    position.entryPricePNS,
    position.lotLNS,
    position.maintMarginFracHdths,
    scale,
  );
  const targetPNS = targetLiquidationPricePNS(markPricePNS, position.side, bufferFraction);
  const gapCNS =
    s(position.side) * notionalCNS(targetPNS - position.entryPricePNS, position.lotLNS, scale);
  const needed = mmrCNS - position.fundingCNS - position.depositCNS - gapCNS;
  return needed > 0n ? needed : 0n;
}

/**
 * The extra collateral that would have to be added to THIS position for it to
 * sit exactly at its maintenance margin at `markPricePNS`. Zero when the
 * position is already above maintenance.
 *
 * It is a floor, not a cushion: adding exactly this much leaves the position AT
 * the liquidation threshold, so a caller offering the trader a survivable top-up
 * wants `marginToReachBufferCNS` with a real buffer instead.
 */
export function marginToSurviveCNS(
  position: IsolatedPosition,
  markPricePNS: bigint,
  scale: MarketScale,
): bigint {
  return marginToReachBufferCNS(position, markPricePNS, 0, scale);
}
