/**
 * The analytics interface — the one thing downstream reads for indexed history.
 *
 * THE VENUE RULE, ONE STEP LATER. `apps/indexer` is allowed to speak Perpl
 * directly, because an indexer IS a venue-specific data source. Nothing
 * downstream is: the bot, the web app and the risk engine read this interface, so
 * no consumer ever learns the word `perpId`, sees a market id, or writes a line
 * of SQL. That is why every symbol below is a CANONICAL TICKER and every id that
 * does appear is wrapped in {@link MarketRef}, which can say "I do not know what
 * this market is called" out loud.
 *
 * THREE THINGS THIS INTERFACE REFUSES TO PRETEND, each because the data cannot
 * support the nicer answer:
 *
 *   OPEN INTEREST IS A DELTA, NOT A LEVEL. The indexer starts partway through
 *   chain history and the public RPC serves archive state only a few days back,
 *   so there is no exact anchor at the start block. `openInterestDeltaLots` is
 *   the exact CHANGE since then, and it is named that way so nothing can render
 *   it as a level. For the absolute figure, read the venue's own market state.
 *
 *   NEITHER IS TVL. Deposits and withdrawals are indexed, but accounts held
 *   balances before the start block, so the net over our window is a FLOW and on
 *   mainnet it is negative. {@link CollateralFlowStats} reports the flow, which is
 *   exact, and says what an absolute figure would need: a `balanceOf` read of the
 *   Exchange proxy, which is a chain read and not this interface's job.
 *
 *   AN ADDRESS WE CANNOT RESOLVE IS NOT AN ADDRESS WITH NO HISTORY. Only
 *   `AccountCreated` links a wallet to an account id, and most mainnet accounts
 *   predate the start block — 1366 of 1556 have no owner recorded. So a lookup
 *   returns {@link WalletLookup}, where `not-linked` is a distinct outcome from an
 *   empty profile. Telling a trader they have no history when we simply cannot
 *   see their address would be the analytics version of rendering an unknown
 *   position set as an empty portfolio.
 */
import type { IndexerHealth } from './health.ts';
import type { BackstopHistory } from './exposure.ts';
import type { Side } from '../venues/types.ts';

export type { IndexerHealth, IndexerState } from './health.ts';

/**
 * A rolling window, or everything.
 *
 * ROLLING, NOT CALENDAR. `24h` means the last 24 hours to the second, not
 * "today so far" — the distinction is the entire volume bug this layer was built
 * to fix, and it is why these are served from raw event rows rather than from day
 * buckets. See the note on {@link ProtocolMetrics}.
 */
export type Timeframe = '24h' | '7d' | '30d' | 'all';

export const TIMEFRAMES: readonly Timeframe[] = ['24h', '7d', '30d', 'all'];

/**
 * BELOW THIS MANY ROUND TRIPS, RATIOS ARE WITHHELD. Three trades and two wins
 * is 66.7%, and it means nothing. `winRate` and `profitFactor` come back
 * undefined under this floor, the counts and the history are still served in
 * full, and every payload that withholds says which floor it used. One number,
 * here, and in CLAUDE.md.
 */
export const MIN_ROUND_TRIPS_FOR_RATIOS = 10;

/**
 * ROI IS ALL TIME AND HAS A FLOOR (owner, 6 Oct 2026). Lifetime net PnL over
 * lifetime deposits, so the numerator and the denominator cover the same
 * period: 30-day PnL over lifetime deposits compares a trader who deposited
 * long ago with one who deposited last week, and the two numbers mean
 * different things. Complete because the index starts at the Exchange's
 * deployment. WITHHELD under 100 AUSD deposited: 50 AUSD made on 10 is 500%,
 * and it means nothing. Always shown with its denominator.
 */
export const MIN_DEPOSIT_FOR_ROI_AUSD = 100;

/** How long a timeframe covers, in milliseconds. `all` has no start. */
export function timeframeMs(timeframe: Timeframe): number | undefined {
  switch (timeframe) {
    case '24h':
      return 24 * 60 * 60_000;
    case '7d':
      return 7 * 24 * 60 * 60_000;
    case '30d':
      return 30 * 24 * 60 * 60_000;
    case 'all':
      return undefined;
  }
}

/**
 * One market, as this interface names it.
 *
 * `symbol` IS UNDEFINED WHEN THE VENUE DOES NOT LIST THE MARKET, and that is a
 * real case rather than a defensive one: mainnet market 80 (TAO) is listed on
 * chain, has real scaling, and `GET /v1/pub/context` does not mention it. The
 * indexer's own `name` is kept alongside for a human reading a diagnostic, and
 * must never be used as a ticker — market 31's is `SOL_v2`.
 *
 * MARKET IDENTITY IS THE MARKET ID (CLAUDE.md). `marketId` is the only key the
 * contract, the indexer and the API agree on, so it is what everything joins on.
 * It appears here, and only here, so a UI can key a list on something stable.
 */
export interface MarketRef {
  readonly marketId: number;
  /** Canonical ticker from the venue context. Undefined when it lists no such market. */
  readonly symbol: string | undefined;
  /** What the indexer recorded. Diagnostic only — NEVER matched on. */
  readonly indexerName: string;
}

/** `symbol` when we have it, otherwise something a human can still read. */
export function describeMarket(market: MarketRef): string {
  return market.symbol ?? `market ${market.marketId} (${market.indexerName}, not listed by the venue)`;
}

// ── protocol level ──────────────────────────────────────────────────────────

/**
 * The headline figures over one window.
 *
 * EVERY ONE OF THESE IS SUMMED FROM RAW EVENT ROWS over `[since, now]`, never
 * from daily buckets. Buckets are UTC midnight, so a 24h query against them sums
 * partial days: measured on mainnet at 05:04 UTC it returned 3.75M AUSD against a
 * true 16.14M, i.e. 0.23x, and the error swings with the time of day rather than
 * being a constant a reader could learn to correct for. Volume is the most
 * checkable number on the page and it cannot be half.
 */
export interface ProtocolMetrics {
  readonly timeframe: Timeframe;
  /** Start of the window. Undefined for `all`. */
  readonly sinceMs: number | undefined;
  readonly untilMs: number;

  /** Traded notional in AUSD. Counted once per match, from the maker fill. */
  readonly volumeAusd: number;
  readonly tradeCount: number;
  /**
   * MAKER fees over the window, in AUSD. Exact for every timeframe.
   *
   * Maker only, and named so, because that is the half with a per-match
   * timestamp. See {@link totalFeesAusd}.
   */
  readonly makerFeesAusd: number;
  /**
   * ALL fees, maker and taker, over WHOLE UTC DAYS — and it carries its own
   * period, because that period is not the rolling window above.
   *
   * A taker fill on this contract is an AGGREGATE OVER A WHOLE ORDER, not a
   * per-match figure, so the indexer cannot attribute it to a single trade and no
   * per-event row carries it. Taker fees therefore have no timestamp finer than
   * the UTC day bucket — and they are the larger share: 128,097 AUSD of total fees
   * against 42,038 of maker fees on mainnet. Serving maker fees under the name
   * "fees" would report a third of the real figure, which is the same mistake as
   * the volume bug this layer was built to fix.
   *
   * So fees come from buckets, and {@link FeesForPeriod} states the range it
   * actually covers rather than borrowing the label of the rolling window. EXACT
   * AND HONEST BEATS PRECISE-LOOKING AND WRONG. A caller rendering this must use
   * `fees.label`, not the timeframe.
   *
   * KNOWN IMPROVEMENT, deliberately not taken yet: a per-event taker-fee feed
   * would make fees exact for a rolling window like everything else. It needs a
   * `takerFeeCNS` column on `Trade`, a handler change, and a reindex of 21.5M
   * events — comparable to the original backfill, so it runs overnight or not at
   * all. Recorded in docs/evidence.md.
   */
  readonly fees: FeesForPeriod;
  /**
   * DISTINCT accounts that traded in the window.
   *
   * A count, not a sum of per-market counts: a trader active on three markets is
   * one active trader, and summing `MarketDay.activeTraderCount` would call them
   * three.
   */
  readonly activeTraders: number;

