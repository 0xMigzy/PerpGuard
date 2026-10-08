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
  bigintOrUndefined,
  bigintOrZero,
  count,
  forcedExitKindFromRow,
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
  fundingUnitsToPct,
  verdictFromRow,
  windowFor,
  type SymbolResolver,
} from './map.ts';
import type { TvlReading } from './tvl.ts';
import { maintenanceMarginRatioFromConfig, maxLeverageFromConfig } from '../units.ts';
import type {
  Analytics,
  CollateralFlowStats,
  FeesForPeriod,
  DailyPoint,
  FundingStats,
  IndexedOpenPosition,
  LiquidationBand,
  LiquidationRecord,
  LiquidationStats,
  LiquidationSummary,
  MarketBreakdown,
  MarketDailyPoint,
  MarketDailySeries,
  MarketFundingSeries,
  MarketListing,
  MarketPnl,
  MarketRef,
  OpenPosition,
  ProtocolMetrics,
  RescueStats,
  RoundTrip,
  SortDirection,
  Timeframe,
  TraderDayPoint,
  TraderList,
  TraderRow,
  TraderRanking,
  TraderSortKey,
  TraderSummary,
  TraderWindow,
  WalletLookup,
  WalletMatch,
  WalletPerformance,
  WalletProfile,
  HistoryCurve,
} from './types.ts';
import type { BackstopHistory } from './exposure.ts';
import { splitWindow, utcDaysIn, type MsRange } from './windowSplit.ts';
import type { ActivityFeed, FeedLiquidation, TakerFill } from './feed.ts';
import type { AccountFill, AccountFillsPage, CollateralTotalsAtBlock, CopySource, CopySourcePosition, CopySourceReader, OpenActivity, LeverageBaseline, WalletInsightFacts } from './types.ts';
import { FLOW_SORT_KEYS, MAX_FILLS_PER_REQUEST, MIN_DEPOSIT_FOR_ROI_AUSD, MIN_ROUND_TRIPS_FOR_RATIOS, MIN_TRADERS_FOR_DISTRIBUTION, TRADER_RANKINGS, TRADER_SORT_KEYS } from './types.ts';

