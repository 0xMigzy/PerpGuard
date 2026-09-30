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
 * NOTHING IS CACHED HERE. `GET /health` rebuilds its report per request for the
 * same reason, and a cached analytics response is a snapshot of how things were
 * presented as how they are. The one exception is TVL, cached inside `TvlProbe`
 * with a short TTL because it costs an RPC round trip — and it carries its own
 * `asOfMs` so the age is visible rather than implied.
 */
import type { FastifyInstance } from 'fastify';
import {
  TIMEFRAMES,
  TRADER_SORT_KEYS,
  type AccountLookup,
  type Analytics,
  type AssessedPositions,
  type IndexerHealth,
  type OpenPosition,
  type MarketOpenInterest,
  type RiskSnapshot,
  type SortDirection,
  type Timeframe,
  type TraderSortKey,
  type WalletLookup,
} from '@perpguard/shared';

export interface AnalyticsRouteOptions {
  readonly analytics: Analytics;
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
  readonly generatedAtMs: number;
}

/** An `0x`-prefixed 20-byte address. Case-insensitive, per CLAUDE.md. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

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

  /**
   * Wraps a payload with the health verdict.
   *
   * Health is read on EVERY request rather than once at startup. An indexer that
   * halts after the process booted is exactly the case this exists for, and a
   * cached verdict would report the halt as healthy for as long as the cache lived.
   */
  async function envelope<T>(data: T): Promise<Envelope<T>> {
    const health = await analytics.health();
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
      generatedAtMs: Date.now(),
    };
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
    return envelope(await analytics.protocolMetrics(timeframe));
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

  scope.get(`${prefix}/series`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return envelope(await analytics.dailySeries(timeframe));
  });

  scope.get(`${prefix}/series/markets`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return envelope(await analytics.dailySeriesByMarket(timeframe));
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

  scope.get(`${prefix}/markets`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return envelope(await analytics.marketBreakdown(timeframe));
  });

  scope.get(`${prefix}/funding`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return envelope(await analytics.funding(timeframe));
  });

  /** Forced exits in the window, newest first. Paged like round trips; the reader clamps. */
  scope.get<{ Querystring: { timeframe?: string; limit?: string; offset?: string } }>(
    `${prefix}/liquidations`,
    async (request, reply) => {
      const timeframe = timeframeOf(request.query);
      if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
      return envelope(
        await analytics.liquidations(timeframe, {
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
          ...(offset === undefined || !Number.isFinite(offset) ? {} : { offset }),
        }),
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
      const profile = await analytics.walletByAccountId(accountId);
      if (profile === undefined) {
        // A 404 IS right here, unlike for an address: an account id either exists
        // in the index or it does not, and there is no third reading.
        return reply.code(404).send({ error: `no account ${accountId} in the index` });
      }
      return envelope(profile);
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
    const profile = await analytics.walletByAccountId(accountId);
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
      return envelope(
        await analytics.roundTrips(accountId, {
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
          ...(offset === undefined || !Number.isFinite(offset) ? {} : { offset }),
        }),
      );
    },
  );

  /**
   * The Traders list: sorted and paged in SQL. Sort keys are whitelisted here
   * AND in the reader; a typo is a 400, never a default, for the same reason a
   * bad timeframe is.
   */
  scope.get<{ Querystring: { timeframe?: string; sort?: string; direction?: string; limit?: string; offset?: string } }>(
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
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
      return envelope(
        await analytics.traders(timeframe, {
          ...(sort === undefined ? {} : { sort: sort as TraderSortKey }),
          ...(direction === undefined ? {} : { direction: direction as SortDirection }),
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
          ...(offset === undefined || !Number.isFinite(offset) ? {} : { offset }),
        }),
      );
    },
  );

  /** One account's UTC days in the window: daily PnL, volume, wins, flows. */
  scope.get<{ Params: { accountId: string }; Querystring: { timeframe?: string } }>(`${prefix}/account/:accountId/days`, async (request, reply) => {
    const accountId = Number(request.params.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 0) {
      return reply.code(400).send({ error: `${JSON.stringify(request.params.accountId)} is not an account id` });
    }
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return envelope(await analytics.traderDays(accountId, timeframe));
  });

  /** The finding banded by size and by spare balance. */
  scope.get(`${prefix}/liquidations/summary`, async (request, reply) => {
    const timeframe = timeframeOf(request.query);
    if (typeof timeframe !== 'string') return reply.code(400).send(timeframe);
    return envelope(await analytics.liquidationSummary(timeframe));
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
      `${prefix}/series?timeframe=30d`,
      `${prefix}/series/markets?timeframe=30d`,
      `${prefix}/open-interest`,
      `${prefix}/markets?timeframe=24h`,
      `${prefix}/funding?timeframe=30d`,
      `${prefix}/liquidations?timeframe=30d&limit=50&offset=0`,
      `${prefix}/liquidations/summary?timeframe=30d`,
      `${prefix}/traders?timeframe=30d&sort=netPnl&direction=desc&limit=50&offset=0`,
      `${prefix}/wallet/:address`,
      `${prefix}/account/:accountId`,
      `${prefix}/account/:accountId/positions`,
      `${prefix}/account/:accountId/round-trips?limit=50&offset=0`,
      `${prefix}/account/:accountId/days?timeframe=30d`,
      `${prefix}/risk`,
    ],
  }));
  });

  return app;
}