  readonly liquidations: LiquidationStats;
  readonly rescues: RescueStats;
  readonly collateralFlow: CollateralFlowStats;
  /**
   * The SAME figures over the window immediately before this one, so a caller
   * can render "vs previous period" without a second request that might land in
   * a different second and compare two windows that overlap.
   *
   * Undefined for `all`: there is no window before everything. A UI renders the
   * delta as unknown then, never as zero.
   *
   * Fees compare the same NUMBER OF UTC DAY BUCKETS ending where the current
   * range starts, so a "today so far" bucket is compared against a whole day.
   * That is what every such comparison does, and `previous.fees.label` says
   * exactly which days were summed.
   */
  readonly previous?: PreviousPeriodMetrics;
  /**
   * UTC midnight of the first day the index holds anything. A window that starts
   * before this is only partly covered, and a comparison against it is not a
   * comparison. Undefined until the indexer has written a bucket.
   */
  readonly indexedFromMs: number | undefined;
}

/**
 * {@link ProtocolMetrics} for the window before, which carries no `previous` of
 * its own, plus whether the index actually covers it.
 */
export type PreviousPeriodMetrics = Omit<ProtocolMetrics, 'previous' | 'indexedFromMs'> & {
  /**
   * True when the index holds data from before this window began, so its
   * figures are a real total. False means the index starts inside it, and a
   * delta against it must render as unknown rather than as growth.
   */
  readonly complete: boolean;
};

/** Forced exits over a window. */
export interface LiquidationStats {
  readonly count: number;
  readonly notionalAusd: number;
  readonly marginLostAusd: number;
  /** Bad debt the insurance fund did not cover. */
  readonly badDebtAusd: number;
}

/**
 * THE NUMBER PERPGUARD EXISTS TO QUOTE.
 *
 * `rescuableCount` is liquidations where the trader's FREE AUSD would have
 * covered the top-up that kept the position above maintenance margin. Perpl uses
 * isolated margin, so none of that balance was used automatically — which is the
 * whole product.
 *
 * QUOTE IT WITH ITS HOLE. `unknownCount` is liquidations of positions opened
 * before the indexer's start block, where the position state needed to judge
 * them is not knowable. They are EXCLUDED from `judgeableCount`, never counted as
 * failures, and `rate` is over the judgeable denominator. Reporting
 * `rescuableCount / count` instead would understate the finding and invite the
 * obvious question about the missing rows.
 *
 * `withAnySpareBalanceCount` IS A DIAGNOSTIC AND NEVER A HEADLINE. It is
 * `freeBalanceBefore > 0`, so it counts dust: on mainnet it is true for 680 of
 * 680, the smallest balance being 0.00024 AUSD. 100% reads as a broken indexer
 * rather than as a finding. It is here so one liquidation can be audited, and for
 * no other reason. (CLAUDE.md is explicit about this.)
 */
export interface RescueStats {
  readonly count: number;
  /** Liquidations we can actually judge: `count - unknownCount`. */
  readonly judgeableCount: number;
  readonly unknownCount: number;
  readonly rescuableCount: number;
  /** `rescuableCount / judgeableCount`, or undefined when nothing is judgeable. */
  readonly rate: number | undefined;
  /**
   * THE COVER RATIO: the median, across rescuable liquidations, of the free
   * AUSD held divided by the shortfall that would have saved the position:
   * "in the median rescuable liquidation the trader held 187x what they
   * needed". Per event, so repeat liquidations of one account cannot inflate
   * it the way a SUM of free balance did (removed 4 Oct 2026: that counted the
   * same account's money once per liquidation, #4734's 23 times over).
   * Undefined when nothing in the window is rescuable.
   */
  readonly medianCoverRatio: number | undefined;
  /** How many rescuable liquidations the ratio's median was taken over. */
  readonly coverRatioCount: number;
  /**
   * Median free AUSD at liquidation, over the RESCUABLE cases only, or undefined
   * when there are none. A median rather than a mean because a handful of large
   * accounts would otherwise describe a typical trader nobody is.
   */
  readonly medianSpareBalanceAusd: number | undefined;
  /**
   * POTENTIALLY AVOIDABLE LOSSES: realised loss (PnL + funding, positive = a
   * loss) summed over the RESCUABLE liquidations. Once per event, so repeats
   * cannot inflate it. Excludes liquidation fees, so it understates.
   *
   * Deliberately NOT marginLostCNS: the event credits part of the removed
   * margin straight back to the account (26% in a sample of 40), and the
   * index does not store that credit (`accAmountCNS`). And never a claim the
   * trader would have kept this money: a top-up keeps the position open, it
   * does not undo the price move.
   */
  readonly rescuableRealisedLossAusd: number;
  /** DIAGNOSTIC. See the note above. Never render this as a rate. */
  readonly withAnySpareBalanceCount: number;
}

/**
 * Total fees over a range of whole UTC days.
 *
 * SEPARATE FROM THE TIMEFRAME ON PURPOSE. A `24h` request gets fees for the UTC
 * day so far, not for the last 24 hours, and this type exists so a caller cannot
 * render the former under the latter's label. The figure is EXACT for the range it
 * states: the sum of day buckets from `fromMs` is precisely the fees charged since
 * that midnight, today's partial bucket included.
 */
export interface FeesForPeriod {
  /** Maker and taker. Exact for `[fromMs, toMs]`. */
  readonly totalAusd: number;
  /** UTC midnight of the first day included. */
  readonly fromMs: number;
  /** Now — the end of the partial current bucket. */
  readonly toMs: number;
  /** How many day buckets were summed, the partial current one included. */
  readonly days: number;
  /**
   * A phrase a UI can render verbatim, e.g. "the 7 UTC days from 2026-09-24
   * (today so far)". Use this rather than the timeframe label.
   */
  readonly label: string;
}

/**
 * Total value locked, read from the CHAIN.
 *
 * NOT DERIVED FROM INDEXED FLOW, and that is the whole point. Accounts held
 * collateral before the indexer's start block, so summing the deposits and
 * withdrawals we can see gives a flow whose net is negative on mainnet. The
 * collateral token's `balanceOf` the Exchange proxy is the current truth
 * regardless of when we started watching.
 *
 * {@link CollateralFlowStats} stays alongside it and answers a different question:
 * this is what is in there now, that is what moved in a window. Both are worth
 * showing.
 */
