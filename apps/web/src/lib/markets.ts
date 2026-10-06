/**
 * Pure derivations for the Markets page. No I/O, no React, unit tested.
 *
 * THE JOIN IS ON THE MARKET ID (CLAUDE.md). Three payloads describe a market —
 * the indexed breakdown over the window, the venue's open-interest LEVEL, and
 * the per-market day series — and the only key they agree on is the id. The
 * ticker comes with the breakdown, already resolved from the venue context, and
 * a market the venue does not list (mainnet 80) has none, so it is EXCLUDED
 * from the table and counted, never silently dropped.
 *
 * The risk score is a COMPOSITE OF FOUR OBSERVABLE INPUTS, each normalised to
 * 0..1 against a stated ceiling and weighted. It is not a probability of
 * anything; it ranks markets by how hard the window has been on isolated margin,
 * and it is served with its components so a reader can see exactly why. An input
 * the API does not have contributes zero and says so.
 */
import type { MarketBreakdown, MarketDailyPoint, MarketDailySeries, MarketListing, MarketOpenInterest, Timeframe } from '@perpguard/shared';

/**
 * MARKETS KEPT OFF THE SITE BY DECISION, by MAINNET market id (the web reads
 * mainnet only; ids differ on testnet), each with its reason. An explicit list,
 * not a rule, so nothing else can ever be dropped by accident: every other market
 * the chain lists still reaches the table by the rules below.
 *
 * 80, TAO: removed from every page at the owner's request, 4 Oct 2026. What the
 * data says about it: listed on chain 20 Aug 2026, never traded, not paused
 * (unlike the other listings waiting to open), absent from the venue's context,
 * and with no first-party icon (public/tokens/SOURCES.md). Without this entry
 * the upcoming rule below would show it. Delete the entry to bring it back.
 */
export const EXCLUDED_MARKETS: ReadonlyMap<number, string> = new Map([[80, 'TAO: listed on chain, never traded, not paused, not in the venue context']]);

export function isExcludedMarket(marketId: number): boolean {
  return EXCLUDED_MARKETS.has(marketId);
}

/**
 * RETIRED MARKETS, NAMED FOR WHAT THEY WERE. The venue context no longer lists
 * them, so they have no ticker, but the index holds their history and the
 * Liquidations and trader pages show it. An explicit list with a reason per
 * entry, like EXCLUDED_MARKETS: never inferred from a name, so nothing else
 * can be relabelled by accident.
 */
export const RETIRED_MARKETS: ReadonlyMap<number, { readonly label: string; readonly icon: string; readonly reason: string }> = new Map([
  [30, { label: 'SOL v1 (retired)', icon: 'SOL', reason: 'the first SOL contract (127,499 trades), retired and replaced by SOL_v2, market 31' }],
]);

/** A market as a page names it: the venue's ticker, else its retired name, else its id. */
export function marketName(ref: { readonly marketId: number; readonly symbol?: string | undefined }): string {
  return ref.symbol ?? RETIRED_MARKETS.get(ref.marketId)?.label ?? `market ${ref.marketId}`;
}

/** The ticker whose icon stands for a market: a retired market borrows its successor's. */
export function marketIconSymbol(ref: { readonly marketId: number; readonly symbol?: string | undefined }): string {
  return ref.symbol ?? RETIRED_MARKETS.get(ref.marketId)?.icon ?? `market ${ref.marketId}`;
}

/**
 * Which day buckets the mark-derived columns (change, low–high, volatility)
 * are computed over, and how to label them honestly.
 *
 * Marks only exist per UTC day bucket, so a rolling window aligned down to
 * days is what these columns can cover. A 24h window is "since 00:00 UTC"
 * (one bucket) and the label is marked as differing from the page's
 * timeframe, the way the fees tile does on the Overview.
 */
export interface MarkWindow {
  readonly fetch: Timeframe;
  readonly showDays: number | undefined;
  readonly label: string;
  /** True when the label is not the page's timeframe. */
  readonly warn: boolean;
}

