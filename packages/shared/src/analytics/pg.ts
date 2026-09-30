/**
 * The Postgres-backed {@link Analytics}. Every query in this codebase lives here.
 *
 * NO `pg` IMPORT, the same as the alert and action logs: this takes a
 * {@link SqlClient} — a `query` method and nothing else — which `pg.Client` and
 * `pg.Pool` both satisfy structurally. So `packages/shared` needs no driver
 * dependency, the tests run against a recording fake, and CI never needs a
 * database.
 *
 * THE ONE RULE THAT SHAPES EVERY QUERY BELOW:
 *
 *   ROLLING WINDOWS COME FROM RAW EVENT ROWS. DAY BUCKETS ARE ONLY FOR DAY SERIES.
 *
 * `MarketDay` ids are `<perpId>-<YYYY-MM-DD>` and `day` is UTC midnight, so
 * `where day >= now() - interval '24 hours'` selects whole buckets whose start is
 * inside the window and gets between 0 and 26 hours of data depending on the time
 * of day. Measured on mainnet at 05:04 UTC: 3.75M AUSD against a true 16.14M,
 * i.e. 0.23x, because only that day's five-hour bucket matched. Volume is the most
 * checkable figure on the page and it cannot be half.
 *
 * So `Trade`, `Liquidation`, `CollateralFlow` and `FundingEvent` are filtered on
 * `timestamp >= $since`, which is exact to the millisecond, and `MarketDay` is
 * used only where a caller has asked for days. This is a rule about the SHAPE of
 * the fix rather than the instance: it removes the bug class, not one query.
 *
 * `all` reads the running totals off `Exchange` instead of scanning 5.5M rows.
 * Verified identical on mainnet: `Exchange.volumeCNS` and `sum(Trade.notionalCNS)`
 * are both 2229336389548745 to the micro.
 */
import { classifyIndexerHealth, type IndexerHealth, type IndexerProgress } from './health.ts';
import {
  bigintOrZero,
  count,
  profitFactor,
  requireMs,
  rescueRate,
  share,
  sideFromRow,
  toAusd,
  toLots,
  toMarketRef,
  toMs,
  toPrice,
  toRatePct,
  windowFor,
  type SymbolResolver,
} from './map.ts';
import type { TvlReading } from './tvl.ts';
import type {
  Analytics,
  CollateralFlowStats,
  FeesForPeriod,
  DailyPoint,
  FundingStats,
  LiquidationStats,
  MarketBreakdown,
  MarketPnl,
  OpenPosition,
  ProtocolMetrics,
  RescueStats,
  RoundTrip,
  Timeframe,
  WalletLookup,
  WalletPerformance,
  WalletProfile,
} from './types.ts';

export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresAnalyticsOptions {
  readonly client: SqlClient;
  readonly chainId: number;
  /** Canonical tickers, keyed by market id. See `symbolResolver`. */
  readonly resolveSymbol: SymbolResolver;
  /**
   * REAL chain head, from something that is not the indexer.
   *
   * Without it `health()` refuses to certify synced. `chain_metadata.block_height`
   * is the indexer's own reading written by the same process, so when that process
   * dies both columns freeze together and the table reports zero blocks behind —
   * the most reassuring possible answer in exactly the case that matters.
   */
  readonly chainHead?: () => Promise<number | undefined>;
  /**
   * Reads TVL off the chain. Absent means `tvl()` reports that it cannot know.
   *
   * Injected rather than constructed here so this class stays a database reader
   * with no opinion about RPC endpoints, and so the tests need no network.
   */
  readonly tvlProbe?: { read(): Promise<TvlReading> };
  readonly now?: () => number;
}

/** Reads `chain_metadata`, which Envio maintains rather than our schema. */
const HEALTH_SQL = `
select latest_processed_block, block_height, num_events_processed, start_block
  from chain_metadata where chain_id = $1
`;

/** Exchange-level running totals. Exact, and the source for `all`. */
const EXCHANGE_SQL = `
select "collateralDecimals", "volumeCNS", "feesCNS", "tradeCount", "accountCount",
       "liquidationCount", "liquidatedNotionalCNS", "rescuableLiquidationCount",
       "liquidationsWithSpareBalanceCount", "liquidationsWithUnknownPositionCount",
       "spareBalanceAtLiquidationCNS", halted
  from "Exchange" limit 1
`;