export type { TvlReading } from './tvl.ts';

/**
 * Deposits and withdrawals over a window.
 *
 * NOT TVL, and the field names say so. `netAusd` is exact for the window, and on
 * mainnet it is NEGATIVE — accounts held collateral before the start block, so
 * withdrawals of pre-existing balances outweigh deposits we can see. An absolute
 * total value locked needs the collateral token's balance of the Exchange proxy,
 * which is a chain read this interface does not do and must not fake.
 */
export interface CollateralFlowStats {
  readonly depositedAusd: number;
  readonly withdrawnAusd: number;
  /** `deposited - withdrawn`. A flow over the window, not a level. */
  readonly netAusd: number;
  readonly depositCount: number;
  readonly withdrawalCount: number;
}

/** Funding over a window. */
export interface FundingStats {
  readonly eventCount: number;
  /** Mean of the actual rates applied, as a percentage. */
  readonly meanRatePct: number | undefined;
  readonly markets: readonly MarketFundingStats[];
}

export interface MarketFundingStats {
  readonly market: MarketRef;
  readonly eventCount: number;
  readonly meanRatePct: number | undefined;
  readonly lastRatePct: number | undefined;
  readonly lastAtMs: number | undefined;
}

/**
 * One market's funding over a window: every rate applied, and their sum.
 *
 * Per Perpl's docs a POSITIVE rate means longs pay shorts, and a position pays
 * price × rate × lots at each funding event (~hourly). So `cumulativeRatePct` —
 * the plain sum of the rates applied — is exactly which side has been paying and
 * by how much per unit of price. It is NOT an AUSD total across traders: that
 * needs each side's open interest at every event, which the index does not keep
 * (funding is settled into a position when it changes size, not per event).
 */
export interface MarketFundingSeries {
  readonly market: MarketRef;
  /**
   * `event`: one point per funding event, the rate as applied. `utc-day`: the
   * MEAN rate per event within each UTC day, used for 30D and All, where every
   * event would draw several to a pixel; the sum is still over every event.
   */
  readonly resolution: 'event' | 'utc-day';
  /** `events`: how many settlements the point's rate averages. 1 at `event` resolution. */
  readonly points: readonly { readonly atMs: number; readonly ratePct: number; readonly events: number }[];
  readonly eventCount: number;
  /** Sum of every rate applied in the window, in percent. Positive: longs paid. */
  readonly cumulativeRatePct: number;
  readonly firstAtMs: number | undefined;
  readonly lastAtMs: number | undefined;
  readonly cadence: FundingCadence;
}

/**
 * How often a market settles funding: what the venue says, and what the index
 * measured. Independent of the requested window — always the 24 hours up to the
 * market's latest indexed settlement — so it reads the same on every timeframe.
 */
export interface FundingCadence {
  /** `funding_interval_sec` from the venue's context. Undefined when it does not list the market. */
  readonly venueIntervalSec: number | undefined;
  /** Mean spacing between consecutive settlements over the measured 24 hours. */
  readonly measuredIntervalSec: number | undefined;
  /** Settlements in those 24 hours. */
  readonly eventsPerDay: number;
}

/**
 * A market as the CHAIN lists it, whether or not the venue's context shows it.
 *
 * The context decides what a trader can see and touch today; this is how the
 * page learns about the markets that are listed on chain but not open yet, with
 * whatever parameters the contract already holds for them.
 */
export interface MarketListing {
  readonly market: MarketRef;
  /** The contract's own symbol: the only name a market the venue does not list has. */
  readonly chainSymbol: string;
  readonly paused: boolean;
  /** From the initial margin fraction, as the venue's context encodes it: 1500 -> 15x. */
  readonly maxLeverage: number | undefined;
  /** From the maintenance margin fraction: 2500 -> 4%. */
  readonly maintenanceMarginRatio: number | undefined;
  /** In the market's own size units. */
  readonly maxOpenInterestSize: number;
  /** The contract's last mark, and when it moved. */
  readonly markPrice: number | undefined;
  readonly markAtMs: number | undefined;
  /** The first event the index saw for this market: its listing. */
  readonly listedAtMs: number;
  /** Fills since the index began. Zero for a market that has never traded. */
  readonly tradesAllTime: number;
}

/**
 * The protocol's whole history, by UTC month: the growth curve. Independent
 * of any timeframe — it always runs from the index's first event to now —
 * and it carries that first event, so a page can name the window "All"
 * really covers instead of calling it all-time on trust.
 */
export interface HistoryCurve {
  /** The first event the index holds: the Exchange's own deployment, when it is complete. */
  readonly startsAtMs: number | undefined;
  readonly startBlock: number | undefined;
  readonly months: readonly HistoryMonth[];
}

export interface HistoryMonth {
  /** UTC midnight on the 1st. */
  readonly monthMs: number;
  /** Maker fills: one per trade. */
  readonly trades: number;
  readonly volumeAusd: number;
  readonly newAccounts: number;
  /** The month still running: its bar is not comparable with a whole month's. */
  readonly partial: boolean;
}

/** One day of one figure, for a chart. Buckets ARE the unit here. */
/**
 * The protocol treasury's AUSD into and out of the Exchange, per UTC day. Not
 * indexed: from a log scan of the chain, so it covers blocks up to
 * `throughBlock` and says so. Together with the indexed collateral flows it
 * rebuilds the contract's balance (27.70 AUSD apart out of 3.84M, 6 Oct 2026).
 */
export interface ProtocolTreasuryDays {
  readonly throughBlock: number;
  readonly days: readonly { readonly dayMs: number; readonly inAusd: number; readonly outAusd: number }[];
  /** Every movement with its time (they are rare: 20 since launch), for a rolling window. Signed: + in, − out. */
  readonly movements: readonly { readonly atMs: number; readonly ausd: number }[];
  readonly lastEventAtMs: number | undefined;
  /** The incremental scan behind these figures: how far, how fresh, and its last reconciliation. */
  readonly scan: TreasuryScanStatus;
}

/** Rebuilt vs contract at ONE block (the index's latest), so neither side trails the other. */
export interface TreasuryReconciliation {
  readonly atBlock: number;
  readonly checkedAtMs: number;
  readonly rebuiltAusd: number;
  readonly contractAusd: number;
  /** contract − rebuilt. */
  readonly gapAusd: number;
  /** The difference measured since 6 Oct 2026 and not explained by any event read. */
  readonly expectedGapAusd: number;
  readonly toleranceAusd: number;
  /** |gap − expected| ≤ tolerance. False means a new, unexplained movement. */
  readonly withinExpected: boolean;
}

export interface TreasuryScanStatus {
  /** Every block up to this one has been scanned. */
  readonly throughBlock: number | undefined;
  /** When the last scan finished; undefined before the first since start-up. */
  readonly scannedAtMs: number | undefined;
  readonly intervalMs: number;
  /** Present while the latest run has failed. Safe to render. */
  readonly lastError?: string;
  readonly lastErrorAtMs?: number;
  readonly reconciliation?: TreasuryReconciliation;
}

