/**
 * Position lifecycle.
 *
 * Perpl is ISOLATED margin: each position carries its own collateral and the
 * account's free balance is never pulled in to rescue it. So a position is a
 * first-class row with its own margin, its own PnL and its own round trip.
 *
 * Every function here takes the entities it changes and returns the changed
 * copies. Nothing re-reads an entity it has already written, so two updates in
 * one handler can never lose each other.
 */
import type { EvmOnEventContext, Exchange, Market, MarketDay, Position, Trader } from "envio";
import { loadMarketDay, netPnl, withOiDelta, withOiObservation, withRoundTrip } from "./entities.ts";
import type { EventMeta } from "./entities.ts";
import { positionCursorId, positionId } from "./ids.ts";

type Context = EvmOnEventContext;

export interface OpenArgs {
  readonly side: "LONG" | "SHORT";
  readonly lotLNS: bigint;
  /**
   * False only when the event we are reacting to publishes no lot figure at all,
   * which is true of `PositionClosed` alone. An unknown size contributes nothing
   * to the open-interest series until the fill that follows supplies it.
   */
  readonly lotKnown?: boolean;
  readonly entryPricePNS: bigint;
  readonly depositCNS: bigint;
  readonly leverageHdths: bigint;
  /** False when we inferred the position rather than seeing it opened. */
  readonly entryPriceKnown: boolean;
  /**
   * True when this row stands in for a position that was already open at our
   * start block. An adopted position's existing lots are NOT added to open
   * interest: the delta series only carries real changes, and adding one side of
   * a position whose counterparty we never saw would break long == short.
   */
  readonly adopted?: boolean;
}

export interface Changed {
  readonly position: Position;
  readonly market: Market;
  readonly trader: Trader;
  /**
   * The Exchange row, threaded through for the same reason Market and Trader
   * are: a caller that changes it afterwards must build on the copy returned
   * here, not on a fresh read. `openPositionCount` was silently stuck at 0 for
   * exactly this reason -- it was the one counter nothing threaded.
   */
  readonly exchange: Exchange;
}

/**
 * Create a position row and take the next epoch for this (market, trader) pair.
 *
 * Used both for a position we watched open and for one we adopted mid-life; see
 * `OpenArgs.adopted` for what that changes.
 */
export async function openPosition(
  context: Context,
  exchange: Exchange,
  market: Market,
  trader: Trader,
  args: OpenArgs,
  meta: EventMeta,
): Promise<Changed> {
  const cursorId = positionCursorId(market.perpId, trader.accountId);
  const cursor = await context.PositionCursor.get(cursorId);
  const epoch = (cursor?.epoch ?? 0) + 1;
  const id = positionId(market.perpId, trader.accountId, epoch);

  const position: Position = {
    id,
    market_id: market.id,
    trader_id: trader.id,
    epoch,
    side: args.side,
    status: "OPEN",
    lotLNS: args.lotLNS,
    lotKnown: args.lotKnown !== false,
    peakLotLNS: args.lotLNS,
    entryPricePNS: args.entryPricePNS,
    entryPriceKnown: args.entryPriceKnown,
    depositCNS: args.depositCNS,
    peakDepositCNS: args.depositCNS,
    leverageHdths: args.leverageHdths,
    marginAddedCNS: 0n,
    marginRemovedCNS: 0n,
    marginActionCount: 0,
    realizedPnlCNS: 0n,
    fundingCNS: 0n,
    feesCNS: 0n,
    netPnlCNS: 0n,
    isWin: undefined,
    openedBlock: meta.blockNumber,
    openedAt: meta.timestamp,
    openTxHash: meta.txHash,
    closedBlock: undefined,
    closedAt: undefined,
    closeTxHash: undefined,
  };
  context.Position.set(position);
  context.PositionCursor.set({ id: cursorId, epoch, openPositionId: id });

  const adopted = args.adopted === true;
  const nextMarket: Market = {
    ...(adopted ? market : withOiDelta(market, args.side, args.lotLNS)),
    openPositionCount: market.openPositionCount + 1,
  };
  context.Market.set(nextMarket);

  const day = await loadMarketDay(context, nextMarket, meta);
  context.MarketDay.set({
    ...withOiObservation(day, nextMarket.openInterestDeltaLNS),
    positionsOpened: adopted ? day.positionsOpened : day.positionsOpened + 1,
  });

  const nextTrader: Trader = {
    ...trader,
    openPositionCount: trader.openPositionCount + 1,
    marginDeployedCNS: trader.marginDeployedCNS + args.depositCNS,
    firstTradeAt: trader.firstTradeAt ?? meta.timestamp,
    lastActiveAt: meta.timestamp,
  };
  context.Trader.set(nextTrader);

  // Counted for an adopted position too, exactly as Market and Trader are: the
  // row stands for a position that really is open, and the three counters are
  // verified against each other and against the open rows.
  const nextExchange: Exchange = {
    ...exchange,
    openPositionCount: exchange.openPositionCount + 1,
    updatedBlock: meta.blockNumber,
  };
  context.Exchange.set(nextExchange);

  return { position, market: nextMarket, trader: nextTrader, exchange: nextExchange };
}

/**
 * The position currently open for a (market, trader) pair, if we have it.
 *
 * Undefined means the position was already open at our start block: we saw it
 * change without ever seeing it opened.
 */
