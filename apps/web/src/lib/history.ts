/**
 * WHAT "ALL" COVERS, SAID RATHER THAN ASSUMED.
 *
 * "All" means the index's whole history, and that begins wherever the index
 * begins. The page asks the index for its first event and names the window
 * from it — "since Feb 11, 2026" — so the label is only as all-time as the data
 * under it. Until that answer arrives the label is "all indexed history",
 * which claims nothing.
 */
import { formatDayLong } from './format.ts';
import { PERIOD_LABEL, type Timeframe } from './timeframe.ts';

/** The tile-suffix form: "30 days", or "since Feb 11, 2026" for All. */
export function periodLabel(t: Timeframe, startsAtMs: number | undefined): string {
  if (t !== 'all') return PERIOD_LABEL[t];
  return startsAtMs === undefined ? 'all indexed history' : `since ${formatDayLong(startsAtMs)}`;
}

/**
 * WHOLE-UTC-DAY FIGURES SAY SO (8 Oct 2026). A figure summed from day buckets
 * (a trader's P&L, round trips, money in and out; fees) covers the whole UTC
 * days from the window's start day PLUS today so far, never the rolling window
 * a bare "7 days" means on the Overview. One label for every such figure on
 * every page, so the same words always mean the same window:
 *   24H -> "yesterday + today", 7D -> "last 7 whole days + today".
 * Rolling figures keep `periodLabel` ("24h", "7 days").
 */
const WHOLE_DAYS: Record<Exclude<Timeframe, 'all'>, { readonly label: string; readonly sentence: string; readonly title: string }> = {
  '24h': { label: 'yesterday + today', sentence: 'since yesterday 00:00 UTC', title: 'Yesterday and today so far, in whole UTC days' },
  '7d': { label: 'last 7 whole days + today', sentence: 'over the last 7 whole UTC days and today', title: 'The last 7 whole UTC days and today so far' },
  '30d': { label: 'last 30 whole days + today', sentence: 'over the last 30 whole UTC days and today', title: 'The last 30 whole UTC days and today so far' },
};

/** The tile-suffix form for a figure summed over whole UTC days. */
export function wholeDaysLabel(t: Timeframe, startsAtMs: number | undefined): string {
  return t === 'all' ? periodLabel(t, startsAtMs) : WHOLE_DAYS[t].label;
}

/** The sentence form for a figure summed over whole UTC days. */
export function inWholeDays(t: Timeframe, startsAtMs: number | undefined): string {
  return t === 'all' ? inPeriod(t, startsAtMs) : WHOLE_DAYS[t].sentence;
}

/** Pill tooltips for a page whose every figure is whole UTC days (a profile, Compare). The buttons keep the site's names. */
export const WHOLE_DAY_PILLS = {
  '24h': { text: '24H', title: WHOLE_DAYS['24h'].title },
  '7d': { text: '7D', title: WHOLE_DAYS['7d'].title },
  '30d': { text: '30D', title: WHOLE_DAYS['30d'].title },
} as const;

/** The sentence form: "in the last 30 days", or "since Feb 11, 2026". */
export function inPeriod(t: Timeframe, startsAtMs: number | undefined): string {
  if (t !== 'all') return `in the last ${PERIOD_LABEL[t]}`;
  return startsAtMs === undefined ? 'across all indexed history' : `since ${formatDayLong(startsAtMs)}`;
}

/** "Sep 2, 2026 – Oct 1, 2026": an exact window, for a figure that has to carry its own. */
export function windowRange(sinceMs: number | undefined, untilMs: number, startsAtMs: number | undefined): string {
  const from = sinceMs ?? startsAtMs;
  return from === undefined ? `to ${formatDayLong(untilMs)}` : `${formatDayLong(from)} – ${formatDayLong(untilMs)}`;
}