/** Exact collateral totals at one block: the index side of the exchange-balance reconciliation. */
export interface CollateralTotalsAtBlock {
  readonly block: number;
  readonly collateralToken: string;
  readonly depositedCNS: bigint;
  readonly withdrawnCNS: bigint;
  readonly collateralDecimals: number;
}

/** Most fills one request may return: a page, or a CSV export. */
export const MAX_FILLS_PER_REQUEST = 10_000;

/**
 * One fill an account took part in. The index records the MAKER of every fill
 * and pairs the taker within its transaction (94% of fills; the rest have no
 * taker and so cannot appear in a taker's list). A fill records neither side
 * nor action, and only the maker's fee: the taker's fee and realised PnL exist
 * per position, on the round trip, not per fill.
 */
export interface AccountFill {
  /** "<txHash>-<logIndex>" of the maker fill. */
  readonly id: string;
  readonly atMs: number;
  readonly txHash: string;
  readonly market: MarketRef;
  /** This account's part in the fill. */
  readonly role: 'maker' | 'taker';
  readonly sizeLots: number;
  readonly price: number | undefined;
  readonly notionalAusd: number;
  /** The maker's fee; undefined for a taker fill, whose fee is not recorded per fill. */
  readonly makerFeeAusd: number | undefined;
  /**
   * What the fill did to this account's position, from the position event in
   * the same transaction. Undefined where no single event of this account on
   * this market is found (see `AccountFillsPage.directions`).
   */
  readonly direction?: { readonly action: 'open' | 'add' | 'reduce' | 'close' | 'flip'; readonly side: 'long' | 'short' } | undefined;
}

export interface AccountFillsPage {
  readonly fills: readonly AccountFill[];
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  /** How directions were resolved: fills left blank, and whether a cap on transactions read stopped short. */
  readonly directions?: { readonly blank: number; readonly cappedAtTxs: number | undefined } | undefined;
}

export interface DailyPoint {
  /** UTC midnight of the day. */
  readonly dayMs: number;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  readonly feesAusd: number;
  /** DISTINCT accounts that traded that day, across all markets. */
  readonly activeTraders: number;
  readonly liquidationCount: number;
  readonly rescuableLiquidationCount: number;
  /** Collateral deposited that day. Exact: flows carry their own timestamps. */
  readonly depositedAusd: number;
  readonly withdrawnAusd: number;
  /** `deposited - withdrawn`. The day's change in TVL, and nothing else moves it. */
  readonly netFlowAusd: number;
}

/**
 * One day of ONE market, for a stacked chart or a market page.
 *
 * Marks are undefined when the bucket recorded none (a day with no market-state
 * update), never zero: a zero close on a price chart is a crash that did not
 * happen.
 */
export interface MarketDailyPoint {
  readonly dayMs: number;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  readonly feesAusd: number;
  readonly liquidationCount: number;
  readonly rescuableLiquidationCount: number;
  /**
   * Cumulative since the start block, at the day's close, in LOTS (one side).
   * The index starts at the Exchange's deployment block, so this IS the level:
   * measured equal to the venue's own OI on every market, 6 Oct 2026.
   */
  readonly openInterestDeltaLots: number;
  readonly markOpen: number | undefined;
  readonly markHigh: number | undefined;
  readonly markLow: number | undefined;
  readonly markClose: number | undefined;
}

export interface MarketDailySeries {
  readonly market: MarketRef;
  /** Most recent last. Only days the market has a bucket for. */
  readonly points: readonly MarketDailyPoint[];
}

/**
 * Per-market figures over a window, with the long/short skew.
 *
 * FEES ARE MAKER PLUS TAKER, HERE AND ON {@link ProtocolMetrics}. One
 * definition: the sum of `MarketDay.feesCNS` over whole UTC days, labelled with
 * the range it covers, because taker fees have no finer timestamp. The exact
 * rolling maker half is served beside it under its own name and is never
 * called "fees". (CLAUDE.md.)
 */
export interface MarketBreakdown {
  readonly market: MarketRef;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  /** Maker and taker, over whole UTC days. `fees.label` says which days. */
  readonly fees: FeesForPeriod;
  /** MAKER fees over the rolling window, exact. Not "fees". */
  readonly makerFeesAusd: number;
  readonly openPositions: number;
  readonly longPositions: number;
  readonly shortPositions: number;
  /**
   * Long positions as a fraction of positions with a side, or undefined when
   * there are none.
   *
   * Counted in POSITIONS, not notional: a position's notional needs its entry
   * price, and `entryPriceKnown` is false for the ones opened before the start
   * block. A skew over a denominator that silently drops those would be wrong in
   * a way nobody could see.
   */
  readonly longShareOfPositions: number | undefined;
  /**
   * Isolated margin posted by each side's open positions, in collateral: what
   * each side has AT RISK.
   *
   * NOT NOTIONAL. On an order book every long lot has a matching short lot, so
   * open size per side is equal by construction and size × mark is 50/50 on
   * every market, always — a skew that cannot vary. Margin can: a side running
   * higher leverage posts less of it for the same size. Mainnet block
   * 110,176,799 (fixtures/open-positions-mainnet.json): BTC 887,454 lots long
   * and 887,454 short across 153 long and 112 short positions; margin 49.4% long.
   */
  readonly longMarginAusd: number;
  readonly shortMarginAusd: number;
  /** `long / (long + short)` by margin, or undefined when there is none. */
  readonly longShareOfMargin: number | undefined;
  /**
   * Open interest change since the indexer's START BLOCK, in this market's lots.
   *
   * CUMULATIVE, NOT WINDOWED, and not a level. Windowing it would need a bucket
   * boundary, and levelling it would need an anchor that does not exist — the
   * public RPC serves archive state only a few days back. Per market, because
   * lots are not comparable across markets: BTC has lotDecimals 5 and MON has 0.
   * For the absolute level, read the venue's own market state.
   */
  readonly openInterestDeltaLots: number;
  readonly liquidationCount: number;
  readonly rescuableLiquidationCount: number;
  readonly markPrice: number | undefined;
  readonly lastFundingRatePct: number | undefined;
}

// ── one liquidation ─────────────────────────────────────────────────────────

/**
 * How a position was forced flat. The indexer's `ForcedExitKind`, in domain
 * spelling. Every mainnet row so far is `liquidation`; the others are kept
 * because the contract can emit them and a row we cannot name must throw
 * rather than be filed under the wrong kind.
 */
export type ForcedExitKind = 'liquidation' | 'buy-to-liquidate' | 'deleverage' | 'unwind' | 'unwind-unpaid';

/**
 * THREE ANSWERS, NOT TWO. `unknown` is a liquidation of a position opened before
 * the indexer's start block, where the state needed to judge it does not exist.
 * It is neither a rescue nor a failure, and a UI renders it as its own thing —
 * the same rule as {@link RescueStats.unknownCount}, per row.
 */
export type RescueVerdict = 'rescuable' | 'not-rescuable' | 'unknown';

