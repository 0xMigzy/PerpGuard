/**
 * Pure derivations for the Liquidations page. No I/O, no React, unit tested.
 */
import type { DailyPoint } from '@perpguard/shared';

export interface LiquidationDay {
  readonly dayMs: number;
  readonly rescuable: number;
  /**
   * Everything else in the bucket. NOT "unavoidable": the day buckets carry
   * no per-day unknown count, so this holds both the liquidations that were
   * judged not rescuable and the ones that could not be judged. The chart's
   * legend says so.
   */
  readonly other: number;
  readonly total: number;
}

/** The day series as two stacked counts. Keeps every day, so a quiet day shows as zero. */
export function splitLiquidationDays(days: readonly DailyPoint[]): readonly LiquidationDay[] {
  return days.map((d) => ({
    dayMs: d.dayMs,
    rescuable: d.rescuableLiquidationCount,
    other: Math.max(0, d.liquidationCount - d.rescuableLiquidationCount),
    total: d.liquidationCount,
  }));
}

/** The reader caps a page at this many rows. Asking for more is asking for the cap. */
export const LIST_CAP = 500;
export const LIST_STEP = 50;

/** The next list size after "load more", never past the cap. */
export function nextLimit(limit: number, step = LIST_STEP, cap = LIST_CAP): number {
  return Math.min(cap, limit + step);
}

/**
 * Whether the list may have more rows than were shown: only when the last
 * request came back full. A short page is the end, and the button goes away.
 */
export function mayHaveMore(shown: number, limit: number, cap = LIST_CAP): boolean {
  return shown >= limit && limit < cap;
}
