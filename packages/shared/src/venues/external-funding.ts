/**
 * Funding on OTHER venues, for comparing against Perpl: Hyperliquid and
 * Binance USD-M. Read-only public endpoints, called from the backend only.
 *
 * Measured and documented 5 Oct 2026 (docs/notes/perpl-funding-interval-2026-10-05.md):
 *
 * - HYPERLIQUID pays every hour, one eighth of an 8-hour rate. `metaAndAssetCtxs`
 *   serves that HOURLY rate as `funding`: its estimate for the hour in
 *   progress. 72 of 72 gaps in fundingHistory were exactly 1 h. Its formula
 *   carries an interest term of 0.01% per 8 h (docs); the API does not serve it.
 * - BINANCE pays per symbol every `fundingIntervalHours` (/fapi/v1/fundingInfo,
 *   8 h or 4 h on the markets Perpl lists). `premiumIndex.lastFundingRate` is
 *   the live estimate for the NEXT settlement, per interval, despite the name.
 *   `fundingInfo` lists only ADJUSTED symbols and the docs state no default,
 *   so a symbol absent from it is timed from its own settlement history and
 *   never assumed to be 8 h. `interestRate` is per 8 h and per symbol (0 on
 *   some), scaled to the interval: a quiet 4 h symbol pays 0.005%.
 *
 * MARKET IDENTITY: a ticker match is not proof (LIT is Lighter on Perpl, and was
 * Litentry on more than one exchange). A quote whose mark is more than
 * `SAME_ASSET_TOLERANCE` away from Perpl's is reported as a different asset,
 * never compared.
 */

export type FundingVenueId = 'hyperliquid' | 'binance';

export const FUNDING_VENUES: readonly FundingVenueId[] = ['hyperliquid', 'binance'];

export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const BINANCE_FAPI_URL = 'https://fapi.binance.com';

/** Hyperliquid's docs: "paid every hour". Constant across coins, measured 72 of 72. */
export const HYPERLIQUID_FUNDING_INTERVAL_SEC = 3_600;
/** Hyperliquid's docs: the interest component is 0.01% every 8 hours. Not served by the API. */
export const HYPERLIQUID_INTEREST_PCT_PER_8H = 0.01;

/** A mark more than 5% from Perpl's is a different asset under the same ticker. */
export const SAME_ASSET_TOLERANCE = 0.05;

const YEAR_SEC = 365 * 86_400;
const EIGHT_HOURS_SEC = 8 * 3_600;

/** One instrument's funding, as its venue states it. */
export interface ExternalFundingQuote {
  readonly venue: FundingVenueId;
  /** The venue's own instrument name: `BTC`, `BTCUSDT`. */
  readonly instrument: string;
  /** The base ticker it is matched on: `BTC`. */
  readonly ticker: string;
  /** The rate per settlement, in percent. */
  readonly ratePct: number;
  /** Seconds between settlements; undefined when neither stated nor measurable. */
  readonly intervalSec: number | undefined;
  /** `stated` by the venue (API or docs), or `measured` from its settlement history. */
  readonly intervalSource: 'stated' | 'measured' | undefined;
  /** The interest term in the venue's formula, percent per 8 hours. */
  readonly interestPctPer8h: number;
  readonly markPrice: number;
}

export interface ExternalFundingSnapshot {
  readonly venue: FundingVenueId;
  readonly quotes: readonly ExternalFundingQuote[];
}

/** What one venue's cell for one Perpl market is. */
export type VenueFundingCell =
  | {
      readonly kind: 'quote';
      readonly instrument: string;
      readonly ratePct: number;
      readonly intervalSec: number | undefined;
      readonly intervalSource: 'stated' | 'measured' | undefined;
      /** Simple APR of the rate, percent; undefined when the interval is unknown. */
      readonly aprPct: number | undefined;
      /** The interest term's share of `aprPct`, percent: what like-for-like strips. */
      readonly interestAprPct: number;
      readonly markPrice: number;
    }
  /** The venue lists no instrument under this ticker. An empty cell, never 0. */
  | { readonly kind: 'not-listed' }
  /** Same ticker, different price: not the same asset, so not compared. */
  | { readonly kind: 'different-asset'; readonly instrument: string; readonly markPrice: number }
  /** The venue could not be read; its status says since when. */
  | { readonly kind: 'unavailable' };