/** One forced exit, as the page lists it. */
export interface LiquidationRecord {
  /** `<txHash>-<logIndex>`: stable across polls, so a list can key on it. */
  readonly id: string;
  readonly atMs: number;
  readonly txHash: string;
  readonly market: MarketRef;
  /** The venue's account id: the handle the wallet page accepts. */
  readonly accountId: number;
  readonly side: Side;
  readonly kind: ForcedExitKind;
  /** False when only part of the position was taken. */
  readonly isFull: boolean;
  readonly sizeLots: number;
  readonly markPrice: number | undefined;
  /** What the engine actually closed at, not a computed threshold. */
  readonly execPrice: number | undefined;
  readonly notionalAusd: number;
  readonly marginLostAusd: number;
  readonly badDebtAusd: number;
  /** Free account balance the instant before. Isolated margin left it untouched. */
  readonly freeBalanceBeforeAusd: number;
  /** The top-up that would have kept it above maintenance. Undefined when unjudgeable. */
  readonly marginToSurviveAusd: number | undefined;
  readonly verdict: RescueVerdict;
}

// ── wallet level ────────────────────────────────────────────────────────────

/**
 * The result of asking about an address.
 *
 * `not-linked` EXISTS BECAUSE 88% OF MAINNET ACCOUNTS HAVE NO OWNER RECORDED.
 * Only `AccountCreated` ties a wallet to an account id and most accounts predate
 * the start block, so an address we cannot resolve is overwhelmingly the normal
 * case rather than a typo. Returning an empty profile for it would tell a trader
 * they have no history, which is a different and much worse claim than "I cannot
 * see which account is yours".
 */
export type WalletLookup =
  | {
      readonly kind: 'found';
      readonly profile: WalletProfile;
      /**
       * `index` when `AccountCreated` was indexed; `chain` when the Exchange's
       * own `getAccountByAddr` resolved it — the lookup Protect sign-in already
       * uses, and the one that works for the 88% with no owner recorded.
       */
      readonly resolvedBy: 'index' | 'chain';
    }
  | {
      readonly kind: 'not-linked';
      readonly address: string;
      /** Safe to render directly. Says what would resolve it. */
      readonly reason: string;
      /** Set when the chain named an account the index holds nothing for. */
      readonly accountId?: number;
    };

/**
 * One owner whose recorded address starts with a searched prefix.
 *
 * Only accounts whose `AccountCreated` the index saw have an owner at all, so a
 * prefix search sees the same 12% of mainnet accounts the full-address lookup
 * does. The address is served as stored, which on mainnet is EIP-55 mixed case.
 */
export interface WalletMatch {
  readonly address: string;
  readonly accountId: number;
}

export interface WalletProfile {
  /** Lowercased. Empty when the account was found by id and has no owner. */
  readonly address: string;
  /**
   * The venue's account id.
   *
   * Exposed because it is the only handle that works for an account whose owner
   * was never recorded, and a caller needs SOMETHING to ask about again. It is an
   * account identifier, not a market one — the venue rule is about not leaking
   * `perpId`, and an account id is the subject of the query.
   */
  readonly accountId: number;
  readonly firstTradeAtMs: number | undefined;
  readonly lastActiveAtMs: number;

  readonly openPositions: readonly OpenPosition[];
  readonly performance: WalletPerformance;
  readonly rescues: RescueStats;

  readonly realisedPnlAusd: number;
  /**
   * Funding, SIGNED: positive means this account was paid it, negative means it
   * paid. Not a cost to subtract — see {@link netPnlAusd}.
   */
  readonly fundingAusd: number;
  readonly feesPaidAusd: number;
  /**
   * `realised + funding - fees`. What actually reached the balance.
   *
   * Funding is ADDED because it is already signed. The indexer defines this once,
   * in `netPnl`, and this field is that definition rather than a second one —
   * reconciled against a live mainnet account: 38,783.55 + 34.39 - 28,219.69 =
   * 10,598.25, which is exactly what the Trader row carries.
   */
  readonly netPnlAusd: number;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  /**
   * The account's FREE balance as indexed: collateral not committed to any
   * position. Isolated margin never pulls it in to save a position, which is
   * why the bot's watched-wallet screen sets it beside what a position would
   * lose. Display value; anything that compares money recovers exact micros.
   */
  readonly freeBalanceAusd: number;
  /**
   * Lifetime totals of the indexed deposit and withdrawal events, the same
   * figures the Traders Flows ranking shows for All. Never a balance delta.
   */
  readonly depositedAusd: number;
  readonly withdrawnAusd: number;
}

/**
 * Lifetime facts behind a wallet's computed insights: counts and sums over the
 * account's CLOSED round trips (status not OPEN, the same set as the round-trip
 * list), straight from the index. No interpretation lives here; the rules that
 * turn these into sentences are pure functions on the page.
 */
export interface WalletInsightFacts {
  readonly accountId: number;
  readonly roundTrips: number;
  /** Mean leverage at open across the round trips, as a multiple. */
  readonly averageLeverage: number | undefined;
  /** The hold-time split below, in hours. */
  readonly holdThresholdHours: number;
  /** Round trips that were not wins (forced exits included). */
  readonly losingTrips: number;
  readonly losingTripsHeldOver: number;
  readonly tripsHeldOver: number;
  readonly longTrips: number;
  readonly shortTrips: number;
  readonly longNetPnlAusd: number;
  readonly shortNetPnlAusd: number;
}

/**
 * The median account's mean leverage at open, over accounts with at least
 * MIN_ROUND_TRIPS_FOR_RATIOS round trips: the baseline a wallet's leverage is
 * compared against. One scan of every position, so it is cached for an hour.
 */
export interface LeverageBaseline {
  readonly medianLeverage: number | undefined;
  readonly accounts: number;
  readonly minRoundTrips: number;
}

export interface OpenPosition {
  readonly market: MarketRef;
  readonly side: Side;
  readonly sizeLots: number;
  /** Undefined when the position predates the start block. Never guessed. */
  readonly entryPrice: number | undefined;
  readonly marginAusd: number;
  readonly leverage: number;
  readonly openedAtMs: number;
  readonly marginAddedAusd: number;
}

/**
 * An open position with the venue's mark and the risk maths applied — or, when
 * that is not possible, the position alone and the reason why. See `assess.ts`.
 *
 * `liqBufferPct` IS SIGNED (CLAUDE.md): negative means the position is already
 * past its liquidation price, and a UI renders that as "past liquidation",
 * never as a negative percentage and never as an absolute value.
 */
export interface AssessedPosition {
  readonly position: OpenPosition;
  readonly markPrice?: number | undefined;
  readonly markAtMs?: number | undefined;
  readonly notionalAusd?: number | undefined;
  readonly unrealisedPnlAusd?: number | undefined;
  /** Unrealised PnL over posted margin. Undefined when no margin is posted. */
  readonly pnlPctOfMargin?: number | undefined;
  readonly liquidationPrice?: number | undefined;
  readonly liqBufferPct?: number | undefined;
  readonly isLiquidatable?: boolean | undefined;
  /** Collateral needed right now to climb back to maintenance. Zero when safe. */
  readonly marginToSurviveAusd?: number | undefined;
  /** Present when the position could not be assessed. Safe to render. */
  readonly reason?: string | undefined;
}

/** What `/account/:id/positions` serves. `asOfMs` is the OLDEST mark used. */
export interface AssessedPositions {
  readonly positions: readonly AssessedPosition[];
  readonly asOfMs: number | undefined;
}

