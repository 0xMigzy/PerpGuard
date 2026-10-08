/**
 * OPEN INTEREST, RECONCILED LIKE FOR LIKE (8 Oct 2026).
 *
 * The index's live lot total per market (`Market.openInterestDeltaLNS`, which
 * is the level: the index runs from the deployment block) beside the venue's
 * reading, taken one straight after the other, each with the block it is
 * from. Until then the site compared an HOUR-OLD cached daily series with the
 * venue's live figure and reported NEAR 30% out; read side by side they
 * matched to the lot. What gap remains is trades landing between the two
 * reads, and the blocks say how many.
 *
 * PURE: the caller does the two reads.
 */

export interface IndexedOpenInterest {
  /** The index's latest processed block when the totals were read. */
  readonly block: number;
  readonly markets: readonly { readonly marketId: number; readonly lots: number }[];
}

export interface VenueOpenInterestReading {
  readonly marketId: number;
  readonly symbol: string;
  readonly lots: number;
  /** The block the venue's market state is from. */
  readonly block: number;
}

export interface OiReconciledMarket {
  readonly marketId: number;
  readonly symbol: string;
  readonly indexedLots: number;
  readonly venueLots: number;
  /** indexed − venue, in lots. */
  readonly gapLots: number;
  /** |gap| over the venue's figure; 0 when both are 0. */
  readonly gapShare: number;
  readonly venueBlock: number;
}

export interface OiReconciliation {
  readonly atMs: number;
  readonly indexBlock: number;
  readonly markets: readonly OiReconciledMarket[];
  /** The market with the largest share gap, or undefined when every market matches exactly. */
  readonly largest: OiReconciledMarket | undefined;
  readonly matched: number;
}

/** Venue markets only: what a trader can see today. A market the venue omits holds nothing open. */
export function reconcileOpenInterest(indexed: IndexedOpenInterest, venue: readonly VenueOpenInterestReading[], atMs: number): OiReconciliation {
  const byId = new Map(indexed.markets.map((m) => [m.marketId, m.lots]));
  const markets = venue.map((v): OiReconciledMarket => {
    const indexedLots = byId.get(v.marketId) ?? 0;
    const gapLots = indexedLots - v.lots;
    const gapShare = v.lots === 0 ? (indexedLots === 0 ? 0 : 1) : Math.abs(gapLots) / Math.abs(v.lots);
    return { marketId: v.marketId, symbol: v.symbol, indexedLots, venueLots: v.lots, gapLots, gapShare, venueBlock: v.block };
  });
  let largest: OiReconciledMarket | undefined;
  for (const m of markets) if (m.gapShare > 0 && (largest === undefined || m.gapShare > largest.gapShare)) largest = m;
  return { atMs, indexBlock: indexed.block, markets, largest, matched: markets.filter((m) => m.gapLots === 0).length };
}