/**
 * Volume, trades and maker fees over a rolling window, from raw fills.
 *
 * `$1 is null` makes one query serve both a window and all-time, so the two
 * cannot drift apart in a way a test on one would miss.
 */
const WINDOW_TOTALS_SQL = `
select coalesce(sum("notionalCNS"), 0)::text as volume,
       coalesce(sum("makerFeeCNS"), 0)::text  as maker_fees,
       count(*)::text                          as trades
  from "Trade"
 where ($1::timestamptz is null or timestamp >= $1::timestamptz)
`;

/**
 * DISTINCT traders over a window.
 *
 * A trader on three markets is ONE active trader. Summing
 * `MarketDay.activeTraderCount` would call them three, which is the same family
 * of mistake as summing partial buckets: it looks like a total and is not one.
 * `union` (not `union all`) does the deduplication across both sides of a match.
 */
const ACTIVE_TRADERS_SQL = `
select count(*)::text as traders from (
  select maker_id as t from "Trade"
   where ($1::timestamptz is null or timestamp >= $1::timestamptz)
  union
  select taker_id as t from "Trade"
   where ($1::timestamptz is null or timestamp >= $1::timestamptz)
     and taker_id is not null
) x
`;

/**
 * Forced exits and the rescue figures over a window.
 *
 * `wasRescuable` IS NULLABLE AND NULL IS NOT FALSE: it is null for positions
 * opened before the start block, where the state needed to judge them is not
 * knowable. So `rescuable` tests `= true` explicitly and `unknown` counts the
 * nulls, and the rate is taken over the difference. Counting nulls as
 * not-rescuable would be an assertion about rows we cannot see.
 */
const LIQUIDATION_SQL = `
select count(*)::text                                                  as total,
       coalesce(sum("notionalCNS"), 0)::text                           as notional,
       coalesce(sum("marginLostCNS"), 0)::text                          as margin_lost,
       coalesce(sum("badDebtCNS"), 0)::text                             as bad_debt,
       count(*) filter (where "wasRescuable" = true)::text              as rescuable,
       count(*) filter (where "wasRescuable" is null)::text             as unknown,
       count(*) filter (where "hadSpareBalance")::text                  as any_spare,
       coalesce(sum("freeBalanceBeforeCNS"), 0)::text                   as spare_balance
  from "Liquidation"
 where ($1::timestamptz is null or timestamp >= $1::timestamptz)
`;

const COLLATERAL_FLOW_SQL = `
select coalesce(sum("amountCNS") filter (where kind = 'DEPOSIT'), 0)::text    as deposited,
       coalesce(sum("amountCNS") filter (where kind = 'WITHDRAWAL'), 0)::text as withdrawn,
       count(*) filter (where kind = 'DEPOSIT')::text                        as deposits,
       count(*) filter (where kind = 'WITHDRAWAL')::text                     as withdrawals
  from "CollateralFlow"
 where ($1::timestamptz is null or timestamp >= $1::timestamptz)
`;

/**
 * Total fees over whole UTC days.
 *
 * THE ONE PLACE A HEADLINE FIGURE COMES FROM BUCKETS, and it does so because taker
 * fees have no finer timestamp — a taker fill is an aggregate over a whole order.
 * The range is returned alongside the figure so the caller labels it for what it
 * is rather than borrowing the rolling window's name.
 */
const FEES_SQL = `
select coalesce(sum("feesCNS"), 0)::text as fees,
       count(distinct day)::text          as days,
       min(day)                           as from_day
  from "MarketDay"
 where ($1::timestamptz is null or day >= $1::timestamptz)
`;

/** The day series. Buckets ARE the unit here, so they are the right source. */
const DAILY_SQL = `
select day,
       coalesce(sum("volumeCNS"), 0)::text                as volume,
       coalesce(sum("tradeCount"), 0)::text               as trades,
       coalesce(sum("feesCNS"), 0)::text                  as fees,
       coalesce(sum("liquidationCount"), 0)::text         as liquidations,
       coalesce(sum("rescuableLiquidationCount"), 0)::text as rescuable,
       coalesce(sum("oiDeltaCloseLNS"), 0)::text          as oi_close,
       coalesce(max("activeTraderCount"), 0)::text        as max_market_traders
  from "MarketDay"
 where ($1::timestamptz is null or day >= $1::timestamptz)
 group by day order by day asc
`;

