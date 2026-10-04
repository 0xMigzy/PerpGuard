import type { FundingCadence, MarketFundingSeries, Timeframe } from '@perpguard/shared';

/**
 * The funding heatmap on the Markets page: one row per LIVE market, one column
 * per period, from one read of the indexed funding events. Pure; unit tested.
 *
 * EVERY LIVE MARKET GETS A ROW. The rows come from the table's live markets, not
 * from whichever markets happen to have funding events, so the heatmap's row
 * count always matches the table's live count. A live market with no settlement
 * in a column shows a MISSING cell, which is drawn differently from a cell at 0%:
 * a market that did not exist yet is not a market with zero funding.
 *
 * EVERY COLUMN SAYS WHAT IT AVERAGED. A settlement column is the rate as applied;
 * a day or week column is the MEAN RATE PER SETTLEMENT in it, carried with how
 * many settlements that was. "Mean of 231 settlements" and "this week's rate" are
 * different claims, and the cell and the caption say which one is drawn.
 */

export type HeatmapGrain = 'settlement' | 'utc-day' | 'utc-week';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const YEAR_SEC = 365 * 86_400;

/**
 * More settlement columns than this would not read as cells. At ~33 a day the
 * 24H window is well under it; if a venue settled far more often, 24H would fall
 * back to UTC hours rather than draw slivers.
 */
export const MAX_SETTLEMENT_COLUMNS = 60;

export interface HeatColumn {
  readonly startMs: number;
  /** Exclusive. For a settlement column, the settlement itself plus one ms. */
  readonly endMs: number;
  /** True for the day or week still running: its mean is "so far". */
  readonly partial: boolean;
}

export interface HeatCell {
  /** In percent: the rate applied, or the mean rate per settlement in the column. */
  readonly ratePct: number;
  /** How many settlements `ratePct` averages. 1 for a settlement column. */
  readonly events: number;
}

export interface LiveMarket {
  readonly marketId: number;
  readonly symbol: string;
  /** The last rate applied, in percent: the table's Funding column. */
  readonly currentRatePct: number | undefined;
}

export interface HeatRow {
  readonly marketId: number;
  readonly symbol: string;
  /** One per column; undefined is NO SETTLEMENT, never zero. */
  readonly cells: readonly (HeatCell | undefined)[];
  readonly currentRatePct: number | undefined;
  /** Simple, not compounded: the current rate × settlements a year. Undefined without both. */
  readonly aprPct: number | undefined;
  /** Settlements in the window. Zero for a live market the index has none for. */
  readonly eventCount: number;
  readonly cadence: FundingCadence | undefined;
}

export interface FundingHeatmap {
  readonly grain: HeatmapGrain;
  readonly columns: readonly HeatColumn[];
  readonly rows: readonly HeatRow[];
  /** One symmetric scale for every cell. Never zero. */
  readonly maxAbsRatePct: number;
  /**
   * The fewest and most settlements a WHOLE column averages, for the caption,
   * leaving out each market's first column (its listing, part-filled).
   * A range, not a "usual" count: the cadence has changed (about 25 a day until
   * 23 Jul 2026, about 33 since), so one typical figure would describe neither.
   * Undefined for settlement columns, and when no whole column has a reading.
   */
  readonly eventsPerColumn: { readonly min: number; readonly max: number } | undefined;
  /** The cadence most live markets share, measured: what the page states. */
  readonly cadence: { readonly measuredIntervalSec: number | undefined; readonly venueIntervalSec: number | undefined; readonly eventsPerDay: number } | undefined;
}

/** Which grain a timeframe is drawn at. */
export function heatmapGrain(timeframe: Timeframe): HeatmapGrain {
  switch (timeframe) {
    case '24h':
      return 'settlement';
    case '7d':
    case '30d':
      return 'utc-day';
    case 'all':
      return 'utc-week';
  }
}

/** Settlements a year from the venue's interval, or the measured one when the venue gives none. */
export function settlementsPerYear(cadence: FundingCadence | undefined): number | undefined {
  const interval = cadence?.venueIntervalSec ?? cadence?.measuredIntervalSec;
  return interval === undefined || interval <= 0 ? undefined : YEAR_SEC / interval;
}

/** Simple annualised rate in percent: `rate × settlements a year`. Not compounded, not a forecast. */
export function aprPct(ratePct: number | undefined, cadence: FundingCadence | undefined): number | undefined {
  const perYear = settlementsPerYear(cadence);
  return ratePct === undefined || perYear === undefined ? undefined : ratePct * perYear;
}

const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
/** Monday 00:00 UTC. The epoch was a Thursday, hence the 3-day shift. */
const weekStart = (ms: number) => Math.floor((ms + 3 * DAY_MS) / WEEK_MS) * WEEK_MS - 3 * DAY_MS;

/**
 * Contiguous columns from the window's start to now, so a period with no
 * settlement is a missing column rather than a skipped one. The column still
 * running is partial; so is the first one when the window cuts into it (`cut`).
 */
