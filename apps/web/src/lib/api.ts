/**
 * The only way a page gets a number.
 *
 * Everything here hits the same origin — `/api/analytics/*` — and Next rewrites
 * it to the backend. The browser never sees a database, the indexer, or the
 * venue. The types come from `@perpguard/shared` as TYPES only, so nothing from
 * the backend's runtime is bundled into the page.
 *
 * READ-ONLY BY CONSTRUCTION. There is no POST, no DELETE and no session here:
 * every call is a GET against public analytics. The backend's action routes
 * exist and are never called from a page — actions live in Telegram.
 */
import type {
  AssessedPositions,
  DailyPoint,
  HistoryCurve,
  IndexerHealth,
  LiquidationRecord,
  LiquidationSummary,
  MarketBreakdown,
  MarketDailySeries,
  MarketOpenInterest,
  ProtocolMetrics,
  RiskSnapshot,
  RoundTrip,
  SortDirection,
  Timeframe,
  TraderDayPoint,
  TraderList,
  TraderSortKey,
  TvlReading,
  WalletLookup,
  WalletMatch,
  WalletProfile,
} from '@perpguard/shared';

/** What every analytics response looks like. Mirrors the backend's envelope. */
export interface Envelope<T> {
  readonly data: T;
  readonly health: IndexerHealth;
  /** True whenever these numbers must not be presented as current. */
  readonly stale: boolean;
  readonly staleReason?: string;
  /** When `data` was computed; `ageMs` is how old it was when served. */
  readonly computedAtMs: number;
  readonly ageMs: number;
  /** True when a newer answer is being computed behind this one. */
  readonly revalidating: boolean;
  readonly generatedAtMs: number;
}

export interface OpenInterestPayload {
  readonly markets: readonly MarketOpenInterest[];
  readonly totalNotional: number;
  readonly asOfMs: number | undefined;
}

export interface WalletSearchPayload {
  readonly query: string;
  readonly matches: readonly WalletMatch[];
  /** The most the backend will list, so the page can say "the first N". */
  readonly limit: number;
}

export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A plain message a page can show. Never a stack trace. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === undefined) {
      return 'The PerpGuard backend could not be reached, so nothing here is current.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function getJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(path, undefined, 'the backend could not be reached');
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(path, response.status, `the backend answered ${response.status} without JSON`);
  }
  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `the backend answered ${response.status}`;
    throw new ApiError(path, response.status, message);
  }
  return parsed as T;
}

/** A POST with a JSON body, same error shape as a GET. The one place the web app writes anything. */
async function postJson<T>(path: string, body: unknown, method: 'POST' | 'DELETE' = 'POST'): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method, cache: 'no-store', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) });
  } catch {
    throw new ApiError(path, undefined, 'the backend could not be reached');
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(path, response.status, `the backend answered ${response.status} without JSON`);
  }
  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String((parsed as { error: unknown }).error) : `the backend answered ${response.status}`;
    throw new ApiError(path, response.status, message);
  }
  return parsed as T;
}

// ── the linking page: the ONE route with a session ──────────────────────────

export interface LinkSessionStatus {
  readonly accountId: number;
  readonly trading: { readonly state: string; readonly reason?: string; readonly forwardingAllowed?: boolean };
  readonly positions: { readonly state: string; readonly reason?: string };
  readonly assessing: boolean;
  readonly tracked: number;
  readonly mismatch?: string;
}

export interface LinkStatus {
  readonly accountId: number;
  readonly proof: 'wallet' | 'key';
  readonly session: LinkSessionStatus | undefined;
  readonly needsRelink?: string;
}

export interface LinkMe {
  readonly telegram: { readonly name: string | null };
  readonly link: LinkStatus | null;
  readonly provenAccountId: number | null;
  readonly dynamicConfigured: boolean;
  readonly keyStorageConfigured: boolean;
  readonly network: string;
}

export type WalletProof =
  | { readonly kind: 'linked'; readonly accountId: number }
  | { readonly kind: 'proven-needs-key'; readonly accountId: number; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };

export type KeyProof =
  | { readonly kind: 'linked'; readonly accountId: number; readonly forwardingAllowed: boolean | undefined }
  | { readonly kind: 'refused'; readonly reason: string };