/**
 * Per-market figures over a window.
 *
 * The volume/fee/trade columns come from `Trade` rows inside the window; the
 * position counts and the OI delta come off `Market` and `Position`, which are
 * current state rather than windowed. Kept in one query so a caller cannot pair a
 * windowed figure with a stale one by accident, and the type names which is which.
 */
const MARKET_BREAKDOWN_SQL = `
select m.id, m.name, m."priceDecimals", m."lotDecimals",
       m."markPricePNS", m."lastFundingRatePct100k",
       m."openInterestDeltaLNS"::text as oi_delta,
       m."openPositionCount"::text    as open_positions,
       coalesce(t.volume, 0)::text    as volume,
       coalesce(t.fees, 0)::text      as maker_fees,
       coalesce(t.trades, 0)::text    as trades,
       coalesce(l.liquidations, 0)::text as liquidations,
       coalesce(l.rescuable, 0)::text as rescuable,
       coalesce(p.longs, 0)::text     as longs,
       coalesce(p.shorts, 0)::text    as shorts
  from "Market" m
  left join (
    select market_id,
           sum("notionalCNS") as volume,
           sum("makerFeeCNS") as fees,
           count(*)           as trades
      from "Trade"
     where ($1::timestamptz is null or timestamp >= $1::timestamptz)
     group by market_id
  ) t on t.market_id = m.id
  left join (
    select market_id,
           count(*)                                       as liquidations,
           count(*) filter (where "wasRescuable" = true)   as rescuable
      from "Liquidation"
     where ($1::timestamptz is null or timestamp >= $1::timestamptz)
     group by market_id
  ) l on l.market_id = m.id
  left join (
    select market_id,
           count(*) filter (where side = 'LONG')  as longs,
           count(*) filter (where side = 'SHORT') as shorts
      from "Position" where status = 'OPEN'
     group by market_id
  ) p on p.market_id = m.id
 order by (m.id::bigint)
`;

const FUNDING_SQL = `
select f.market_id as id, m.name,
       count(*)::text                                as events,
       avg(f."actualRatePct100k")::text              as mean_rate,
       (array_agg(f."actualRatePct100k" order by f.timestamp desc))[1]::text as last_rate,
       max(f.timestamp)                              as last_at
  from "FundingEvent" f join "Market" m on m.id = f.market_id
 where ($1::timestamptz is null or f.timestamp >= $1::timestamptz)
 group by f.market_id, m.name order by (f.market_id::bigint)
`;

/**
 * Wallet -> account.
 *
 * `lower(owner)`, NOT `owner`. The indexer stores the address exactly as the
 * event gave it, which on mainnet is mixed-case EIP-55 checksummed —
 * `0xB7854953A71e45D1033B3d619E76d56391291765`. An exact comparison against a
 * lowercased input therefore matches nothing, and the failure is invisible: it
 * looks exactly like an address with no linked account, which is the ordinary
 * case here. Found by running the live script, which printed no profile for an
 * address it had just selected as linked.
 *
 * A sequential scan over 1556 rows, so the unused index on `owner` costs
 * nothing. Addresses are case-insensitive and this layer treats them that way.
 */
const TRADER_BY_OWNER_SQL = `select id from "Trader" where lower(owner) = $1 limit 1`;

const TRADER_SQL = `
select id, "accountId", owner, "firstTradeAt", "lastActiveAt",
       "realizedPnlCNS", "fundingCNS", "feesPaidCNS", "netPnlCNS", "volumeCNS",
       "tradeCount", "roundTrips", wins, losses,
       "bestRoundTripCNS", "worstRoundTripCNS",
       "liquidationCount", "rescuableLiquidationCount",
       "liquidationsWithSpareBalanceCount", "spareBalanceAtLiquidationCNS"
  from "Trader" where id = $1
`;

/** A trader's liquidations, for the unknown count the Trader row does not carry. */
const TRADER_LIQUIDATION_SQL = `
select count(*)::text                                      as total,
       count(*) filter (where "wasRescuable" = true)::text  as rescuable,
       count(*) filter (where "wasRescuable" is null)::text as unknown,
       count(*) filter (where "hadSpareBalance")::text      as any_spare,
       coalesce(sum("freeBalanceBeforeCNS"), 0)::text       as spare_balance,
       coalesce(sum("notionalCNS"), 0)::text                as notional,
       coalesce(sum("marginLostCNS"), 0)::text              as margin_lost,
       coalesce(sum("badDebtCNS"), 0)::text                 as bad_debt
  from "Liquidation" where trader_id = $1
`;

