/**
 * Stress tests: what happens to a book of positions under a price shock.
 *
 * Pure. Current mark prices and market configs are passed in; nothing here
 * fetches a price.
 *
 * Funding scenarios are deliberately absent. `GET /v1/pub/context` reports
 * `funding: { rate, div }` while the chain event calls the same idea
 * `ratePct100k`. RECONCILED 6 Oct 2026: the chain's value is the rate as a
 * fraction × 100,000 (measured against positions' payments; see
 * `toRatePct`), and the API's `rate` is 10× it. The funding scenario still
 * ships separately; this module does not price funding.
 */
import { numberToScaled } from '../units.ts';
import { positionMetrics, type PositionMetrics } from './metrics.ts';
import type { MarketRiskConfig, RiskPosition } from './position.ts';

const FRACTION_DECIMALS = 9;
const FRACTION_SCALE = 10n ** BigInt(FRACTION_DECIMALS);

export type StressScenario =
  /** One market moves; everything else holds still. */
  | { readonly kind: 'market'; readonly marketId: number; readonly priceMoveFraction: number }
  /** Every market moves together. */
  | { readonly kind: 'all'; readonly priceMoveFraction: number };

export interface StressOutcome {
  readonly position: RiskPosition;
  readonly markPricePNS: bigint;
  readonly shockedMarkPricePNS: bigint;
  readonly survives: boolean;
  /**
   * Margin consumed if the shock liquidates the position: the deposit less what
   * is left standing behind it when equity reaches maintenance margin.
   *
   * A FLOOR, not the final bill. It is before liquidation fees and before the
   * residual is split 80/10/10 between trader, protocol and insurance fund, so
   * the real loss is larger. Zero for a position that survives, because a stress
   * test that survives realises nothing.
   */
  readonly marginLostCNS: bigint;
  readonly metrics: PositionMetrics;
}

export interface StressResult {
  readonly scenario: StressScenario;
  readonly perPosition: readonly StressOutcome[];
  readonly liquidatedCount: number;
  readonly survivedCount: number;
  readonly totalMarginLostCNS: bigint;
  readonly totalUnrealisedPnlCNS: bigint;
}

/**
 * Apply a fractional move to a price: -0.2 is a 20% fall.
 *
 * FLOAT BOUNDARY: the caller's fraction is rounded to 9 decimal places once,
 * here. A price can be shocked to zero but never below it.
 */
export function shockPricePNS(markPricePNS: bigint, priceMoveFraction: number): bigint {
  if (!Number.isFinite(priceMoveFraction)) {
    throw new RangeError(`priceMoveFraction must be finite, got ${priceMoveFraction}`);
  }
  const moved =
    markPricePNS +
    (markPricePNS * numberToScaled(priceMoveFraction, FRACTION_DECIMALS)) / FRACTION_SCALE;
  return moved > 0n ? moved : 0n;
}

const movesFor = (scenario: StressScenario, marketId: number): number =>
  scenario.kind === 'all' || scenario.marketId === marketId ? scenario.priceMoveFraction : 0;

export function stressTest(
  positions: readonly RiskPosition[],
  scenario: StressScenario,
  markPrices: ReadonlyMap<number, bigint>,
  configs: ReadonlyMap<number, MarketRiskConfig>,
): StressResult {
  const perPosition: StressOutcome[] = [];
  let totalMarginLostCNS = 0n;
  let totalUnrealisedPnlCNS = 0n;

  for (const position of positions) {
    const config = configs.get(position.marketId);
    const markPricePNS = markPrices.get(position.marketId);
    if (!config || markPricePNS === undefined) {
      throw new RangeError(
        `no ${config ? 'mark price' : 'market config'} supplied for market ${position.marketId}`,
      );
    }
    const shockedMarkPricePNS = shockPricePNS(
      markPricePNS,
      movesFor(scenario, position.marketId),
    );
    const metrics = positionMetrics(position, shockedMarkPricePNS, config);
    const survives = !metrics.isLiquidatable;
    const consumed = position.depositCNS - metrics.maintenanceMarginCNS;
    const marginLostCNS = survives ? 0n : consumed > 0n ? consumed : 0n;

    perPosition.push({
      position,
      markPricePNS,
      shockedMarkPricePNS,
      survives,
      marginLostCNS,
      metrics,
    });
    totalMarginLostCNS += marginLostCNS;
    totalUnrealisedPnlCNS += metrics.unrealisedPnlCNS;
  }

  return {
    scenario,
    perPosition,
    liquidatedCount: perPosition.filter((o) => !o.survives).length,
    survivedCount: perPosition.filter((o) => o.survives).length,
    totalMarginLostCNS,
    totalUnrealisedPnlCNS,
  };
}
