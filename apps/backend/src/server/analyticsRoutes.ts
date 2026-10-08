/**
 * The analytics HTTP surface.
 *
 * EVERY RESPONSE CARRIES THE INDEXER'S HEALTH, in an envelope, and that is the
 * single design decision this file is built around. Same rule as the price feed:
 * analytics that has gone blind must never look healthy. A dashboard reading these
 * endpoints has to be able to render "these numbers are frozen" without making a
 * second request to find out, because a client that has to ask separately is a
 * client that will forget to.
 *
 * SO WHY 200 AND NOT 503. A halted indexer's figures are real but frozen, and the
 * product rule everywhere else is to keep the last known state visible and say
 * plainly that the feed is down — a blank dashboard helps nobody. So the data is
 * served with `stale: true` and the health block attached, and the machine-readable
 * gate stays where machines already look: `GET /health`, which does return 503.
 *
 * INDEXED ANSWERS ARE CACHED, STALE-WHILE-REVALIDATE, AND SAY HOW OLD THEY ARE.
 * A 30-day protocol window is five aggregate scans over millions of fill rows,
 * run twice for the previous-period comparison: 3.6s alone, 5s with a page's
 * other calls queued behind it, measured. Nothing in it changes faster than a
 * block and a page polls every 30s, so each response serves the last computed
 * answer immediately and refreshes it behind the reader once it is past its
 * TTL. `computedAtMs`, `ageMs` and `revalidating` travel in the envelope, so a
 * page can say "computed 40s ago" instead of presenting a snapshot as the
 * present — the same honesty the `stale` flag already carries for the indexer.
 * The indexer-health verdict itself is cached for two seconds for the same
 * reason: it was a chain RPC per request, and queued behind the scans.
 *
 * Chain reads keep their own short caches and their own `asOfMs`: TVL inside
 * `TvlProbe`, open interest in the venue context, the risk snapshot in its source.
 */
import type { FastifyInstance } from 'fastify';
import {
  TIMEFRAMES,
  TRADER_RANKINGS,
  TRADER_SORT_KEYS,
  type AccountLookup,
  type Analytics,
  type AssessedPositions,
  type IndexerHealth,
  type LeverageBaseline,
  type VenueFundingPayload,
  type ProtocolTreasuryDays,
  type OpenPosition,
  type MarketOpenInterest,
  type RiskSnapshot,
  type SortDirection,
  type Timeframe,
  type TraderRanking,
  type TraderSortKey,
  type WalletLookup,
  type WalletMatch,
} from '@perpguard/shared';
import { SwrCache } from './responseCache.ts';
import type { InfrastructureFacts } from './infrastructure.ts';
import type { FillDirections } from './fillDirections.ts';