const OPEN_POSITIONS_SQL = `
select p.market_id as id, m.name, m."priceDecimals", m."lotDecimals",
       p.side, p."lotLNS"::text, p."entryPricePNS"::text, p."entryPriceKnown",
       p."depositCNS"::text, p."leverageHdths"::text, p."openedAt",
       p."marginAddedCNS"::text
  from "Position" p join "Market" m on m.id = p.market_id
 where p.trader_id = $1 and p.status = 'OPEN'
 order by p."openedAt" desc
`;

/**
 * Round trips, paged, most recent first.
 *
 * PAGED BECAUSE ONE MAINNET ACCOUNT HAS 207,681 OF THEM. A method that returned
 * all of them would be one nobody can call safely, and the limit is applied in
 * SQL rather than after the fact.
 */
const ROUND_TRIPS_SQL = `
select p.market_id as id, m.name, m."priceDecimals", m."lotDecimals",
       p.side, p.status, p."peakLotLNS"::text, p."entryPricePNS"::text,
       p."entryPriceKnown", p."netPnlCNS"::text, p."isWin",
       p."openedAt", p."closedAt"
  from "Position" p join "Market" m on m.id = p.market_id
 where p.trader_id = $1 and p.status <> 'OPEN'
 order by p."closedAt" desc nulls last
 limit $2 offset $3
`;

/**
 * Drawdown, streaks and hold time — computed IN SQL.
 *
 * Deliberately not in TypeScript: a trader with 207,681 closed positions would
 * mean pulling 207,681 rows across the wire to fold them, per page view. The
 * window functions do it in one pass over an index.
 *
 * `running` is cumulative net PnL ordered by close time; `peak` is the running
 * maximum of it; the drawdown is the largest `peak - running`, reported as a
 * positive magnitude and zero when the curve never fell. Streaks come from a gaps
 * -and-islands grouping: `row_number() - row_number() partitioned by outcome` is
 * constant exactly while the outcome does not change.
 */
const WALLET_CURVE_SQL = `
with closed as (
  select "netPnlCNS", "isWin", status, "openedAt", "closedAt",
         row_number() over (order by "closedAt", id) as seq
    from "Position"
   where trader_id = $1 and status <> 'OPEN' and "closedAt" is not null
),
running as (
  select seq, "isWin", "openedAt", "closedAt", "netPnlCNS",
         sum("netPnlCNS") over (order by seq) as cum
    from closed
),
peaks as (
  select cum, max(cum) over (order by seq) as peak from running
),
islands as (
  select "isWin",
         seq - row_number() over (partition by "isWin" order by seq) as island
    from running
),
streaks as (
  select "isWin", count(*)::bigint as len from islands group by "isWin", island
)
select coalesce(max(peak - cum), 0)::text                                    as max_drawdown,
       (select coalesce(max(len), 0) from streaks where "isWin" = true)::text  as win_streak,
       (select coalesce(max(len), 0) from streaks where "isWin" = false)::text as loss_streak,
       (select coalesce(sum("netPnlCNS"), 0) from running where "netPnlCNS" > 0)::text as gross_profit,
       (select coalesce(-sum("netPnlCNS"), 0) from running where "netPnlCNS" < 0)::text as gross_loss,
       (select avg(extract(epoch from ("closedAt" - "openedAt"))) from running)::text  as mean_hold_s
  from peaks
`;

/** Net PnL per market for one trader, for best and worst. */
const WALLET_MARKETS_SQL = `
select p.market_id as id, m.name,
       sum(p."netPnlCNS")::text as net_pnl,
       count(*)::text           as round_trips
  from "Position" p join "Market" m on m.id = p.market_id
 where p.trader_id = $1 and p.status <> 'OPEN'
 group by p.market_id, m.name
`;

const iso = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString();

export class PostgresAnalytics implements Analytics {
  readonly #client: SqlClient;
  readonly #chainId: number;
  readonly #resolve: SymbolResolver;
  readonly #chainHead: (() => Promise<number | undefined>) | undefined;
  readonly #tvlProbe: { read(): Promise<TvlReading> } | undefined;
  readonly #now: () => number;
  /** The last reading whose processed block DIFFERED. See classifyIndexerHealth. */
  #lastProgress: IndexerProgress | undefined;
  #collateralDecimals: number | undefined;

