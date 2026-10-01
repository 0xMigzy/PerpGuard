/**
 * The growth curve's words, computed from the months rather than written in.
 * Pure, so the claim the caption makes is tested against the numbers it
 * describes.
 */
import type { HistoryMonth } from '@perpguard/shared';

/** "Feb 2026". UTC, because the buckets are UTC months. */
export function formatMonth(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The largest month-on-month step between two WHOLE months, as "×17": the
 * running month is never compared, because a partial bar is not a month.
 * Undefined until there are two whole months with trades.
 */
export function biggestStep(months: readonly HistoryMonth[]): { readonly from: HistoryMonth; readonly to: HistoryMonth; readonly factor: number } | undefined {
  const whole = months.filter((m) => !m.partial);
  let best: { from: HistoryMonth; to: HistoryMonth; factor: number } | undefined;
  for (let i = 1; i < whole.length; i++) {
    const from = whole[i - 1]!, to = whole[i]!;
    if (from.trades === 0) continue;
    const factor = to.trades / from.trades;
    if (best === undefined || factor > best.factor) best = { from, to, factor };
  }
  return best;
}