export interface AnalyticsRouteOptions {
  readonly analytics: Analytics;
  /** Static facts for the Data & Methodology page; the cache and health TTLs are added here. No query. */
  readonly infrastructure?: () => Omit<InfrastructureFacts, 'cacheTtlMs' | 'healthTtlMs'>;
  /**
   * The stale-while-revalidate cache for indexed answers. Supplied by the
   * process so it can warm the default views at boot and keep them warm; a
   * fresh one is made when absent, which is what the tests get.
   */
  readonly cache?: SwrCache;
  /** How long an indexed answer is served without a refresh behind it. */
  readonly cacheTtlMs?: number;
  /**
   * The TTL for the default views the process warms itself (`defaultWarmEntries`):
   * a little past its warm interval, so a reader never triggers the scan the warm
   * pass is about to run anyway. Absent, they take `cacheTtlMs` like the rest.
   */
  readonly warmedTtlMs?: number;
  readonly now?: () => number;
  /**
   * The open-interest LEVEL, from the analytics network's venue.
   *
   * Separate from `analytics` because it is a venue read and not an indexer
   * read: the indexer can only produce a delta. When absent the route says so
   * rather than serving the delta under the level's name.
   */
  readonly openInterest?: () => Promise<readonly MarketOpenInterest[]>;
  /**
   * Assesses a wallet's open positions against the analytics network's venue:
   * mark, unrealised PnL, liquidation price, buffer. A venue read plus the pure
   * risk maths, so it lives beside `openInterest` rather than on the reader. When
   * absent the route says so rather than serving positions with invented marks.
   */
  readonly assessPositions?: (positions: readonly OpenPosition[]) => Promise<AssessedPositions>;
  /**
   * Wallet -> account id off the Exchange contract, on the analytics network.
   *
   * THE SAME LOOKUP PROTECT SIGN-IN USES. The index only links a wallet to an
   * account when it saw `AccountCreated`, which is 12% of mainnet accounts; the
   * chain knows every one. When the index says not-linked, this is asked before
   * the page is told so. Absent means the index is the only source.
   */
  readonly lookupAccountOnChain?: (address: string) => Promise<AccountLookup>;
  /**
   * The protocol-wide risk snapshot: every open position under a price shock,
   * with the venue's marks and the chain's insurance balances. A point-in-time
   * read, so it takes no timeframe and carries the block it came from. Absent
   * when no venue is wired on the analytics network.
   */
  readonly riskSnapshot?: () => Promise<RiskSnapshot>;
  /**
   * Perpl's live markets against Hyperliquid's and Binance's funding. External
   * reads, made by the backend only and held in their own store
   * (`VenueFundingStore`): never from the browser. Absent when no venue is
   * wired on the analytics network, since the join needs Perpl's tickers and marks.
   */
  readonly venueFunding?: () => Promise<VenueFundingPayload>;
  /**
   * The protocol treasury's AUSD in and out of the Exchange per day, from the
   * chain-log scan (`pnpm protocol:flows`), not the index. With the indexed
   * collateral flows it rebuilds the exchange balance. Absent: no scan file.
   */
  readonly protocolTreasuryDays?: () => Promise<ProtocolTreasuryDays>;
  /** Labels fills with what they did to the position, from their transactions' receipts. Absent: fills carry no direction. */
  readonly fillDirections?: FillDirections;
  /** Mounted under this prefix. */
  readonly prefix?: string;
}

/** What `/open-interest` serves: the per-market readings and their sum. */
export interface OpenInterestPayload {
  readonly markets: readonly MarketOpenInterest[];
  /** Sum of `openInterestNotional`, in collateral. */
  readonly totalNotional: number;
  /** The OLDEST reading's timestamp: how stale the worst market is. */
  readonly asOfMs: number | undefined;
}

/**
 * What every analytics response looks like.
 *
 * `stale` is the flag a client gates its own rendering on, and it is the INVERSE
 * of `health.serveAsCurrent` rather than a second judgement — one verdict, stated
 * once, in the place a reader will actually look.
 */
interface Envelope<T> {
  readonly data: T;
  readonly health: IndexerHealth;
  /** True whenever these numbers must not be presented as current. */
  readonly stale: boolean;
  /** Present when stale. Safe to render directly. */
  readonly staleReason?: string;
  /** When `data` was COMPUTED. Equal to `generatedAtMs` for an uncached answer. */
  readonly computedAtMs: number;
  /** How old `data` was when served. 0 for an uncached answer. */
  readonly ageMs: number;
  /** True when `data` is past its TTL and a refresh is running behind this response. */
  readonly revalidating: boolean;
  readonly generatedAtMs: number;
}

/**
 * Five minutes (8 Oct 2026; was 20 s). Past it a read is served at once and refreshed
 * behind the reader, and every refresh is a scan: at 20 s each visitor's poll re-scanned
 * millions of rows. The page still says how old the answer is.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
/** The health verdict: one small query plus a chain RPC, and every response wants it. */
const HEALTH_TTL_MS = 2_000;

/** The cross-account leverage baseline moves slowly and costs a full scan. */
/** Transactions whose receipts one fills request may read: a page's worth, or an export's. */
export const FILL_PAGE_DIRECTION_TXS = 500;
export const FILL_EXPORT_DIRECTION_TXS = 2_000;

export const LEVERAGE_BASELINE_TTL_MS = 60 * 60_000;

/**
 * The cache keys and loaders for every indexed answer, in ONE place, so the
 * route that serves a key and the boot-time warm that precomputes it cannot
 * drift apart on how the key is spelled.
 */
