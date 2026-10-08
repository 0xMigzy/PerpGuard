/**
 * A ROLLING WINDOW, SPLIT INTO WHOLE UTC DAYS AND ITS TWO RAGGED EDGES.
 *
 * The rolling figures (volume, trades, maker fees, distinct traders) used to
 * scan every fill in the window: 3.5M rows for 30 days, 22.8M for all of it,
 * every pass, and the host capped the VPS for the CPU (8 Oct 2026). The window
 * is still exactly the rolling one. A closed UTC day's fills never change, so
 * the whole days inside it are read from per-day sums and only the edges, the
 * part of the first day after the rolling start and today so far, are scanned
 * row by row with their exact instants.
 *
 * THIS IS NOT THE BUCKET BUG. Summing day buckets FOR the window (midnight to
 * now) is what once served 3.75M against a true 16.14M. Here the days are only
 * the ones lying WHOLLY inside the window, and the edges are scanned exactly,
 * so the three parts add up to the same rows the old scan read.
 *
 * Pure: no clock, no I/O.
 */

const DAY_MS = 86_400_000;

export interface MsRange {
  /** Inclusive; undefined means from the start of the index. */
  readonly fromMs: number | undefined;
  /** Exclusive. */
  readonly toMs: number;
}

export interface WindowSplit {
  /** Whole UTC days [fromMs, toMs) read from per-day sums; absent when none lies inside. */
  readonly days: MsRange | undefined;
  /** At most two ranges scanned row by row, never overlapping the days or each other. */
  readonly edges: readonly MsRange[];
}

export const floorUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
export const ceilUtcDay = (ms: number): number => Math.ceil(ms / DAY_MS) * DAY_MS;

/**
 * `closedBeforeMs`: days ending after it are not final yet (the index has not
 * passed their end), so they stay in the scanned tail. Undefined means no day
 * is known final and the whole window is one edge, which is the old scan.
 */
export function splitWindow(sinceMs: number | undefined, untilMs: number, closedBeforeMs: number | undefined): WindowSplit {
  const whole: WindowSplit = { days: undefined, edges: [{ fromMs: sinceMs, toMs: untilMs }] };
  if (closedBeforeMs === undefined) return whole;
  const daysTo = Math.min(floorUtcDay(untilMs), floorUtcDay(closedBeforeMs));
  const daysFrom = sinceMs === undefined ? undefined : ceilUtcDay(sinceMs);
  if (daysFrom !== undefined && daysFrom >= daysTo) return whole;
  const edges: MsRange[] = [];
  if (sinceMs !== undefined && daysFrom !== undefined && sinceMs < daysFrom) edges.push({ fromMs: sinceMs, toMs: daysFrom });
  if (daysTo < untilMs) edges.push({ fromMs: daysTo, toMs: untilMs });
  return { days: { fromMs: daysFrom, toMs: daysTo }, edges };
}

/** Every UTC day start in [fromMs, toMs). */
export function utcDaysIn(fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (let d = ceilUtcDay(fromMs); d < toMs; d += DAY_MS) out.push(d);
  return out;
}