export function markWindow(timeframe: Timeframe): MarkWindow {
  switch (timeframe) {
    case '24h':
      return { fetch: '7d', showDays: 1, label: 'since 00:00 UTC', warn: true };
    case '7d':
      return { fetch: '30d', showDays: 8, label: '8 UTC days', warn: false };
    case '30d':
      return { fetch: 'all', showDays: 31, label: '31 UTC days', warn: false };
    case 'all':
      return { fetch: 'all', showDays: undefined, label: 'since index start', warn: false };
  }
}

// ── the risk score ──────────────────────────────────────────────────────────

export type RiskKey = 'volatility' | 'liquidations' | 'crowding' | 'funding';

export interface RiskComponent {
  readonly key: RiskKey;
  readonly label: string;
  /** 0..1 after normalisation against the ceiling. */
  readonly value: number;
  readonly weight: number;
  /** `value * weight * 100`: the points this input contributes. */
  readonly points: number;
  /** The raw figure it came from, fit to render, or why it is unknown. */
  readonly detail: string;
}

export interface RiskScore {
  /** 0..100, rounded. */
  readonly score: number;
  readonly tier: 'safe' | 'watch' | 'danger';
  readonly components: readonly RiskComponent[];
}

export interface RiskInputs {
  /** Per shown day: `(markHigh - markLow) / markClose`. Empty when no marks. */
  readonly dailyRanges: readonly number[];
  readonly liquidationCount: number;
  readonly openPositions: number;
  /** Long positions as a fraction of sided positions, or undefined. */
  readonly longShare: number | undefined;
  /** Last funding rate, in PERCENT units as the API serves it. */
  readonly fundingPct: number | undefined;
}

/** The ceilings: an input at or past this normalises to 1. Stated, so the score can be read. */
export const RISK_CEILING = {
  /** Mean daily high–low range as a fraction of close. 10% a day is the top. */
  volatility: 0.1,
  /** Liquidations per open position over the window. One per four is the top. */
  liquidations: 0.25,
  /**
   * Absolute last funding rate in percent per settlement. 0.1% is the top: the
   * same ceiling as before 6 Oct 2026 (0.001%) in the CORRECTED unit, where
   * every rate is 100× what the old divisor showed, so no score moved.
   */
  funding: 0.1,
} as const;