export async function livePosition(
  context: Context,
  perpId: bigint,
  accountId: bigint,
): Promise<Position | undefined> {
  const cursor = await context.PositionCursor.get(positionCursorId(perpId, accountId));
  if (!cursor?.openPositionId) return undefined;
  return context.Position.get(cursor.openPositionId);
}

/**
 * The open position, or a row adopting one that predates our start block.
 *
 * `entryPriceKnown` is false on an adopted row unless the caller genuinely has
 * the entry price from the event it is handling (`PositionIncreasedV2` publishes
 * the blended entry; `PositionDecreased` publishes no price at all). Everything
 * that depends on the entry price is left null downstream rather than guessed.
 */
export async function ensurePosition(
  context: Context,
  exchange: Exchange,
  market: Market,
  trader: Trader,
  args: OpenArgs,
  meta: EventMeta,
): Promise<Changed> {
  const existing = await livePosition(context, market.perpId, trader.accountId);
  if (existing) return { position: existing, market, trader, exchange };
  return openPosition(context, exchange, market, trader, { ...args, adopted: true }, meta);
}

export interface CloseArgs {
  readonly status: "CLOSED" | "LIQUIDATED" | "DELEVERAGED" | "UNWOUND";
  /** A forced exit is scored as a loss whatever the PnL arithmetic says. */
  readonly forced: boolean;
}

/**
 * Take a position to flat: clear its lots and margin, score the round trip, and
 * remove its lots from open interest.
 */
export async function closePosition(
  context: Context,
  position: Position,
  exchange: Exchange,
  market: Market,
  trader: Trader,
  args: CloseArgs,
  meta: EventMeta,
): Promise<Changed> {
  // Open interest only ever moves by a delta an event actually published. A
  // position whose size we never learned takes its lots out of the series when
  // the following fill tells us what they were, not now, and is counted so the
  // long == short check stays meaningful in the meantime.
  const lotsToRemove = position.lotKnown ? position.lotLNS : 0n;
  const tripNetPnlCNS = netPnl(position.realizedPnlCNS, position.fundingCNS, position.feesCNS);
  const closed: Position = {
    ...position,
    status: args.status,
    lotLNS: 0n,
    depositCNS: 0n,
    netPnlCNS: tripNetPnlCNS,
    isWin: !args.forced && tripNetPnlCNS > 0n,
    closedBlock: meta.blockNumber,
    closedAt: meta.timestamp,
    closeTxHash: meta.txHash,
  };
  context.Position.set(closed);
  context.PositionCursor.set({
    id: positionCursorId(market.perpId, trader.accountId),
    epoch: position.epoch,
    openPositionId: undefined,
  });

  const nextMarket: Market = {
    ...withOiDelta(market, position.side, -lotsToRemove),
    openPositionCount: Math.max(0, market.openPositionCount - 1),
    oiUnverifiedCloseCount:
      market.oiUnverifiedCloseCount + (position.lotKnown ? 0 : 1),
  };
  context.Market.set(nextMarket);

  const day = await loadMarketDay(context, nextMarket, meta);
  context.MarketDay.set({
    ...withOiObservation(day, nextMarket.openInterestDeltaLNS),
    positionsClosed: day.positionsClosed + 1,
  });

  const scored = withRoundTrip(trader, tripNetPnlCNS, args.forced);
  const nextTrader: Trader = {
    ...scored,
    openPositionCount: Math.max(0, trader.openPositionCount - 1),
    marginDeployedCNS: trader.marginDeployedCNS - position.depositCNS,
    lastActiveAt: meta.timestamp,
  };
  context.Trader.set(nextTrader);

  const nextExchange: Exchange = {
    ...exchange,
    openPositionCount: Math.max(0, exchange.openPositionCount - 1),
    updatedBlock: meta.blockNumber,
  };
  context.Exchange.set(nextExchange);

  return { position: closed, market: nextMarket, trader: nextTrader, exchange: nextExchange };
}

/** Roll the day's open-interest observation after a size change. */
export async function observeOi(
  context: Context,
  market: Market,
  meta: EventMeta,
): Promise<MarketDay> {
  const day = await loadMarketDay(context, market, meta);
  const next = withOiObservation(day, market.openInterestDeltaLNS);
  context.MarketDay.set(next);
  return next;
}

/**
 * Supply the size of a close that `PositionClosed` could not publish.
 *
 * Called from the fill that follows it in the same transaction: for a full close
 * the lots matched are the whole position, so this is where those lots finally
 * leave the open-interest series and the long == short check comes back into
 * balance.
 */
export async function resolveUnsizedClose(
  context: Context,
  positionId: string,
  market: Market,
  lotLNS: bigint,
  meta: EventMeta,
): Promise<Market> {
  const position = await context.Position.get(positionId);
  if (!position || position.lotKnown) return market;

  context.Position.set({
    ...position,
    lotKnown: true,
    peakLotLNS: lotLNS > position.peakLotLNS ? lotLNS : position.peakLotLNS,
  });

  const next: Market = {
    ...withOiDelta(market, position.side, -lotLNS),
    oiUnverifiedCloseCount: Math.max(0, market.oiUnverifiedCloseCount - 1),
  };
  context.Market.set(next);
  await observeOi(context, next, meta);
  return next;
}