/** One completed round trip: a position from open to flat. */
export interface RoundTrip {
  readonly market: MarketRef;
  readonly side: Side;
  readonly sizeLots: number;
  readonly entryPrice: number | undefined;
  readonly netPnlAusd: number;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly holdMs: number;
  /** True when this exit was forced. A forced exit is a loss whatever the maths. */
  readonly wasForcedExit: boolean;
  readonly isWin: boolean;
}

/**
 * How a wallet has actually done.
 *
 * WIN RATE IS PER ROUND TRIP, not per trade: one position from open to flat, won
 * if its lifetime net PnL is positive. A forced exit counts as a loss whatever
 * the arithmetic says, because being liquidated is not a win.
 */
export interface WalletPerformance {
  readonly roundTrips: number;
  readonly wins: number;
  readonly losses: number;
  /**
   * Undefined below {@link MIN_ROUND_TRIPS_FOR_RATIOS} round trips, rather
   * than a figure computed off a handful of trades. The counts stay.
   */
  readonly winRate: number | undefined;
  /**
   * Gross profit over gross loss.
   *
   * Undefined below the same floor, and undefined when there are no losses —
   * the ratio is unbounded there, and `Infinity` in a UI reads as a bug rather
   * than as a perfect record.
   */
  readonly profitFactor: number | undefined;
  /** The floor the two ratios were withheld under. Rendered beside them. */
  readonly minRoundTripsForRatios: number;
  /**
   * Largest peak-to-trough fall in cumulative net PnL, in AUSD, as a positive
   * magnitude. Zero when the curve never fell.
   */
  readonly maxDrawdownAusd: number;
  readonly longestWinStreak: number;
  readonly longestLossStreak: number;
  readonly averageHoldMs: number | undefined;
  readonly bestRoundTripAusd: number;
  readonly worstRoundTripAusd: number;
  readonly bestMarket: MarketPnl | undefined;
  readonly worstMarket: MarketPnl | undefined;
}

export interface MarketPnl {
  readonly market: MarketRef;
  readonly netPnlAusd: number;
  readonly roundTrips: number;
}

// ── the Traders section ─────────────────────────────────────────────────────

export type TraderSortKey = 'netPnl' | 'volume' | 'roundTrips' | 'winRate' | 'liquidations' | 'freeBalance' | 'lastActive' | 'spareHeld' | 'deposits' | 'withdrawals' | 'netFlow' | 'netFlowAbs' | 'roi';
export type SortDirection = 'asc' | 'desc';

export const TRADER_SORT_KEYS: readonly TraderSortKey[] = ['netPnl', 'volume', 'roundTrips', 'winRate', 'liquidations', 'freeBalance', 'lastActive', 'spareHeld', 'deposits', 'withdrawals', 'netFlow', 'netFlowAbs', 'roi'];

/** The sorts the Flows ranking lets a reader choose between. Every other ranking's order is fixed. */
export const FLOW_SORT_KEYS: readonly TraderSortKey[] = ['netFlowAbs', 'netFlow', 'deposits', 'withdrawals'];

/**
 * The Traders page's leaderboards. Each is an order AND a filter, decided here
 * rather than in the page:
 *
 *   pnl, losses  Net PnL, desc / asc, over accounts with at least
 *                MIN_ROUND_TRIPS_FOR_RATIOS round trips in the window. One lucky
 *                (or unlucky) trade is not a ranking: the same floor as the
 *                ratios, and the list says how many it left out.
 *   volume       traded volume, desc. No floor: volume is not luck.
 *   liquidated   liquidation count, desc, over accounts liquidated at least once.
 *   spare        THE FINDING, PER TRADER: accounts with at least one RESCUABLE
 *                liquidation (free balance covered the shortfall; never the
 *                dust flag `hadSpareBalance`), by the LARGEST free balance held
 *                at any of them. The largest, not a sum: a sum counts one
 *                account's money once per liquidation.
 *   flows        CAPITAL MOVED: accounts with any deposit or withdrawal in the
 *                window, whether or not they traded, by |net flow| desc so the
 *                largest inflows and outflows both surface. The one ranking a
 *                reader may re-sort, among FLOW_SORT_KEYS. Deposits and
 *                withdrawals are the indexed events (CollateralFlow, summed
 *                into Trader and TraderDay), NEVER a balance delta: a balance
 *                also moves on PnL, funding, fees and liquidations.
 */
export type TraderRanking = 'pnl' | 'losses' | 'volume' | 'liquidated' | 'spare' | 'flows' | 'roi';
export const TRADER_RANKINGS: readonly TraderRanking[] = ['pnl', 'losses', 'volume', 'liquidated', 'spare', 'flows', 'roi'];

/**
 * Which rows the list's windowed columns were summed over.
 *
 * A trader's window comes from `TraderDay`, which is UTC-day bucketed, so a
 * `7d` request is served as whole days and SAYS SO: `honoursTimeframe` is
 * false and `label` names the days. `all` reads the lifetime `Trader` row and
 * honours the request exactly. The level columns — free balance, last active,
 * open positions — are always "now" whatever the window.
 */
export interface TraderWindow {
  readonly timeframe: Timeframe;
  readonly honoursTimeframe: boolean;
  /** A phrase a UI renders verbatim, e.g. "the 8 UTC days from 2026-09-23 (today so far)". */
  readonly label: string;
  /** How many UTC day buckets were summed, the partial current one included. Undefined for all time. */
  readonly days: number | undefined;
  readonly fromMs: number | undefined;
  readonly toMs: number;
}

export interface TraderRow {
  readonly accountId: number;
  /** Lowercased. Empty when the owner was never recorded. */
  readonly address: string;
  // ── over the window ──
  readonly netPnlAusd: number;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  readonly roundTrips: number;
  readonly wins: number;
  readonly losses: number;
  /** Undefined below {@link MIN_ROUND_TRIPS_FOR_RATIOS} round trips in the window. */
  readonly winRate: number | undefined;
  readonly liquidationCount: number;
  readonly rescuableLiquidationCount: number;
  /** Margin lost to forced exits in the window. A flow, so summing it is right. */
  readonly marginLostAusd: number;
  /**
   * The largest free balance held at any RESCUABLE liquidation in the window,
   * or undefined when there was none. A max, never a sum (see TraderRanking).
   */
  readonly maxSpareHeldAusd: number | undefined;
  /** Deposited into the account over the window, from the indexed deposit events. */
  readonly depositedAusd: number;
  /** Withdrawn over the window, from the indexed withdrawal events. */
  readonly withdrawnAusd: number;
  /** `depositedAusd - withdrawnAusd`, computed exactly in SQL. */
  readonly netFlowAusd: number;
  // ── now ──
  readonly freeBalanceAusd: number;
  readonly openPositionCount: number;
  readonly lastActiveAtMs: number;
  /**
   * Lifetime net PnL over lifetime deposits, in percent. ONLY on an all-time
   * list (see MIN_DEPOSIT_FOR_ROI_AUSD), and undefined under the deposit
   * floor. Render it with `depositedAusd` beside it, always.
   */
  readonly roiPct: number | undefined;
}