function periodColumns(grain: 'utc-day' | 'utc-week', fromMs: number, nowMs: number, cut: boolean): HeatColumn[] {
  const start = grain === 'utc-day' ? dayStart : weekStart;
  const step = grain === 'utc-day' ? DAY_MS : WEEK_MS;
  const columns: HeatColumn[] = [];
  for (let at = start(fromMs); at <= nowMs; at += step) columns.push({ startMs: at, endMs: at + step, partial: at + step > nowMs || (cut && at < fromMs) });
  return columns;
}

/** Where the window starts, for the day and week grains. The same windows the API serves. */
function windowStart(timeframe: Timeframe, nowMs: number, series: readonly MarketFundingSeries[]): number | undefined {
  switch (timeframe) {
    case '7d':
      return nowMs - 7 * DAY_MS;
    case '30d':
      return nowMs - 30 * DAY_MS;
    default: {
      const firsts = series.map((s) => s.firstAtMs).filter((v): v is number => v !== undefined);
      return firsts.length === 0 ? undefined : Math.min(...firsts);
    }
  }
}

export function fundingHeatmap(live: readonly LiveMarket[], series: readonly MarketFundingSeries[], timeframe: Timeframe, nowMs: number): FundingHeatmap {
  const liveIds = new Set(live.map((m) => m.marketId));
  const seriesById = new Map(series.map((s) => [s.market.marketId, s]));
  // Columns are built from the LIVE markets' events only: an upcoming market's
  // 0% settlements must not add a column no row has a reading for.
  const liveSeries = series.filter((s) => liveIds.has(s.market.marketId));

  let grain = heatmapGrain(timeframe);
  let columns: HeatColumn[];
  if (grain === 'settlement') {
    const times = [...new Set(liveSeries.flatMap((s) => s.points.map((p) => p.atMs)))].sort((a, b) => a - b);
    if (times.length <= MAX_SETTLEMENT_COLUMNS) {
      columns = times.map((t) => ({ startMs: t, endMs: t + 1, partial: false }));
    } else {
      grain = 'utc-day';
      columns = periodColumns('utc-day', nowMs - DAY_MS, nowMs, true);
    }
  } else {
    const from = windowStart(timeframe, nowMs, liveSeries);
    // All starts at the index's first settlement: nothing before it was cut off.
    columns = from === undefined ? [] : periodColumns(grain, from, nowMs, timeframe !== 'all');
  }

  const rows: HeatRow[] = [...live]
    .sort((a, b) => a.marketId - b.marketId)
    .map((m) => {
      const s = seriesById.get(m.marketId);
      const cells = columns.map((c): HeatCell | undefined => {
        let weighted = 0;
        let events = 0;
        for (const p of s?.points ?? []) {
          if (p.atMs < c.startMs || p.atMs >= c.endMs) continue;
          weighted += p.ratePct * p.events;
          events += p.events;
        }
        return events === 0 ? undefined : { ratePct: weighted / events, events };
      });
      return {
        marketId: m.marketId,
        symbol: m.symbol,
        cells,
        currentRatePct: m.currentRatePct,
        aprPct: aprPct(m.currentRatePct, s?.cadence),
        eventCount: s?.eventCount ?? 0,
        cadence: s?.cadence,
      };
    });

  let maxAbsRatePct = 0;
  for (const r of rows) for (const c of r.cells) if (c !== undefined) maxAbsRatePct = Math.max(maxAbsRatePct, Math.abs(c.ratePct));

  // A market's FIRST column is its listing day or week, part-filled however whole
  // the column is: counting it would put a new listing's 17 beside everyone's 33.
  const whole = rows.flatMap((r) => {
    const first = r.cells.findIndex((c) => c !== undefined);
    return r.cells.filter((c, i): c is HeatCell => c !== undefined && i !== first && !columns[i]!.partial).map((c) => c.events);
  });

  return {
    grain,
    columns,
    rows,
    // A floor of one rate unit (0.00001%) so an all-zero window still has a scale.
    maxAbsRatePct: Math.max(maxAbsRatePct, 0.00001),
    eventsPerColumn: grain === 'settlement' || whole.length === 0 ? undefined : { min: Math.min(...whole), max: Math.max(...whole) },
    cadence: sharedCadence(rows),
  };
}

/** The most common value, so one new market's short first day does not set the caption. */
function mode(values: readonly number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [v, n] of counts) if (n > bestCount || (n === bestCount && best !== undefined && v > best)) [best, bestCount] = [v, n];
  return best;
}

/** The cadence the most live markets were measured at: the one sentence the page states. */
function sharedCadence(rows: readonly HeatRow[]): FundingHeatmap['cadence'] {
  const measured = rows.map((r) => r.cadence).filter((c): c is FundingCadence => c !== undefined && c.measuredIntervalSec !== undefined);
  const eventsPerDay = mode(measured.map((c) => c.eventsPerDay));
  const pick = measured.find((c) => c.eventsPerDay === eventsPerDay);
  return pick === undefined ? undefined : { measuredIntervalSec: pick.measuredIntervalSec, venueIntervalSec: pick.venueIntervalSec, eventsPerDay: pick.eventsPerDay };
}
