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
}

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
  /** Total free AUSD sitting in these accounts at the moment of liquidation. */
  readonly spareBalanceAusd: number;
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

/** One day of one figure, for a chart. Buckets ARE the unit here. */
export interface DailyPoint {
  /** UTC midnight of the day. */
  readonly dayMs: number;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  readonly feesAusd: number;
  readonly activeTraders: number;
  readonly liquidationCount: number;
  readonly rescuableLiquidationCount: number;
  readonly openInterestDeltaLots: number;
}

/** Per-market figures over a window, with the long/short skew. */
export interface MarketBreakdown {
  readonly market: MarketRef;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  readonly feesAusd: number;
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
  | { readonly kind: 'found'; readonly profile: WalletProfile }
  | {
      readonly kind: 'not-linked';
      readonly address: string;
      /** Safe to render directly. Says what would resolve it. */
      readonly reason: string;
    };

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
  /** Undefined when there are no round trips, rather than a misleading 0. */
  readonly winRate: number | undefined;
  /**
   * Gross profit over gross loss.
   *
   * Undefined when there are no losses — the ratio is unbounded there, and
   * `Infinity` in a UI reads as a bug rather than as a perfect record.
   */
  readonly profitFactor: number | undefined;
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

  /** Per-market figures over one window, with the long/short skew. */
  marketBreakdown(timeframe: Timeframe): Promise<readonly MarketBreakdown[]>;

  /** Funding over one window. */
  funding(timeframe: Timeframe): Promise<FundingStats>;

  /** @param address a wallet address. See {@link WalletLookup} on `not-linked`. */
  wallet(address: string): Promise<WalletLookup>;

  /** The same profile for an account id, which always resolves if it exists. */
  walletByAccountId(accountId: number): Promise<WalletProfile | undefined>;

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
}