export function analyticsLoaders(analytics: Analytics) {
  const entry = <T>(key: string, load: () => Promise<T>) => ({ key, load });
  return {
    metrics: (t: Timeframe) => entry(`metrics:${t}`, () => analytics.protocolMetrics(t)),
    series: (t: Timeframe) => entry(`series:${t}`, () => analytics.dailySeries(t)),
    history: () => entry('history', () => analytics.history()),
    seriesByMarket: (t: Timeframe) => entry(`series-markets:${t}`, () => analytics.dailySeriesByMarket(t)),
    markets: (t: Timeframe) => entry(`markets:${t}`, () => analytics.marketBreakdown(t)),
    funding: (t: Timeframe) => entry(`funding:${t}`, () => analytics.funding(t)),
    fundingSeries: (t: Timeframe) => entry(`funding-series:${t}`, () => analytics.fundingSeries(t)),
    listings: () => entry('market-listings', () => analytics.marketListings()),
    liquidations: (t: Timeframe, limit: number | undefined, offset: number | undefined) =>
      entry(`liquidations:${t}:${limit ?? ''}:${offset ?? ''}`, () =>
        analytics.liquidations(t, { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) }),
      ),
    liquidationSummary: (t: Timeframe) => entry(`liquidation-summary:${t}`, () => analytics.liquidationSummary(t)),
    traders: (
      t: Timeframe,
      sort: TraderSortKey | undefined,
      direction: SortDirection | undefined,
      limit: number | undefined,
      offset: number | undefined,
      ranking?: TraderRanking,
      query?: string,
    ) =>
      entry(`traders:${t}:${sort ?? ''}:${direction ?? ''}:${limit ?? ''}:${offset ?? ''}:${ranking ?? ''}:${query?.toLowerCase() ?? ''}`, () =>
        analytics.traders(t, {
          ...(sort === undefined ? {} : { sort }),
          ...(direction === undefined ? {} : { direction }),
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
          ...(ranking === undefined ? {} : { ranking }),
          ...(query === undefined ? {} : { query }),
        }),
      ),
    traderSummary: (t: Timeframe) => entry(`trader-summary:${t}`, () => analytics.traderSummary(t)),
    profile: (accountId: number) => entry(`account:${accountId}`, () => analytics.walletByAccountId(accountId)),
    fills: (accountId: number, limit: number | undefined, offset: number | undefined) =>
      entry(`fills:${accountId}:${limit ?? ''}:${offset ?? ''}`, () =>
        analytics.accountFills(accountId, { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) }),
      ),
    roundTrips: (accountId: number, limit: number | undefined, offset: number | undefined) =>
      entry(`round-trips:${accountId}:${limit ?? ''}:${offset ?? ''}`, () =>
        analytics.roundTrips(accountId, { ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) }),
      ),
    traderDays: (accountId: number, t: Timeframe) => entry(`trader-days:${accountId}:${t}`, () => analytics.traderDays(accountId, t)),
    insights: (accountId: number) => entry(`insights:${accountId}`, () => analytics.walletInsightFacts(accountId)),
    leverageBaseline: () => entry('leverage-baseline', () => analytics.leverageBaseline()),
    walletSearch: (q: string) => entry(`wallet-search:${q.toLowerCase()}`, () => analytics.walletSearch(q, SEARCH_LIMIT)),
  };
}

/**
 * The answers every first visit asks for, warmed at boot and kept warm: the
 * six sections on their default 30-day window, plus the all-time series the
 * charts draw. Anything else is warmed by its first reader and stays warm
 * while it keeps being read.
 */
export function defaultWarmEntries(analytics: Analytics): ReadonlyArray<{ readonly key: string; readonly load: () => Promise<unknown> }> {
  const l = analyticsLoaders(analytics);
  return [
    l.metrics('30d'),
    // All covers the whole history: the slowest answers, so they are kept warm.
    l.metrics('all'),
    l.liquidationSummary('all'),
    l.history(),
    l.series('30d'),
    l.series('all'),
    l.seriesByMarket('30d'),
    l.seriesByMarket('all'),
    l.markets('30d'),
    l.fundingSeries('30d'),
    l.listings(),
    l.liquidationSummary('30d'),
    l.liquidations('30d', 50, 0),
    l.traders('30d', 'netPnl', 'desc', 50, 0),
    l.traders('30d', undefined, undefined, 50, 0, 'pnl'),
    l.traderSummary('30d'),
  ];
}

/** An `0x`-prefixed 20-byte address. Case-insensitive, per CLAUDE.md. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Part of an address, for the search box: `0x` plus 3 to 39 hex characters.
 * Three is the floor so a search cannot list the whole owner table; a full
 * address is `/wallet/:address`'s job, where the chain is asked too.
 */