export const RISK_WEIGHT: Record<RiskKey, number> = {
  volatility: 0.35,
  liquidations: 0.3,
  crowding: 0.2,
  funding: 0.15,
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pct = (fraction: number, decimals = 1) => `${(fraction * 100).toFixed(decimals)}%`;

export function riskScore(inputs: RiskInputs): RiskScore {
  const ranges = inputs.dailyRanges.filter((r) => Number.isFinite(r));
  const meanRange = ranges.length === 0 ? undefined : ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const liqRate = inputs.openPositions > 0 ? inputs.liquidationCount / inputs.openPositions : inputs.liquidationCount > 0 ? 1 : 0;
  const skew = inputs.longShare === undefined ? undefined : Math.abs(inputs.longShare - 0.5) * 2;
  const funding = inputs.fundingPct === undefined ? undefined : Math.abs(inputs.fundingPct);

  const component = (key: RiskKey, label: string, value: number | undefined, detail: string): RiskComponent => {
    const v = value === undefined ? 0 : clamp01(value);
    const weight = RISK_WEIGHT[key];
    return { key, label, value: v, weight, points: v * weight * 100, detail };
  };

  const components: RiskComponent[] = [
    component(
      'volatility',
      'Volatility',
      meanRange === undefined ? undefined : meanRange / RISK_CEILING.volatility,
      meanRange === undefined ? 'no marks in the window' : `avg daily range ${pct(meanRange)} of mark · ceiling ${pct(RISK_CEILING.volatility, 0)}`,
    ),
    component(
      'liquidations',
      'Liquidations',
      liqRate / RISK_CEILING.liquidations,
      inputs.openPositions > 0
        ? `${inputs.liquidationCount} vs ${inputs.openPositions} open positions (${pct(liqRate)}) · ceiling ${pct(RISK_CEILING.liquidations, 0)}`
        : inputs.liquidationCount > 0
          ? `${inputs.liquidationCount} with no open positions left`
          : 'none, and no open positions',
    ),
    component(
      'crowding',
      'Crowding',
      skew,
      inputs.longShare === undefined ? 'no sided positions' : `${pct(inputs.longShare, 0)} long · balanced is 50%`,
    ),
    component(
      'funding',
      'Funding',
      funding === undefined ? undefined : funding / RISK_CEILING.funding,
      funding === undefined ? 'no funding event in the window' : `last rate ${inputs.fundingPct! > 0 ? '+' : inputs.fundingPct! < 0 ? '−' : ''}${funding.toFixed(6)}% · ceiling ${RISK_CEILING.funding}%`,
    ),
  ];
  const score = Math.round(components.reduce((sum, c) => sum + c.points, 0));
  return { score, tier: score < 35 ? 'safe' : score < 65 ? 'watch' : 'danger', components };
}

// ── the risk tag ────────────────────────────────────────────────────────────

/**
 * One side holding more than this of a market's open MARGIN is crowded.
 *
 * Re-derived for margin on 3 Oct 2026, not carried over from the notional share
 * it used to read (which was 50/50 by construction and so never fired). Over
 * 1,077 market-day ends (11 markets with ten or more open positions, 24 Feb –
 * 2 Oct 2026) margin share centres on 43.6% long — shorts post more margin per
 * position — and its 95th percentile is 70.4%. With funding paying the crowded
 * side, 70% tags 6.1% of market-days (65% would tag 9.7%, 75% 3.3%): the tail,
 * which is what "crowded" should mean. docs/methodology.md has the query.
 */
export const CROWDED_SHARE = 0.7;

export interface RiskTag {
  readonly label: 'Normal' | 'Elevated' | 'High' | 'Crowded long' | 'Crowded short';
  readonly tone: 'ok' | 'watch' | 'danger';
  /** Why, fit to render on hover. */
  readonly detail: string;
}

/**
 * The one-word verdict a row shows.
 *
 * CROWDED means one side holds more than 70% of open margin AND funding is
 * paying that side to stay in — positive with a long crowd, negative with a
 * short crowd. That is the side with the most to lose from a move against it,
 * and it is a risk signal, not a trade signal. Otherwise the tag is the
 * composite score's tier. The rule is stated on the page.
 */
export function riskTag(score: RiskScore, longShare: number | undefined, fundingPct: number | undefined): RiskTag {
  if (longShare !== undefined && fundingPct !== undefined) {
    if (longShare > CROWDED_SHARE && fundingPct > 0) {
      return { label: 'Crowded long', tone: 'danger', detail: `${pct(longShare, 0)} of open margin is long and funding is positive: longs pay to stay in` };
    }
    if (1 - longShare > CROWDED_SHARE && fundingPct < 0) {
      return { label: 'Crowded short', tone: 'danger', detail: `${pct(1 - longShare, 0)} of open margin is short and funding is negative: shorts pay to stay in` };
    }
  }
  const detail = `composite ${score.score} of 100`;
  if (score.tier === 'danger') return { label: 'High', tone: 'danger', detail };
  if (score.tier === 'watch') return { label: 'Elevated', tone: 'watch', detail };
  return { label: 'Normal', tone: 'ok', detail };
}

// ── the rows ────────────────────────────────────────────────────────────────

export interface MarketRow {
  readonly status: 'live';
  readonly marketId: number;
  readonly symbol: string;
  /** The venue's mark now when the level is known, else the indexed one. */
  readonly markPrice: number | undefined;
  /** Fraction vs the open of the first shown bucket. Undefined without both ends. */
  readonly change: number | undefined;
  readonly low: number | undefined;
  readonly high: number | undefined;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  /** Maker + taker over whole UTC days; `feesLabel` says which. Same definition as the Overview tile. */
  readonly feesAusd: number;
  readonly feesLabel: string;
  /** Maker only, exact for the rolling window. */
  readonly makerFeesAusd: number;
  /** The LEVEL from the venue, undefined when it has no reading. */
  readonly openInterestNotional: number | undefined;
  readonly openInterestSize: number | undefined;
  readonly openInterestAtMs: number | undefined;
  readonly openPositions: number;
  readonly longPositions: number;
  readonly shortPositions: number;
  readonly longShare: number | undefined;
  /**
   * By isolated margin at risk: the skew a reader wants. Never by notional, which
   * is 50/50 by construction on an order book. Falls back to nothing, never to
   * the headcount.
   */
  readonly longMarginAusd: number;
  readonly shortMarginAusd: number;
  readonly longShareOfMargin: number | undefined;
  readonly fundingPct: number | undefined;
  readonly liquidationCount: number;
  readonly rescuableLiquidationCount: number;
  readonly risk: RiskScore;
  readonly tag: RiskTag;
}

export interface MarketTable {
  /**
   * The markets the venue's context lists. A market it does not list is not a
   * LIVE row: if it has never traded it is an UPCOMING row (see `upcomingRows`); if it has
   * traded it is RETIRED (SOL v1, market 30) and is not shown at all.
   */
  readonly rows: readonly MarketRow[];
}

/** The last N points, or all of them. */
function shown(points: readonly MarketDailyPoint[], showDays: number | undefined): readonly MarketDailyPoint[] {
  return showDays === undefined ? points : points.slice(Math.max(0, points.length - showDays));
}

export function buildMarketTable(
  breakdown: readonly MarketBreakdown[],
  openInterest: readonly MarketOpenInterest[] | undefined,
  series: readonly MarketDailySeries[] | undefined,
  showDays: number | undefined,
): MarketTable {
  const oiById = new Map((openInterest ?? []).map((m) => [m.marketId, m]));
  const seriesById = new Map((series ?? []).map((s) => [s.market.marketId, s]));
  const rows: MarketRow[] = [];

  for (const m of breakdown) {
    if (m.market.symbol === undefined || isExcludedMarket(m.market.marketId)) continue;
    const oi = oiById.get(m.market.marketId);
    const points = shown(seriesById.get(m.market.marketId)?.points ?? [], showDays);
    const markPrice = oi?.markPrice ?? m.markPrice ?? points.at(-1)?.markClose;
    const open = points[0]?.markOpen;
    const change = open !== undefined && open > 0 && markPrice !== undefined ? (markPrice - open) / open : undefined;
    const lows = points.map((p) => p.markLow).filter((v): v is number => v !== undefined);
    const highs = points.map((p) => p.markHigh).filter((v): v is number => v !== undefined);
    if (markPrice !== undefined && lows.length > 0) {
      lows.push(markPrice);
      highs.push(markPrice);
    }
    const dailyRanges = points
      .filter((p) => p.markHigh !== undefined && p.markLow !== undefined && p.markClose !== undefined && p.markClose > 0)
      .map((p) => (p.markHigh! - p.markLow!) / p.markClose!);
    const risk = riskScore({
      dailyRanges,
      liquidationCount: m.liquidationCount,
      openPositions: m.openPositions,
      longShare: m.longShareOfPositions,
      fundingPct: m.lastFundingRatePct,
    });

    rows.push({
      status: 'live',
      marketId: m.market.marketId,
      symbol: m.market.symbol,
      markPrice,
      change,
      low: lows.length === 0 ? undefined : Math.min(...lows),
      high: highs.length === 0 ? undefined : Math.max(...highs),
      volumeAusd: m.volumeAusd,
      tradeCount: m.tradeCount,
      feesAusd: m.fees.totalAusd,
      feesLabel: m.fees.label,
      makerFeesAusd: m.makerFeesAusd,
      openInterestNotional: oi?.openInterestNotional,
      openInterestSize: oi?.openInterestSize,
      openInterestAtMs: oi?.atMs,
      openPositions: m.openPositions,
      longPositions: m.longPositions,
      shortPositions: m.shortPositions,
      longShare: m.longShareOfPositions,
      longMarginAusd: m.longMarginAusd,
      shortMarginAusd: m.shortMarginAusd,
      longShareOfMargin: m.longShareOfMargin,
      fundingPct: m.lastFundingRatePct,
      liquidationCount: m.liquidationCount,
      rescuableLiquidationCount: m.rescuableLiquidationCount,
      risk,
      tag: riskTag(risk, m.longShareOfMargin, m.lastFundingRatePct),
    });
  }
  return { rows };
}

// ── upcoming rows, and the one table ────────────────────────────────────────

/**
 * A market listed on chain that the venue has not opened, as a row of the one
 * table. It has a name (the contract's own symbol: there is no venue ticker yet)
 * and the contract's last mark, and NONE of the venue's figures: volume, open
 * interest, funding, exposure and risk are absent, rendered as "—", and sorted
 * last, never as zero.
 */
export interface UpcomingRow {
  readonly status: 'upcoming';
  readonly marketId: number;
  readonly symbol: string;
  /** The CONTRACT's last mark, labelled so on the page. Not a venue price. */
  readonly markPrice: number | undefined;
  readonly listing: MarketListing;
}

export type TableRow = MarketRow | UpcomingRow;

export function upcomingRows(listings: readonly MarketListing[]): readonly UpcomingRow[] {
  return upcomingMarkets(listings).map((l) => ({ status: 'upcoming', marketId: l.market.marketId, symbol: l.chainSymbol, markPrice: l.markPrice, listing: l }));
}

/** Which rows the page's All | Live | Upcoming control shows. `?status=` in the URL. */
export type StatusFilter = 'all' | 'live' | 'upcoming';
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'live', 'upcoming'];

