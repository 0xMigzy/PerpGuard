import type { Timeframe } from '@perpguard/shared';

export type { Timeframe };

export const TIMEFRAMES: readonly Timeframe[] = ['24h', '7d', '30d', 'all'];

/** Every timeframed section opens on 30 days. One default, not one per page. */
export const DEFAULT_TIMEFRAME: Timeframe = '30d';

/** The pill text. */
export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  '24h': '24H',
  '7d': '7D',
  '30d': '30D',
  all: 'All',
};

/** The tile label suffix, e.g. "Volume · 30 days". */
export const PERIOD_LABEL: Record<Timeframe, string> = {
  '24h': '24h',
  '7d': '7 days',
  '30d': '30 days',
  all: 'all time',
};

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value);
}

/** The timeframe from a `?t=` query value, or the page's default. */
export function timeframeFromQuery(value: string | null | undefined, fallback: Timeframe): Timeframe {
  return isTimeframe(value) ? value : fallback;
}

/**
 * Which series a sparkline or chart is drawn from, and how many of its days
 * are shown.
 *
 * A 24h window aligned down to UTC days is two points, which is not a shape,
 * so the day-based charts show the last 7 days for it and say so. And the
 * 7-day average needs six days of run-up before the first shown day, so the
 * series is FETCHED for a longer window than it is SHOWN for: 30d behind a
 * 7-day chart, and 8 shown days (the aligned-down leading bucket plus seven).
 */
export function chartWindow(timeframe: Timeframe): { readonly fetch: Timeframe; readonly showDays: number | undefined } {
  switch (timeframe) {
    case '24h':
    case '7d':
      return { fetch: '30d', showDays: 8 };
    case '30d':
      return { fetch: 'all', showDays: 31 };
    case 'all':
      return { fetch: 'all', showDays: undefined };
  }
}
