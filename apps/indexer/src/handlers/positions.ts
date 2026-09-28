/**
 * Position changes: the source of every realized-PnL figure in the schema.
 *
 * Perpl publishes `perpId` and `accountId` on every position event, which is why
 * per-trader PnL, fees and volume can be built from these plus the maker fill,
 * without indexing `OrderRequestV2` -- the most expensive event on the contract
 * at roughly 35 per block.
 *
 * `positionType` is 0 = LONG, 1 = SHORT, measured over 496 real mainnet round
 * trips rather than assumed (see CLAUDE.md).
 *
 * Fees are NOT taken from `insFeeCNS` + `protFeeCNS` here. Those are the taker
 * fee decomposed -- on a real fill, 3150 + 17848 exactly equals the 20998 that
 * `TakerOrderFilledV2` reports -- so counting both would double count. Fees come
 * from the fill events only; see src/handlers/trades.ts.
 */
import { indexer } from "envio";
import {
  loadExchange,
  loadMarket,
  loadTrader,
  loadTraderDay,
  metaOf,
  netPnl,
} from "../lib/entities.ts";
import type { EventMeta } from "../lib/entities.ts";
import { closePosition, ensurePosition, livePosition, observeOi, openPosition } from "../lib/positions.ts";
import { withOiDelta } from "../lib/entities.ts";
import { flipSide, sideOf, type SideContext } from "../lib/scale.ts";
import { attributeTaker } from "../lib/takers.ts";
import { claimTradeAndBecomeActor, offerUnsizedClose } from "../lib/txScope.ts";
import { markTraderActive } from "../lib/entities.ts";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

/**
 * Locate a positionType for the error sideOf throws when it cannot decode one.
 * A halted indexer is a real cost, so the halt has to say exactly which log
 * did it.
 */
const at = (
  event: string,
  params: { perpId: bigint; accountId: bigint },
  meta: EventMeta,
): SideContext => ({
  event,
  perpId: params.perpId,
  accountId: params.accountId,
  blockNumber: meta.blockNumber,
  txHash: meta.txHash,
});

/**
 * Shared prologue: load the exchange, market and trader, claim any maker fill
 * in this transaction that was waiting to learn its taker, and register this
 * account as the taker of any fill that follows.
 */
async function enter(
  context: Parameters<typeof loadMarket>[0],
  perpId: bigint,
  accountId: bigint,
  meta: EventMeta,
) {
  const market = await loadMarket(context, perpId, meta);
  let trader = await loadTrader(context, accountId, meta);
  const tradeId = await claimTradeAndBecomeActor(context, meta, perpId, accountId);
  if (tradeId) trader = await attributeTaker(context, tradeId, trader, meta);
  if (await markTraderActive(context, perpId, accountId, meta)) {
    const day = await context.MarketDay.get(`${perpId}-${meta.day.toISOString().slice(0, 10)}`);
    if (day) context.MarketDay.set({ ...day, activeTraderCount: day.activeTraderCount + 1 });
  }
  // LAST, deliberately. loadMarket and loadTrader each bump a counter on the
  // Exchange row when they create something, so a copy taken before them would
  // be stale and the caller's write would silently drop marketCount or
  // accountCount. Read it once everything that might touch it is done.
  const exchange = await loadExchange(context, meta);
  return { exchange, market, trader };
}

/** Record realized PnL and funding on the position, the trader and the day. */
async function realize(
  context: Parameters<typeof loadMarket>[0],
  positionRow: NonNullable<Awaited<ReturnType<typeof livePosition>>>,
  trader: Awaited<ReturnType<typeof loadTrader>>,
  deltaPnlCNS: bigint,
  fundingCNS: bigint,
  meta: EventMeta,
) {
  const position = {
    ...positionRow,
    realizedPnlCNS: positionRow.realizedPnlCNS + deltaPnlCNS,
    fundingCNS: positionRow.fundingCNS + fundingCNS,
    netPnlCNS: netPnl(
      positionRow.realizedPnlCNS + deltaPnlCNS,
      positionRow.fundingCNS + fundingCNS,
      positionRow.feesCNS,
    ),
  };
  const nextTrader = {
    ...trader,
    realizedPnlCNS: trader.realizedPnlCNS + deltaPnlCNS,
    fundingCNS: trader.fundingCNS + fundingCNS,
    netPnlCNS: netPnl(
      trader.realizedPnlCNS + deltaPnlCNS,
      trader.fundingCNS + fundingCNS,
      trader.feesPaidCNS,
    ),
    lastActiveAt: meta.timestamp,
  };
  context.Trader.set(nextTrader);

  const day = await loadTraderDay(context, nextTrader, meta);
  context.TraderDay.set({
    ...day,
    realizedPnlCNS: day.realizedPnlCNS + deltaPnlCNS,
    fundingCNS: day.fundingCNS + fundingCNS,
    netPnlCNS: netPnl(
      day.realizedPnlCNS + deltaPnlCNS,
      day.fundingCNS + fundingCNS,
      day.feesCNS,
    ),
  });
  return { position, trader: nextTrader };
}