export function statusFromQuery(value: string | null | undefined): StatusFilter {
  return value === 'live' || value === 'upcoming' ? value : 'all';
}

export function filterRows(rows: readonly TableRow[], filter: StatusFilter): readonly TableRow[] {
  return filter === 'all' ? rows : rows.filter((r) => r.status === filter);
}

// ── sorting ─────────────────────────────────────────────────────────────────

export type SortKey =
  | 'symbol'
  | 'status'
  | 'markPrice'
  | 'change'
  | 'volumeAusd'
  | 'tradeCount'
  | 'openInterestNotional'
  | 'longShare'
  | 'longShareOfMargin'
  | 'fundingPct'
  | 'liquidationCount'
  | 'risk';

export type SortDirection = 'asc' | 'desc';

/** The direction a column starts in when first clicked: figures high-first, names A–Z, live first. */
export function defaultDirection(key: SortKey): SortDirection {
  return key === 'symbol' || key === 'status' ? 'asc' : 'desc';
}

function sortValue(row: TableRow, key: SortKey): number | string | undefined {
  switch (key) {
    case 'symbol':
      return row.symbol;
    case 'status':
      return row.status === 'live' ? 0 : 1;
    case 'markPrice':
      return row.markPrice;
    case 'risk':
      return row.status === 'live' ? row.risk.score : undefined;
    default:
      // An upcoming market has none of the venue's figures: unknown, so last.
      return row.status === 'live' ? row[key] : undefined;
  }
}

