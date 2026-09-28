/**
 * Trades and fees.
 *
 * `MakerOrderFilledV2` is the per-match record: it is emitted once per match and
 * is the only fill event that names its own account. `TakerOrderFilledV2` names
 * nobody and aggregates a whole order, so it is used for one thing only -- the
 * taker's fee, which is the only published figure for a taker fee on a reducing
 * fill.
 *
 * Volume conventions, both deliberate:
 *   Market.volumeCNS  counts a match ONCE, from the maker fill.
 *   Trader.volumeCNS  counts a match for EACH of its two traders.
 */
import { indexer } from "envio";
import {
  collateralDecimals,
  loadExchange,
  loadMarket,
  loadMarketDay,
  loadTrader,
  loadTraderDay,
  metaOf,
  netPnl,
} from "../lib/entities.ts";
import { logId } from "../lib/ids.ts";
import { resolveUnsizedClose } from "../lib/positions.ts";
import { notional } from "../lib/scale.ts";
import { claimUnsizedClose, currentActor, offerTrade } from "../lib/txScope.ts";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

for (const event of ["MakerOrderFilledV2", "MakerOrderFilled"] as const) {
  indexer.onEvent({ contract: "Exchange", event, fields }, async ({ event, context }) => {
    const meta = metaOf(event);
    const decimals = await collateralDecimals(context, meta);
    const market = await loadMarket(context, event.params.perpId, meta);
    const maker = await loadTrader(context, event.params.accountId, meta);
    const notionalCNS = notional(market, decimals, event.params.pricePNS, event.params.lotLNS);
    const id = logId(meta.txHash, meta.logIndex);
    const builderId = "builderId" in event.params ? event.params.builderId : 0n;

    context.Trade.set({
      id,
      market_id: market.id,
      pricePNS: event.params.pricePNS,
      lotLNS: event.params.lotLNS,
      notionalCNS,
      maker_id: maker.id,
      // Filled in by the next position event in this transaction, if the join
      // lines up. Left null rather than guessed when it does not.
      taker_id: undefined,
      takerSide: undefined,
      makerFeeCNS: event.params.feeCNS,
      makerOrderId: event.params.orderId,
      builderId,
      blockNumber: meta.blockNumber,
      timestamp: meta.timestamp,
      txHash: meta.txHash,
      logIndex: meta.logIndex,
    });
    await offerTrade(context, meta, id, event.params.perpId, maker.id);

    // A PositionClosed for this same account earlier in the transaction had no
    // lot figure of its own; this fill is where its size becomes known.
    const closedId = await claimUnsizedClose(
      context,
      meta,
      event.params.perpId,
      event.params.accountId,
    );
    const marketAfterClose = closedId
      ? await resolveUnsizedClose(context, closedId, market, event.params.lotLNS, meta)
      : market;

    context.Market.set({
      ...marketAfterClose,
      tradeCount: marketAfterClose.tradeCount + 1n,
      volumeCNS: marketAfterClose.volumeCNS + notionalCNS,
      feesCNS: marketAfterClose.feesCNS + event.params.feeCNS,
    });

    const nextMaker = {
      ...maker,
      // balanceCNS is the account's post-state free balance.
      freeBalanceCNS: event.params.balanceCNS,
      volumeCNS: maker.volumeCNS + notionalCNS,
      tradeCount: maker.tradeCount + 1,
      makerTradeCount: maker.makerTradeCount + 1,
      feesPaidCNS: maker.feesPaidCNS + event.params.feeCNS,
      netPnlCNS: netPnl(
        maker.realizedPnlCNS,
        maker.fundingCNS,
        maker.feesPaidCNS + event.params.feeCNS,
      ),
      firstTradeAt: maker.firstTradeAt ?? meta.timestamp,
      lastActiveAt: meta.timestamp,
    };
    context.Trader.set(nextMaker);

    const day = await loadMarketDay(context, market, meta);
    context.MarketDay.set({
      ...day,
      tradeCount: day.tradeCount + 1,
      volumeCNS: day.volumeCNS + notionalCNS,
      feesCNS: day.feesCNS + event.params.feeCNS,
    });

    const makerDay = await loadTraderDay(context, nextMaker, meta);
    context.TraderDay.set({
      ...makerDay,
      tradeCount: makerDay.tradeCount + 1,
      volumeCNS: makerDay.volumeCNS + notionalCNS,
      feesCNS: makerDay.feesCNS + event.params.feeCNS,
      netPnlCNS: netPnl(
        makerDay.realizedPnlCNS,
        makerDay.fundingCNS,
        makerDay.feesCNS + event.params.feeCNS,
      ),
      endFreeBalanceCNS: event.params.balanceCNS,
    });

    const exchange = await loadExchange(context, meta);
    context.Exchange.set({
      ...exchange,
      tradeCount: exchange.tradeCount + 1n,
      volumeCNS: exchange.volumeCNS + notionalCNS,
      feesCNS: exchange.feesCNS + event.params.feeCNS,
      updatedBlock: meta.blockNumber,
    });
  });
}

