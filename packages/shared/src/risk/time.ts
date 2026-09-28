/**
 * How long a position has, at the rate the market has actually been moving.
 *
 * Pure, and it does not read a clock: the caller supplies both the mark price
 * and the observed rate of movement, and gets back a duration, not a deadline.
 */
import { positionMetrics } from './metrics.ts';
import type { MarketRiskConfig, RiskPosition } from './position.ts';
import { sideSign } from '../venues/types.ts';

/**
 * The rate the mark has been moving, measured by the caller over whatever
 * window it thinks is representative.
 *
 * In the market's OWN price units per hour, so it needs no scaling here and
 * cannot be mixed up between markets with different `priceDecimals`.
 */
export interface ObservedVolatility {
  readonly pricePnsPerHour: bigint;
}

/**
 * Hours until the mark reaches the liquidation price, if it keeps moving the
 * wrong way at the observed rate.
 *
 * Returns null when the answer is not knowable rather than infinity:
 *   - the market has not moved at all, or no rate was observed
 *   - the position has no size, so it has no liquidation price
 * Returns 0 when the position is already at or past liquidation.
 *
 * This is an extrapolation of one observed rate in one direction, not a
 * forecast. It says "at this speed, this long" and nothing more.
 */
export function timeToLiquidation(
  position: RiskPosition,
  markPricePNS: bigint,
  volatility: ObservedVolatility | undefined,
  config: MarketRiskConfig,
): number | null {
  if (!volatility || volatility.pricePnsPerHour <= 0n) return null;

  const { liquidationPricePNS } = positionMetrics(position, markPricePNS, config);
  if (liquidationPricePNS === undefined) return null;

  // Signed distance in the direction this position is in danger from: a long
  // dies as the price falls, a short as it rises.
  const distancePNS = BigInt(sideSign(position.side)) * (markPricePNS - liquidationPricePNS);
  if (distancePNS <= 0n) return 0;

  // FLOAT BOUNDARY. Both operands are prices in their own units, far inside the
  // safe-integer range, and the result is a duration for display.
  return Number(distancePNS) / Number(volatility.pricePnsPerHour);
}
