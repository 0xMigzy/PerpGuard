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
 * now. History is never moved to meet it.
 *
 * WHETHER THE INDEX AGREES WITH THE VENUE IS NOT ASKED HERE (8 Oct 2026). This
 * series is a cached answer up to an hour old; held against the venue's live
 * figure it reported NEAR 30% out when, read side by side, the two matched to
 * the lot. The like-for-like check is the backend's 5-minute reconciliation
 * (`analytics/oiReconcile.ts`, GET /api/analytics/open-interest/reconciliation).
 */
import type { MarketDailySeries, MarketOpenInterest, OiReconciliation } from '@perpguard/shared';

export interface OiDay {
  readonly dayMs: number;
  readonly totalAusd: number;
  /** Per market id, AUSD. Markets with no open interest that day are omitted. */
  readonly byMarket: Readonly<Record<number, number>>;
  /** Markets holding lots that day with no mark yet to price them: left out of the total, and counted. */
  readonly unpriced: number;
}

export interface OiHistory {
  readonly days: readonly OiDay[];
  /** The venue's level now: the anchor the series ends on. Undefined without a reading. */
  readonly now: { readonly atMs: number; readonly totalAusd: number } | undefined;
}

export function oiHistory(series: readonly MarketDailySeries[], venue: readonly MarketOpenInterest[] | undefined): OiHistory {
  const byDay = new Map<number, { total: number; byMarket: Record<number, number>; unpriced: number }>();
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
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a - b).map(([dayMs, d]) => ({ dayMs, totalAusd: d.total, byMarket: d.byMarket, unpriced: d.unpriced }));

  const now =
    venue === undefined || venue.length === 0
      ? undefined
      : { atMs: Math.min(...venue.map((v) => v.atMs)), totalAusd: venue.reduce((sum, v) => sum + v.openInterestNotional, 0) };
  return { days, now };
}

/**
 * The words behind the Open interest info icon, from the backend's like-for-like reconciliation.
 * States what was measured: how many markets match to the lot, the largest gap now and its cause
 * (trades landing between the two reads, the blocks said), and how old the check is.
 */
export function reconciliationText(r: OiReconciliation | undefined, nowMs: number): { readonly lead: string; readonly detail: string | undefined } {
  const lead = 'Drawn as indexed.';
  if (r === undefined) return { lead, detail: 'The check against the venue has not run yet; it runs every 5 minutes.' };
  const n = r.markets.length;
  const age = Math.max(0, Math.round((nowMs - r.atMs) / 60_000));
  const when = age < 1 ? 'under a minute ago' : `${age} min ago`;
  const matched = r.matched === n ? `matches the venue to the lot on all ${n} markets` : `matches the venue to the lot on ${r.matched} of ${n} markets`;
  const l = r.largest;
  const gap =
    l === undefined
      ? ''
      : ` The largest gap is ${l.symbol}, ${gapPct(l.gapShare)} (${Math.abs(l.gapLots).toLocaleString('en-US', { maximumFractionDigits: 6 })} lots): trades landing between the two reads, the venue's at block ${l.venueBlock.toLocaleString('en-US')} and the index's at ${r.indexBlock.toLocaleString('en-US')}.`;
  return { lead, detail: `Read beside the venue's own figure, the index ${matched}.${gap} Checked ${when}.` };
}

/** A gap as a percent that never reads 0 for a real gap: two decimals from 1%, two significant digits below. */
export function gapPct(share: number): string {
  const pct = share * 100;
  if (pct === 0) return '0%';
  return `${pct >= 1 ? pct.toLocaleString('en-US', { maximumFractionDigits: 2 }) : pct.toLocaleString('en-US', { maximumSignificantDigits: 2 })}%`;
}