const ADDRESS_PREFIX = /^0x[0-9a-fA-F]{3,39}$/;
const SEARCH_LIMIT = 20;

function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * A BIGINT BECOMES A DECIMAL STRING, never a JSON number.
 *
 * `JSON.stringify` THROWS on a bigint, so without this a perfectly valid TVL
 * reading — which carries exact micros alongside the display figure — turns into a
 * 500. And a bigint emitted as a number would be worse than the crash: AUSD micros
 * exceed float64's exact range, so a large figure would arrive silently rounded.
 * Same rule as `amountCNS` in the alert log's jsonb.
 */
function bigintSafe(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  options: AnalyticsRouteOptions,
): FastifyInstance {
  const { analytics } = options;
  const prefix = options.prefix ?? '/api/analytics';
  const now = options.now ?? Date.now;
  const cache = options.cache ?? new SwrCache({ now });
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const loaders = analyticsLoaders(analytics);
  const warmedKeys = new Set(defaultWarmEntries(analytics).map((e) => e.key));
  const ttlFor = (key: string): number => (options.warmedTtlMs !== undefined && warmedKeys.has(key) ? options.warmedTtlMs : ttlMs);

  /**
   * Wraps a payload with the health verdict.
   *
   * Health is read on every request, through a TWO-SECOND cache: an indexer that
   * halts after the process booted is exactly the case this exists for, and two
   * seconds is far inside the halt threshold, while a verdict per request was a
   * chain RPC per request, queued behind the scans it was meant to qualify.
   */
  async function envelope<T>(
    data: T,
    computed: { readonly cachedAtMs: number; readonly ageMs: number; readonly revalidating: boolean } | undefined = undefined,
  ): Promise<Envelope<T>> {
    const health = (await cache.get('health', HEALTH_TTL_MS, () => analytics.health())).value;
    const generatedAtMs = now();
    return {
      data,
      health,
      stale: !health.serveAsCurrent,
      ...(health.serveAsCurrent
        ? {}
        : {
            staleReason:
              health.reason ??
              `the indexer is ${health.state} and ${health.blocksBehind} block(s) behind, so ` +
                `these figures must not be shown as current`,
          }),
      computedAtMs: computed?.cachedAtMs ?? generatedAtMs,
      ageMs: computed?.ageMs ?? 0,
      revalidating: computed?.revalidating ?? false,
      generatedAtMs,
    };
  }

  /** An indexed answer: served from the cache, refreshed behind the reader past its TTL. */
  async function served<T>(entry: { readonly key: string; readonly load: () => Promise<T> }): Promise<Envelope<T>> {
    const hit = await cache.get(entry.key, ttlFor(entry.key), entry.load);
    return envelope(hit.value, hit);
  }

  /**
   * The timeframe from a query string, or a 400.
   *
   * REJECTED RATHER THAN DEFAULTED. A typo silently served as 24h would put one
   * window's numbers under another's label, which is the volume bug wearing a
   * different hat.
   */
  function timeframeOf(query: unknown): Timeframe | { readonly error: string } {
    const raw = (query as { timeframe?: unknown } | undefined)?.timeframe;
    if (raw === undefined) return '24h';
    if (!isTimeframe(raw)) {
      return {
        error:
          `unknown timeframe ${JSON.stringify(raw)}. Use one of ${TIMEFRAMES.join(', ')}. ` +
          `Refusing to default: a typo served as 24h would put one window's numbers under ` +
          `another's label.`,
      };
    }
    return raw;
  }

  // ENCAPSULATED, so the bigint serialiser applies to these routes and not to
  // `/health` next door — a plugin that changed how a sibling route serialises
  // would be a surprising thing to inherit.
  void app.register(async (scope) => {
    scope.setReplySerializer(bigintSafe);

  scope.get(`${prefix}/health`, async () => {
    const health = await analytics.health();
    // The health of the indexer is itself the payload here, so the envelope's copy
    // is the same object. Kept in the envelope anyway so every route has one shape.
    return envelope(health);
  });

  scope.get(`${prefix}/metrics`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.metrics(timeframe));
  });

  /**
   * TVL, from the chain.
   *
   * NOT GATED ON INDEXER HEALTH, and the envelope's `stale` flag does not apply to
   * it: this figure is a `balanceOf` read, so it is current even when the indexer
   * is hours behind. The reading carries its own `known` flag and `asOfMs`, which is
   * what a client should read. The envelope is still attached for shape consistency.
   */
  scope.get(`${prefix}/tvl`, async () => envelope(await analytics.tvl()));

  /** How PerpGuard runs, for /status: configuration only, never a query. The RPC is named by provider domain alone. */
  scope.get(`${prefix}/infrastructure`, async (_request, reply) => {
    const facts = options.infrastructure?.();
    if (facts === undefined) return reply.code(503).send({ error: 'no infrastructure facts are configured on this process.' });
    const payload: InfrastructureFacts = { ...facts, cacheTtlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, healthTtlMs: HEALTH_TTL_MS };
    return envelope(payload);
  });

  scope.get(`${prefix}/history`, async () => served(loaders.history()));

  scope.get(`${prefix}/series`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.series(timeframe));
  });

  scope.get(`${prefix}/series/markets`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.seriesByMarket(timeframe));
  });

  /**
   * Open interest, the LEVEL, from the venue.
   *
   * Like TVL, not an indexer figure and not gated on indexer health: the
   * envelope's `stale` refers to the indexer, and each reading carries its own
   * `atMs`. A 503 when no venue is wired, because there is no honest fallback —
   * the indexer's delta is not a level and must not be served as one.
   */
  scope.get(`${prefix}/open-interest`, async (_request, reply) => {
    const read = options.openInterest;
    if (read === undefined) {
      return reply.code(503).send({
        error:
          'no venue is wired for open interest on the analytics network, so the level is ' +
          'unavailable. The indexer only knows the change since its start block.',
      });
    }
    const markets = await read();
    const payload: OpenInterestPayload = {
      markets,
      totalNotional: markets.reduce((sum, m) => sum + m.openInterestNotional, 0),
      asOfMs: markets.length === 0 ? undefined : Math.min(...markets.map((m) => m.atMs)),
    };
    return envelope(payload);
  });

  scope.get(`${prefix}/exchange-balance/protocol-days`, async (_request, reply) => {
    const read = options.protocolTreasuryDays;
    if (read === undefined) return reply.code(503).send({ error: 'no protocol treasury scan is configured, so the exchange balance cannot be rebuilt from events.' });
    return envelope(await read());
  });

  scope.get(`${prefix}/funding/venues`, async (_request, reply) => {
    const read = options.venueFunding;
    if (read === undefined) {
      return reply.code(503).send({ error: 'no venue is wired on the analytics network, so there are no Perpl markets to compare against other venues.' });
    }
    return envelope(await read());
  });

  scope.get(`${prefix}/markets`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.markets(timeframe));
  });

  scope.get(`${prefix}/funding`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.funding(timeframe));
  });

  /** Every funding rate applied in the window, per market, with their sum. */
  scope.get(`${prefix}/funding/series`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.fundingSeries(timeframe));
  });

  /** Every market the chain lists, with its contract parameters. Not windowed. */
  scope.get(`${prefix}/markets/listings`, async () => served(loaders.listings()));

  /** Forced exits in the window, newest first. Paged like round trips; the reader clamps. */
  scope.get<{ Querystring: { timeframe?: string; limit?: string; offset?: string } }>(
    `${prefix}/liquidations`,
    async (request, reply) => {
      const timeframe = timeframeOf(request.query);
      if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
      return served(
        loaders.liquidations(
          timeframe,
          limit === undefined || !Number.isFinite(limit) ? undefined : limit,
          offset === undefined || !Number.isFinite(offset) ? undefined : offset,
        ),
      );
    },
  );

  /**
   * A wallet by address.
   *
   * RETURNS 200 FOR `not-linked`, not 404. The address is a perfectly valid thing
   * to ask about and the answer is informative — most mainnet accounts have no
   * owner recorded, so "I cannot see which account is yours" is the ORDINARY reply
   * and carries advice about asking by account id. A 404 would read as "no such
   * trader", which is the claim this whole distinction exists to avoid making.
   *
   * A malformed address IS a 400, because that is a client mistake rather than an
   * answer.
   */
  scope.get<{ Params: { address: string } }>(`${prefix}/wallet/:address`, async (request, reply) => {
    const { address } = request.params;
    if (!ADDRESS.test(address)) {
      return reply.code(400).send({
        error: `${JSON.stringify(address)} is not a 0x-prefixed 20-byte address`,
      });
    }
    // Case-insensitive, per CLAUDE.md: a checksummed address pasted from an
    // explorer must resolve, and the failure would otherwise be invisible because
    // "not linked" is the ordinary answer.
    return envelope(await resolveWallet(address));
  });

  /**
   * The index first, the chain second.
   *
   * An address the index cannot link is asked of the Exchange itself, which
   * resolves every account regardless of when it was created. A chain answer
   * that names an account the index holds is a profile, marked `chain` so the
   * page can say how it got there; one the index has never seen is still
   * not-linked, but now with the account id and a reason that says why.
   */
  async function resolveWallet(address: string): Promise<WalletLookup> {
    const indexed = await analytics.wallet(address);
    if (indexed.kind === 'found' || options.lookupAccountOnChain === undefined) return indexed;
    const chain = await options.lookupAccountOnChain(address);
    if (!chain.found) {
      return { ...indexed, reason: `${indexed.reason} The Exchange contract was asked too: ${chain.reason}.` };
    }
    const profile = await analytics.walletByAccountId(chain.accountId);
    if (profile === undefined) {
      return {
        kind: 'not-linked',
        address: indexed.address,
        accountId: chain.accountId,
        reason:
          `the Exchange contract resolves ${indexed.address} to account ${chain.accountId}, but the index holds no ` +
          `activity for that account since its start block. It exists; it has not traded in the indexed window.`,
      };
    }
    // The index never recorded the owner, so the profile's address is empty;
    // the chain just said whose it is, and the page should be able to say so.
    return { kind: 'found', profile: { ...profile, address: profile.address === '' ? indexed.address : profile.address }, resolvedBy: 'chain' };
  }

  /**
   * Owners by address prefix, for a search box given part of an address.
   *
   * An empty list is an ORDINARY 200, like `not-linked`: only accounts whose
   * `AccountCreated` the index saw have an owner at all, so most prefixes match
   * nothing and that is not an error. The hex-only check is also what keeps the
   * bind free of LIKE wildcards.
   */
  scope.get<{ Querystring: { q?: string } }>(`${prefix}/wallet-search`, async (request, reply) => {
    const q = request.query.q ?? '';
    if (!ADDRESS_PREFIX.test(q)) {
      return reply.code(400).send({ error: `${JSON.stringify(q)} is not a 0x-prefixed hex prefix of 3 to 39 characters` });
    }
    const hit = await cache.get(loaders.walletSearch(q).key, ttlMs, loaders.walletSearch(q).load);
    const matches: readonly WalletMatch[] = hit.value;
    return envelope({ query: q, matches, limit: SEARCH_LIMIT }, hit);
  });

  /** A wallet by account id — the handle that works when the owner is unrecorded. */
  scope.get<{ Params: { accountId: string } }>(
    `${prefix}/account/:accountId`,
    async (request, reply) => {
      const accountId = Number(request.params.accountId);
      if (!Number.isSafeInteger(accountId) || accountId < 0) {
        return reply
          .code(400)
          .send({ error: `${JSON.stringify(request.params.accountId)} is not an account id` });
      }
      const hit = await cache.get(loaders.profile(accountId).key, ttlMs, loaders.profile(accountId).load);
      if (hit.value === undefined) {
        // A 404 IS right here, unlike for an address: an account id either exists
        // in the index or it does not, and there is no third reading.
        return reply.code(404).send({ error: `no account ${accountId} in the index` });
      }
      return envelope(hit.value, hit);
    },
  );

  /**
   * The account's open positions, ASSESSED: the profile's rows with the venue's
   * mark and the risk maths applied. A 503 without a venue, like open interest,
   * because a position table with no liquidation price is not this route.
   */
  scope.get<{ Params: { accountId: string } }>(`${prefix}/account/:accountId/positions`, async (request, reply) => {
    const accountId = Number(request.params.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 0) {
      return reply.code(400).send({ error: `${JSON.stringify(request.params.accountId)} is not an account id` });
    }
    const assess = options.assessPositions;
    if (assess === undefined) {
      return reply.code(503).send({
        error: 'no venue is wired on the analytics network, so open positions cannot be priced or given a liquidation price.',
      });
    }
    // The CACHED profile, the one /account/:id serves: rebuilding it per call
    // cost account #10 (a million round trips) 17-22 s every time, to learn
    // which positions are open. The prices are still read fresh on every call.
    const hit = await cache.get(loaders.profile(accountId).key, ttlMs, loaders.profile(accountId).load);
    const profile = hit.value;
    if (profile === undefined) {
      return reply.code(404).send({ error: `no account ${accountId} in the index` });
    }
    return envelope(await assess(profile.openPositions));
  });

  scope.get<{ Params: { accountId: string }; Querystring: { limit?: string; offset?: string } }>(
    `${prefix}/account/:accountId/round-trips`,
    async (request, reply) => {
      const accountId = Number(request.params.accountId);
      if (!Number.isSafeInteger(accountId) || accountId < 0) {
        return reply
          .code(400)
          .send({ error: `${JSON.stringify(request.params.accountId)} is not an account id` });
      }
      // The reader clamps these itself — one account has 207,681 round trips — so
      // an absurd limit is answered rather than refused.
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
      return served(
        loaders.roundTrips(
          accountId,
          limit === undefined || !Number.isFinite(limit) ? undefined : limit,
          offset === undefined || !Number.isFinite(offset) ? undefined : offset,
        ),
      );
    },
  );

  /** One account's fills, newest first, paged; the reader clamps the page (at most 10,000, for a CSV). */
  scope.get<{ Params: { accountId: string }; Querystring: { limit?: string; offset?: string } }>(`${prefix}/account/:accountId/fills`, async (request, reply) => {
    const accountId = Number(request.params.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 0) {
      return reply.code(400).send({ error: `${JSON.stringify(request.params.accountId)} is not an account id` });
    }
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
    const entry = loaders.fills(accountId, limit === undefined || !Number.isFinite(limit) ? undefined : limit, offset === undefined || !Number.isFinite(offset) ? undefined : offset);
    const hit = await cache.get(entry.key, ttlMs, entry.load);
    if (options.fillDirections === undefined) return envelope(hit.value, hit);
    // A page resolves every fill; an export, its newest transactions up to the cap.
    const maxTxs = hit.value.limit > FILL_PAGE_DIRECTION_TXS ? FILL_EXPORT_DIRECTION_TXS : FILL_PAGE_DIRECTION_TXS;
    const named = await options.fillDirections.annotate(accountId, hit.value.fills, maxTxs);
    return envelope({ ...hit.value, fills: named.fills, directions: { blank: named.blank, cappedAtTxs: named.cappedAtTxs } }, hit);
  });

  /**
   * The Traders list: sorted and paged in SQL. Sort keys are whitelisted here
   * AND in the reader; a typo is a 400, never a default, for the same reason a
   * bad timeframe is.
   */
  scope.get(`${prefix}/traders/summary`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.traderSummary(timeframe));
  });

  scope.get<{ Querystring: { timeframe?: string; sort?: string; direction?: string; limit?: string; offset?: string; ranking?: string; q?: string } }>(
    `${prefix}/traders`,
    async (request, reply) => {
      const timeframe = timeframeOf(request.query);
      if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
      const { sort, direction } = request.query;
      if (sort !== undefined && !(TRADER_SORT_KEYS as readonly string[]).includes(sort)) {
        return reply.code(400).send({ error: `unknown sort ${JSON.stringify(sort)}. Use one of ${TRADER_SORT_KEYS.join(', ')}.` });
      }
      if (direction !== undefined && direction !== 'asc' && direction !== 'desc') {
        return reply.code(400).send({ error: `unknown direction ${JSON.stringify(direction)}. Use asc or desc.` });
      }
      const { ranking, q } = request.query;
      if (ranking !== undefined && !(TRADER_RANKINGS as readonly string[]).includes(ranking)) {
        return reply.code(400).send({ error: `unknown ranking ${JSON.stringify(ranking)}. Use one of ${TRADER_RANKINGS.join(', ')}.` });
      }
      const query = q === undefined || q.trim() === '' ? undefined : q.trim().slice(0, 64);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
      return served(
        loaders.traders(
          timeframe,
          sort === undefined ? undefined : (sort as TraderSortKey),
          direction === undefined ? undefined : (direction as SortDirection),
          limit === undefined || !Number.isFinite(limit) ? undefined : limit,
          offset === undefined || !Number.isFinite(offset) ? undefined : offset,
          ranking === undefined ? undefined : (ranking as TraderRanking),
          query,
        ),
      );
    },
  );

  /**
   * One account's computed-insight facts, with the cross-account leverage
   * baseline beside them. The baseline is one pass over every position (~7 s),
   * so it keeps an hour's TTL: stale-while-revalidate means only the very first
   * reader ever waits for it, and nobody waits for a refresh.
   */
  scope.get<{ Params: { accountId: string } }>(`${prefix}/account/:accountId/insights`, async (request, reply) => {
    const accountId = Number(request.params.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 0) {
      return reply.code(400).send({ error: `${JSON.stringify(request.params.accountId)} is not an account id` });
    }
    const facts = await cache.get(loaders.insights(accountId).key, ttlMs, loaders.insights(accountId).load);
    if (facts.value === undefined) return reply.code(404).send({ error: `no account ${accountId} in the index` });
    // NEVER WAIT FOR THE BASELINE. If no answer is cached yet, start one behind
    // this reader and serve the wallet's facts without it: the leverage rule
    // stays silent until the panel's next refresh.
    const b = loaders.leverageBaseline();
    let baseline: (LeverageBaseline & { readonly computedAtMs: number }) | undefined;
    if (cache.ageOf(b.key) === undefined) {
      void cache.get(b.key, LEVERAGE_BASELINE_TTL_MS, b.load).catch(() => undefined);
    } else {
      const hit = await cache.get(b.key, LEVERAGE_BASELINE_TTL_MS, b.load);
      baseline = { ...hit.value, computedAtMs: hit.cachedAtMs };
    }
    return envelope({ facts: facts.value, baseline }, facts);
  });

  /** One account's UTC days in the window: daily PnL, volume, wins, flows. */
  scope.get<{ Params: { accountId: string }; Querystring: { timeframe?: string } }>(`${prefix}/account/:accountId/days`, async (request, reply) => {
    const accountId = Number(request.params.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 0) {
      return reply.code(400).send({ error: `${JSON.stringify(request.params.accountId)} is not an account id` });
    }
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.traderDays(accountId, timeframe));
  });

  /** The finding banded by size and by spare balance. */
  scope.get(`${prefix}/liquidations/summary`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return served(loaders.liquidationSummary(timeframe));
  });

  /**
   * Protocol-wide liquidation exposure. NO TIMEFRAME: it is contract state at
   * one block, and the payload says which. A 503 without a venue, because a
   * stress test with no marks is not this route.
   */
  scope.get(`${prefix}/risk`, async (_request, reply) => {
    const read = options.riskSnapshot;
    if (read === undefined) {
      return reply.code(503).send({
        error: 'no venue is wired on the analytics network, so open positions cannot be priced and there is no exposure to report.',
      });
    }
    return envelope(await read());
  });

  /** What is here, for a human who typed the prefix. */
  scope.get(prefix, async () => ({
    service: 'perpguard-analytics',
    note:
      'every response carries the indexer health and a `stale` flag. When stale is true the ' +
      'figures are real but must not be presented as current.',
    routes: [
      `${prefix}/health`,
      `${prefix}/metrics?timeframe=24h|7d|30d|all`,
      `${prefix}/tvl`,
      `${prefix}/infrastructure`,
      `${prefix}/series?timeframe=30d`,
      `${prefix}/series/markets?timeframe=30d`,
      `${prefix}/open-interest`,
      `${prefix}/markets?timeframe=24h`,
      `${prefix}/funding?timeframe=30d`,
      `${prefix}/funding/venues`,
      `${prefix}/exchange-balance/protocol-days`,
      `${prefix}/liquidations?timeframe=30d&limit=50&offset=0`,
      `${prefix}/liquidations/summary?timeframe=30d`,
      `${prefix}/traders?timeframe=30d&sort=netPnl&direction=desc&limit=50&offset=0`,
      `${prefix}/wallet/:address`,
      `${prefix}/wallet-search?q=0x1234`,
      `${prefix}/account/:accountId`,
      `${prefix}/account/:accountId/positions`,
      `${prefix}/account/:accountId/round-trips?limit=50&offset=0`,
      `${prefix}/account/:accountId/fills?limit=50&offset=0`,
      `${prefix}/account/:accountId/days?timeframe=30d`,
      `${prefix}/risk`,
    ],
  }));
  });

  return app;
}