export interface TraderList {
  readonly rows: readonly TraderRow[];
  /** Traders with any activity in the window: the paging denominator. */
  readonly total: number;
  readonly window: TraderWindow;
  readonly sort: TraderSortKey;
  readonly direction: SortDirection;
  readonly limit: number;
  readonly offset: number;
  readonly minRoundTripsForRatios: number;
  /** The leaderboard this page is, when one was asked for. */
  readonly ranking: TraderRanking | undefined;
  /**
   * Accounts that traded in the window but were left out of a PnL ranking for
   * having fewer than `minRoundTripsForRatios` round trips. Undefined when no
   * floor applied (other rankings, or a search, which always finds an account).
   */
  readonly belowFloor: number | undefined;
  /** The search the rows were filtered by, normalised, when there was one. */
  readonly query: string | undefined;
}

/**
 * The Traders page's cards: every account that TRADED in the window, over the
 * same UTC-day buckets as the table, so the two always agree.
 */
export interface TraderSummary {
  /** The whole-UTC-day window of the per-trader figures (closed, profitable, median, liquidations). */
  readonly window: TraderWindow;
  /** Accounts with at least one fill in the ROLLING window: the Overview's own figure and query. */
  readonly traders: number;
  /**
   * Traded notional in the ROLLING window, counted ONCE PER MATCH: the
   * Overview's own figure and query. Not the sum of the rows' volume, which
   * credits maker and taker both and runs at about twice this.
   */
  readonly volumeAusd: number;
  /** Accounts with at least one closed round trip: the denominator below. */
  readonly closedTraders: number;
  /** Of `closedTraders`, those whose Net PnL (after fees and funding) is above zero. */
  readonly profitableTraders: number;
  /**
   * The median Net PnL across `closedTraders`. Undefined below
   * `minTradersForDistribution`: a median of four accounts describes nobody.
   */
  readonly medianNetPnlAusd: number | undefined;
  readonly minTradersForDistribution: number;
  readonly liquidations: number;
  readonly rescuableLiquidations: number;
}

/** Below this many accounts with a closed trade, the cards withhold the share and the median. */
export const MIN_TRADERS_FOR_DISTRIBUTION = 10;

/** One UTC day of one trader, straight off `TraderDay`. Buckets are the unit. */
export interface TraderDayPoint {
  readonly dayMs: number;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  readonly realisedPnlAusd: number;
  readonly fundingAusd: number;
  readonly feesAusd: number;
  readonly netPnlAusd: number;
  readonly wins: number;
  readonly losses: number;
  readonly liquidationCount: number;
  readonly rescuableLiquidationCount: number;
  readonly marginAddedAusd: number;
  readonly marginRemovedAusd: number;
  readonly depositedAusd: number;
  readonly withdrawnAusd: number;
  /** Free balance at the end of the day. A level, from the last event that day. */
  readonly endFreeBalanceAusd: number;
}

// ── the Liquidations section ────────────────────────────────────────────────

/** One band of a histogram. `maxAusd` undefined means open-ended. */
export interface LiquidationBand {
  readonly label: string;
  readonly minAusd: number;
  readonly maxAusd: number | undefined;
  readonly count: number;
  readonly rescuableCount: number;
  readonly notRescuableCount: number;
  readonly unknownCount: number;
}

/**
 * The finding taken apart, over one window.
 *
 * `bySize` bands liquidations by the notional taken; `bySpareBalance` bands
 * them by the free AUSD the account held at that moment. Every band carries
 * the three-way verdict so a reader can see WHERE the rescuable ones sit —
 * and the median shortfall says what a typical rescue would have cost.
 */
export interface LiquidationSummary {
  readonly timeframe: Timeframe;
  readonly bySize: readonly LiquidationBand[];
  readonly bySpareBalance: readonly LiquidationBand[];
  /** Median `marginToSurvive` over the RESCUABLE cases, or undefined when none. */
  readonly medianShortfallAusd: number | undefined;
  /** Over every judgeable case, rescuable or not. */
  readonly medianShortfallAllAusd: number | undefined;
}

// ── the Risk section ────────────────────────────────────────────────────────

/** Every open position the index holds, with its owner. The risk snapshot's input. */
export interface IndexedOpenPosition {
  readonly accountId: number;
  readonly position: OpenPosition;
}

// ── the interface ───────────────────────────────────────────────────────────

/**
 * Indexed history, venue-agnostic.
 *
 * Every method is async because the data is in a database; none of them takes a
 * market id, a `perpId`, or SQL.
 */
export interface Analytics {
  /**
   * Whether these numbers may be shown as current.
   *
   * SAME RULE AS THE PRICE FEED. Analytics that has gone blind must never look
   * healthy, and a HALTED indexer reports distinctly from a LAGGING one: a
   * lagging one's figures are real but out of date, a halted one's are frozen at
   * whatever the last processed block saw. `serveAsCurrent` is the single flag a
   * caller gates on, and it is true only when synced against an INDEPENDENT chain
   * head — the indexer's own `block_height` freezes with it when it dies, so a
   * dead indexer reads as zero blocks behind.
   */
  health(): Promise<IndexerHealth>;

  /** Headline figures over one window. */
  protocolMetrics(timeframe: Timeframe): Promise<ProtocolMetrics>;

  /**
   * Total value locked, now, from the chain.
   *
   * NOT WINDOWED, which is why it is its own method rather than a field on
   * {@link ProtocolMetrics}: a level does not belong inside an object keyed by a
   * timeframe, and putting it there would invite a caller to read "TVL over 24h".
   * Cached briefly — see `TvlProbe`.
   */
  tvl(): Promise<import('./tvl.ts').TvlReading>;

  /** Daily series, most recent last, for charting. */
  dailySeries(timeframe: Timeframe): Promise<readonly DailyPoint[]>;
  /** Every month since the index's first event. See {@link HistoryCurve}. */
  history(): Promise<HistoryCurve>;
  /** Lifetime facts for one account's computed insights; undefined when the account is not indexed. */
  walletInsightFacts(accountId: number): Promise<WalletInsightFacts | undefined>;
  /** The cross-account leverage baseline. Heavy: one pass over every position. */
  leverageBaseline(): Promise<LeverageBaseline>;
  /** Collateral deposited and withdrawn up to the index's latest processed block, exact, with that block. */
  collateralTotalsAtIndexHead(): Promise<CollateralTotalsAtBlock>;
  /** One account's fills, newest first, as maker and as taker. */
  accountFills(accountId: number, options?: { readonly limit?: number; readonly offset?: number }): Promise<AccountFillsPage>;
  /** The account ids with the most fills since launch, busiest first: the profiles worth computing ahead of a reader. */
  busiestAccounts(limit: number): Promise<readonly number[]>;
  /**
   * Whether the insurance funds have ever been drawn on: liquidations the fund
   * topped up (`PositionLiquidationCredit`) and liquidations that left bad
   * debt, over the whole index. From the indexer's own handler, so it is as
   * good as that handler, not an independent chain read.
   */
  backstopHistory(): Promise<BackstopHistory>;

  /**
   * The same days split per market, for a stacked chart. Markets ordered by
   * market id; a market absent from the venue context still appears, with
   * `symbol` undefined, so the chart can label it honestly rather than drop it.
   */
  dailySeriesByMarket(timeframe: Timeframe): Promise<readonly MarketDailySeries[]>;