  constructor(options: PostgresAnalyticsOptions) {
    this.#client = options.client;
    this.#chainId = options.chainId;
    this.#resolve = options.resolveSymbol;
    this.#chainHead = options.chainHead;
    this.#tvlProbe = options.tvlProbe;
    this.#now = options.now ?? Date.now;
  }

  async #rows(sql: string, values: readonly unknown[] = []): Promise<Array<Record<string, unknown>>> {
    const result = await this.#client.query(sql, values);
    return result.rows;
  }

  async #one(sql: string, values: readonly unknown[] = []): Promise<Record<string, unknown> | undefined> {
    return (await this.#rows(sql, values))[0];
  }

  /** AUSD decimals, read from the Exchange row once rather than assumed to be 6. */
  async #decimals(): Promise<number> {
    if (this.#collateralDecimals !== undefined) return this.#collateralDecimals;
    const row = await this.#one(EXCHANGE_SQL);
    if (row === undefined) {
      throw new Error(
        'no Exchange row: the indexer has not processed anything yet, so there is no ' +
          'collateral scaling to read. Refusing to assume 6 decimals.',
      );
    }
    this.#collateralDecimals = count(row['collateralDecimals']);
    return this.#collateralDecimals;
  }

  async health(): Promise<IndexerHealth> {
    const row = await this.#one(HEALTH_SQL, [this.#chainId]);
    const observedAtMs = this.#now();
    if (row === undefined) {
      // No row at all: the indexer has never run against this chain. Reported as
      // `unknown` by the classifier rather than as healthy.
      return classifyIndexerHealth(
        {
          chainId: this.#chainId,
          startBlock: 0,
          latestProcessedBlock: 0,
          blockHeight: 0,
          eventsProcessed: 0,
          observedAtMs,
        },
        undefined,
      );
    }

    const head = this.#chainHead === undefined ? undefined : await this.#chainHead();
    const progress: IndexerProgress = {
      chainId: this.#chainId,
      startBlock: count(row['start_block']),
      latestProcessedBlock: count(row['latest_processed_block']),
      blockHeight: count(row['block_height']),
      eventsProcessed: count(row['num_events_processed']),
      ...(head === undefined ? {} : { chainHead: head }),
      observedAtMs,
    };

    const health = classifyIndexerHealth(progress, this.#lastProgress);
    // Only advance the baseline when progress ACTUALLY moved: comparing against
    // the previous poll would find only one interval of stall each time and never
    // cross the halt threshold, so a halt would stay invisible forever.
    if (
      this.#lastProgress === undefined ||
      progress.latestProcessedBlock !== this.#lastProgress.latestProcessedBlock
    ) {
      this.#lastProgress = progress;
    }
    return health;
  }

  async protocolMetrics(timeframe: Timeframe): Promise<ProtocolMetrics> {
    const decimals = await this.#decimals();
    const { sinceMs, untilMs } = windowFor(timeframe, this.#now());
    const since = iso(sinceMs);

    // Fees are asked for over whole days, so the bind is the day boundary rather
    // than the rolling instant. Everything else uses the rolling window.
    const feesSince = sinceMs === undefined ? null : iso(startOfUtcDay(sinceMs));

    const [totals, traders, liquidations, flows, fees] = await Promise.all([
      this.#one(WINDOW_TOTALS_SQL, [since]),
      this.#one(ACTIVE_TRADERS_SQL, [since]),
      this.#one(LIQUIDATION_SQL, [since]),
      this.#one(COLLATERAL_FLOW_SQL, [since]),
      this.#one(FEES_SQL, [feesSince]),
    ]);

    return {
      timeframe,
      sinceMs,
      untilMs,
      volumeAusd: toAusd(totals?.['volume'], decimals),
      tradeCount: count(totals?.['trades']),
      makerFeesAusd: toAusd(totals?.['maker_fees'], decimals),
      fees: this.#fees(fees, decimals, untilMs),
      activeTraders: count(traders?.['traders']),
      liquidations: this.#liquidationStats(liquidations, decimals),
      rescues: this.#rescueStats(liquidations, decimals),
      collateralFlow: this.#flowStats(flows, decimals),
    };
  }

  /**
   * Fees, plus the range they actually cover.
   *
   * `label` is written here rather than in the UI so every surface says the same
   * thing, and so it cannot be rendered under the timeframe's name by accident.
   * `from_day` comes from the data, not from the requested window: if the indexer
   * holds fewer days than were asked for, the label says what is really there.
   */
  #fees(
    row: Record<string, unknown> | undefined,
    decimals: number,
    untilMs: number,
  ): FeesForPeriod {
    const days = count(row?.['days']);
    const fromMs = toMs(row?.['from_day']) ?? startOfUtcDay(untilMs);
    const from = new Date(fromMs).toISOString().slice(0, 10);
    const label =
      days === 0
        ? 'no complete UTC day of fees is indexed yet'
        : days === 1
          ? `the UTC day from ${from} (today so far)`
          : `the ${days} UTC days from ${from} (today so far)`;
    return {
      totalAusd: toAusd(row?.['fees'], decimals),
      fromMs,
      toMs: untilMs,
      days,
      label,
    };
  }

  #liquidationStats(row: Record<string, unknown> | undefined, decimals: number): LiquidationStats {
    return {
      count: count(row?.['total']),
      notionalAusd: toAusd(row?.['notional'], decimals),
      marginLostAusd: toAusd(row?.['margin_lost'], decimals),
      badDebtAusd: toAusd(row?.['bad_debt'], decimals),
    };
  }

  #rescueStats(row: Record<string, unknown> | undefined, decimals: number): RescueStats {
    const total = count(row?.['total']);
    const unknownCount = count(row?.['unknown']);
    const rescuableCount = count(row?.['rescuable']);
    const { judgeableCount, rate } = rescueRate(rescuableCount, total, unknownCount);
    return {
      count: total,
      judgeableCount,
      unknownCount,
      rescuableCount,
      rate,
      spareBalanceAusd: toAusd(row?.['spare_balance'], decimals),
      withAnySpareBalanceCount: count(row?.['any_spare']),
    };
  }

  #flowStats(row: Record<string, unknown> | undefined, decimals: number): CollateralFlowStats {
    const depositedAusd = toAusd(row?.['deposited'], decimals);
    const withdrawnAusd = toAusd(row?.['withdrawn'], decimals);
    return {
      depositedAusd,
      withdrawnAusd,
      netAusd: depositedAusd - withdrawnAusd,
      depositCount: count(row?.['deposits']),
      withdrawalCount: count(row?.['withdrawals']),
    };
  }

  /**
   * Total value locked, from the chain.
   *
   * Requires a probe. Without one this reports `known: false` with a reason rather
   * than falling back to the indexed flow — whose net is negative on mainnet, so a
   * fallback would put a negative TVL on a dashboard.
   */
  async tvl(): Promise<TvlReading> {
    if (this.#tvlProbe === undefined) {
      return {
        known: false,
        reason:
          'no chain RPC is configured for this reader, so the Exchange’s collateral balance ' +
          'cannot be read. Indexed deposit and withdrawal flow is NOT a substitute: accounts ' +
          'held collateral before the start block, so its net is negative.',
        asOfMs: this.#now(),
      };
    }
    return this.#tvlProbe.read();
  }

  async dailySeries(timeframe: Timeframe): Promise<readonly DailyPoint[]> {
    const decimals = await this.#decimals();
    const { sinceMs } = windowFor(timeframe, this.#now());
    // Aligned DOWN to the bucket, because a day series is asked for in days: a
    // partial leading bucket is what a caller wants at the left edge of a chart,
    // and it is labelled with its own day rather than folded into a total.
    const since = sinceMs === undefined ? null : iso(startOfUtcDay(sinceMs));
    const rows = await this.#rows(DAILY_SQL, [since]);

    return rows.map((row) => ({
      dayMs: requireMs(row['day']),
      volumeAusd: toAusd(row['volume'], decimals),
      tradeCount: count(row['trades']),
      // The day bucket IS the unit here, so this is TOTAL fees and is exact —
      // unlike a rolling window, which cannot have them.
      feesAusd: toAusd(row['fees'], decimals),
      // The largest single market's count, NOT a sum: summing per-market counts
      // would multiply-count a trader active on several markets, and the set
      // membership needed to deduplicate is per market per day. A floor, and
      // named as the honest one available from buckets.
      activeTraders: count(row['max_market_traders']),
      liquidationCount: count(row['liquidations']),
      rescuableLiquidationCount: count(row['rescuable']),
      openInterestDeltaLots: Number(bigintOrZero(row['oi_close'])),
    }));
  }

  async marketBreakdown(timeframe: Timeframe): Promise<readonly MarketBreakdown[]> {
    const decimals = await this.#decimals();
    const { sinceMs } = windowFor(timeframe, this.#now());
    const rows = await this.#rows(MARKET_BREAKDOWN_SQL, [iso(sinceMs)]);

    return rows.map((row) => {
      const priceDecimals = count(row['priceDecimals']);
      const lotDecimals = count(row['lotDecimals']);
      const longs = count(row['longs']);
      const shorts = count(row['shorts']);
      return {
        market: toMarketRef(row['id'], row['name'], this.#resolve),
        volumeAusd: toAusd(row['volume'], decimals),
        tradeCount: count(row['trades']),
        feesAusd: toAusd(row['maker_fees'], decimals),
        openPositions: count(row['open_positions']),
        longPositions: longs,
        shortPositions: shorts,
        longShareOfPositions: share(longs, longs + shorts),
        openInterestDeltaLots: toLots(row['oi_delta'], lotDecimals),
        liquidationCount: count(row['liquidations']),
        rescuableLiquidationCount: count(row['rescuable']),
        markPrice: toPrice(row['markPricePNS'], priceDecimals),
        lastFundingRatePct: toRatePct(row['lastFundingRatePct100k']),
      };
    });
  }

  async funding(timeframe: Timeframe): Promise<FundingStats> {
    const { sinceMs } = windowFor(timeframe, this.#now());
    const rows = await this.#rows(FUNDING_SQL, [iso(sinceMs)]);

    const markets = rows.map((row) => ({
      market: toMarketRef(row['id'], row['name'], this.#resolve),
      eventCount: count(row['events']),
      meanRatePct: meanRate(row['mean_rate']),
      lastRatePct: toRatePct(row['last_rate']),
      lastAtMs: toMs(row['last_at']),
    }));

    const eventCount = markets.reduce((sum, m) => sum + m.eventCount, 0);
    // Weighted by event count, so a market with one event does not pull the mean
    // as hard as one with a thousand.
    const weighted = markets.reduce(
      (sum, m) => sum + (m.meanRatePct ?? 0) * m.eventCount,
      0,
    );
    return {
      eventCount,
      meanRatePct: eventCount === 0 ? undefined : weighted / eventCount,
      markets,
    };
  }

  async wallet(address: string): Promise<WalletLookup> {
    const wanted = address.trim().toLowerCase();
    const row = await this.#one(TRADER_BY_OWNER_SQL, [wanted]);
    if (row === undefined) {
      // NOT "no history". Only AccountCreated links a wallet to an account id and
      // most mainnet accounts predate the start block — 1366 of 1556 have no
      // owner recorded — so this is the ordinary case, not a typo.
      return {
        kind: 'not-linked',
        address: wanted,
        reason:
          `no account in the index is linked to ${wanted}. Only the AccountCreated event ties a ` +
          `wallet to an account id, and most accounts were created before the indexer's start ` +
          `block, so their owner is not recorded. This does NOT mean the address has no ` +
          `history — look it up by account id instead.`,
      };
    }
    const profile = await this.walletByAccountId(count(row['id']));
    if (profile === undefined) {
      return { kind: 'not-linked', address: wanted, reason: `account row for ${wanted} vanished mid-read` };
    }
    return { kind: 'found', profile };
  }

  async walletByAccountId(accountId: number): Promise<WalletProfile | undefined> {
    const decimals = await this.#decimals();
    const id = String(accountId);
    const trader = await this.#one(TRADER_SQL, [id]);
    if (trader === undefined) return undefined;

    const [liq, positions, curve, marketPnl] = await Promise.all([
      this.#one(TRADER_LIQUIDATION_SQL, [id]),
      this.#rows(OPEN_POSITIONS_SQL, [id]),
      this.#one(WALLET_CURVE_SQL, [id]),
      this.#rows(WALLET_MARKETS_SQL, [id]),
    ]);

    const roundTrips = count(trader['roundTrips']);
    const wins = count(trader['wins']);
    const losses = count(trader['losses']);
    const byPnl = marketPnl
      .map(
        (row): MarketPnl => ({
          market: toMarketRef(row['id'], row['name'], this.#resolve),
          netPnlAusd: toAusd(row['net_pnl'], decimals),
          roundTrips: count(row['round_trips']),
        }),
      )
      .sort((a, b) => b.netPnlAusd - a.netPnlAusd);

    const meanHoldS = curve?.['mean_hold_s'];
    const performance: WalletPerformance = {
      roundTrips,
      wins,
      losses,
      winRate: share(wins, roundTrips),
      profitFactor: profitFactor(
        toAusd(curve?.['gross_profit'], decimals),
        toAusd(curve?.['gross_loss'], decimals),
      ),
      maxDrawdownAusd: toAusd(curve?.['max_drawdown'], decimals),
      longestWinStreak: count(curve?.['win_streak']),
      longestLossStreak: count(curve?.['loss_streak']),
      averageHoldMs:
        meanHoldS === null || meanHoldS === undefined ? undefined : Number(meanHoldS) * 1000,
      bestRoundTripAusd: toAusd(trader['bestRoundTripCNS'], decimals),
      worstRoundTripAusd: toAusd(trader['worstRoundTripCNS'], decimals),
      bestMarket: byPnl[0],
      worstMarket: byPnl.length > 1 ? byPnl[byPnl.length - 1] : undefined,
    };

    const total = count(liq?.['total']);
    const unknownCount = count(liq?.['unknown']);
    const rescuableCount = count(liq?.['rescuable']);
    const { judgeableCount, rate } = rescueRate(rescuableCount, total, unknownCount);

    return {
      address: String(trader['owner'] ?? ''),
      accountId: count(trader['accountId']),
      firstTradeAtMs: toMs(trader['firstTradeAt']),
      lastActiveAtMs: requireMs(trader['lastActiveAt']),
      openPositions: positions.map((row): OpenPosition => {
        const priceDecimals = count(row['priceDecimals']);
        const lotDecimals = count(row['lotDecimals']);
        return {
          market: toMarketRef(row['id'], row['name'], this.#resolve),
          side: sideFromRow(row['side']),
          sizeLots: toLots(row['lotLNS'], lotDecimals),
          // Undefined rather than wrong when the position predates the start
          // block: `entryPriceKnown` false means the first event we saw carried
          // no price.
          entryPrice: row['entryPriceKnown'] === true ? toPrice(row['entryPricePNS'], priceDecimals) : undefined,
          marginAusd: toAusd(row['depositCNS'], decimals),
          leverage: Number(bigintOrZero(row['leverageHdths'])) / 100,
          openedAtMs: requireMs(row['openedAt']),
          marginAddedAusd: toAusd(row['marginAddedCNS'], decimals),
        };
      }),
      performance,
      rescues: {
        count: total,
        judgeableCount,
        unknownCount,
        rescuableCount,
        rate,
        spareBalanceAusd: toAusd(liq?.['spare_balance'], decimals),
        withAnySpareBalanceCount: count(liq?.['any_spare']),
      },
      realisedPnlAusd: toAusd(trader['realizedPnlCNS'], decimals),
      fundingAusd: toAusd(trader['fundingCNS'], decimals),
      feesPaidAusd: toAusd(trader['feesPaidCNS'], decimals),
      netPnlAusd: toAusd(trader['netPnlCNS'], decimals),
      volumeAusd: toAusd(trader['volumeCNS'], decimals),
      tradeCount: count(trader['tradeCount']),
    };
  }

  async roundTrips(
    accountId: number,
    options: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<readonly RoundTrip[]> {
    const decimals = await this.#decimals();
    // Capped, not merely defaulted: one account has 207,681 of these and a caller
    // passing a huge limit would take the process down rather than the query.
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    const offset = Math.max(0, options.offset ?? 0);
    const rows = await this.#rows(ROUND_TRIPS_SQL, [String(accountId), limit, offset]);

    return rows.map((row): RoundTrip => {
      const priceDecimals = count(row['priceDecimals']);
      const lotDecimals = count(row['lotDecimals']);
      const openedAtMs = requireMs(row['openedAt']);
      const closedAtMs = requireMs(row['closedAt']);
      const status = String(row['status']);
      return {
        market: toMarketRef(row['id'], row['name'], this.#resolve),
        side: sideFromRow(row['side']),
        sizeLots: toLots(row['peakLotLNS'], lotDecimals),
        entryPrice: row['entryPriceKnown'] === true ? toPrice(row['entryPricePNS'], priceDecimals) : undefined,
        netPnlAusd: toAusd(row['netPnlCNS'], decimals),
        openedAtMs,
        closedAtMs,
        holdMs: closedAtMs - openedAtMs,
        wasForcedExit: status !== 'CLOSED',
        isWin: row['isWin'] === true,
      };
    });
  }
}

/** UTC midnight of the day containing `ms`. */
function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** `avg()` over a numeric comes back as a decimal string, not an integer. */
function meanRate(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 100_000 : undefined;
}
