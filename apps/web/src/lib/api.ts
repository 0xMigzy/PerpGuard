/**
 * The only way a page gets a number.
 *
 * Everything here hits the same origin — `/api/analytics/*` and `/health` — and
 * Next rewrites those to the backend. The browser never sees a database, the
 * indexer, or the venue. The types come from `@perpguard/shared` as TYPES only,
 * so nothing from the backend's runtime is bundled into the page.
 */
import type { Prepared, PrepareRequest, ProtectProgress, ProtectSession, ProtectSnapshot, ProtectStress } from '@perpguard/backend/protect';
import type {
  AssessedPositions,
  DailyPoint,
  IndexerHealth,
  LiquidationRecord,
  MarketBreakdown,
  MarketDailySeries,
  MarketOpenInterest,
  ProtocolMetrics,
  RoundTrip,
  Timeframe,
  TvlReading,
  WalletLookup,
  WalletProfile,
} from '@perpguard/shared';

/** What every analytics response looks like. Mirrors the backend's envelope. */
export interface Envelope<T> {
  readonly data: T;
  readonly health: IndexerHealth;
  /** True whenever these numbers must not be presented as current. */
  readonly stale: boolean;
  readonly staleReason?: string;
  readonly generatedAtMs: number;
}

export interface OpenInterestPayload {
  readonly markets: readonly MarketOpenInterest[];
  readonly totalNotional: number;
  readonly asOfMs: number | undefined;
}

/** The backend's `/health` report, the parts the header and pages read. */
export interface ComponentReport {
  readonly state: 'ok' | 'degraded' | 'not-configured';
  readonly detail?: string;
  readonly [key: string]: unknown;
}

export interface HealthReport {
  readonly status: 'OK' | 'DEGRADED';
  readonly network: string;
  readonly at: string;
  readonly reasons: readonly string[];
  readonly components: {
    readonly process: ComponentReport;
    readonly feed: ComponentReport & { readonly connection?: string };
    readonly positions: ComponentReport & { readonly source?: string; readonly ageMs?: number };
    readonly trading: ComponentReport;
    readonly alerts: ComponentReport;
    readonly indexer: ComponentReport & { readonly indexer?: string; readonly blocksBehind?: number };
    readonly risk: ComponentReport;
  };
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
  // `/health` answers 503 with a full report when degraded; that is data, not
  // an error. Only an unparseable body or a 4xx is an error here.
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(path, response.status, `the backend answered ${response.status} without JSON`);
  }
  if (!response.ok && !(path === '/health' && response.status === 503)) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `the backend answered ${response.status}`;
    throw new ApiError(path, response.status, message);
  }
  return parsed as T;
}

/** A JSON body in, JSON out. Same origin, so the session cookie rides along. */
async function sendJson<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(path, undefined, 'the backend could not be reached');
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(path, response.status, `the backend answered ${response.status} without JSON`);
  }
  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed ? String((parsed as { error: unknown }).error) : `the backend answered ${response.status}`;
    throw new ApiError(path, response.status, message);
  }
  return parsed as T;
}

const A = '/api/analytics';
const P = '/api/protect';

/** The session-gated Protect API. A 401 surfaces as an ApiError with status 401. */
export const protect = {
  me: () => getJson<ProtectSession>(`${P}/me`),
  signIn: (code: string) => sendJson<ProtectSession>('POST', `${P}/session`, { code }),
  signOut: () => sendJson<{ signedOut: boolean }>('DELETE', `${P}/session`),
  positions: () => getJson<ProtectSnapshot & { readonly notes: readonly string[] }>(`${P}/positions`),
  prepare: (request: PrepareRequest) => sendJson<Prepared>('POST', `${P}/prepare`, request),
  execute: (token: string) => sendJson<{ idempotencyKey: string }>('POST', `${P}/execute`, { token }),
  progress: (key: string) => getJson<ProtectProgress>(`${P}/actions/${encodeURIComponent(key)}`),
  stress: (priceMoveFraction: number) => sendJson<ProtectStress>('POST', `${P}/stress`, { priceMoveFraction }),
};

export const api = {
  health: () => getJson<HealthReport>('/health'),
  metrics: (t: Timeframe) => getJson<Envelope<ProtocolMetrics>>(`${A}/metrics?timeframe=${t}`),
  tvl: () => getJson<Envelope<TvlReading>>(`${A}/tvl`),
  series: (t: Timeframe) => getJson<Envelope<readonly DailyPoint[]>>(`${A}/series?timeframe=${t}`),
  seriesByMarket: (t: Timeframe) =>
    getJson<Envelope<readonly MarketDailySeries[]>>(`${A}/series/markets?timeframe=${t}`),
  openInterest: () => getJson<Envelope<OpenInterestPayload>>(`${A}/open-interest`),
  markets: (t: Timeframe) => getJson<Envelope<readonly MarketBreakdown[]>>(`${A}/markets?timeframe=${t}`),
  liquidations: (t: Timeframe, limit: number, offset = 0) =>
    getJson<Envelope<readonly LiquidationRecord[]>>(`${A}/liquidations?timeframe=${t}&limit=${limit}&offset=${offset}`),
  /** By address, any case. `not-linked` is an ordinary 200 answer, not an error. */
  wallet: (address: string) => getJson<Envelope<WalletLookup>>(`${A}/wallet/${encodeURIComponent(address)}`),
  /** By account id. A missing account is a 404, which surfaces as an ApiError with status 404. */
  account: (accountId: number) => getJson<Envelope<WalletProfile>>(`${A}/account/${accountId}`),
  accountPositions: (accountId: number) => getJson<Envelope<AssessedPositions>>(`${A}/account/${accountId}/positions`),
  roundTrips: (accountId: number, limit: number, offset = 0) =>
    getJson<Envelope<readonly RoundTrip[]>>(`${A}/account/${accountId}/round-trips?limit=${limit}&offset=${offset}`),
};
