/**
 * Pure derivations for the Overview page. No I/O, no React, unit tested.
 *
 * These turn API answers into chart shapes. They never invent a figure the API
 * did not serve: a delta needs a real previous period, a TVL history is exactly
 * the current level walked back through the exact daily flows, and a stacked
 * series is the per-market series regrouped.
 */
import type { MarketDailySeries, PreviousPeriodMetrics, ProtocolMetrics } from '@perpguard/shared';

export interface Delta {
  /** Fraction, e.g. 0.227 for +22.7%. Undefined when there is nothing honest to compare. */
  readonly fraction: number | undefined;
  /** Why it is unknown, fit to render. */
  readonly reason?: string;
}

/**
 * Change versus the previous period, or unknown with a reason.
 *
 * Unknown when there is no previous window (`all`), when the index does not
 * cover the whole previous window (its total would be a partial dressed as a
 * whole), or when the previous value is zero (a ratio over nothing).
 */
export function deltaVsPrevious(
  metrics: Pick<ProtocolMetrics, 'previous' | 'indexedFromMs'>,
  pick: (m: PreviousPeriodMetrics | ProtocolMetrics) => number,
  current: number,
): Delta {
  const previous = metrics.previous;
  if (previous === undefined) return { fraction: undefined, reason: 'all time has no previous period' };
  if (!previous.complete) {
    const from = metrics.indexedFromMs;
    return {
      fraction: undefined,
      reason:
        from === undefined
          ? 'the index has no complete previous period'
          : `the index starts ${new Date(from).toISOString().slice(0, 10)}, inside the previous period`,
    };
  }
  const before = pick(previous);
  if (before === 0) return { fraction: undefined, reason: 'nothing in the previous period to compare with' };
  return { fraction: (current - before) / Math.abs(before) };
}

/** A delta from two plain numbers, for figures without a `previous` block. */
export function deltaOf(current: number, previous: number | undefined): Delta {
  if (previous === undefined) return { fraction: undefined, reason: 'no previous level is known' };
  if (previous === 0) return { fraction: undefined, reason: 'nothing before to compare with' };
  return { fraction: (current - previous) / Math.abs(previous) };
}

export interface StackedDay {
  readonly dayMs: number;
  readonly total: number;
  /** One entry per key in {@link StackedVolume.keys}. */
  readonly byKey: Readonly<Record<string, number>>;
}

export interface StackedVolume {
  /** Series labels in FIXED order: the kept markets by market id, then "Other". */
  readonly keys: readonly string[];
  /** Which kept key each colour slot belongs to; "Other" is not in here. */
  readonly slotOf: Readonly<Record<string, number>>;
  readonly days: readonly StackedDay[];
  /** Trailing N-day mean of `total`, one per day, over the days available. */
  readonly average: readonly number[];
}

/**
 * Per-market day series -> a stacked shape with at most `slots` named markets.
 *
 * Which markets get a slot is decided by total volume over the window; the
 * ORDER of the slots is by market id, so the same market keeps the same colour
 * whichever window is shown. Everything else, including a market the venue
 * does not list, folds into "Other".
 */
export function stackByMarket(
  series: readonly MarketDailySeries[],
  slots = 4,
  averageWindow = 7,
  /** Keep only the last N days AFTER the average is computed over all of them. */
  showDays?: number,
): StackedVolume {
  const totals = series.map((s) => ({
    series: s,
    total: s.points.reduce((sum, p) => sum + p.volumeAusd, 0),
  }));
  const kept = totals
    .filter((t) => t.series.market.symbol !== undefined && t.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, slots)
    .sort((a, b) => a.series.market.marketId - b.series.market.marketId)
    .map((t) => t.series);

  const keys = [...kept.map((s) => s.market.symbol!), 'Other'];
  const slotOf: Record<string, number> = {};
  kept.forEach((s, i) => {
    slotOf[s.market.symbol!] = i;
  });

  const dayMap = new Map<number, Record<string, number>>();
  for (const s of series) {
    const key = kept.includes(s) ? s.market.symbol! : 'Other';
    for (const p of s.points) {
      let row = dayMap.get(p.dayMs);
      if (row === undefined) {
        row = Object.fromEntries(keys.map((k) => [k, 0]));
        dayMap.set(p.dayMs, row);
      }
      row[key] = (row[key] ?? 0) + p.volumeAusd;
    }
  }
  const days = [...dayMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayMs, byKey]) => ({
      dayMs,
      byKey,
      total: Object.values(byKey).reduce((a, b) => a + b, 0),
    }));

  const average = trailingMean(days.map((d) => d.total), averageWindow);
  const from = showDays === undefined ? 0 : Math.max(0, days.length - showDays);
  return { keys, slotOf, days: days.slice(from), average: average.slice(from) };
}

/** The last N of a day series, or all of it. */
export function lastDays<T>(days: readonly T[], showDays: number | undefined): readonly T[] {
  return showDays === undefined ? days : days.slice(Math.max(0, days.length - showDays));
}

/** Trailing mean over up to `window` points, including the current one. */
export function trailingMean(values: readonly number[], window: number): readonly number[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}
