/**
 * Open interest as a LEVEL over time, one side, in AUSD. Pure.
 *
 * The index starts at the Exchange's deployment block, so a market's cumulative
 * OI delta at a day's close IS its open interest then: measured equal to the
 * venue's own level on every market (6 Oct 2026; BTC 8.14921 vs 8.14836 lots,
 * the gap being the ~145 blocks the index trails the chain by). Each day is
 * lots × that day's closing mark, summed over markets.
 *
 * ANCHORED, NOT SHIFTED: the series ends in a point that IS the venue's level
 * now. History is never moved to meet it: the gap is the index trailing the
 * chain, not an error in the past. Instead every market whose latest indexed
 * lots differ from the venue's by more than `ANCHOR_TOLERANCE` is reported, so
 * a disagreement is shown rather than hidden.
 */
import type { MarketDailySeries, MarketOpenInterest } from '@perpguard/shared';

/** A market's indexed lots may differ from the venue's by this share before it is reported. */
export const ANCHOR_TOLERANCE = 0.005;

export interface OiDay {
  readonly dayMs: number;
  readonly totalAusd: number;
  /** Per market id, AUSD. Markets with no open interest that day are omitted. */
  readonly byMarket: Readonly<Record<number, number>>;
  /** Markets holding lots that day with no mark yet to price them: left out of the total, and counted. */
  readonly unpriced: number;
}

export interface OiMismatch {
  readonly marketId: number;
  readonly symbol: string;
  readonly indexedLots: number;
  readonly venueLots: number | undefined;
}

export interface OiHistory {
  readonly days: readonly OiDay[];
  /** The venue's level now: the anchor the series ends on. Undefined without a reading. */
  readonly now: { readonly atMs: number; readonly totalAusd: number } | undefined;
  readonly mismatches: readonly OiMismatch[];
}

export function oiHistory(series: readonly MarketDailySeries[], venue: readonly MarketOpenInterest[] | undefined): OiHistory {
  const byDay = new Map<number, { total: number; byMarket: Record<number, number>; unpriced: number }>();
  const latestLots = new Map<number, { lots: number; symbol: string }>();
  for (const s of series) {
    let mark: number | undefined;
    for (const p of s.points) {
      if (p.markClose !== undefined) mark = p.markClose;
      const day = byDay.get(p.dayMs) ?? { total: 0, byMarket: {}, unpriced: 0 };
      byDay.set(p.dayMs, day);
      if (p.openInterestDeltaLots === 0) continue;
      if (mark === undefined) {
        day.unpriced += 1;
        continue;
      }
      const ausd = p.openInterestDeltaLots * mark;
      day.byMarket[s.market.marketId] = ausd;
      day.total += ausd;
    }
    const last = s.points.at(-1);
    if (last !== undefined) latestLots.set(s.market.marketId, { lots: last.openInterestDeltaLots, symbol: s.market.symbol ?? s.market.indexerName });
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a - b).map(([dayMs, d]) => ({ dayMs, totalAusd: d.total, byMarket: d.byMarket, unpriced: d.unpriced }));

  const mismatches: OiMismatch[] = [];
  if (venue !== undefined) {
    const venueBy = new Map(venue.map((v) => [v.marketId, v]));
    for (const [marketId, { lots, symbol }] of latestLots) {
      const v = venueBy.get(marketId);
      // A market the venue does not list (retired, or not open) should hold nothing.
      if (v === undefined) {
        if (lots !== 0) mismatches.push({ marketId, symbol, indexedLots: lots, venueLots: undefined });
        continue;
      }
      const scale = Math.max(Math.abs(v.openInterestSize), Math.abs(lots));
      if (scale > 0 && Math.abs(lots - v.openInterestSize) / scale > ANCHOR_TOLERANCE) mismatches.push({ marketId, symbol: v.symbol, indexedLots: lots, venueLots: v.openInterestSize });
    }
  }
  const now =
    venue === undefined || venue.length === 0
      ? undefined
      : { atMs: Math.min(...venue.map((v) => v.atMs)), totalAusd: venue.reduce((sum, v) => sum + v.openInterestNotional, 0) };
  return { days, now, mismatches };
}