export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresAnalyticsOptions {
  readonly client: SqlClient;
  readonly chainId: number;
  /** Canonical tickers, keyed by market id. See `symbolResolver`. */
  readonly resolveSymbol: SymbolResolver;
  /** `funding_interval_sec` from the venue's context, keyed by market id. Absent: unknown. */
  readonly fundingIntervalSec?: (marketId: number) => number | undefined;
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
/**
 * The rolling window's EDGES, scanned fill by fill: at most two ranges (see
 * `windowSplit.ts`), each absent when its upper bound is null. The whole UTC
 * days between come from `#closedDayTotals`, so the sum is the same rows the
 * old whole-window scan read.
 */
const WINDOW_TOTALS_SQL = `
select coalesce(sum(v), 0)::text as volume,
       coalesce(sum(f), 0)::text as maker_fees,
       coalesce(sum(n), 0)::text as trades
  from (
    select sum("notionalCNS") as v, sum("makerFeeCNS") as f, count(*) as n
      from "Trade"
     where $2::timestamptz is not null
       and ($1::timestamptz is null or timestamp >= $1::timestamptz)
       and timestamp < $2::timestamptz
    union all
    select sum("notionalCNS"), sum("makerFeeCNS"), count(*)
      from "Trade"
     where $4::timestamptz is not null
       and timestamp >= $3::timestamptz
       and timestamp < $4::timestamptz
  ) edges
`;

/** One row per UTC day of fills in [$1, $2): the closed-day sums, read once per day. */
const DAY_TOTALS_SQL = `
select date_trunc('day', timestamp at time zone 'UTC') at time zone 'UTC' as day,
       sum("notionalCNS")::text as volume,
       sum("makerFeeCNS")::text as maker_fees,
       count(*)::text           as trades
  from "Trade"
 where ($1::timestamptz is null or timestamp >= $1::timestamptz)
   and timestamp < $2::timestamptz
 group by 1
`;

/** The first and last indexed fill: two index lookups. A day is final once the index is past its end. */
const TRADE_BOUNDS_SQL = `select min(timestamp) as first, max(timestamp) as through from "Trade"`;

/**
 * DISTINCT traders over a window.
 *
 * A trader on three markets is ONE active trader. Summing
 * `MarketDay.activeTraderCount` would call them three, which is the same family
 * of mistake as summing partial buckets: it looks like a total and is not one.
 * `union` (not `union all`) does the deduplication across both sides of a match.
 *
 * EACH SIDE IS GROUPED BEFORE THE UNION. Without that, Postgres sorts every
 * row of both branches — 9.6M rows for a 30-day window, spilling 80MB to disk —
 * to find ~1,100 distinct ids. Two hash aggregates first, then a union of two
 * tiny sets, is the same answer in a fraction of the time.
 */
const ACTIVE_TRADERS_SQL = `
select count(*)::text as traders from (
  -- Whole UTC days inside the window: one TraderDay row per account per day,
  -- measured equal to the maker/taker union over Trade (1,059 = 1,059 over
  -- the 30 whole days to 8 Oct 2026).
  select trader_id as t from "TraderDay"
   where "tradeCount" > 0
     and $6::timestamptz is not null
     and ($5::timestamptz is null or day >= $5::timestamptz)
     and day < $6::timestamptz
   group by trader_id
  union
  select maker_id as t from "Trade"
   where $2::timestamptz is not null
     and ($1::timestamptz is null or timestamp >= $1::timestamptz)
     and timestamp < $2::timestamptz
   group by maker_id
  union
  select taker_id as t from "Trade"
   where $2::timestamptz is not null
     and ($1::timestamptz is null or timestamp >= $1::timestamptz)
     and timestamp < $2::timestamptz
     and taker_id is not null
   group by taker_id
  union
  select maker_id as t from "Trade"
   where $4::timestamptz is not null
     and timestamp >= $3::timestamptz
     and timestamp < $4::timestamptz
   group by maker_id
  union
  select taker_id as t from "Trade"
   where $4::timestamptz is not null
     and timestamp >= $3::timestamptz
     and timestamp < $4::timestamptz
     and taker_id is not null
   group by taker_id
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
       -- NO SUM OF FREE BALANCE: it counts one account's money once per
       -- liquidation (#4734: 23 rescuable, the same balance 23 times). The
       -- ratio below is per event and cannot be inflated by repeats.
       (percentile_cont(0.5) within group (order by "freeBalanceBeforeCNS"::numeric / "marginToSurviveCNS")
          filter (where "wasRescuable" = true and "marginToSurviveCNS" > 0))::text as median_cover,
       count(*) filter (where "wasRescuable" = true and "marginToSurviveCNS" > 0)::text as cover_count,
       (percentile_cont(0.5) within group (order by "freeBalanceBeforeCNS")
          filter (where "wasRescuable" = true))::text                    as median_spare,
       -- Realised loss (PnL + funding, sign flipped), once per event: a flow,
       -- so summing it is honest. NOT marginLostCNS, which includes margin the
       -- event credited straight back to the account (docs/notes/accamount-
       -- finding-2026-10-05.md).
       coalesce(-sum("realizedPnlCNS" + "fundingCNS")
          filter (where "wasRescuable" = true), 0)::text                as rescuable_loss
  from "Liquidation"
 where ($1::timestamptz is null or timestamp >= $1::timestamptz)
   and ($2::timestamptz is null or timestamp <  $2::timestamptz)
`;

const COLLATERAL_FLOW_SQL = `
select coalesce(sum("amountCNS") filter (where kind = 'DEPOSIT'), 0)::text    as deposited,
       coalesce(sum("amountCNS") filter (where kind = 'WITHDRAWAL'), 0)::text as withdrawn,
       count(*) filter (where kind = 'DEPOSIT')::text                        as deposits,
       count(*) filter (where kind = 'WITHDRAWAL')::text                     as withdrawals
  from "CollateralFlow"
 where ($1::timestamptz is null or timestamp >= $1::timestamptz)
   and ($2::timestamptz is null or timestamp <  $2::timestamptz)
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
   and ($2::timestamptz is null or day <  $2::timestamptz)
`;

/** The day series. Buckets ARE the unit here, so they are the right source. */
/**
 * Buckets and flows, FULL OUTER JOINED on the day. A day with deposits but no
 * trade has no MarketDay row and must still appear, and a day with trades but no
 * flow must not vanish from the volume chart because nobody deposited.
 */
/** The first bucket the index holds: where "before the index" ends. */
const INDEXED_FROM_SQL = `select min(day) as from_day from "MarketDay"`;

const DAILY_SQL = `
with buckets as (
  select day,
         coalesce(sum("volumeCNS"), 0)                 as volume,
         coalesce(sum("tradeCount"), 0)                as trades,
         coalesce(sum("feesCNS"), 0)                   as fees,
         coalesce(sum("liquidationCount"), 0)          as liquidations,
         coalesce(sum("rescuableLiquidationCount"), 0) as rescuable
    from "MarketDay"
   where ($1::timestamptz is null or day >= $1::timestamptz)
   group by day
),
-- DISTINCT accounts that traded that day, across every market: one TraderDay
-- row per account per day, so a count is already deduplicated. Measured equal
-- to the maker/taker union over Trade on 1-4 Oct 2026 (290, 332, 263, 290).
traders as (
  select day, count(*) as traders
    from "TraderDay"
   where "tradeCount" > 0
     and ($1::timestamptz is null or day >= $1::timestamptz)
   group by day
),
flows as (
  select date_trunc('day', timestamp at time zone 'UTC') at time zone 'UTC' as day,
         coalesce(sum("amountCNS") filter (where kind = 'DEPOSIT'), 0)    as deposited,
         coalesce(sum("amountCNS") filter (where kind = 'WITHDRAWAL'), 0) as withdrawn
    from "CollateralFlow"
   where ($1::timestamptz is null or timestamp >= $1::timestamptz)
   group by 1
)
select coalesce(b.day, f.day)          as day,
       coalesce(b.volume, 0)::text        as volume,
       coalesce(b.trades, 0)::text        as trades,
       coalesce(b.fees, 0)::text          as fees,
       coalesce(b.liquidations, 0)::text  as liquidations,
       coalesce(b.rescuable, 0)::text     as rescuable,
       coalesce(t.traders, 0)::text       as traders_distinct,
       coalesce(f.deposited, 0)::text     as deposited,
       coalesce(f.withdrawn, 0)::text     as withdrawn
  from buckets b full outer join flows f on f.day = b.day
  left join traders t on t.day = coalesce(b.day, f.day)
 order by 1 asc
`;

const MARKET_DAILY_SQL = `
select d.market_id as id, m.name, m."priceDecimals", m."lotDecimals",
       d.day,
       d."volumeCNS"::text                  as volume,
       d."tradeCount"::text                 as trades,
       d."feesCNS"::text                    as fees,
       d."liquidationCount"::text           as liquidations,
       d."rescuableLiquidationCount"::text  as rescuable,
       d."oiDeltaCloseLNS"::text            as oi_close,
       d."markOpenPNS"::text                as mark_open,
       d."markHighPNS"::text                as mark_high,
       d."markLowPNS"::text                 as mark_low,
       d."markClosePNS"::text               as mark_close
  from "MarketDay" d join "Market" m on m.id = d.market_id
 where ($1::timestamptz is null or d.day >= $1::timestamptz)
 order by (d.market_id::bigint), d.day asc
`;

/**
 * Per-market figures over a window.
 *
 * The volume/maker-fee/trade columns come from `Trade` rows inside the rolling
 * window; FEES (maker plus taker) come from `MarketDay` buckets bound to a DAY
 * boundary, exactly as the protocol figure does, so the two cannot disagree
 * about what "fees" means; the position counts, the lots by side and the OI
 * delta come off `Market` and `Position`, which are current state rather than
 * windowed. Kept in one query so a caller cannot pair a windowed figure with a
 * stale one by accident, and the type names which is which.
 */
const MARKET_BREAKDOWN_SQL = `
select m.id, m.name, m."priceDecimals", m."lotDecimals",
       m."markPricePNS", m."lastFundingRatePct100k",
       m."openInterestDeltaLNS"::text as oi_delta,
       m."openPositionCount"::text    as open_positions,
       coalesce(t.volume, 0)::text    as volume,
       coalesce(t.fees, 0)::text      as maker_fees,
       coalesce(t.trades, 0)::text    as trades,
       coalesce(d.fees, 0)::text      as fees,
       coalesce(d.days, 0)::text      as fee_days,
       d.from_day                     as fee_from_day,
       coalesce(l.liquidations, 0)::text as liquidations,
       coalesce(l.rescuable, 0)::text as rescuable,
       coalesce(p.longs, 0)::text     as longs,
       coalesce(p.shorts, 0)::text    as shorts,
       coalesce(p.long_margin, 0)::text  as long_margin,
       coalesce(p.short_margin, 0)::text as short_margin
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
           sum("feesCNS")      as fees,
           count(distinct day) as days,
           min(day)            as from_day
      from "MarketDay"
     where ($2::timestamptz is null or day >= $2::timestamptz)
     group by market_id
  ) d on d.market_id = m.id
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
           count(*) filter (where side = 'SHORT') as shorts,
           sum("depositCNS") filter (where side = 'LONG')  as long_margin,
           sum("depositCNS") filter (where side = 'SHORT') as short_margin
      from "Position" where status = 'OPEN'
     group by market_id
  ) p on p.market_id = m.id
 order by (m.id::bigint)
`;

/**
 * Forced exits in a window, newest first, PAGED.
 *
 * Raw `Liquidation` rows filtered on the rolling timestamp, like every other
 * window here. The join brings the market's own decimals along so each row is
 * scaled by its market rather than by a constant; `logIndex` breaks ties so two
 * liquidations in one block page deterministically.
 */
const LIQUIDATIONS_SQL = `
select l.id, l.kind, l.market_id as market, m.name, m."priceDecimals", m."lotDecimals",
       l.trader_id as account, l.side, l."isFull",
       l."markPricePNS"::text          as mark,
       l."execPricePNS"::text          as exec,
       l."lotLNS"::text                as lots,
       l."notionalCNS"::text           as notional,
       l."marginLostCNS"::text         as margin_lost,
       l."badDebtCNS"::text            as bad_debt,
       l."freeBalanceBeforeCNS"::text  as free_before,
       l."marginToSurviveCNS"::text    as to_survive,
       l."wasRescuable", l.timestamp, l."txHash"
  from "Liquidation" l join "Market" m on m.id = l.market_id
 where ($1::timestamptz is null or l.timestamp >= $1::timestamptz)
 order by l.timestamp desc, l."logIndex" desc
 limit $2 offset $3
`;

/**
 * The activity feed (see feed.ts). Oldest first, from a moment, bounded.
 * Both use the timestamp indexes the index already has.
 */
const FEED_LIQUIDATIONS_SQL = `
select l.id, l.kind, l.market_id as market, m.name, m."priceDecimals", m."lotDecimals",
       l.trader_id as account, l.side, l."isFull",
       l."markPricePNS"::text          as mark,
       l."execPricePNS"::text          as exec,
       l."lotLNS"::text                as lots,
       l."notionalCNS"::text           as notional,
       l."marginLostCNS"::text         as margin_lost,
       l."badDebtCNS"::text            as bad_debt,
       l."freeBalanceBeforeCNS"::text  as free_before,
       l."marginToSurviveCNS"::text    as to_survive,
       l."realizedPnlCNS"::text        as realized,
       l."fundingCNS"::text            as funding,
       l."wasRescuable", l.timestamp, l."txHash", l."blockNumber"::text as block, l."logIndex",
       case when p."entryPriceKnown" then p."entryPricePNS"::text end as entry
  from "Liquidation" l
  join "Market" m on m.id = l.market_id
  left join "Position" p on p.id = l.position_id
 where l.timestamp >= $1::timestamptz
 order by l.timestamp asc, l."blockNumber" asc, l."logIndex" asc
 limit $2
`;

const FEED_TAKER_FILLS_SQL = `
select t.id, t."txHash", t."blockNumber"::text as block, t.timestamp, t.market_id as market, m.name,
       m."priceDecimals", m."lotDecimals", t.taker_id as taker,
       t."lotLNS"::text as lots, t."pricePNS"::text as price, t."notionalCNS"::text as notional
  from "Trade" t join "Market" m on m.id = t.market_id
 where t.timestamp >= $1::timestamptz and t.taker_id is not null
 order by t.timestamp asc, t."blockNumber" asc, t."logIndex" asc
 limit $2
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
 * Every funding rate applied in a window, per market. One row per EVENT, or per
 * UTC DAY when $2 says so: the window too long to draw every event. The day row
 * carries the mean (for the line) AND the exact sum and count (for the total), so
 * the cumulative figure is over every event whichever resolution is drawn.
 */
const FUNDING_SERIES_SQL = `
select f.market_id as id, m.name,
       case when $2::boolean then date_trunc('day', f.timestamp) else f.timestamp end as at,
       avg(f."actualRatePct100k")::text as rate,
       sum(f."actualRatePct100k")::text as rate_sum,
       count(*)::text                   as events
  from "FundingEvent" f join "Market" m on m.id = f.market_id
 where ($1::timestamptz is null or f.timestamp >= $1::timestamptz)
 group by f.market_id, m.name, 3
 order by (f.market_id::bigint), 3
`;

/**
 * Each market's settlement cadence, measured over the 24 hours up to its latest
 * settlement (not up to now, so indexer lag cannot thin it): how many, and the
 * mean gap between consecutive ones.
 */
const FUNDING_CADENCE_SQL = `
select f.market_id as id,
       count(*)::text as events,
       (extract(epoch from max(f.timestamp) - min(f.timestamp)) / nullif(count(*) - 1, 0))::text as mean_gap_sec
  from "FundingEvent" f
  join (select market_id, max(timestamp) as last_at from "FundingEvent" group by market_id) l
    on l.market_id = f.market_id
 where f.timestamp > l.last_at - interval '24 hours'
 group by f.market_id
`;

/** Every market the chain lists, with the contract's parameters for it. */
const MARKET_LISTINGS_SQL = `
select m.id, m.name, m.symbol, m.paused, m."priceDecimals", m."lotDecimals",
       m."initMarginFracHdths"::text  as init_margin,
       m."maintMarginFracHdths"::text as maint_margin,
       m."maxOpenInterestLNS"::text   as max_oi,
       m."markPricePNS"::text         as mark,
       m."markUpdatedAt"              as mark_at,
       m."firstSeenAt"                as listed_at,
       m."tradeCount"::text           as trades
  from "Market" m
 where m.listed
 order by (m.id::bigint)
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

/**
 * Owners by prefix, for a search box given part of an address. Same
 * `lower(owner)` rule as above, for the same reason. `$1` is `0x` plus hex and
 * nothing else, so it carries no LIKE wildcard; the route checks that.
 */
const TRADERS_BY_OWNER_PREFIX_SQL = `
select id, owner from "Trader"
 where owner is not null and lower(owner) like $1 || '%'
 order by (id::bigint) limit $2
`;

const TRADER_SQL = `
select id, "accountId", owner, "firstTradeAt", "lastActiveAt",
       "realizedPnlCNS", "fundingCNS", "feesPaidCNS", "netPnlCNS", "volumeCNS",
       "tradeCount", "roundTrips", wins, losses,
       "bestRoundTripCNS", "worstRoundTripCNS",
       "liquidationCount", "rescuableLiquidationCount",
       "liquidationsWithSpareBalanceCount", "spareBalanceAtLiquidationCNS",
       "freeBalanceCNS"::text as free_balance,
       "depositedCNS"::text as deposited, "withdrawnCNS"::text as withdrawn
  from "Trader" where id = $1
`;

/** Trades and volume by UTC month, from the day buckets: one maker fill is one trade. */
const HISTORY_MONTHS_SQL = `
select date_trunc('month', day) as month, sum("tradeCount")::text as trades, sum("volumeCNS")::text as volume
  from "MarketDay" group by 1 order by 1
`;

/** Accounts opened per UTC month. */
const HISTORY_ACCOUNTS_SQL = `
select date_trunc('month', "createdAt") as month, count(*)::text as accounts
  from "Trader" where "createdAt" is not null group by 1
`;

/** The hold-time split the insights use, in hours. */
export const INSIGHT_HOLD_HOURS = 48;

/**
 * One account's lifetime insight facts, over its closed round trips (the same
 * set as the round-trip list). One aggregate pass: an account with a million
 * round trips takes ~11 s, which the route's cache absorbs.
 */
const WALLET_INSIGHTS_SQL = `
select count(*)::text                                                              as round_trips,
       (avg("leverageHdths") filter (where "leverageHdths" > 0))::text              as avg_lev_hdths,
       count(*) filter (where "isWin" is not true)::text                            as losing,
       count(*) filter (where "isWin" is not true
                          and "closedAt" - "openedAt" > make_interval(hours => $2))::text as losing_held_over,
       count(*) filter (where "closedAt" - "openedAt" > make_interval(hours => $2))::text as held_over,
       count(*) filter (where side = 'LONG')::text                                 as longs,
       count(*) filter (where side = 'SHORT')::text                                as shorts,
       coalesce(sum("netPnlCNS") filter (where side = 'LONG'), 0)::text            as long_net,
       coalesce(sum("netPnlCNS") filter (where side = 'SHORT'), 0)::text           as short_net
  from "Position"
 where trader_id = $1 and status <> 'OPEN'
`;

/** The median account's mean leverage at open, over accounts with at least the ratio floor of round trips. */
/**
 * One account's fills, newest first. Each side reads its own index
 * (Trade_maker_id_timestamp_pg, Trade_taker_id_timestamp_pg: created
 * CONCURRENTLY on 6 Oct 2026, outside Envio, so the schema never re-synced),
 * takes only the rows the page can need, and the two are merged. An account
 * that is maker and taker of one fill appears twice, once per role. Without
 * the indexes a quiet account's first page ran past 60 s; with them, 0.07 s.
 */
const ACCOUNT_FILLS_SQL = `
with f as (
  (select t.id, 'maker' as role, t.timestamp, t."logIndex", t."txHash", t.market_id, t."pricePNS", t."lotLNS", t."notionalCNS", t."makerFeeCNS"
     from "Trade" t where t.maker_id = $1 order by t.timestamp desc limit $2)
  union all
  (select t.id, 'taker' as role, t.timestamp, t."logIndex", t."txHash", t.market_id, t."pricePNS", t."lotLNS", t."notionalCNS", null
     from "Trade" t where t.taker_id = $1 order by t.timestamp desc limit $2)
)
select f.id, f.role, f.timestamp, f."txHash",
       f."pricePNS"::text as price, f."lotLNS"::text as lots, f."notionalCNS"::text as notional, f."makerFeeCNS"::text as maker_fee,
       m.id as market, m.name, m."priceDecimals", m."lotDecimals"
  from f join "Market" m on m.id = f.market_id
 order by f.timestamp desc, f."logIndex" desc, f.role
 limit $3 offset $4
`;

/** Deposits and withdrawals up to the index's own latest block, in one statement so the block and the sums agree. */
const COLLATERAL_AT_HEAD_SQL = `
with head as (select latest_processed_block::bigint as block from chain_metadata limit 1)
select head.block::text as block,
       (select "collateralToken" from "Exchange" limit 1) as token,
       coalesce(sum(f."amountCNS") filter (where f.kind = 'DEPOSIT'), 0)::text as deposited,
       coalesce(sum(f."amountCNS") filter (where f.kind = 'WITHDRAWAL'), 0)::text as withdrawn
  from head left join "CollateralFlow" f on f."blockNumber" <= head.block
 group by head.block
`;

/** Busiest accounts by fills since launch, from the day buckets (~0.3 s, not a scan of Trade). */
const BUSIEST_ACCOUNTS_SQL = `
select trader_id as id from "TraderDay"
 group by trader_id
 order by sum("tradeCount") desc, trader_id
 limit $1
`;

const LEVERAGE_BASELINE_SQL = `
select (percentile_cont(0.5) within group (order by avg_lev))::text as median_hdths,
       count(*)::text                                              as accounts
  from (select trader_id, avg("leverageHdths") as avg_lev
          from "Position"
         where status <> 'OPEN' and "leverageHdths" > 0
         group by trader_id
        having count(*) >= $1) per_account
`;

/** Whether the backstop was ever used: insurance top-ups and bad debt, across every forced exit. */
const BACKSTOP_SQL = `
select count(*)::text                                               as liquidations,
       count(*) filter (where "insuranceCreditCNS" > 0)::text       as credits,
       coalesce(sum("insuranceCreditCNS"), 0)::text                 as credited,
       count(*) filter (where "badDebtCNS" > 0)::text               as bad_debt_count,
       coalesce(sum("badDebtCNS"), 0)::text                         as bad_debt,
       (select min("firstSeenAt") from "Market")                    as starts_at
  from "Liquidation"
`;

/** Where the index's history begins: its first market sighting and its configured start block. */
const HISTORY_START_SQL = `
select (select min("firstSeenAt") from "Market") as starts_at,
       (select start_block from chain_metadata limit 1) as start_block
`;

/** A trader's liquidations, for the unknown count the Trader row does not carry. */
const TRADER_LIQUIDATION_SQL = `
select count(*)::text                                      as total,
       count(*) filter (where "wasRescuable" = true)::text  as rescuable,
       count(*) filter (where "wasRescuable" is null)::text as unknown,
       count(*) filter (where "hadSpareBalance")::text      as any_spare,
       -- No sum of free balance: see LIQUIDATION_SQL.
       (percentile_cont(0.5) within group (order by "freeBalanceBeforeCNS"::numeric / "marginToSurviveCNS")
          filter (where "wasRescuable" = true and "marginToSurviveCNS" > 0))::text as median_cover,
       count(*) filter (where "wasRescuable" = true and "marginToSurviveCNS" > 0)::text as cover_count,
       (percentile_cont(0.5) within group (order by "freeBalanceBeforeCNS")
          filter (where "wasRescuable" = true))::text        as median_spare,
       coalesce(-sum("realizedPnlCNS" + "fundingCNS")
          filter (where "wasRescuable" = true), 0)::text    as rescuable_loss,
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
// ── copy trading: the replay's source (see CopySource) ──
const COPY_START_EQUITY_SQL = `
select (select coalesce(sum(case when kind = 'DEPOSIT' then "amountCNS" else -"amountCNS" end), 0)::text
          from "CollateralFlow" where trader_id = $1 and "timestamp" < $2) as flows,
       (select coalesce(sum("netPnlCNS"), 0)::text
          from "Position" where trader_id = $1 and status <> 'OPEN' and "closedAt" < $2) as pnl,
       (select coalesce(sum("feesCNS"), 0)::text
          from "TraderDay" where trader_id = $1 and day + interval '1 day' <= $2) as fees
`;
const COPY_FEES_SQL = `
select day + interval '1 day' as ends, "feesCNS"::text as fees
  from "TraderDay" where trader_id = $1 and day + interval '1 day' > $2 and day <= $3 and "feesCNS" <> 0
 order by day
`;
const COPY_BOOKS_NOW_SQL = `
select t."freeBalanceCNS"::text as free,
       (select coalesce(sum("depositCNS"), 0) from "Position" where trader_id = $1 and status = 'OPEN')::text as open_margin,
       (select coalesce(sum("netPnlCNS"), 0) from "Position" where trader_id = $1 and status = 'OPEN')::text as open_result
  from "Trader" t where t.id = $1
`;
const COPY_FLOWS_SQL = `
select kind, "amountCNS"::text as amount, "timestamp"
  from "CollateralFlow" where trader_id = $1 and "timestamp" >= $2 and "timestamp" <= $3
 order by "timestamp", id
`;
const COPY_CLOSED_FROM_BEFORE_SQL = `
select "closedAt", "netPnlCNS"::text as pnl
  from "Position"
 where trader_id = $1 and "openedAt" < $2 and status <> 'OPEN' and "closedAt" >= $2 and "closedAt" <= $3
 order by "closedAt"
`;
const COPY_COUNTS_SQL = `
select (select count(*) from "Position" where trader_id = $1 and "openedAt" >= $2 and "openedAt" <= $3) as opened,
       (select count(*) from "Position" where trader_id = $1 and "openedAt" < $2
           and (status = 'OPEN' or "closedAt" >= $2)) as open_at_start
`;
const COPY_POSITIONS_SQL = `
select p.id as key, p.market_id as id, m.name, m."priceDecimals", m."lotDecimals",
       p.side, p.status, p."peakLotLNS"::text, p."lotLNS"::text, p."entryPricePNS"::text,
       p."entryPriceKnown", p."peakDepositCNS"::text, p."netPnlCNS"::text, p."leverageHdths"::text,
       p."openedAt", p."closedAt"
  from "Position" p join "Market" m on m.id = p.market_id
 where p.trader_id = $1 and p."openedAt" >= $2 and p."openedAt" <= $3
 order by p."openedAt", p.id
 limit $4
`;

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

/**
 * The Traders list: ONE builder for the lifetime and windowed forms, sorted,
 * filtered and paged in SQL.
 *
 * The source `w` is `Trader` (lifetime) or `TraderDay` summed per trader
 * (window, day-aligned: buckets are the unit, and the caller labels it so).
 * `l` is the trader's liquidations in the same window, for the margin lost
 * and the LARGEST free balance held at a rescuable one, never a sum, which
 * would count one account's money once per liquidation.
 *
 * Nothing user-supplied reaches the text: the sort column comes from a
 * whitelist, the direction from a two-value one, the ranking filter from a
 * fixed map, and the search goes in as bind parameters. `count(*) over ()` is
 * the paging denominator after the filter.
 *
 * ORDER BY THE NUMERIC COLUMN, NEVER THE OUTPUT ALIAS. Money is selected
 * `::text` so node-pg cannot round it, and Postgres resolves a bare name in
 * ORDER BY against the output list first, so `order by net_pnl` would sort
 * "+99" above "+911". The map names the source column and the test pins it.
 *
 * "A TRADER" HAS TRADED IN THE WINDOW. An account that only moved funds is
 * not one, on the list or in its count (30 days, 4 Oct 2026: 1,108 traded of
 * 1,443 with any activity).
 *
 * The win rate SORTS WITH THE FLOOR: an account under it has no rate and
 * sorts last in either direction, the same rule the UI applies to an unknown.
 */
/** The ROI floor in AUSD micros. AUSD is 6 decimals (CLAUDE.md). */
const MIN_DEPOSIT_FOR_ROI_CNS = MIN_DEPOSIT_FOR_ROI_AUSD * 1_000_000;

const TRADER_SORT: Record<TraderSortKey, string> = {
  netPnl: 'w.net_pnl',
  volume: 'w.volume',
  roundTrips: 'w.round_trips',
  winRate: 'win_rate',
  liquidations: 'w.liquidations',
  freeBalance: 't."freeBalanceCNS"',
  lastActive: 't."lastActiveAt"',
  spareHeld: 'l.spare_held',
  deposits: 'w.deposited',
  withdrawals: 'w.withdrawn',
  netFlow: '(w.deposited - w.withdrawn)',
  netFlowAbs: 'abs(w.deposited - w.withdrawn)',
  // Numeric, never a ::text alias (see CLAUDE.md). Null under the floor, so it sorts last.
  roi: `case when w.deposited >= ${MIN_DEPOSIT_FOR_ROI_CNS} then w.net_pnl::numeric / w.deposited end`,
};

/**
 * Who a list is ABOUT. Every ranking but one lists traders (an account that
 * traded in the window); Flows lists accounts that moved capital in it,
 * traded or not.
 */
// Who is ON a board: an account belongs to the liquidation boards because it was LIQUIDATED, not because it
// also traded (8 Oct 2026: gated on trades, the 24H "Most liquidated" board held 18 of 50 liquidations).
const TRADER_ACTIVITY = { trades: 'w.trades > 0', flows: '(w.deposited > 0 or w.withdrawn > 0)', liquidations: 'w.liquidations > 0' } as const;

/** Each leaderboard's order and filter. See `TraderRanking`. */
const TRADER_RANKING: Record<
  TraderRanking,
  { readonly sort: TraderSortKey; readonly direction: SortDirection; readonly where: string; readonly floor: boolean; readonly activity: keyof typeof TRADER_ACTIVITY; readonly sortable?: readonly TraderSortKey[] }
> = {
  pnl: { sort: 'netPnl', direction: 'desc', where: `w.round_trips >= ${MIN_ROUND_TRIPS_FOR_RATIOS}`, floor: true, activity: 'trades' },
  losses: { sort: 'netPnl', direction: 'asc', where: `w.round_trips >= ${MIN_ROUND_TRIPS_FOR_RATIOS}`, floor: true, activity: 'trades' },
  volume: { sort: 'volume', direction: 'desc', where: 'true', floor: false, activity: 'trades' },
  liquidated: { sort: 'liquidations', direction: 'desc', where: 'w.liquidations > 0', floor: false, activity: 'liquidations' },
  spare: { sort: 'spareHeld', direction: 'desc', where: 'l.spare_held is not null', floor: false, activity: 'liquidations' },
  flows: { sort: 'netFlowAbs', direction: 'desc', where: 'true', floor: false, activity: 'flows', sortable: FLOW_SORT_KEYS },
  // ALL TIME ONLY: `traders()` reads the lifetime rows for it whatever window is asked. The board
  // also takes Top PnL's round-trip floor: 427 made on 100 over 4 round trips is +426% and noise.
  roi: { sort: 'roi', direction: 'desc', where: `w.deposited >= ${MIN_DEPOSIT_FOR_ROI_CNS} and w.round_trips >= ${MIN_ROUND_TRIPS_FOR_RATIOS}`, floor: true, activity: 'trades' },
};

const TRADER_SOURCE_LIFETIME = `
  select id as trader_id, "netPnlCNS" as net_pnl, "volumeCNS" as volume, "tradeCount" as trades,
         "roundTrips" as round_trips, wins, losses,
         "liquidationCount" as liquidations, "rescuableLiquidationCount" as rescuable,
         "depositedCNS" as deposited, "withdrawnCNS" as withdrawn
    from "Trader"`;

const TRADER_SOURCE_WINDOW = `
  select trader_id,
         sum("netPnlCNS")       as net_pnl,
         sum("volumeCNS")       as volume,
         sum("tradeCount")      as trades,
         sum(wins + losses)     as round_trips,
         sum(wins)              as wins,
         sum(losses)            as losses,
         sum("liquidationCount") as liquidations,
         sum("rescuableLiquidationCount") as rescuable,
         sum("depositedCNS")    as deposited,
         sum("withdrawnCNS")    as withdrawn
    from "TraderDay"
   where day >= $3::timestamptz
   group by trader_id`;

/**
 * THE 24H SOURCE (8 Oct 2026): volume, trades and liquidations over the
 * ROLLING 24 hours, the Overview's window, read fill by fill and liquidation
 * by liquidation; P&L, round trips and money in and out stay on WHOLE UTC DAYS
 * (yesterday and today so far) and are labelled so. A rolling P&L would need
 * per-position attribution that is not yet settled, and taker fees, which
 * exist only per day. $3 is the rolling start; the day start is derived from
 * it in UTC whatever the session's time zone.
 */
const TRADER_SOURCE_24H = `
  with d as (
    select trader_id,
           sum("netPnlCNS")    as net_pnl,
           sum(wins + losses)  as round_trips,
           sum(wins)           as wins,
           sum(losses)         as losses,
           sum("depositedCNS") as deposited,
           sum("withdrawnCNS") as withdrawn
      from "TraderDay"
     where day >= (date_trunc('day', $3::timestamptz at time zone 'UTC') at time zone 'UTC')
     group by trader_id
  ),
  f as (
    select trader_id, sum(v) as volume, count(*) as trades
      from (select maker_id as trader_id, "notionalCNS" as v from "Trade" where timestamp >= $3::timestamptz
            union all
            select taker_id, "notionalCNS" from "Trade" where timestamp >= $3::timestamptz and taker_id is not null) legs
     group by trader_id
  ),
  q as (
    select trader_id, count(*) as liquidations, count(*) filter (where "wasRescuable") as rescuable
      from "Liquidation" where timestamp >= $3::timestamptz
     group by trader_id
  )
  select coalesce(d.trader_id, f.trader_id, q.trader_id) as trader_id,
         coalesce(d.net_pnl, 0)      as net_pnl,
         coalesce(f.volume, 0)       as volume,
         coalesce(f.trades, 0)       as trades,
         coalesce(d.round_trips, 0)  as round_trips,
         coalesce(d.wins, 0)         as wins,
         coalesce(d.losses, 0)       as losses,
         coalesce(q.liquidations, 0) as liquidations,
         coalesce(q.rescuable, 0)    as rescuable,
         coalesce(d.deposited, 0)    as deposited,
         coalesce(d.withdrawn, 0)    as withdrawn
    from d full join f using (trader_id) full join q using (trader_id)`;

type TraderSource = 'lifetime' | 'days' | 'rolling24h';
const traderSource = (source: TraderSource): string => (source === 'lifetime' ? TRADER_SOURCE_LIFETIME : source === 'rolling24h' ? TRADER_SOURCE_24H : TRADER_SOURCE_WINDOW);

/**
 * Binds: $1 limit, $2 offset, $3 window start (null for lifetime), $4 address
 * prefix (lowercased, or null), $5 account id (or null).
 */
const tradersSql = (source: TraderSource, sort: TraderSortKey, direction: SortDirection, where: string, activity: keyof typeof TRADER_ACTIVITY = 'trades'): string => `
with w as (${traderSource(source)}),
l as (
  select trader_id,
         max("freeBalanceBeforeCNS") filter (where "wasRescuable" = true) as spare_held,
         sum("marginLostCNS")                                              as margin_lost
    from "Liquidation"
   where ($3::timestamptz is null or timestamp >= $3::timestamptz)
   group by trader_id
)
select t.id, t.owner, t."freeBalanceCNS"::text as free_balance, t."openPositionCount" as open_positions,
       t."lastActiveAt" as last_active,
       w.net_pnl::text as net_pnl, w.volume::text as volume, w.trades, w.round_trips, w.wins, w.losses,
       case when w.round_trips >= ${MIN_ROUND_TRIPS_FOR_RATIOS} then w.wins::float / w.round_trips end as win_rate,
       w.liquidations, w.rescuable,
       l.spare_held::text as spare_held, coalesce(l.margin_lost, 0)::text as margin_lost,
       w.deposited::text as deposited, w.withdrawn::text as withdrawn, (w.deposited - w.withdrawn)::text as net_flow,
       (select count(*) from w w2 where w2.trades > 0 and w2.round_trips < ${MIN_ROUND_TRIPS_FOR_RATIOS}) as below_floor,
       count(*) over () as total
  from w join "Trader" t on t.id = w.trader_id
  left join l on l.trader_id = w.trader_id
 where ${TRADER_ACTIVITY[activity]}
   and (${where})
   and ($4::text is null or lower(t.owner) like $4::text || '%')
   and ($5::text is null or t.id = $5::text)
 order by ${TRADER_SORT[sort]} ${direction === 'asc' ? 'asc' : 'desc'} nulls last, (t.id::bigint) asc
 limit $1 offset $2
`;

/**
 * The Traders cards' per-trader figures. Binds: $1 whole-day window start and
 * $2 rolling start (neither for lifetime). Closed and profitable traders and
 * the median are WHOLE UTC DAYS, the list's own source. Liquidations are the
 * ROLLING window, the Overview's query, so "Liquidations · 7 days" is one
 * number on every page. The trader count and volume are the Overview's too.
 */
const traderSummarySql = (lifetime: boolean): string => `
with w as (${lifetime ? TRADER_SOURCE_LIFETIME.replace('$3', '$1') : TRADER_SOURCE_WINDOW.replace('$3', '$1')}),
a as (select * from w where trades > 0)
select count(*)                                                        as traders,
       count(*) filter (where round_trips > 0)                         as closed,
       count(*) filter (where round_trips > 0 and net_pnl > 0)         as profitable,
       (percentile_cont(0.5) within group (order by net_pnl)
          filter (where round_trips > 0))::text                        as median_pnl,
       -- LIQUIDATIONS READ "Liquidation" DIRECTLY, as the Overview does (8 Oct 2026): summed over the
       -- accounts that traded, they dropped every account liquidated without a fill of its own (44 of 87).
       (select count(*) from "Liquidation"
         where ${lifetime ? 'true' : 'timestamp >= $2::timestamptz'})                          as liquidations,
       (select count(*) filter (where "wasRescuable") from "Liquidation"
         where ${lifetime ? 'true' : 'timestamp >= $2::timestamptz'})                          as rescuable
  from a
`;

/** One trader's days, oldest first. Buckets ARE the unit here. */
const TRADER_DAYS_SQL = `
select day, "volumeCNS"::text as volume, "tradeCount" as trades,
       "realizedPnlCNS"::text as realised, "fundingCNS"::text as funding, "feesCNS"::text as fees,
       "netPnlCNS"::text as net_pnl, wins, losses,
       "liquidationCount" as liquidations, "rescuableLiquidationCount" as rescuable,
       "marginAddedCNS"::text as margin_added, "marginRemovedCNS"::text as margin_removed,
       "depositedCNS"::text as deposited, "withdrawnCNS"::text as withdrawn,
       "endFreeBalanceCNS"::text as end_free
  from "TraderDay"
 where trader_id = $1 and ($2::timestamptz is null or day >= $2::timestamptz)
 order by day asc
`;

/**
 * The finding banded, over the rolling window.
 *
 * Bands are in AUSD micros, computed here from the collateral decimals so the
 * SQL never assumes 6. `width_bucket` against an explicit threshold array puts
 * each row in exactly one band; the verdict is counted three ways per band.
 */
const LIQUIDATION_BANDS_SQL = `
select width_bucket("notionalCNS"::numeric, $3::numeric[])       as size_band,
       width_bucket("freeBalanceBeforeCNS"::numeric, $4::numeric[]) as spare_band,
       count(*)::text                                            as total,
       count(*) filter (where "wasRescuable" = true)::text       as rescuable,
       count(*) filter (where "wasRescuable" = false)::text      as not_rescuable,
       count(*) filter (where "wasRescuable" is null)::text      as unknown
  from "Liquidation"
 where ($1::timestamptz is null or timestamp >= $1::timestamptz)
   and ($2::timestamptz is null or timestamp <  $2::timestamptz)
 group by 1, 2
`;

const LIQUIDATION_SHORTFALL_SQL = `
select (percentile_cont(0.5) within group (order by "marginToSurviveCNS")
          filter (where "wasRescuable" = true))::text     as median_rescuable,
       (percentile_cont(0.5) within group (order by "marginToSurviveCNS")
          filter (where "wasRescuable" is not null))::text as median_all
  from "Liquidation"
 where ($1::timestamptz is null or timestamp >= $1::timestamptz)
   and ($2::timestamptz is null or timestamp <  $2::timestamptz)
`;

/** Every open position, with its owner, for the protocol-wide risk snapshot. */
const ALL_OPEN_POSITIONS_SQL = `
select p.trader_id as account, p.market_id as id, m.name, m."priceDecimals", m."lotDecimals",
       p.side, p."lotLNS"::text, p."entryPricePNS"::text, p."entryPriceKnown",
       p."depositCNS"::text, p."leverageHdths"::text, p."openedAt",
       p."marginAddedCNS"::text
  from "Position" p join "Market" m on m.id = p.market_id
 where p.status = 'OPEN'
 order by (p.market_id::bigint), p."openedAt" desc
`;

/** The band edges, in AUSD. Named so the label and the SQL threshold cannot drift. */
export const SIZE_BANDS_AUSD: readonly number[] = [100, 1_000, 10_000, 100_000];
export const SPARE_BANDS_AUSD: readonly number[] = [1, 100, 1_000, 10_000];

interface DayTotals {
  readonly volume: bigint;
  readonly makerFees: bigint;
  readonly trades: bigint;
}

const iso = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString();

/**
 * A bucket's mark, or undefined when the bucket recorded none. The indexer
 * writes 0 into a day's marks when no market-state event landed that day, and a
 * zero on a price chart is a crash that did not happen.
 */
const markOrUndefined = (pns: unknown, priceDecimals: number): number | undefined => {
  const price = toPrice(pns, priceDecimals);
  return price === undefined || price <= 0 ? undefined : price;
};

/**
 * `percentile_cont` returns a double, and Postgres renders it as text with a
 * fractional part — `1234567.5` micros — so it is not a bigint. Parsed as a
 * float ON PURPOSE: a median of integers can be a half, and it is a display
 * statistic, never an amount anything sends.
 */
/** A unitless median off percentile_cont, or undefined when there was nothing to take it over. */
/** The Traders window: lifetime, or whole UTC days from the window's start, labelled as such. */
function traderWindow(timeframe: Timeframe, now: number): { readonly window: TraderWindow; readonly start: string | null } {
  const { sinceMs } = windowFor(timeframe, now);
  if (sinceMs === undefined) {
    return { window: { timeframe, honoursTimeframe: true, label: 'all time', days: undefined, fromMs: undefined, toMs: now }, start: null };
  }
  // Aligned DOWN to the bucket: TraderDay has no finer grain.
  const fromMs = startOfUtcDay(sinceMs);
  const days = Math.floor((startOfUtcDay(now) - fromMs) / 86_400_000) + 1;
  const from = new Date(fromMs).toISOString().slice(0, 10);
  return {
    window: {
      timeframe,
      honoursTimeframe: false,
      label: days === 1 ? `the UTC day from ${from} (today so far)` : `the ${days} UTC days from ${from} (today so far)`,
      days,
      fromMs,
      toMs: now,
    },
    start: iso(fromMs),
  };
}

/**
 * A Traders search: an address prefix (0x and up to 40 hex, lowercased, per
 * the case rule) or an account id (digits, optionally #). Anything else is no
 * search at all rather than a guess.
 */
export function parseTraderQuery(raw: string | undefined): { readonly kind: 'address'; readonly prefix: string } | { readonly kind: 'account'; readonly accountId: number } | undefined {
  const q = raw?.trim();
  if (q === undefined || q === '') return undefined;
  if (/^0x[0-9a-fA-F]{1,40}$/.test(q)) return { kind: 'address', prefix: q.toLowerCase() };
  const id = q.replace(/^#/, '');
  if (/^\d{1,12}$/.test(id)) return { kind: 'account', accountId: Number(id) };
  return undefined;
}

const ratioOrUndefined = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const medianAusd = (raw: unknown, decimals: number): number | undefined => {
  if (raw === null || raw === undefined) return undefined;
  const micros = Number(raw);
  return Number.isFinite(micros) ? micros / 10 ** decimals : undefined;
};

export class PostgresAnalytics implements Analytics, ActivityFeed, CopySourceReader {
  readonly #client: SqlClient;
  readonly #chainId: number;
  readonly #resolve: SymbolResolver;
  readonly #fundingIntervalSec: (marketId: number) => number | undefined;
  readonly #chainHead: (() => Promise<number | undefined>) | undefined;
  readonly #tvlProbe: { read(): Promise<TvlReading> } | undefined;
  readonly #now: () => number;
  /** The last reading whose processed block DIFFERED. See classifyIndexerHealth. */
  #lastProgress: IndexerProgress | undefined;
  #collateralDecimals: number | undefined;
  /** Fill sums per CLOSED UTC day, keyed by the day's start. A closed day's fills never change. */
  readonly #dayTotals = new Map<number, DayTotals>();
  /** One fill of the day memo at a time, so two windows asking together scan once. */
  #dayFill: Promise<void> = Promise.resolve();

  constructor(options: PostgresAnalyticsOptions) {
    this.#client = options.client;
    this.#chainId = options.chainId;
    this.#resolve = options.resolveSymbol;
    this.#fundingIntervalSec = options.fundingIntervalSec ?? (() => undefined);
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
    const { sinceMs, untilMs } = windowFor(timeframe, this.#now());
    // The window before: same length, ending where this one starts. Its upper
    // bound is EXCLUSIVE so a trade at exactly `sinceMs` is counted once. Both
    // windows are read concurrently; each is a few scans of the fill table.
    const span = sinceMs === undefined ? undefined : untilMs - sinceMs;
    const previousSince = sinceMs === undefined || span === undefined ? undefined : sinceMs - span;
    const [current, indexedFrom, previous] = await Promise.all([
      this.#metricsOver(timeframe, sinceMs, untilMs, true),
      this.#one(INDEXED_FROM_SQL),
      sinceMs === undefined || previousSince === undefined
        ? undefined
        : this.#metricsOver(timeframe, previousSince, sinceMs, false),
    ]);
    const indexedFromMs = toMs(indexedFrom?.['from_day']);
    if (previous === undefined || previousSince === undefined) return { ...current, indexedFromMs };
    return {
      ...current,
      indexedFromMs,
      previous: {
        ...previous,
        // Complete only when the index was already recording when it began.
        complete: indexedFromMs !== undefined && indexedFromMs <= previousSince,
      },
    };
  }

  /**
   * Volume, trades, maker fees and DISTINCT traders over a rolling window,
   * exactly: whole UTC days from per-day sums, the two ragged edges scanned
   * fill by fill (`windowSplit.ts`). A 24-hour window has no whole day in it
   * and is one exact scan, as before.
   */
  async #windowTotals(
    sinceMs: number | undefined,
    untilMs: number,
  ): Promise<{ readonly totals: Record<string, unknown>; readonly traders: Record<string, unknown> | undefined }> {
    // Too short to hold a whole day: skip the bounds probe, scan it whole.
    const short = sinceMs !== undefined && untilMs - sinceMs <= 86_400_000;
    const bounds = short ? undefined : await this.#one(TRADE_BOUNDS_SQL);
    const firstMs = toMs(bounds?.['first']);
    const split = splitWindow(sinceMs, untilMs, firstMs === undefined ? undefined : toMs(bounds?.['through']));
    const [e1, e2] = split.edges;
    const edgeBinds = [iso(e1?.fromMs), iso(e1?.toMs), iso(e2?.fromMs), iso(e2?.toMs)];
    const [edges, days, traders] = await Promise.all([
      this.#one(WINDOW_TOTALS_SQL, edgeBinds),
      split.days === undefined || firstMs === undefined ? undefined : this.#closedDayTotals(split.days, firstMs),
      this.#one(ACTIVE_TRADERS_SQL, [...edgeBinds, iso(split.days?.fromMs), iso(split.days?.toMs)]),
    ]);
    const big = (v: unknown): bigint => BigInt(String(v ?? '0'));
    return {
      totals: {
        volume: (big(edges?.['volume']) + (days?.volume ?? 0n)).toString(),
        maker_fees: (big(edges?.['maker_fees']) + (days?.makerFees ?? 0n)).toString(),
        trades: (big(edges?.['trades']) + (days?.trades ?? 0n)).toString(),
      },
      traders,
    };
  }

  /** The summed fills of whole closed UTC days, each day read from the index once and remembered. */
  async #closedDayTotals(range: MsRange, firstMs: number): Promise<DayTotals> {
    const wanted = utcDaysIn(range.fromMs ?? Math.floor(firstMs / 86_400_000) * 86_400_000, range.toMs);
    const missing = wanted.filter((d) => !this.#dayTotals.has(d));
    if (missing.length > 0) {
      const fill = this.#dayFill.then(async () => {
        // Each run of consecutive missing days is one scan, so a day already held is never re-read.
        const runs: Array<[number, number]> = [];
        for (const d of missing.filter((x) => !this.#dayTotals.has(x))) {
          const last = runs.at(-1);
          if (last !== undefined && last[1] === d) last[1] = d + 86_400_000;
          else runs.push([d, d + 86_400_000]);
        }
        for (const [from, to] of runs) {
          const rows = await this.#rows(DAY_TOTALS_SQL, [iso(from), iso(to)]);
          const found = new Map(rows.map((r) => [toMs(r['day']), r]));
          // A day with no fills is a closed day of zeros, not a missing one.
          for (const d of utcDaysIn(from, to)) {
            const r = found.get(d);
            this.#dayTotals.set(d, {
              volume: BigInt(String(r?.['volume'] ?? '0')),
              makerFees: BigInt(String(r?.['maker_fees'] ?? '0')),
              trades: BigInt(String(r?.['trades'] ?? '0')),
            });
          }
        }
      });
      this.#dayFill = fill.catch(() => undefined);
      await fill;
    }
    const sum: { volume: bigint; makerFees: bigint; trades: bigint } = { volume: 0n, makerFees: 0n, trades: 0n };
    for (const d of wanted) {
      const t = this.#dayTotals.get(d)!;
      sum.volume += t.volume;
      sum.makerFees += t.makerFees;
      sum.trades += t.trades;
    }
    return sum;
  }

  /**
   * The headline figures over one bounded window.
   *
   * `untilMs` is a real bound, not decoration: the previous-period query needs
   * it, and without it "the 7 days before" would read as "everything before".
   * The current window's bound is `now`, which excludes nothing that exists.
   */
  async #metricsOver(
    timeframe: Timeframe,
    sinceMs: number | undefined,
    untilMs: number,
    /** The window that ends now, rather than a previous one. Said, not inferred from the clock. */
    current: boolean,
  ): Promise<Omit<ProtocolMetrics, 'previous' | 'indexedFromMs'>> {
    const decimals = await this.#decimals();
    const since = iso(sinceMs);
    const until = iso(untilMs);

    // Fees are asked for over whole days, so the binds are day boundaries rather
    // than rolling instants. Everything else uses the rolling window.
    const feesSince = sinceMs === undefined ? null : iso(startOfUtcDay(sinceMs));
    // Open-ended for the current window, so today's partial bucket is included;
    // for a previous window this is the current window's first day, exclusive.
    // NOT `untilMs >= now()`: untilMs WAS now a moment ago, so that comparison
    // flipped on whether a millisecond had passed, and today's fees came and
    // went at random (seen 1 Oct 2026: the same 7D read gave 7 days or 8).
    const feesUntil = current ? null : iso(startOfUtcDay(untilMs));

    const [{ totals, traders }, liquidations, flows, fees] = await Promise.all([
      this.#windowTotals(sinceMs, untilMs),
      this.#one(LIQUIDATION_SQL, [since, until]),
      this.#one(COLLATERAL_FLOW_SQL, [since, until]),
      this.#one(FEES_SQL, [feesSince, feesUntil]),
    ]);

    return {
      timeframe,
      sinceMs,
      untilMs,
      volumeAusd: toAusd(totals?.['volume'], decimals),
      tradeCount: count(totals?.['trades']),
      makerFeesAusd: toAusd(totals?.['maker_fees'], decimals),
      fees: this.#fees(fees, decimals, untilMs, current),
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
    /** The current window, whose last bucket is today so far. Said, not read off the clock. */
    open: boolean,
  ): FeesForPeriod {
    const days = count(row?.['days']);
    const fromMs = toMs(row?.['from_day']) ?? startOfUtcDay(untilMs);
    const from = new Date(fromMs).toISOString().slice(0, 10);
    // A window that ends before now is a closed range of whole days; only the
    // current window's last bucket is "today so far".
    const tail = open ? ' (today so far)' : '';
    const label =
      days === 0
        ? open
          ? 'no complete UTC day of fees is indexed yet'
          : 'no UTC day of fees is indexed in the previous period'
        : days === 1
          ? `the UTC day from ${from}${tail}`
          : `the ${days} UTC days from ${from}${tail}`;
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
      medianCoverRatio: ratioOrUndefined(row?.['median_cover']),
      coverRatioCount: count(row?.['cover_count']),
      medianSpareBalanceAusd: medianAusd(row?.['median_spare'], decimals),
      rescuableRealisedLossAusd: toAusd(row?.['rescuable_loss'], decimals),
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
      // DISTINCT accounts that traded that day, from TraderDay. Until 6 Oct 2026
      // this was the largest single market's count, a floor about a third low.
      activeTraders: count(row['traders_distinct']),
      liquidationCount: count(row['liquidations']),
      rescuableLiquidationCount: count(row['rescuable']),
      depositedAusd: toAusd(row['deposited'], decimals),
      withdrawnAusd: toAusd(row['withdrawn'], decimals),
      netFlowAusd: toAusd(row['deposited'], decimals) - toAusd(row['withdrawn'], decimals),
    }));
  }

  async walletInsightFacts(accountId: number): Promise<WalletInsightFacts | undefined> {
    const exists = await this.#one('select 1 as found from "Trader" where id = $1', [String(accountId)]);
    if (exists === undefined) return undefined;
    const decimals = await this.#decimals();
    const row = await this.#one(WALLET_INSIGHTS_SQL, [String(accountId), INSIGHT_HOLD_HOURS]);
    const avgHdths = row?.['avg_lev_hdths'];
    return {
      accountId,
      roundTrips: count(row?.['round_trips']),
      // Leverage is stored in hundredths of a multiple (1500 = 15x).
      averageLeverage: avgHdths === null || avgHdths === undefined ? undefined : Number(avgHdths) / 100,
      holdThresholdHours: INSIGHT_HOLD_HOURS,
      losingTrips: count(row?.['losing']),
      losingTripsHeldOver: count(row?.['losing_held_over']),
      tripsHeldOver: count(row?.['held_over']),
      longTrips: count(row?.['longs']),
      shortTrips: count(row?.['shorts']),
      longNetPnlAusd: toAusd(row?.['long_net'], decimals),
      shortNetPnlAusd: toAusd(row?.['short_net'], decimals),
    };
  }

  async collateralTotalsAtIndexHead(): Promise<CollateralTotalsAtBlock> {
    const decimals = await this.#decimals();
    const row = await this.#one(COLLATERAL_AT_HEAD_SQL, []);
    if (row === undefined || row['block'] === null || row['block'] === undefined) throw new Error('the index has no processed block yet');
    return {
      block: Number(row['block']),
      collateralToken: String(row['token']),
      depositedCNS: BigInt(String(row['deposited'])),
      withdrawnCNS: BigInt(String(row['withdrawn'])),
      collateralDecimals: decimals,
    };
  }

  async accountFills(accountId: number, options: { readonly limit?: number; readonly offset?: number } = {}): Promise<AccountFillsPage> {
    const decimals = await this.#decimals();
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), MAX_FILLS_PER_REQUEST);
    const offset = Math.min(Math.max(0, Math.floor(options.offset ?? 0)), 1_000_000);
    // One row past the page says whether there is more; each side needs at most offset + limit + 1.
    const rows = await this.#rows(ACCOUNT_FILLS_SQL, [String(accountId), offset + limit + 1, limit + 1, offset]);
    const fills = rows.slice(0, limit).map((row): AccountFill => {
      const role = row['role'] === 'taker' ? 'taker' : 'maker';
      return {
        id: String(row['id']),
        atMs: requireMs(row['timestamp']),
        txHash: String(row['txHash']),
        market: toMarketRef(row['market'], row['name'], this.#resolve),
        role,
        sizeLots: toLots(row['lots'], count(row['lotDecimals'])),
        price: toPrice(row['price'], count(row['priceDecimals'])),
        notionalAusd: toAusd(row['notional'], decimals),
        makerFeeAusd: role === 'maker' ? toAusd(row['maker_fee'], decimals) : undefined,
      };
    });
    return { fills, limit, offset, hasMore: rows.length > limit };
  }

  async copySource(accountId: number, window: { readonly fromMs: number; readonly toMs: number; readonly cap: number }): Promise<CopySource | undefined> {
    const id = String(accountId);
    const exists = await this.#one('select 1 from "Trader" where id = $1', [id]);
    if (exists === undefined) return undefined;
    const decimals = await this.#decimals();
    const from = new Date(window.fromMs).toISOString();
    const to = new Date(window.toMs).toISOString();
    const cap = Math.max(1, Math.floor(window.cap));
    // Counted first: a leader with more opens than the cap is refused whole, so its rows are never read.
    const counts = await this.#one(COPY_COUNTS_SQL, [id, from, to]);
    const tooMany = count(counts?.['opened']) > cap;
    const [books, start, fees, flows, before, rows] = await Promise.all([
      this.#one(COPY_BOOKS_NOW_SQL, [id]),
      this.#one(COPY_START_EQUITY_SQL, [id, from]),
      this.#rows(COPY_FEES_SQL, [id, from, to]),
      this.#rows(COPY_FLOWS_SQL, [id, from, to]),
      this.#rows(COPY_CLOSED_FROM_BEFORE_SQL, [id, from, to]),
      tooMany ? Promise.resolve([]) : this.#rows(COPY_POSITIONS_SQL, [id, from, to, cap]),
    ]);
    return {
      accountId,
      fromMs: window.fromMs,
      toMs: window.toMs,
      collateralDecimals: decimals,
      equityAtStartCNS: bigintOrZero(start?.['flows']) + bigintOrZero(start?.['pnl']) - bigintOrZero(start?.['fees']),
      feesByDay: fees.map((r) => ({ atMs: Math.min(requireMs(r['ends']), window.toMs), feesCNS: bigintOrZero(r['fees']) })),
      flows: flows.map((r) => ({ atMs: requireMs(r['timestamp']), deltaCNS: r['kind'] === 'DEPOSIT' ? bigintOrZero(r['amount']) : -bigintOrZero(r['amount']) })),
      closedFromBefore: before.map((r) => ({ atMs: requireMs(r['closedAt']), netPnlCNS: bigintOrZero(r['pnl']) })),
      openAtStart: count(counts?.['open_at_start']),
      openedInWindow: count(counts?.['opened']),
      now: { freeCNS: bigintOrZero(books?.['free']), openMarginCNS: bigintOrZero(books?.['open_margin']), openResultCNS: bigintOrZero(books?.['open_result']) },
      positions: rows.map((r): CopySourcePosition => {
        const status = String(r['status']);
        const closedAtMs = toMs(r['closedAt']);
        return {
          key: String(r['key']),
          market: toMarketRef(r['id'], r['name'], this.#resolve),
          side: sideFromRow(r['side']),
          status: status === 'OPEN' ? 'open' : status === 'CLOSED' ? 'closed' : 'forced',
          lotDecimals: count(r['lotDecimals']),
          priceDecimals: count(r['priceDecimals']),
          peakLotLNS: bigintOrZero(r['peakLotLNS']),
          lotLNS: bigintOrZero(r['lotLNS']),
          entryPricePNS: r['entryPriceKnown'] === true ? bigintOrUndefined(r['entryPricePNS']) : undefined,
          peakMarginCNS: bigintOrZero(r['peakDepositCNS']),
          netPnlCNS: bigintOrZero(r['netPnlCNS']),
          leverageHdths: bigintOrZero(r['leverageHdths']),
          openedAtMs: requireMs(r['openedAt']),
          closedAtMs: status === 'OPEN' ? undefined : closedAtMs,
        };
      }),
    };
  }

  async copyLeader(accountId: number, sinceMs: number, cap: number): Promise<{ readonly positions: readonly CopySourcePosition[]; readonly equityCNS: bigint } | undefined> {
    const now = this.#now();
    const source = await this.copySource(accountId, { fromMs: sinceMs, toMs: now + 60_000, cap });
    if (source === undefined) return undefined;
    return { positions: source.positions, equityCNS: source.now.freeCNS + source.now.openMarginCNS };
  }

  async openActivity(accountId: number, nowMs: number): Promise<OpenActivity> {
    const row = await this.#one(
      `select (select max("openedAt") from "Position" where trader_id = $1) as last_opened,
              (select count(*) from "Position" where trader_id = $1 and "openedAt" >= $2) as d1,
              (select count(*) from "Position" where trader_id = $1 and "openedAt" >= $3) as d7`,
      [String(accountId), new Date(nowMs - 86_400_000).toISOString(), new Date(nowMs - 7 * 86_400_000).toISOString()],
    );
    return { lastOpenedAtMs: toMs(row?.['last_opened']), opened24h: count(row?.['d1']), opened7d: count(row?.['d7']) };
  }

  async knownOwners(accountIds: readonly number[]): Promise<ReadonlyMap<number, string>> {
    if (accountIds.length === 0) return new Map();
    const rows = await this.#rows('select id, lower(owner) as owner from "Trader" where id = any($1::text[]) and owner is not null', [accountIds.map(String)]);
    return new Map(rows.map((r) => [count(r['id']), String(r['owner'])]));
  }

  async busiestAccounts(limit: number): Promise<readonly number[]> {
    const rows = await this.#rows(BUSIEST_ACCOUNTS_SQL, [Math.max(1, Math.min(100, Math.floor(limit)))]);
    return rows.map((row) => count(row['id']));
  }

  async leverageBaseline(): Promise<LeverageBaseline> {
    const row = await this.#one(LEVERAGE_BASELINE_SQL, [MIN_ROUND_TRIPS_FOR_RATIOS]);
    const median = row?.['median_hdths'];
    return {
      medianLeverage: median === null || median === undefined ? undefined : Number(median) / 100,
      accounts: count(row?.['accounts']),
      minRoundTrips: MIN_ROUND_TRIPS_FOR_RATIOS,
    };
  }

  async backstopHistory(): Promise<BackstopHistory> {
    const decimals = await this.#decimals();
    const row = await this.#one(BACKSTOP_SQL, []);
    return {
      liquidations: count(row?.['liquidations']),
      insuranceCredits: count(row?.['credits']),
      insuranceCreditedAusd: toAusd(row?.['credited'], decimals),
      badDebtLiquidations: count(row?.['bad_debt_count']),
      badDebtAusd: toAusd(row?.['bad_debt'], decimals),
      sinceMs: toMs(row?.['starts_at']),
    };
  }

  async history(): Promise<HistoryCurve> {
    const decimals = await this.#decimals();
    const [months, accounts, start] = await Promise.all([
      this.#rows(HISTORY_MONTHS_SQL, []),
      this.#rows(HISTORY_ACCOUNTS_SQL, []),
      this.#one(HISTORY_START_SQL, []),
    ]);
    const newByMonth = new Map(accounts.map((row) => [requireMs(row['month']), count(row['accounts'])]));
    const thisMonth = Date.UTC(new Date(this.#now()).getUTCFullYear(), new Date(this.#now()).getUTCMonth(), 1);
    return {
      startsAtMs: toMs(start?.['starts_at']),
      startBlock: start?.['start_block'] === null || start?.['start_block'] === undefined ? undefined : Number(start['start_block']),
      months: months.map((row) => {
        const monthMs = requireMs(row['month']);
        return {
          monthMs,
          trades: count(row['trades']),
          volumeAusd: toAusd(row['volume'], decimals),
          newAccounts: newByMonth.get(monthMs) ?? 0,
          partial: monthMs >= thisMonth,
        };
      }),
    };
  }

  async dailySeriesByMarket(timeframe: Timeframe): Promise<readonly MarketDailySeries[]> {
    const decimals = await this.#decimals();
    const { sinceMs } = windowFor(timeframe, this.#now());
    const since = sinceMs === undefined ? null : iso(startOfUtcDay(sinceMs));
    const rows = await this.#rows(MARKET_DAILY_SQL, [since]);

    // Rows arrive ordered by market then day, so one pass groups them.
    const series: Array<{ market: MarketRef; points: MarketDailyPoint[] }> = [];
    for (const row of rows) {
      const marketId = count(row['id']);
      let current = series.at(-1);
      if (current === undefined || current.market.marketId !== marketId) {
        current = { market: toMarketRef(row['id'], row['name'], this.#resolve), points: [] };
        series.push(current);
      }
      const priceDecimals = count(row['priceDecimals']);
      current.points.push({
        dayMs: requireMs(row['day']),
        volumeAusd: toAusd(row['volume'], decimals),
        tradeCount: count(row['trades']),
        feesAusd: toAusd(row['fees'], decimals),
        liquidationCount: count(row['liquidations']),
        rescuableLiquidationCount: count(row['rescuable']),
        // In LOTS, scaled by the market's own lot decimals. Until 6 Oct 2026 this
        // served the raw integer under the name "lots".
        openInterestDeltaLots: toLots(row['oi_close'], count(row['lotDecimals'])),
        markOpen: markOrUndefined(row['mark_open'], priceDecimals),
        markHigh: markOrUndefined(row['mark_high'], priceDecimals),
        markLow: markOrUndefined(row['mark_low'], priceDecimals),
        markClose: markOrUndefined(row['mark_close'], priceDecimals),
      });
    }
    return series;
  }

  async marketBreakdown(timeframe: Timeframe): Promise<readonly MarketBreakdown[]> {
    const decimals = await this.#decimals();
    const { sinceMs, untilMs } = windowFor(timeframe, this.#now());
    // Fees bind a day boundary, everything else the rolling instant — the same
    // two binds `protocolMetrics` uses, for the same reason.
    const feesSince = sinceMs === undefined ? null : iso(startOfUtcDay(sinceMs));
    const rows = await this.#rows(MARKET_BREAKDOWN_SQL, [iso(sinceMs), feesSince]);

    return rows.map((row) => {
      const priceDecimals = count(row['priceDecimals']);
      const lotDecimals = count(row['lotDecimals']);
      const longs = count(row['longs']);
      const shorts = count(row['shorts']);
      const markPrice = toPrice(row['markPricePNS'], priceDecimals);
      // Isolated margin per side: what each side has at risk. NOT size × mark —
      // on an order book that is identically 50/50, see `longShareOfMargin`.
      const longMarginAusd = toAusd(row['long_margin'], decimals);
      const shortMarginAusd = toAusd(row['short_margin'], decimals);
      return {
        market: toMarketRef(row['id'], row['name'], this.#resolve),
        volumeAusd: toAusd(row['volume'], decimals),
        tradeCount: count(row['trades']),
        fees: this.#fees({ fees: row['fees'], days: row['fee_days'], from_day: row['fee_from_day'] }, decimals, untilMs, true),
        makerFeesAusd: toAusd(row['maker_fees'], decimals),
        openPositions: count(row['open_positions']),
        longPositions: longs,
        shortPositions: shorts,
        longShareOfPositions: share(longs, longs + shorts),
        longMarginAusd,
        shortMarginAusd,
        longShareOfMargin: share(longMarginAusd, longMarginAusd + shortMarginAusd),
        openInterestDeltaLots: toLots(row['oi_delta'], lotDecimals),
        liquidationCount: count(row['liquidations']),
        rescuableLiquidationCount: count(row['rescuable']),
        markPrice,
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

  async fundingSeries(timeframe: Timeframe): Promise<readonly MarketFundingSeries[]> {
    const { sinceMs } = windowFor(timeframe, this.#now());
    // Every event up to 7 days (~230 a market). Beyond that a day per point: at
    // 30 days the ~1,000 steps, flipping sign settlement to settlement, draw four
    // to a pixel and read as a solid block. The sum is over every event either way.
    const byDay = timeframe === '30d' || timeframe === 'all';
    const [rows, cadenceRows] = await Promise.all([this.#rows(FUNDING_SERIES_SQL, [iso(sinceMs), byDay]), this.#rows(FUNDING_CADENCE_SQL)]);
    const cadenceById = new Map(
      cadenceRows.map((row) => {
        const gap = row['mean_gap_sec'] === null || row['mean_gap_sec'] === undefined ? undefined : Number(row['mean_gap_sec']);
        return [count(row['id']), { events: count(row['events']), gap: gap !== undefined && Number.isFinite(gap) ? gap : undefined }] as const;
      }),
    );

    const out: Array<{ market: MarketRef; points: { atMs: number; ratePct: number; events: number }[]; sum100k: bigint; events: number }> = [];
    for (const row of rows) {
      const marketId = count(row['id']);
      let current = out.at(-1);
      if (current === undefined || current.market.marketId !== marketId) {
        current = { market: toMarketRef(row['id'], row['name'], this.#resolve), points: [], sum100k: 0n, events: 0 };
        out.push(current);
      }
      current.points.push({ atMs: requireMs(row['at']), ratePct: fundingUnitsToPct(Number(row['rate'])), events: count(row['events']) });
      current.sum100k += bigintOrZero(row['rate_sum']);
      current.events += count(row['events']);
    }
    return out.map((m) => ({
      market: m.market,
      resolution: byDay ? 'utc-day' : 'event',
      points: m.points,
      eventCount: m.events,
      // Summed as integers, divided once: no float drift over thousands of events.
      cumulativeRatePct: fundingUnitsToPct(Number(m.sum100k)),
      firstAtMs: m.points[0]?.atMs,
      lastAtMs: m.points.at(-1)?.atMs,
      cadence: {
        venueIntervalSec: this.#fundingIntervalSec(m.market.marketId),
        measuredIntervalSec: cadenceById.get(m.market.marketId)?.gap,
        eventsPerDay: cadenceById.get(m.market.marketId)?.events ?? 0,
      },
    }));
  }

  async marketListings(): Promise<readonly MarketListing[]> {
    const rows = await this.#rows(MARKET_LISTINGS_SQL, []);
    return rows.map((row) => {
      const priceDecimals = count(row['priceDecimals']);
      const init = Number(row['init_margin']);
      const maint = Number(row['maint_margin']);
      return {
        market: toMarketRef(row['id'], row['name'], this.#resolve),
        chainSymbol: String(row['symbol']),
        paused: row['paused'] === true,
        maxLeverage: init > 0 ? maxLeverageFromConfig(init) : undefined,
        maintenanceMarginRatio: maint > 0 ? maintenanceMarginRatioFromConfig(maint) : undefined,
        maxOpenInterestSize: toLots(row['max_oi'], count(row['lotDecimals'])),
        markPrice: toPrice(row['mark'], priceDecimals),
        markAtMs: toMs(row['mark_at']),
        listedAtMs: requireMs(row['listed_at']),
        tradesAllTime: count(row['trades']),
      };
    });
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
    return { kind: 'found', profile, resolvedBy: 'index' };
  }

  async walletSearch(prefix: string, limit: number): Promise<readonly WalletMatch[]> {
    const rows = await this.#rows(TRADERS_BY_OWNER_PREFIX_SQL, [prefix.trim().toLowerCase(), limit]);
    return rows.map((row) => ({ address: String(row['owner']), accountId: count(row['id']) }));
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
    // WITHHELD UNDER THE FLOOR, not computed off a handful: the counts stay.
    const enough = roundTrips >= MIN_ROUND_TRIPS_FOR_RATIOS;
    const performance: WalletPerformance = {
      roundTrips,
      wins,
      losses,
      winRate: enough ? share(wins, roundTrips) : undefined,
      profitFactor: enough
        ? profitFactor(toAusd(curve?.['gross_profit'], decimals), toAusd(curve?.['gross_loss'], decimals))
        : undefined,
      minRoundTripsForRatios: MIN_ROUND_TRIPS_FOR_RATIOS,
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
      openPositions: positions.map((row) => this.#openPosition(row, decimals)),
      performance,
      rescues: {
        count: total,
        judgeableCount,
        unknownCount,
        rescuableCount,
        rate,
        medianCoverRatio: ratioOrUndefined(liq?.['median_cover']),
        coverRatioCount: count(liq?.['cover_count']),
        medianSpareBalanceAusd: medianAusd(liq?.['median_spare'], decimals),
        rescuableRealisedLossAusd: toAusd(liq?.['rescuable_loss'], decimals),
        withAnySpareBalanceCount: count(liq?.['any_spare']),
      },
      realisedPnlAusd: toAusd(trader['realizedPnlCNS'], decimals),
      fundingAusd: toAusd(trader['fundingCNS'], decimals),
      feesPaidAusd: toAusd(trader['feesPaidCNS'], decimals),
      netPnlAusd: toAusd(trader['netPnlCNS'], decimals),
      volumeAusd: toAusd(trader['volumeCNS'], decimals),
      tradeCount: count(trader['tradeCount']),
      freeBalanceAusd: toAusd(trader['free_balance'], decimals),
      depositedAusd: toAusd(trader['deposited'], decimals),
      withdrawnAusd: toAusd(trader['withdrawn'], decimals),
    };
  }

  async liquidations(
    timeframe: Timeframe,
    options: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<readonly LiquidationRecord[]> {
    const decimals = await this.#decimals();
    const { sinceMs } = windowFor(timeframe, this.#now());
    // Same cap as round trips, for the same reason.
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    const offset = Math.max(0, options.offset ?? 0);
    const rows = await this.#rows(LIQUIDATIONS_SQL, [iso(sinceMs), limit, offset]);

    return rows.map((row): LiquidationRecord => {
      const priceDecimals = count(row['priceDecimals']);
      const lotDecimals = count(row['lotDecimals']);
      const toSurvive = row['to_survive'];
      return {
        id: String(row['id']),
        atMs: requireMs(row['timestamp']),
        txHash: String(row['txHash']),
        market: toMarketRef(row['market'], row['name'], this.#resolve),
        accountId: count(row['account']),
        side: sideFromRow(row['side']),
        kind: forcedExitKindFromRow(row['kind']),
        isFull: row['isFull'] === true,
        sizeLots: toLots(row['lots'], lotDecimals),
        markPrice: toPrice(row['mark'], priceDecimals),
        execPrice: toPrice(row['exec'], priceDecimals),
        notionalAusd: toAusd(row['notional'], decimals),
        marginLostAusd: toAusd(row['margin_lost'], decimals),
        badDebtAusd: toAusd(row['bad_debt'], decimals),
        freeBalanceBeforeAusd: toAusd(row['free_before'], decimals),
        // Null means unjudgeable, and stays a hole rather than becoming zero.
        marginToSurviveAusd: toSurvive === null || toSurvive === undefined ? undefined : toAusd(toSurvive, decimals),
        verdict: verdictFromRow(row['wasRescuable']),
      };
    });
  }

  async liquidationsSince(sinceMs: number, limit: number): Promise<readonly FeedLiquidation[]> {
    const decimals = await this.#decimals();
    const rows = await this.#rows(FEED_LIQUIDATIONS_SQL, [iso(sinceMs), Math.min(Math.max(1, limit), 1_000)]);
    return rows.map((row): FeedLiquidation => {
      const priceDecimals = count(row['priceDecimals']);
      const lotDecimals = count(row['lotDecimals']);
      const toSurvive = row['to_survive'];
      return {
        id: String(row['id']),
        atMs: requireMs(row['timestamp']),
        txHash: String(row['txHash']),
        blockNumber: count(row['block']),
        logIndex: count(row['logIndex']),
        market: toMarketRef(row['market'], row['name'], this.#resolve),
        accountId: count(row['account']),
        side: sideFromRow(row['side']),
        kind: forcedExitKindFromRow(row['kind']),
        isFull: row['isFull'] === true,
        sizeLots: toLots(row['lots'], lotDecimals),
        markPrice: toPrice(row['mark'], priceDecimals),
        execPrice: toPrice(row['exec'], priceDecimals),
        entryPrice: toPrice(row['entry'], priceDecimals),
        notionalAusd: toAusd(row['notional'], decimals),
        marginLostAusd: toAusd(row['margin_lost'], decimals),
        badDebtAusd: toAusd(row['bad_debt'], decimals),
        freeBalanceBeforeAusd: toAusd(row['free_before'], decimals),
        marginToSurviveAusd: toSurvive === null || toSurvive === undefined ? undefined : toAusd(toSurvive, decimals),
        realizedPnlAusd: toAusd(row['realized'], decimals),
        fundingAusd: toAusd(row['funding'], decimals),
        verdict: verdictFromRow(row['wasRescuable']),
      };
    });
  }

  async takerFillsSince(sinceMs: number, limit: number): Promise<readonly TakerFill[]> {
    const decimals = await this.#decimals();
    const rows = await this.#rows(FEED_TAKER_FILLS_SQL, [iso(sinceMs), Math.min(Math.max(1, limit), 10_000)]);
    return rows.map((row): TakerFill => {
      const priceDecimals = count(row['priceDecimals']);
      const lotDecimals = count(row['lotDecimals']);
      return {
        id: String(row['id']),
        txHash: String(row['txHash']),
        blockNumber: count(row['block']),
        atMs: requireMs(row['timestamp']),
        market: toMarketRef(row['market'], row['name'], this.#resolve),
        takerAccountId: count(row['taker']),
        sizeLots: toLots(row['lots'], lotDecimals),
        price: toPrice(row['price'], priceDecimals),
        notionalAusd: toAusd(row['notional'], decimals),
      };
    });
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

  async traders(
    timeframe: Timeframe,
    options: {
      readonly sort?: TraderSortKey;
      readonly direction?: SortDirection;
      readonly limit?: number;
      readonly offset?: number;
      readonly ranking?: TraderRanking;
      readonly query?: string;
    } = {},
  ): Promise<TraderList> {
    const decimals = await this.#decimals();
    const now = this.#now();
    const ranking = options.ranking !== undefined && TRADER_RANKINGS.includes(options.ranking) ? options.ranking : undefined;
    const rule = ranking === undefined ? undefined : TRADER_RANKING[ranking];
    // A ranking fixes its order, except where it names sorts a reader may choose (Flows).
    const chosen = rule?.sortable !== undefined && options.sort !== undefined && rule.sortable.includes(options.sort);
    const sort: TraderSortKey = chosen ? options.sort! : (rule?.sort ?? (options.sort !== undefined && TRADER_SORT_KEYS.includes(options.sort) ? options.sort : 'netPnl'));
    const direction: SortDirection = chosen ? (options.direction === 'asc' ? 'asc' : 'desc') : (rule?.direction ?? (options.direction === 'asc' ? 'asc' : 'desc'));
    // Capped like every other list: a page, not a payload.
    const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
    const offset = Math.max(0, options.offset ?? 0);
    const search = parseTraderQuery(options.query);
    // A SEARCH DROPS THE FLOOR: whoever is searched for is found, with their
    // row marked by its round trips like any other.
    const where = rule === undefined ? 'true' : search === undefined ? rule.where : rule.floor ? 'true' : rule.where;
    const floorApplied = rule?.floor === true && search === undefined;

    // ROI is lifetime over lifetime, whatever window was asked: never a window's PnL over all-time deposits.
    const lifetimeOnly = sort === 'roi';
    const { window, start } = traderWindow(lifetimeOnly ? 'all' : timeframe, now);
    // 24H: volume, trades and liquidations over the rolling 24 hours (TRADER_SOURCE_24H), bound by the rolling start.
    const source: TraderSource = start === null ? 'lifetime' : !lifetimeOnly && timeframe === '24h' ? 'rolling24h' : 'days';
    const bound = source === 'rolling24h' ? iso(windowFor('24h', now).sinceMs) : start;
    const rows = await this.#rows(tradersSql(source, sort, direction, where, rule?.activity ?? 'trades'), [
      limit,
      offset,
      bound,
      search?.kind === 'address' ? search.prefix : null,
      search?.kind === 'account' ? String(search.accountId) : null,
    ]);

    const list: TraderRow[] = rows.map((row) => {
      const roundTrips = count(row['round_trips']);
      const wins = count(row['wins']);
      return {
        accountId: count(row['id']),
        address: String(row['owner'] ?? '').toLowerCase(),
        netPnlAusd: toAusd(row['net_pnl'], decimals),
        volumeAusd: toAusd(row['volume'], decimals),
        tradeCount: count(row['trades']),
        roundTrips,
        wins,
        losses: count(row['losses']),
        winRate: roundTrips >= MIN_ROUND_TRIPS_FOR_RATIOS ? share(wins, roundTrips) : undefined,
        liquidationCount: count(row['liquidations']),
        rescuableLiquidationCount: count(row['rescuable']),
        marginLostAusd: toAusd(row['margin_lost'], decimals),
        maxSpareHeldAusd: row['spare_held'] === null || row['spare_held'] === undefined ? undefined : toAusd(row['spare_held'], decimals),
        depositedAusd: toAusd(row['deposited'], decimals),
        withdrawnAusd: toAusd(row['withdrawn'], decimals),
        netFlowAusd: toAusd(row['net_flow'], decimals),
        freeBalanceAusd: toAusd(row['free_balance'], decimals),
        openPositionCount: count(row['open_positions']),
        lastActiveAtMs: requireMs(row['last_active']),
        roiPct: start === null ? roiPct(toAusd(row['net_pnl'], decimals), toAusd(row['deposited'], decimals)) : undefined,
      };
    });
    return {
      rows: list,
      total: count(rows[0]?.['total']),
      window: source === 'rolling24h' ? { ...window, rollingFromMs: windowFor('24h', now).sinceMs } : window,
      sort,
      direction,
      limit,
      offset,
      minRoundTripsForRatios: MIN_ROUND_TRIPS_FOR_RATIOS,
      ranking,
      // From the first row, which carries it; with no row, the floor still left
      // these out, so it is asked for alone rather than reported as zero.
      belowFloor: !floorApplied ? undefined : rows[0] !== undefined ? count(rows[0]['below_floor']) : await this.#belowFloor(source, bound),
      query: search === undefined ? undefined : search.kind === 'address' ? search.prefix : `#${search.accountId}`,
    };
  }

  async #belowFloor(source: TraderSource, bound: string | null): Promise<number> {
    const row = await this.#one(
      `with w as (${traderSource(source).replaceAll('$3', '$1')}) select count(*) as n from w where trades > 0 and round_trips < ${MIN_ROUND_TRIPS_FOR_RATIOS}`,
      source === 'lifetime' ? [] : [bound],
    );
    return count(row?.['n']);
  }

  async traderSummary(timeframe: Timeframe): Promise<TraderSummary> {
    const decimals = await this.#decimals();
    const now = this.#now();
    const { window, start } = traderWindow(timeframe, now);
    // TRADERS AND VOLUME ON THE OVERVIEW'S OWN ROLLING WINDOW, by the same two
    // queries: until 6 Oct 2026 these came from whole UTC days, so the 30-day
    // volume here started at 00:00 UTC and ran 12.7 h longer than the
    // Overview's ($1.56B against $1.43B, the gap being exactly the trades
    // between midnight and the rolling start). The per-trader figures below
    // stay in whole UTC days: the per-trader record is kept by day.
    const { sinceMs } = windowFor(timeframe, now);
    const [row, { totals, traders }] = await Promise.all([
      // The lifetime form has no parameter; binding one is a Postgres error (08P01), not a no-op.
      this.#one(traderSummarySql(start === null), start === null ? [] : [start, iso(sinceMs)]),
      this.#windowTotals(sinceMs, now),
    ]);
    const closed = count(row?.['closed']);
    return {
      window,
      traders: count(traders?.['traders']),
      volumeAusd: toAusd(totals?.['volume'], decimals),
      closedTraders: closed,
      profitableTraders: count(row?.['profitable']),
      medianNetPnlAusd: closed >= MIN_TRADERS_FOR_DISTRIBUTION ? medianAusd(row?.['median_pnl'], decimals) : undefined,
      minTradersForDistribution: MIN_TRADERS_FOR_DISTRIBUTION,
      liquidations: count(row?.['liquidations']),
      rescuableLiquidations: count(row?.['rescuable']),
    };
  }

  async traderDays(accountId: number, timeframe: Timeframe): Promise<readonly TraderDayPoint[]> {
    const decimals = await this.#decimals();
    const { sinceMs } = windowFor(timeframe, this.#now());
    const since = sinceMs === undefined ? null : iso(startOfUtcDay(sinceMs));
    const rows = await this.#rows(TRADER_DAYS_SQL, [String(accountId), since]);
    return rows.map((row) => ({
      dayMs: requireMs(row['day']),
      volumeAusd: toAusd(row['volume'], decimals),
      tradeCount: count(row['trades']),
      realisedPnlAusd: toAusd(row['realised'], decimals),
      fundingAusd: toAusd(row['funding'], decimals),
      feesAusd: toAusd(row['fees'], decimals),
      netPnlAusd: toAusd(row['net_pnl'], decimals),
      wins: count(row['wins']),
      losses: count(row['losses']),
      liquidationCount: count(row['liquidations']),
      rescuableLiquidationCount: count(row['rescuable']),
      marginAddedAusd: toAusd(row['margin_added'], decimals),
      marginRemovedAusd: toAusd(row['margin_removed'], decimals),
      depositedAusd: toAusd(row['deposited'], decimals),
      withdrawnAusd: toAusd(row['withdrawn'], decimals),
      endFreeBalanceAusd: toAusd(row['end_free'], decimals),
    }));
  }

  async liquidationSummary(timeframe: Timeframe): Promise<LiquidationSummary> {
    const decimals = await this.#decimals();
    const { sinceMs, untilMs } = windowFor(timeframe, this.#now());
    const since = iso(sinceMs);
    const until = iso(untilMs);
    const micros = (ausd: number) => (BigInt(Math.round(ausd)) * 10n ** BigInt(decimals)).toString();
    const [cells, shortfall] = await Promise.all([
      this.#rows(LIQUIDATION_BANDS_SQL, [since, until, SIZE_BANDS_AUSD.map(micros), SPARE_BANDS_AUSD.map(micros)]),
      this.#one(LIQUIDATION_SHORTFALL_SQL, [since, until]),
    ]);
    return {
      timeframe,
      bySize: foldBands(cells, 'size_band', SIZE_BANDS_AUSD),
      bySpareBalance: foldBands(cells, 'spare_band', SPARE_BANDS_AUSD),
      medianShortfallAusd: medianAusd(shortfall?.['median_rescuable'], decimals),
      medianShortfallAllAusd: medianAusd(shortfall?.['median_all'], decimals),
    };
  }

  async openPositions(): Promise<readonly IndexedOpenPosition[]> {
    const decimals = await this.#decimals();
    const rows = await this.#rows(ALL_OPEN_POSITIONS_SQL);
    return rows.map((row) => ({ accountId: count(row['account']), position: this.#openPosition(row, decimals) }));
  }

  /** One `Position` row -> an {@link OpenPosition}. Shared by the profile and the risk snapshot. */
  #openPosition(row: Record<string, unknown>, decimals: number): OpenPosition {
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
  }
}

/**
 * Band cells -> one row per band, in edge order, EVERY band present.
 *
 * `width_bucket` numbers bands from 0 (below the first edge) to `edges.length`
 * (at or above the last). A band with no rows still appears with zeros, so a
 * chart never drops a bar and a reader can see an empty band is empty.
 */
function foldBands(cells: Array<Record<string, unknown>>, key: 'size_band' | 'spare_band', edges: readonly number[]): readonly LiquidationBand[] {
  const bands: LiquidationBand[] = [];
  for (let i = 0; i <= edges.length; i += 1) {
    const minAusd = i === 0 ? 0 : edges[i - 1]!;
    const maxAusd = i === edges.length ? undefined : edges[i];
    const label = maxAusd === undefined ? `≥ ${fmtBand(minAusd)}` : i === 0 ? `< ${fmtBand(maxAusd)}` : `${fmtBand(minAusd)} – ${fmtBand(maxAusd)}`;
    const mine = cells.filter((c) => count(c[key]) === i);
    const sum = (col: string) => mine.reduce((acc, c) => acc + count(c[col]), 0);
    bands.push({ label, minAusd, maxAusd, count: sum('total'), rescuableCount: sum('rescuable'), notRescuableCount: sum('not_rescuable'), unknownCount: sum('unknown') });
  }
  return bands;
}

/** "1K", "10K", "100", for a band label. */
function fmtBand(ausd: number): string {
  return ausd >= 1_000 ? `${ausd / 1_000}K` : String(ausd);
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
  return Number.isFinite(parsed) ? fundingUnitsToPct(parsed) : undefined;
}

/** Lifetime ROI in percent, or undefined under the deposit floor. Pure. */
export function roiPct(netPnlAusd: number, depositedAusd: number): number | undefined {
  return depositedAusd >= MIN_DEPOSIT_FOR_ROI_AUSD ? (netPnlAusd / depositedAusd) * 100 : undefined;
}