// ──────────────────────────────── open ───────────────────────────────────────

for (const eventName of ["PositionOpenedV2", "PositionOpened"] as const) {
  indexer.onEvent({ contract: "Exchange", event: eventName, fields }, async ({ event, context }) => {
    const meta = metaOf(event);
    const { exchange, market, trader } = await enter(
      context,
      event.params.perpId,
      event.params.accountId,
      meta,
    );
    await openPosition(
      context,
      exchange,
      market,
      trader,
      {
        side: sideOf(event.params.positionType, at(eventName, event.params, meta)),
        lotLNS: event.params.lotLNS,
        entryPricePNS: event.params.pricePNS,
        depositCNS: event.params.depositCNS,
        leverageHdths: event.params.leverageHdths,
        entryPriceKnown: true,
      },
      meta,
    );
  });
}

// ─────────────────────────────── increase ────────────────────────────────────

for (const eventName of ["PositionIncreasedV2", "PositionIncreased"] as const) {
  indexer.onEvent({ contract: "Exchange", event: eventName, fields }, async ({ event, context }) => {
    const meta = metaOf(event);
    const side = sideOf(event.params.positionType, at(eventName, event.params, meta));
    const { exchange, market, trader } = await enter(
      context,
      event.params.perpId,
      event.params.accountId,
      meta,
    );
    // `pricePNS` on this event is the position's BLENDED entry price after the
    // fill, not the fill price, so it is the entry price even when we are
    // adopting a position we never saw opened.
    const adoptArgs = {
      side,
      lotLNS: event.params.startLotLNS,
      entryPricePNS: event.params.pricePNS,
      depositCNS: event.params.startDepositCNS,
      leverageHdths: event.params.leverageHdths,
      entryPriceKnown: true,
    };
    const opened = await ensurePosition(context, exchange, market, trader, adoptArgs, meta);
    // Deltas come from the contract's own start/end figures, not from what we
    // have stored. Every match moves both sides by the same number of lots, so
    // using the published delta is what keeps long == short exact.
    const lotDelta = event.params.endLotLNS - event.params.startLotLNS;
    const depositDelta = event.params.endDepositCNS - event.params.startDepositCNS;

    context.Position.set({
      ...opened.position,
      lotLNS: event.params.endLotLNS,
      peakLotLNS:
        event.params.endLotLNS > opened.position.peakLotLNS
          ? event.params.endLotLNS
          : opened.position.peakLotLNS,
      entryPricePNS: event.params.pricePNS,
      entryPriceKnown: true,
      lotKnown: true,
      depositCNS: event.params.endDepositCNS,
      peakDepositCNS:
        event.params.endDepositCNS > opened.position.peakDepositCNS
          ? event.params.endDepositCNS
          : opened.position.peakDepositCNS,
      leverageHdths: event.params.leverageHdths,
    });

    const market2 = withOiDelta(opened.market, side, lotDelta);
    context.Market.set(market2);
    await observeOi(context, market2, meta);

    context.Trader.set({
      ...opened.trader,
      marginDeployedCNS: opened.trader.marginDeployedCNS + depositDelta,
      lastActiveAt: meta.timestamp,
    });
  });
}

// ─────────────────────────────── decrease ────────────────────────────────────

/**
 * `deltaPnlCNS` here is REALIZED PnL on the part that was closed, and
 * `fundingCNS` the funding settled with it. This event carries no price, so a
 * position first seen decreasing has no known entry price and every figure that
 * needs one stays null.
 */
