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
 * THE TRADERS PAGES COUNT WHOLE UTC DAYS. Their 24H window starts at
 * yesterday 00:00 UTC (the per-trader record is kept by day), so it holds
 * yesterday and today so far, and is labelled as such, never "24h" and never
 * "today". The window itself is unchanged.
 */
export const DAY_BUCKET_24H = { pill: '2D', title: 'Yesterday and today so far, in whole UTC days', period: 'yesterday + today', sentence: 'since yesterday 00:00 UTC' } as const;

/** periodLabel for a page that counts whole UTC days (Traders). */
export function dayPeriodLabel(t: Timeframe, startsAtMs: number | undefined): string {
  return t === '24h' ? DAY_BUCKET_24H.period : periodLabel(t, startsAtMs);
}

/** inPeriod for a page that counts whole UTC days (Traders). */
export function inDayPeriod(t: Timeframe, startsAtMs: number | undefined): string {
  return t === '24h' ? DAY_BUCKET_24H.sentence : inPeriod(t, startsAtMs);
}

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
