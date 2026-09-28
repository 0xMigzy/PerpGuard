/**
 * Market configs and a seeded generator, shared by the risk tests.
 *
 * The configs are real mainnet values, deliberately spanning very different
 * scalings and maintenance margins, so nothing can pass by accidentally
 * assuming BTC's numbers.
 */
import type { MarketRiskConfig, RiskPosition } from './position.ts';
import { maintenanceMarginCNS, notionalCNS } from './liquidation.ts';
import { maintMarginFracHdths, scaleOf } from './position.ts';
import type { Side } from '../venues/types.ts';

export const MARKETS: readonly MarketRiskConfig[] = [
  // maintenance_margin 2500 -> ratio 0.04
  { marketId: 1, symbol: 'BTC', priceDecimals: 1, lotDecimals: 5, collateralDecimals: 6, maintenanceMargin: 2500, initialMargin: 1500 },
  // 2000 -> 0.05
  { marketId: 20, symbol: 'ETH', priceDecimals: 2, lotDecimals: 3, collateralDecimals: 6, maintenanceMargin: 2000, initialMargin: 1000 },
  { marketId: 10, symbol: 'MON', priceDecimals: 6, lotDecimals: 0, collateralDecimals: 6, maintenanceMargin: 2000, initialMargin: 1000 },
  // 1800 -> 0.0556
  { marketId: 50, symbol: 'ZEC', priceDecimals: 2, lotDecimals: 4, collateralDecimals: 6, maintenanceMargin: 1800, initialMargin: 1000 },
  // 1000 -> 0.10
  { marketId: 90, symbol: 'PUMP', priceDecimals: 6, lotDecimals: 0, collateralDecimals: 6, maintenanceMargin: 1000, initialMargin: 1000 },
];

export const marketById = (id: number): MarketRiskConfig => {
  const found = MARKETS.find((m) => m.marketId === id);
  if (!found) throw new Error(`no test market ${id}`);
  return found;
};

/** Deterministic PRNG. Seeded so a failure is always reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratedCase {
  readonly position: RiskPosition;
  readonly config: MarketRiskConfig;
  readonly markPricePNS: bigint;
}

/**
 * A position that could actually exist: margin at or above the maintenance
 * requirement, which is true of anything legally opened, since every market's
 * initial margin requirement exceeds its maintenance one.
 */
export function generateCase(rand: () => number): GeneratedCase {
  const config = MARKETS[Math.floor(rand() * MARKETS.length)]!;
  const side: Side = rand() < 0.5 ? 'long' : 'short';
  const scale = scaleOf(config);

  // Entry between 1 and 1,000,000 in the market's own price units.
  const entryPricePNS = BigInt(1 + Math.floor(rand() * 1_000_000));
  const lotLNS = BigInt(1 + Math.floor(rand() * 500_000));

  const mmr = maintenanceMarginCNS(entryPricePNS, lotLNS, maintMarginFracHdths(config), scale);
  // Margin between 1.0x and 3.0x the maintenance requirement.
  const depositCNS = mmr + (mmr * BigInt(Math.floor(rand() * 2000))) / 1000n;

  // Mark within +/-10% of entry.
  const drift = BigInt(Math.floor((rand() - 0.5) * 200_000));
  const markPricePNS = entryPricePNS + (entryPricePNS * drift) / 1_000_000n;

  return {
    position: {
      marketId: config.marketId,
      symbol: config.symbol,
      side,
      lotLNS,
      entryPricePNS,
      depositCNS,
      fundingCNS: 0n,
    },
    config,
    markPricePNS: markPricePNS > 0n ? markPricePNS : 1n,
  };
}

/** Notional helper for tests that need to reason in AUSD. */
export const testNotionalCNS = (
  pricePNS: bigint,
  lotLNS: bigint,
  config: MarketRiskConfig,
): bigint => notionalCNS(pricePNS, lotLNS, scaleOf(config));

/**
 * How far two prices are apart, as a fraction of the larger.
 *
 * Reducing a position by a fraction cannot in general be done exactly in
 * integers: an odd lot count has no exact half, so the reduced position is a
 * hair smaller than the arithmetic says and its recomputed maintenance margin
 * moves with it. The algebraic property — that proportional release leaves the
 * liquidation price alone — is proved separately on a position that halves
 * exactly. For arbitrary fractions the right assertion is that any movement is
 * negligible relative to the price, which is what this measures.
 */
export function relativeDrift(a: bigint, b: bigint): number {
  const larger = (a > b ? a : b) < 0n ? -(a > b ? a : b) : a > b ? a : b;
  if (larger === 0n) return 0;
  const gap = a > b ? a - b : b - a;
  return Number(gap) / Number(larger);
}

/** One price unit expressed as notional, the natural granularity of these tests. */
export function onePriceUnitCNS(lotLNS: bigint, config: MarketRiskConfig): bigint {
  return (
    (lotLNS * 10n ** BigInt(config.collateralDecimals)) /
    10n ** BigInt(config.priceDecimals + config.lotDecimals)
  );
}
