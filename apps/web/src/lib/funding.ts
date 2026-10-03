import type { MarketFundingSeries } from '@perpguard/shared';

/**
 * The two funding panels on the Markets page, from one read of the indexed
 * funding events.
 *
 * Only markets the venue lists are drawn. A market not yet trading still gets
 * funding events (all at 0%), and a retired one is history; neither belongs in a
 * reading of what traders are paying now.
 */
export interface FundingPanel {
  readonly marketId: number;
  readonly symbol: string;
  readonly resolution: MarketFundingSeries['resolution'];
  readonly points: MarketFundingSeries['points'];
  readonly eventCount: number;
  readonly lastRatePct: number | undefined;
  readonly cumulativeRatePct: number;
  /** Positive rates are longs paying shorts (Perpl docs, Funding). */
  readonly payer: 'longs' | 'shorts' | 'neither';
}

export interface FundingPanels {
  /** By market id: a fixed order, so a market never moves between windows. */
  readonly markets: readonly FundingPanel[];
  /** The same panels, largest cumulative first: who paid most to hold. */
  readonly byCumulative: readonly FundingPanel[];
  /**
   * One symmetric scale for every small multiple, so a line's height means the
   * same rate in every panel. Never zero-width.
   */
  readonly maxAbsRatePct: number;
  readonly maxAbsCumulativePct: number;
  readonly resolution: MarketFundingSeries['resolution'] | undefined;
}

export function payerOf(cumulativeRatePct: number): FundingPanel['payer'] {
  return cumulativeRatePct > 0 ? 'longs' : cumulativeRatePct < 0 ? 'shorts' : 'neither';
}

export function fundingPanels(series: readonly MarketFundingSeries[]): FundingPanels {
  const markets: FundingPanel[] = series
    .filter((s): s is MarketFundingSeries & { market: { symbol: string } } => s.market.symbol !== undefined)
    .map((s) => ({
      marketId: s.market.marketId,
      symbol: s.market.symbol,
      resolution: s.resolution,
      points: s.points,
      eventCount: s.eventCount,
      lastRatePct: s.resolution === 'event' ? s.points.at(-1)?.ratePct : undefined,
      cumulativeRatePct: s.cumulativeRatePct,
      payer: payerOf(s.cumulativeRatePct),
    }))
    .sort((a, b) => a.marketId - b.marketId);

  let maxAbsRatePct = 0;
  for (const m of markets) for (const p of m.points) maxAbsRatePct = Math.max(maxAbsRatePct, Math.abs(p.ratePct));
  const maxAbsCumulativePct = markets.reduce((max, m) => Math.max(max, Math.abs(m.cumulativeRatePct)), 0);

  return {
    markets,
    byCumulative: [...markets].sort((a, b) => b.cumulativeRatePct - a.cumulativeRatePct || a.marketId - b.marketId),
    // A floor of one rate unit (0.00001%) so a window of all-zero rates still draws a flat line, not a NaN.
    maxAbsRatePct: Math.max(maxAbsRatePct, 0.00001),
    maxAbsCumulativePct,
    resolution: markets[0]?.resolution,
  };
}
