/**
 * The funding scanner: Perpl's APR beside Hyperliquid's and Binance's, and the
 * widest gap. Pure; the page renders what this returns.
 *
 * - PERPL'S APR IS THE HEATMAP'S: the same `aprPct` the heatmap row ends in
 *   (last applied rate × settlements a year). Computed once, shown twice.
 * - RAW BY DEFAULT. The other two venues' formulas carry an interest term
 *   (0.01% per 8 h, 10.95% APR) that a trader there really pays; Perpl's has
 *   none. LIKE-FOR-LIKE subtracts each quote's own interest term, so what is
 *   left is the premium part, comparable with Perpl's rate.
 * - SPREAD vs BEST = Perpl's APR minus the venue FURTHEST from it, named,
 *   signed. Sorted by its size, largest first; rows without one go last.
 * - A MARKET IS ON BOTH SIDES when at least one venue lists it as the same
 *   asset, or cannot currently be read (unknown is not "not listed"). A venue
 *   that does not list it is an empty cell, never 0.
 */
import type { FundingVenueId, VenueFundingCell, VenueFundingPayload } from '@perpguard/shared';

export type ScannerMode = 'raw' | 'like-for-like';

export const SCANNER_VENUES: readonly FundingVenueId[] = ['hyperliquid', 'binance'];

export const VENUE_NAME: Readonly<Record<FundingVenueId, string>> = { hyperliquid: 'Hyperliquid', binance: 'Binance' };

export interface PerplFunding {
  readonly marketId: number;
  readonly symbol: string;
  /** The last applied rate, percent per settlement. */
  readonly ratePct: number | undefined;
  readonly intervalSec: number | undefined;
  readonly aprPct: number | undefined;
}

export interface ScannerCell {
  readonly cell: VenueFundingCell;
  /** The APR shown in this mode; undefined unless `cell` is a quote with a known interval. */
  readonly aprPct: number | undefined;
}

export interface ScannerRow {
  readonly marketId: number;
  readonly symbol: string;
  readonly perpl: PerplFunding;
  readonly venues: Readonly<Record<FundingVenueId, ScannerCell>>;
  /** Perpl's APR minus the furthest venue's, in percentage points. */
  readonly spread: { readonly pts: number; readonly vs: FundingVenueId } | undefined;
}

export function scannerApr(cell: VenueFundingCell, mode: ScannerMode): number | undefined {
  if (cell.kind !== 'quote' || cell.aprPct === undefined) return undefined;
  return mode === 'raw' ? cell.aprPct : cell.aprPct - cell.interestAprPct;
}

const onBothSides = (cells: readonly VenueFundingCell[]) => cells.some((c) => c.kind === 'quote' || c.kind === 'unavailable');

export function scannerRows(perpl: readonly PerplFunding[], payload: VenueFundingPayload, mode: ScannerMode): ScannerRow[] {
  const byId = new Map(payload.markets.map((m) => [m.marketId, m]));
  const rows: ScannerRow[] = [];
  for (const p of perpl) {
    const m = byId.get(p.marketId);
    if (m === undefined || !onBothSides(SCANNER_VENUES.map((v) => m.venues[v]))) continue;
    const venues = Object.fromEntries(SCANNER_VENUES.map((v) => [v, { cell: m.venues[v], aprPct: scannerApr(m.venues[v], mode) }])) as Record<FundingVenueId, ScannerCell>;
    let spread: ScannerRow['spread'];
    if (p.aprPct !== undefined) {
      for (const v of SCANNER_VENUES) {
        const apr = venues[v].aprPct;
        if (apr === undefined) continue;
        const pts = p.aprPct - apr;
        if (spread === undefined || Math.abs(pts) > Math.abs(spread.pts)) spread = { pts, vs: v };
      }
    }
    rows.push({ marketId: p.marketId, symbol: p.symbol, perpl: p, venues, spread });
  }
  return rows.sort((a, b) => {
    if (a.spread === undefined || b.spread === undefined) return a.spread === b.spread ? a.symbol.localeCompare(b.symbol) : a.spread === undefined ? 1 : -1;
    return Math.abs(b.spread.pts) - Math.abs(a.spread.pts) || a.symbol.localeCompare(b.symbol);
  });
}

/** "+10.95%", "−4.80%", "<0.01%": a tiny non-zero APR never reads as zero. */
export function formatAprCell(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  const abs = Math.abs(pct);
  const body = abs === 0 ? '0.00' : abs < 0.005 ? '<0.01' : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${body}%`;
}

/** "−53.77 pts": percentage points, signed. */
export function formatPts(pts: number): string {
  const sign = pts > 0 ? '+' : pts < 0 ? '−' : '';
  return `${sign}${Math.abs(pts).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pts`;
}

/** "1 h", "8 h", "43 min". */
export function formatInterval(sec: number): string {
  if (sec < 3_600) return `${Math.round(sec / 60)} min`;
  const h = sec / 3_600;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}