const L = '/api/link';

export const link = {
  session: (code: string) => postJson<LinkMe>(`${L}/session`, { code }),
  signOut: () => postJson<{ signedOut: boolean }>(`${L}/session`, undefined, 'DELETE'),
  me: () => getJson<LinkMe>(`${L}/me`),
  wallet: (dynamicToken: string) => postJson<{ proof: WalletProof; me: LinkMe }>(`${L}/wallet`, { dynamicToken }),
  /** The key goes to this origin's backend and nowhere else, and is never read back. */
  key: (apiKey: string, secret: string) => postJson<{ proof: KeyProof; me: LinkMe }>(`${L}/key`, { apiKey, secret }),
  unlink: () => postJson<{ ok: boolean; text: string; me: LinkMe }>(`${L}/unlink`, {}),
};

const A = '/api/analytics';

export const api = {
  indexerHealth: () => getJson<Envelope<IndexerHealth>>(`${A}/health`),
  metrics: (t: Timeframe) => getJson<Envelope<ProtocolMetrics>>(`${A}/metrics?timeframe=${t}`),
  tvl: () => getJson<Envelope<TvlReading>>(`${A}/tvl`),
  series: (t: Timeframe) => getJson<Envelope<readonly DailyPoint[]>>(`${A}/series?timeframe=${t}`),
  /** Every UTC month since the index's first event, and where that history starts. */
  history: () => getJson<Envelope<HistoryCurve>>(`${A}/history`),
  seriesByMarket: (t: Timeframe) =>
    getJson<Envelope<readonly MarketDailySeries[]>>(`${A}/series/markets?timeframe=${t}`),
  openInterest: () => getJson<Envelope<OpenInterestPayload>>(`${A}/open-interest`),
  markets: (t: Timeframe) => getJson<Envelope<readonly MarketBreakdown[]>>(`${A}/markets?timeframe=${t}`),
  liquidations: (t: Timeframe, limit: number, offset = 0) =>
    getJson<Envelope<readonly LiquidationRecord[]>>(`${A}/liquidations?timeframe=${t}&limit=${limit}&offset=${offset}`),
  /** By address, any case. `not-linked` is an ordinary 200 answer, not an error. */
  wallet: (address: string) => getJson<Envelope<WalletLookup>>(`${A}/wallet/${encodeURIComponent(address)}`),
  /** By address prefix, `0x` plus 3 to 39 hex characters. No match is an ordinary empty list. */
  walletSearch: (prefix: string) => getJson<Envelope<WalletSearchPayload>>(`${A}/wallet-search?q=${encodeURIComponent(prefix)}`),
  /** By account id. A missing account is a 404, which surfaces as an ApiError with status 404. */
  account: (accountId: number) => getJson<Envelope<WalletProfile>>(`${A}/account/${accountId}`),
  accountPositions: (accountId: number) => getJson<Envelope<AssessedPositions>>(`${A}/account/${accountId}/positions`),
  roundTrips: (accountId: number, limit: number, offset = 0) =>
    getJson<Envelope<readonly RoundTrip[]>>(`${A}/account/${accountId}/round-trips?limit=${limit}&offset=${offset}`),
  /** The account's UTC days in the window, oldest first. */
  accountDays: (accountId: number, t: Timeframe) => getJson<Envelope<readonly TraderDayPoint[]>>(`${A}/account/${accountId}/days?timeframe=${t}`),
  /** Sorted and paged by the backend; the page never re-sorts a page. */
  traders: (t: Timeframe, sort: TraderSortKey, direction: SortDirection, limit: number, offset: number) =>
    getJson<Envelope<TraderList>>(`${A}/traders?timeframe=${t}&sort=${sort}&direction=${direction}&limit=${limit}&offset=${offset}`),
  liquidationSummary: (t: Timeframe) => getJson<Envelope<LiquidationSummary>>(`${A}/liquidations/summary?timeframe=${t}`),
  /** A point-in-time snapshot. No timeframe: the payload carries its block. */
  risk: () => getJson<Envelope<RiskSnapshot>>(`${A}/risk`),
};