indexer.onEvent(
  { contract: "Exchange", event: "PositionDecreased", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const side = sideOf(event.params.positionType, at("PositionDecreased", event.params, meta));
    const { exchange, market, trader } = await enter(
      context,
      event.params.perpId,
      event.params.accountId,
      meta,
    );
    const opened = await ensurePosition(
      context,
      exchange,
      market,
      trader,
      {
        side,
        lotLNS: event.params.startLotLNS,
        entryPricePNS: 0n,
        depositCNS: event.params.startDepositCNS,
        leverageHdths: 0n,
        entryPriceKnown: false,
      },
      meta,
    );
    const realized = await realize(
      context,
      opened.position,
      opened.trader,
      event.params.deltaPnlCNS,
      event.params.fundingCNS,
      meta,
    );
    const lotDelta = event.params.endLotLNS - event.params.startLotLNS;
    const depositDelta = event.params.endDepositCNS - event.params.startDepositCNS;

    context.Position.set({
      ...realized.position,
      lotKnown: true,
      lotLNS: event.params.endLotLNS,
      depositCNS: event.params.endDepositCNS,
    });

    const market2 = withOiDelta(opened.market, side, lotDelta);
    context.Market.set(market2);
    await observeOi(context, market2, meta);

    context.Trader.set({
      ...realized.trader,
      marginDeployedCNS: realized.trader.marginDeployedCNS + depositDelta,
    });
  },
);

// ──────────────────────────────── close ──────────────────────────────────────

/** Position went to zero: the round trip is scored here. */
indexer.onEvent(
  { contract: "Exchange", event: "PositionClosed", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const side = sideOf(event.params.positionType, at("PositionClosed", event.params, meta));
    const { exchange, market, trader } = await enter(
      context,
      event.params.perpId,
      event.params.accountId,
      meta,
    );
    // This event publishes no lot figure, so a position we are seeing for the
    // first time here has an unknown size. It is adopted as unknown and parked:
    // the fill that follows in this transaction says how many lots were matched.
    const opened = await ensurePosition(
      context,
      exchange,
      market,
      trader,
      {
        side,
        lotLNS: 0n,
        lotKnown: false,
        entryPricePNS: event.params.pricePNS,
        depositCNS: 0n,
        leverageHdths: 0n,
        entryPriceKnown: false,
      },
      meta,
    );
    if (!opened.position.lotKnown) {
      await offerUnsizedClose(
        context,
        meta,
        opened.position.id,
        event.params.perpId,
        event.params.accountId,
      );
    }
    const realized = await realize(
      context,
      opened.position,
      opened.trader,
      event.params.deltaPnlCNS,
      event.params.fundingCNS,
      meta,
    );
    const closed = await closePosition(
      context,
      realized.position,
      opened.exchange,
      opened.market,
      realized.trader,
      { status: "CLOSED", forced: false },
      meta,
    );

    const day = await loadTraderDay(context, closed.trader, meta);
    const won = closed.position.isWin === true;
    context.TraderDay.set({
      ...day,
      wins: day.wins + (won ? 1 : 0),
      losses: day.losses + (won ? 0 : 1),
    });
  },
);

// ─────────────────────────────── inverted ────────────────────────────────────

/**
 * A fill larger than the position flipped it long <-> short: PnL is realized on
 * the old side and a new position opens on the other one, in a single event.
 *
 * The old side is taken from the position we already hold rather than from the
 * event's `positionType`, whose sense (old side or new) the contract does not
 * document. When we hold no position, `positionType` is read as the new side and
 * the old one is its opposite.
 */
indexer.onEvent(
  { contract: "Exchange", event: "PositionInverted", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const { exchange, market, trader } = await enter(
      context,
      event.params.perpId,
      event.params.accountId,
      meta,
    );
    const existing = await livePosition(context, event.params.perpId, event.params.accountId);
    const oldSide = existing?.side ?? flipSide(sideOf(event.params.positionType, at("PositionInverted", event.params, meta)));

    const opened = await ensurePosition(
      context,
      exchange,
      market,
      trader,
      {
        side: oldSide,
        lotLNS: event.params.startLotLNS,
        entryPricePNS: 0n,
        depositCNS: event.params.startDepositCNS,
        leverageHdths: event.params.leverageHdths,
        entryPriceKnown: false,
      },
      meta,
    );
    const realized = await realize(
      context,
      opened.position,
      opened.trader,
      event.params.deltaPnlCNS,
      event.params.fundingCNS,
      meta,
    );
    const closed = await closePosition(
      context,
      realized.position,
      opened.exchange,
      opened.market,
      realized.trader,
      { status: "CLOSED", forced: false },
      meta,
    );

    await openPosition(
      context,
      closed.exchange,
      closed.market,
      closed.trader,
      {
        side: flipSide(oldSide),
        lotLNS: event.params.endLotLNS,
        entryPricePNS: event.params.pricePNS,
        depositCNS: event.params.endDepositCNS,
        leverageHdths: event.params.leverageHdths,
        entryPriceKnown: true,
      },
      meta,
    );
  },
);