  /** Per-market figures over one window, with the long/short skew by margin. */
  marketBreakdown(timeframe: Timeframe): Promise<readonly MarketBreakdown[]>;

  /** Funding over one window. */
  funding(timeframe: Timeframe): Promise<FundingStats>;

  /** Every funding rate applied in one window, per market, with their sum. */
  fundingSeries(timeframe: Timeframe): Promise<readonly MarketFundingSeries[]>;

  /** Every market the CHAIN lists, with its contract parameters. Not windowed. */
  marketListings(): Promise<readonly MarketListing[]>;

  /**
   * Forced exits in one window, most recent first.
   *
   * PAGED, like round trips: mainnet holds 680 and counting, and a caller that
   * asked for all of them would be asked to render all of them.
   */
  liquidations(
    timeframe: Timeframe,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<readonly LiquidationRecord[]>;

  /** @param address a wallet address. See {@link WalletLookup} on `not-linked`. */
  wallet(address: string): Promise<WalletLookup>;

  /** The same profile for an account id, which always resolves if it exists. */
  walletByAccountId(accountId: number): Promise<WalletProfile | undefined>;

  /**
   * Every recorded owner whose address starts with `prefix`, compared
   * case-insensitively, ordered by account id, at most `limit` of them.
   * `prefix` must already be `0x` plus hex; the caller validates.
   */
  walletSearch(prefix: string, limit: number): Promise<readonly WalletMatch[]>;

  /**
   * Completed round trips for one account, most recent first.
   *
   * PAGED, and not optional: one mainnet account has 207,681 of these, so a
   * method that returned them all would be a method nobody can call safely.
   */
  roundTrips(
    accountId: number,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<readonly RoundTrip[]>;

  /**
   * Every account with activity in the window, sorted and paged in SQL.
   *
   * `all` reads the lifetime `Trader` rows; a window sums `TraderDay` buckets
   * and the result says so — see {@link TraderWindow}.
   */
  traders(
    timeframe: Timeframe,
    options?: {
      readonly sort?: TraderSortKey;
      readonly direction?: SortDirection;
      readonly limit?: number;
      readonly offset?: number;
      /** A leaderboard: overrides sort and direction, and applies its filter. See TraderRanking. */
      readonly ranking?: TraderRanking;
      /** An address prefix (0x…) or an account id; a search drops the ranking floor so any account can be found. */
      readonly query?: string;
    },
  ): Promise<TraderList>;

  /** The cards over the Traders table. See TraderSummary. */
  traderSummary(timeframe: Timeframe): Promise<TraderSummary>;

  /** One account's UTC days in the window, oldest first. */
  traderDays(accountId: number, timeframe: Timeframe): Promise<readonly TraderDayPoint[]>;

  /** The liquidation finding banded by size and by spare balance. */
  liquidationSummary(timeframe: Timeframe): Promise<LiquidationSummary>;

  /**
   * Every open position in the index, for the protocol-wide risk snapshot.
   *
   * Not paged: mainnet holds a few hundred, and a stress test over a page of
   * them would be a stress test of nothing.
   */
  openPositions(): Promise<readonly IndexedOpenPosition[]>;
  /** The owners the index recorded (AccountCreated), lowercased; an account it never saw created is absent. */
  knownOwners(accountIds: readonly number[]): Promise<ReadonlyMap<number, string>>;
}

// ───────────────────────── copy trading: the replay's source ─────────────────────────

/**
 * One of a leader's positions, as the index holds it, for the copy replay
 * (`apps/backend/src/copy/replay.ts`). RAW INTEGERS: the replay does money
 * maths, and money maths in this repo is integer-only.
 *
 * The index keeps a position's open and close but not the adds and reduces
 * between, so this is the position's PEAK size and margin and its lifetime
 * result. A proportional copy of every fill at the leader's prices has exactly
 * the leader's result times the copy's scale, so the result is exact under
 * that assumption; the margin it needed is the peak's, which is conservative.
 */
export interface CopySourcePosition {
  readonly key: string;
  readonly market: MarketRef;
  readonly side: Side;
  /** `forced` is any forced exit: liquidated, deleveraged or unwound. */
  readonly status: 'open' | 'closed' | 'forced';
  readonly lotDecimals: number;
  readonly priceDecimals: number;
  readonly peakLotLNS: bigint;
  /** Size now: zero once closed. */
  readonly lotLNS: bigint;
  /** Undefined when the index never saw the entry price. */
  readonly entryPricePNS: bigint | undefined;
  readonly peakMarginCNS: bigint;
  /**
   * Lifetime realised P&L and funding; for an open position, so far.
   * WITHOUT FEES: the index keeps fees per account per UTC day, never per
   * position (`Position.feesCNS` is never written), so this is before fees.
   */
  readonly netPnlCNS: bigint;
  readonly leverageHdths: bigint;
  readonly openedAtMs: number;
  readonly closedAtMs: number | undefined;
}

/** Everything the replay reads about one leader over one window. */
export interface CopySource {
  readonly accountId: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly collateralDecimals: number;
  /**
   * The leader's equity when the window began: deposits minus withdrawals plus
   * the realised result of every position closed before it, minus the fees of
   * every whole UTC day that ended before it. Unrealised P&L of positions open
   * at that moment is not in it.
   */
  readonly equityAtStartCNS: bigint;
  /** Fees per UTC day inside the window, each taken when its day ends (the index keeps no finer grain). */
  readonly feesByDay: readonly { readonly atMs: number; readonly feesCNS: bigint }[];
  /** Deposits (+) and withdrawals (−) inside the window, oldest first. */
  readonly flows: readonly { readonly atMs: number; readonly deltaCNS: bigint }[];
  /** Positions opened before the window and closed inside it: they move the leader's equity, and are never copied. */
  readonly closedFromBefore: readonly { readonly atMs: number; readonly netPnlCNS: bigint }[];
  /** How many were already open when the window began. Never copied: a copy starts with new opens. */
  readonly openAtStart: number;
  /** How many the leader opened inside the window, whether or not `positions` holds them all. */
  readonly openedInWindow: number;
  /** Opened inside the window, oldest first, at most the cap asked for. */
  readonly positions: readonly CopySourcePosition[];
  /**
   * THE INDEX'S OWN BOOKS NOW, for reconciliation: the free balance, the
   * margin in open positions, and those open positions' results so far.
   */
  readonly now: { readonly freeCNS: bigint; readonly openMarginCNS: bigint; readonly openResultCNS: bigint };
}

/** How recently a trader opens positions: a top trader who stopped a week ago is no one to copy. */
export interface OpenActivity {
  readonly lastOpenedAtMs: number | undefined;
  readonly opened24h: number;
  readonly opened7d: number;
}

/** Reads a copy replay's source. Implemented by the Postgres analytics. */
export interface CopySourceReader {
  /** Undefined when the index has no such account. `cap` bounds `positions`; `openedInWindow` is always the true count. */
  copySource(accountId: number, window: { readonly fromMs: number; readonly toMs: number; readonly cap: number }): Promise<CopySource | undefined>;
  openActivity(accountId: number, nowMs: number): Promise<OpenActivity>;
}