/**
 * A stable sort with UNKNOWNS LAST in either direction: a market with no mark is
 * not the cheapest market, one with no funding event is not the calmest, and an
 * upcoming market's "—" is not a zero. Ties break by market id so the order never
 * flickers between polls.
 */
export function sortRows<R extends TableRow>(rows: readonly R[], key: SortKey, direction: SortDirection): readonly R[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === undefined && vb === undefined) return a.marketId - b.marketId;
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : Number(va) - Number(vb);
    return cmp === 0 ? a.marketId - b.marketId : cmp * sign;
  });
}

// ── markets not yet trading ─────────────────────────────────────────────────

/**
 * Listed on chain, absent from the venue's context, and NEVER TRADED: the
 * markets that are coming. The rule reads the data rather than naming ids, so a
 * new listing appears here on its own and leaves when the venue opens it.
 *
 * A market the context omits that HAS traded is retired (SOL v1) and is left out
 * entirely. "Coming" is the venue's call, not ours: a market is shown with its
 * listing date, and the page does not claim to know when it opens. The only
 * exceptions are named, not inferred: see EXCLUDED_MARKETS.
 */
export function upcomingMarkets(listings: readonly MarketListing[]): readonly MarketListing[] {
  return listings
    .filter((m) => m.market.symbol === undefined && m.tradesAllTime === 0 && !isExcludedMarket(m.market.marketId))
    .sort((a, b) => a.market.marketId - b.market.marketId);
}