/**
 * The taker's fee, and nothing else.
 *
 * This event carries no account id, so the taker is whoever the last position
 * event in this transaction belonged to. When there is no such event the fee
 * cannot be attributed: it goes to `Exchange.unattributedTakerFeeCNS` so the fee
 * totals stay auditable instead of quietly losing it.
 *
 * Its `feeCNS` is the same money as the `insFeeCNS` + `protFeeCNS` on the
 * taker's position event, so only one of the two is ever counted -- this one.
 */
for (const event of ["TakerOrderFilledV2", "TakerOrderFilled"] as const) {
  indexer.onEvent({ contract: "Exchange", event, fields }, async ({ event, context }) => {
    const meta = metaOf(event);
    const feeCNS = event.params.feeCNS;

    const actor = await currentActor(context, meta);
    if (!actor) {
      if (feeCNS === 0n) return;
      const exchange = await loadExchange(context, meta);
      context.Exchange.set({
        ...exchange,
        unattributedTakerFeeCNS: exchange.unattributedTakerFeeCNS + feeCNS,
        updatedBlock: meta.blockNumber,
      });
      context.log.warn(
        `taker fill at ${meta.txHash}:${meta.logIndex} had no preceding position event to name its taker`,
      );
      return;
    }

    const loaded = await loadMarket(context, actor.perpId, meta);
    // Resolving a parked close comes FIRST and unconditionally. A fill can carry
    // a zero fee, and an early return on that would leave the close unsized for
    // ever -- which is exactly what made longLotsDeltaLNS drift from
    // shortLotsDeltaLNS the first time this ran.
    const closedId = await claimUnsizedClose(context, meta, actor.perpId, actor.accountId);
    const market = closedId
      ? await resolveUnsizedClose(context, closedId, loaded, event.params.lotLNS, meta)
      : loaded;
    if (feeCNS === 0n) return;
    const taker = await loadTrader(context, actor.accountId, meta);
    context.Trader.set({
      ...taker,
      freeBalanceCNS: event.params.balanceCNS,
      feesPaidCNS: taker.feesPaidCNS + feeCNS,
      netPnlCNS: netPnl(taker.realizedPnlCNS, taker.fundingCNS, taker.feesPaidCNS + feeCNS),
      lastActiveAt: meta.timestamp,
    });

    context.Market.set({ ...market, feesCNS: market.feesCNS + feeCNS });

    const day = await loadMarketDay(context, market, meta);
    context.MarketDay.set({ ...day, feesCNS: day.feesCNS + feeCNS });

    const takerDay = await loadTraderDay(context, taker, meta);
    context.TraderDay.set({
      ...takerDay,
      feesCNS: takerDay.feesCNS + feeCNS,
      netPnlCNS: netPnl(
        takerDay.realizedPnlCNS,
        takerDay.fundingCNS,
        takerDay.feesCNS + feeCNS,
      ),
      endFreeBalanceCNS: event.params.balanceCNS,
    });

    const exchange = await loadExchange(context, meta);
    context.Exchange.set({
      ...exchange,
      feesCNS: exchange.feesCNS + feeCNS,
      updatedBlock: meta.blockNumber,
    });
  });
}