export interface VenueFundingStatus {
  /** `unavailable`: no good read within the window, so nothing from it is shown. */
  readonly state: 'ok' | 'unavailable';
  /** When the figures served (or last held) were fetched. */
  readonly lastGoodAtMs: number | undefined;
  /** Present when the latest attempt failed. Safe to render. */
  readonly error?: string;
}

export interface VenueFundingMarket {
  readonly marketId: number;
  /** Perpl's canonical ticker, from the context. */
  readonly symbol: string;
  readonly perplMarkPrice: number;
  readonly venues: Readonly<Record<FundingVenueId, VenueFundingCell>>;
}

/** What `/funding/venues` serves. */
export interface VenueFundingPayload {
  readonly markets: readonly VenueFundingMarket[];
  readonly venues: Readonly<Record<FundingVenueId, VenueFundingStatus>>;
}

/** Simple APR in percent: rate per settlement × settlements a year. */
export function fundingAprPct(ratePct: number, intervalSec: number | undefined): number | undefined {
  return intervalSec === undefined || intervalSec <= 0 ? undefined : ratePct * (YEAR_SEC / intervalSec);
}

const num = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN);

/** `POST /info {"type":"metaAndAssetCtxs"}`: `[meta, assetCtxs]`, index-aligned. Delisted coins are dropped. */
export function parseHyperliquidFunding(body: unknown): ExternalFundingSnapshot {
  if (!Array.isArray(body) || body.length < 2) throw new Error('hyperliquid: metaAndAssetCtxs is not [meta, ctxs]');
  const universe = (body[0] as { universe?: unknown })?.universe;
  const ctxs = body[1];
  if (!Array.isArray(universe) || !Array.isArray(ctxs) || universe.length !== ctxs.length) throw new Error('hyperliquid: universe and ctxs do not align');
  const quotes: ExternalFundingQuote[] = [];
  universe.forEach((u: { name?: unknown; isDelisted?: unknown }, i) => {
    const ctx = ctxs[i] as { funding?: unknown; markPx?: unknown };
    if (typeof u?.name !== 'string' || u.isDelisted === true) return;
    const rate = num(ctx?.funding);
    const mark = num(ctx?.markPx);
    if (!Number.isFinite(rate) || !Number.isFinite(mark) || mark <= 0) return;
    quotes.push({
      venue: 'hyperliquid',
      instrument: u.name,
      ticker: u.name,
      ratePct: rate * 100,
      intervalSec: HYPERLIQUID_FUNDING_INTERVAL_SEC,
      intervalSource: 'stated',
      interestPctPer8h: HYPERLIQUID_INTEREST_PCT_PER_8H,
      markPrice: mark,
    });
  });
  return { venue: 'hyperliquid', quotes };
}

/**
 * `GET /fapi/v1/premiumIndex` (every symbol) with `GET /fapi/v1/fundingInfo`.
 * USDT-margined only, the venue's main book. `measured` fills the interval for
 * a symbol fundingInfo does not list; without either it stays undefined.
 */
export function parseBinanceFunding(premiumIndex: unknown, fundingInfo: unknown, measured: ReadonlyMap<string, number> = new Map()): ExternalFundingSnapshot {
  if (!Array.isArray(premiumIndex)) throw new Error('binance: premiumIndex is not an array');
  if (!Array.isArray(fundingInfo)) throw new Error('binance: fundingInfo is not an array');
  const hours = new Map<string, number>();
  for (const r of fundingInfo as { symbol?: unknown; fundingIntervalHours?: unknown }[]) {
    const h = num(r?.fundingIntervalHours);
    if (typeof r?.symbol === 'string' && Number.isFinite(h) && h > 0) hours.set(r.symbol, h);
  }
  const quotes: ExternalFundingQuote[] = [];
  for (const r of premiumIndex as { symbol?: unknown; lastFundingRate?: unknown; interestRate?: unknown; markPrice?: unknown }[]) {
    if (typeof r?.symbol !== 'string' || !r.symbol.endsWith('USDT')) continue;
    const rate = num(r.lastFundingRate);
    const interest = num(r.interestRate);
    const mark = num(r.markPrice);
    if (!Number.isFinite(rate) || !Number.isFinite(mark) || mark <= 0) continue;
    const stated = hours.get(r.symbol);
    const fromHistory = measured.get(r.symbol);
    quotes.push({
      venue: 'binance',
      instrument: r.symbol,
      ticker: r.symbol.slice(0, -'USDT'.length),
      ratePct: rate * 100,
      intervalSec: stated !== undefined ? stated * 3_600 : fromHistory,
      intervalSource: stated !== undefined ? 'stated' : fromHistory !== undefined ? 'measured' : undefined,
      interestPctPer8h: Number.isFinite(interest) ? interest * 100 : 0,
      markPrice: mark,
    });
  }
  return { venue: 'binance', quotes };
}

