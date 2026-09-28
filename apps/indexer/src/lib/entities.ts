/**
 * Entity loaders and the aggregate arithmetic every handler shares.
 *
 * Handlers stay thin: they decode one event and call in here. The rules that
 * must hold everywhere — how open interest moves, how a round trip is scored,
 * how a day bucket is opened — live once, in this file.
 */
import type { EvmOnEventContext, Market, MarketDay, Trader, TraderDay } from "envio";
import { BigDecimal } from "envio";
import { getExchangeIdentity, getMarketInfo } from "./chain.ts";
import {
  dayStart,
  exchangeId,
  marketDayId,
  marketDayTraderId,
  marketId,
  traderDayId,
  traderId,
} from "./ids.ts";

type Context = EvmOnEventContext;

/** The block coordinates every handler needs; `hash` requires `fields` on the event. */
export interface EventMeta {
  readonly blockNumber: bigint;
  readonly timestamp: Date;
  readonly day: Date;
  readonly txHash: string;
  readonly logIndex: number;
  readonly chainId: number;
}

export function metaOf(event: {
  block: { number: number; timestamp: number };
  transaction: { hash: string };
  logIndex: number;
  chainId: number;
}): EventMeta {
  return {
    blockNumber: BigInt(event.block.number),
    timestamp: new Date(event.block.timestamp * 1000),
    day: dayStart(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    chainId: event.chainId,
  };
}

// ───────────────────────────── Exchange ──────────────────────────────────────

export async function loadExchange(context: Context, meta: EventMeta) {
  const id = exchangeId(meta.chainId);
  const existing = await context.Exchange.get(id);
  if (existing) return existing;

  // First event of the run: ExchangeInitialized is millions of blocks behind our
  // start block, so the identity comes off the contract.
  const identity = await context.effect(getExchangeIdentity, undefined);
  const created = {
    id,
    address: (process.env.ENVIO_PERPL_EXCHANGE ??
      "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F") as string,
    implementation: identity.implementation,
    contractVersion: identity.contractVersion,
    halted: identity.halted,
    collateralToken: identity.collateralToken,
    collateralDecimals: identity.collateralDecimals,
    accountCount: 0,
    marketCount: 0,
    openPositionCount: 0,
    tradeCount: 0n,
    volumeCNS: 0n,
    feesCNS: 0n,
    liquidationCount: 0,
    liquidatedNotionalCNS: 0n,
    liquidationsWithSpareBalanceCount: 0,
    rescuableLiquidationCount: 0,
    spareBalanceAtLiquidationCNS: 0n,
    liquidationsWithUnknownPositionCount: 0,
    unattributedTakerFeeCNS: 0n,
    lastUpgradeBlock: undefined,
    lastUpgradeAt: undefined,
    updatedBlock: meta.blockNumber,
  };
  context.Exchange.set(created);
  return created;
}

/** AUSD decimals, read from the Exchange rather than assumed to be 6. */
export async function collateralDecimals(context: Context, meta: EventMeta): Promise<number> {
  return (await loadExchange(context, meta)).collateralDecimals;
}

// ────────────────────────────── Market ───────────────────────────────────────

export async function loadMarket(
  context: Context,
  perpId: bigint,
  meta: EventMeta,
): Promise<Market> {
  const id = marketId(perpId);
  const existing = await context.Market.get(id);
  if (existing) return existing;

  const info = await context.effect(getMarketInfo, perpId);
  const created: Market = {
    id,
    perpId,
    name: info.name,
    symbol: info.symbol,
    priceDecimals: info.priceDecimals,
    lotDecimals: info.lotDecimals,
    status: info.status,
    paused: false,
    listed: true,
    initMarginFracHdths: info.initMarginFracHdths,
    maintMarginFracHdths: info.maintMarginFracHdths,
    maxOpenInterestLNS: info.maxOpenInterestLNS,
    markPricePNS: info.markPNS,
    markUpdatedBlock: meta.blockNumber,
    markUpdatedAt: meta.timestamp,
    lastFundingRatePct100k: undefined,
    lastFundingAt: undefined,
    // Open interest is a signed DELTA SERIES from our start block, not a level.
    // It starts at zero on purpose: the public RPC serves archive state only a
    // few days back, so there is no exact anchor at the start block, and an
    // approximate one would break the long == short check below.
    longLotsDeltaLNS: 0n,
    shortLotsDeltaLNS: 0n,
    openInterestDeltaLNS: 0n,
    openPositionCount: 0,
    tradeCount: 0n,
    volumeCNS: 0n,
    feesCNS: 0n,
    liquidationCount: 0,
    liquidatedNotionalCNS: 0n,
    rescuableLiquidationCount: 0,
    oiUnverifiedCloseCount: 0,
    firstSeenBlock: meta.blockNumber,
    firstSeenAt: meta.timestamp,
  };
  context.Market.set(created);

  const exchange = await loadExchange(context, meta);
  context.Exchange.set({ ...exchange, marketCount: exchange.marketCount + 1 });
  return created;
}

/**
 * Move open interest by `deltaLots` on one side of a market.
 *
 * Every match moves both sides by the same number of lots, so
 * `longLotsDeltaLNS` and `shortLotsDeltaLNS` must stay equal at all times. They
 * are tracked separately precisely so that a divergence is visible. Only real
 * deltas go through here: a position that predates our start block never has its
 * existing lots added, because that would be an asymmetric change.
 */
export function withOiDelta(market: Market, side: "LONG" | "SHORT", deltaLots: bigint): Market {
  const longLotsDeltaLNS = side === "LONG" ? market.longLotsDeltaLNS + deltaLots : market.longLotsDeltaLNS;
  const shortLotsDeltaLNS = side === "SHORT" ? market.shortLotsDeltaLNS + deltaLots : market.shortLotsDeltaLNS;
  return {
    ...market,
    longLotsDeltaLNS,
    shortLotsDeltaLNS,
    // One figure for the net change, taking the long side by convention.
    openInterestDeltaLNS: longLotsDeltaLNS,
  };
}

// ────────────────────────────── Trader ───────────────────────────────────────

export async function loadTrader(
  context: Context,
  accountId: bigint,
  meta: EventMeta,
): Promise<Trader> {
  const id = traderId(accountId);
  const existing = await context.Trader.get(id);
  if (existing) return existing;

  const created: Trader = {
    id,
    accountId,
    // Only AccountCreated links an account to a wallet, and most accounts were
    // created long before our start block. Empty means "not seen", not "none".
    owner: "",
    createdBlock: undefined,
    createdAt: undefined,
    forwardingAllowed: false,
    feeTier: 0,
    freeBalanceCNS: 0n,
    depositedCNS: 0n,
    withdrawnCNS: 0n,
    marginDeployedCNS: 0n,
    realizedPnlCNS: 0n,
    fundingCNS: 0n,
    feesPaidCNS: 0n,
    netPnlCNS: 0n,
    volumeCNS: 0n,
    tradeCount: 0,
    makerTradeCount: 0,
    takerTradeCount: 0,
    roundTrips: 0,
    wins: 0,
    losses: 0,
    winRate: new BigDecimal(0),
    bestRoundTripCNS: 0n,
    worstRoundTripCNS: 0n,
    liquidationCount: 0,
    liquidatedNotionalCNS: 0n,
    liquidationsWithSpareBalanceCount: 0,
    rescuableLiquidationCount: 0,
    spareBalanceAtLiquidationCNS: 0n,
    marginAddCount: 0,
    marginAddedCNS: 0n,
    marginRemovedCNS: 0n,
    openPositionCount: 0,
    firstTradeAt: undefined,
    lastActiveAt: meta.timestamp,
  };
  context.Trader.set(created);

  const exchange = await loadExchange(context, meta);
  context.Exchange.set({ ...exchange, accountCount: exchange.accountCount + 1 });
  return created;
}

/** Net PnL is one definition in one place: realized, plus funding, less fees. */
export const netPnl = (realizedPnlCNS: bigint, fundingCNS: bigint, feesCNS: bigint): bigint =>
  realizedPnlCNS + fundingCNS - feesCNS;

/**
 * Score one completed round trip.
 *
 * A round trip is a Position from open to flat. It wins if its lifetime net PnL
 * is positive. A forced exit is a loss whatever the arithmetic says: a trader
 * whose position was taken away did not win it.
 */
export function withRoundTrip(trader: Trader, tripNetPnlCNS: bigint, forced: boolean): Trader {
  const won = !forced && tripNetPnlCNS > 0n;
  const roundTrips = trader.roundTrips + 1;
  const wins = trader.wins + (won ? 1 : 0);
  return {
    ...trader,
    roundTrips,
    wins,
    losses: trader.losses + (won ? 0 : 1),
    // Integer percentage-free ratio, to 4 decimal places. Zero until the first
    // round trip completes, never null.
    winRate: new BigDecimal(wins).div(new BigDecimal(roundTrips)).decimalPlaces(4),
    bestRoundTripCNS:
      tripNetPnlCNS > trader.bestRoundTripCNS ? tripNetPnlCNS : trader.bestRoundTripCNS,
    worstRoundTripCNS:
      tripNetPnlCNS < trader.worstRoundTripCNS ? tripNetPnlCNS : trader.worstRoundTripCNS,
  };
}

// ──────────────────────────── day buckets ────────────────────────────────────

export async function loadMarketDay(
  context: Context,
  market: Market,
  meta: EventMeta,
): Promise<MarketDay> {
  const id = marketDayId(market.perpId, meta.day);
  const existing = await context.MarketDay.get(id);
  if (existing) return existing;

  // A fresh day opens at the market's current state, so OHLC has a real open
  // even on a day whose first event is not a price update.
  const mark = market.markPricePNS ?? 0n;
  const created: MarketDay = {
    id,
    market_id: market.id,
    day: meta.day,
    volumeCNS: 0n,
    tradeCount: 0,
    feesCNS: 0n,
    activeTraderCount: 0,
    oiDeltaOpenLNS: market.openInterestDeltaLNS,
    oiDeltaCloseLNS: market.openInterestDeltaLNS,
    oiDeltaHighLNS: market.openInterestDeltaLNS,
    oiDeltaLowLNS: market.openInterestDeltaLNS,
    markOpenPNS: mark,
    markHighPNS: mark,
    markLowPNS: mark,
    markClosePNS: mark,
    liquidationCount: 0,
    liquidatedNotionalCNS: 0n,
    liquidatedMarginCNS: 0n,
    liquidationsWithSpareBalanceCount: 0,
    rescuableLiquidationCount: 0,
    spareBalanceAtLiquidationCNS: 0n,
    positionsOpened: 0,
    positionsClosed: 0,
    marginAddedCNS: 0n,
    marginRemovedCNS: 0n,
    fundingRateSumPct100k: 0n,
    fundingEventCount: 0,
  };
  context.MarketDay.set(created);
  return created;
}

/** Roll the day's open-interest high/low/close to the market's current value. */
export function withOiObservation(day: MarketDay, openInterestDeltaLNS: bigint): MarketDay {
  return {
    ...day,
    oiDeltaCloseLNS: openInterestDeltaLNS,
    oiDeltaHighLNS:
      openInterestDeltaLNS > day.oiDeltaHighLNS ? openInterestDeltaLNS : day.oiDeltaHighLNS,
    oiDeltaLowLNS:
      openInterestDeltaLNS < day.oiDeltaLowLNS ? openInterestDeltaLNS : day.oiDeltaLowLNS,
  };
}

export function withMarkObservation(day: MarketDay, markPNS: bigint): MarketDay {
  // A day bucket opened before any price was known has a zero open; the first
  // real price fills it rather than leaving a zero in the OHLC.
  const seeded = day.markOpenPNS === 0n;
  return {
    ...day,
    markOpenPNS: seeded ? markPNS : day.markOpenPNS,
    markHighPNS: seeded || markPNS > day.markHighPNS ? markPNS : day.markHighPNS,
    markLowPNS: seeded || markPNS < day.markLowPNS ? markPNS : day.markLowPNS,
    markClosePNS: markPNS,
  };
}

export async function loadTraderDay(
  context: Context,
  trader: Trader,
  meta: EventMeta,
): Promise<TraderDay> {
  const id = traderDayId(trader.accountId, meta.day);
  const existing = await context.TraderDay.get(id);
  if (existing) return existing;

  const created: TraderDay = {
    id,
    trader_id: trader.id,
    day: meta.day,
    volumeCNS: 0n,
    tradeCount: 0,
    realizedPnlCNS: 0n,
    fundingCNS: 0n,
    feesCNS: 0n,
    netPnlCNS: 0n,
    wins: 0,
    losses: 0,
    liquidationCount: 0,
    rescuableLiquidationCount: 0,
    marginAddedCNS: 0n,
    marginRemovedCNS: 0n,
    depositedCNS: 0n,
    withdrawnCNS: 0n,
    endFreeBalanceCNS: trader.freeBalanceCNS,
  };
  context.TraderDay.set(created);
  return created;
}

/**
 * Count a trader as active on a market for this day, once.
 *
 * Returns true the first time, which is when the day's counter moves. A set
 * membership row is the only way to count distinct traders without holding the
 * whole set in memory.
 */
export async function markTraderActive(
  context: Context,
  perpId: bigint,
  accountId: bigint,
  meta: EventMeta,
): Promise<boolean> {
  const id = marketDayTraderId(perpId, meta.day, accountId);
  if (await context.MarketDayTrader.get(id)) return false;
  context.MarketDayTrader.set({ id });
  return true;
}