/** Median gap between settlement times, in seconds; undefined under two settlements. */
export function measuredIntervalSec(fundingTimesMs: readonly number[]): number | undefined {
  const t = [...fundingTimesMs].sort((a, b) => a - b);
  const gaps = t.slice(1).map((v, i) => (v - t[i]!) / 1000).sort((a, b) => a - b);
  if (gaps.length === 0) return undefined;
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

/**
 * One venue's cell for one Perpl market: matched on the ticker
 * (case-insensitively), confirmed by price.
 */
export function venueCell(ticker: string, perplMarkPrice: number, quotes: readonly ExternalFundingQuote[]): VenueFundingCell {
  const q = quotes.find((x) => x.ticker.toUpperCase() === ticker.toUpperCase());
  if (q === undefined) return { kind: 'not-listed' };
  if (!(perplMarkPrice > 0) || Math.abs(q.markPrice / perplMarkPrice - 1) > SAME_ASSET_TOLERANCE) {
    return { kind: 'different-asset', instrument: q.instrument, markPrice: q.markPrice };
  }
  return {
    kind: 'quote',
    instrument: q.instrument,
    ratePct: q.ratePct,
    intervalSec: q.intervalSec,
    intervalSource: q.intervalSource,
    aprPct: fundingAprPct(q.ratePct, q.intervalSec),
    interestAprPct: q.interestPctPer8h * (YEAR_SEC / EIGHT_HOURS_SEC),
    markPrice: q.markPrice,
  };
}

const DEFAULT_TIMEOUT_MS = 8_000;

export interface ExternalFundingFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

async function json(response: Response, what: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`);
  return response.json();
}

export async function fetchHyperliquidFunding(options: ExternalFundingFetchOptions = {}): Promise<ExternalFundingSnapshot> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  return parseHyperliquidFunding(await json(response, 'hyperliquid metaAndAssetCtxs'));
}

/**
 * Two requests (weight 10 + 1), plus one history read (weight 1) for each
 * WANTED ticker whose USDT symbol fundingInfo does not list.
 */
export async function fetchBinanceFunding(wantedTickers: readonly string[], options: ExternalFundingFetchOptions = {}): Promise<ExternalFundingSnapshot> {
  const doFetch = options.fetchImpl ?? fetch;
  const get = async (path: string) => json(await doFetch(`${BINANCE_FAPI_URL}${path}`, { signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) }), `binance ${path.split('?')[0]}`);
  const [premiumIndex, fundingInfo] = await Promise.all([get('/fapi/v1/premiumIndex'), get('/fapi/v1/fundingInfo')]);
  const listed = new Set(Array.isArray(fundingInfo) ? (fundingInfo as { symbol?: unknown }[]).map((r) => r?.symbol) : []);
  const present = new Set(Array.isArray(premiumIndex) ? (premiumIndex as { symbol?: unknown }[]).map((r) => r?.symbol) : []);
  const toMeasure = wantedTickers.map((t) => `${t.toUpperCase()}USDT`).filter((s) => present.has(s) && !listed.has(s));
  const measured = new Map<string, number>();
  await Promise.all(
    toMeasure.map(async (symbol) => {
      try {
        const history = await get(`/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=10`);
        const times = Array.isArray(history) ? (history as { fundingTime?: unknown }[]).map((h) => num(h?.fundingTime)).filter(Number.isFinite) : [];
        const interval = measuredIntervalSec(times);
        if (interval !== undefined) measured.set(symbol, interval);
      } catch {
        // Unmeasured: the cell says the interval is unknown rather than assuming 8 h.
      }
    }),
  );
  return parseBinanceFunding(premiumIndex, fundingInfo, measured);
}
