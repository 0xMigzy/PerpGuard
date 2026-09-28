/**
 * Forced exits, and the number this whole product exists to show.
 *
 * Perpl uses ISOLATED margin: a position runs on its own collateral, and the
 * account's free AUSD is never pulled in to save it. `PositionLiquidated` hands
 * us both halves of that story in one event -- the margin that was consumed, and
 * the account balance that was sitting there untouched.
 *
 * The free balance immediately BEFORE the liquidation is exact, with no reliance
 * on a running total: the event publishes the post-state `accBalanceCNS` and the
 * signed `accAmountCNS` applied to get there, so before = after - applied.
 *
 * `marginToSurviveCNS` is risk maths, so it is the pure, unit-tested function in
 * packages/shared, not a formula reimplemented here. It needs the position's
 * entry price, which we only have if we saw the position open or increase; when
 * we do not, it and `wasRescuable` are left null and the liquidation is counted
 * in `liquidationsWithUnknownPositionCount` instead of being guessed at.
 *
 * Observed on mainnet: a liquidation is executed as a forced IOC order on the
 * victim's own account, and the victim gets NO PositionDecreased or
 * PositionClosed -- this event replaces them. `posLotLNS` and `posDepositCNS` are
 * what REMAINS after the liquidation, both zero on a full one.
 */
import { indexer } from "envio";
import { marginToSurviveCNS } from "@perpguard/shared/risk";
import {
  collateralDecimals,
  loadExchange,
  loadMarket,
  loadMarketDay,
  loadTrader,
  loadTraderDay,
  metaOf,
  withOiDelta,
} from "../lib/entities.ts";
import type { EventMeta } from "../lib/entities.ts";
import { logId } from "../lib/ids.ts";
import { closePosition, ensurePosition, observeOi } from "../lib/positions.ts";
import { notional, scaleOf, sideOf, toRiskSide } from "../lib/scale.ts";
import { claimTradeAndBecomeActor, offerLiquidation, pendingLiquidation } from "../lib/txScope.ts";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

type Context = Parameters<typeof loadMarket>[0];

interface ForcedExit {
  readonly kind: "LIQUIDATION" | "BUY_TO_LIQUIDATE" | "DELEVERAGE" | "UNWIND" | "UNWIND_UNPAID";
  readonly perpId: bigint;
  readonly accountId: bigint;
  readonly positionType: bigint;
  readonly markPricePNS: bigint;
  readonly execPricePNS: bigint;
  /** Lots taken by the forced exit. */
  readonly lotLNS: bigint;
  /** Lots left open afterwards. */
  readonly remainingLotLNS: bigint;
  readonly remainingDepositCNS: bigint;
  readonly realizedPnlCNS: bigint;
  readonly fundingCNS: bigint;
  readonly badDebtCNS: bigint;
  readonly onOrderBook: boolean;
  /** Free balance before the event, or undefined when the event does not say. */
  readonly freeBalanceBeforeCNS: bigint | undefined;
  /** Status to leave the position in when it is fully gone. */
  readonly closedStatus: "LIQUIDATED" | "DELEVERAGED" | "UNWOUND";
  readonly startLotLNS: bigint;
  readonly startDepositCNS: bigint;
  readonly entryPricePNS: bigint | undefined;
}

async function recordForcedExit(
  context: Context,
  exit: ForcedExit,
  meta: EventMeta,
): Promise<void> {
  const decimals = await collateralDecimals(context, meta);
  const market = await loadMarket(context, exit.perpId, meta);
  let trader = await loadTrader(context, exit.accountId, meta);
  // A forced exit is not a match, but it does close a position, so it takes the
  // actor slot for any fill that follows it in the transaction.
  await claimTradeAndBecomeActor(context, meta, exit.perpId, exit.accountId);
  // After loadMarket and loadTrader, both of which may have written Exchange.
  const exchange = await loadExchange(context, meta);

  const side = sideOf(exit.positionType);
  const opened = await ensurePosition(
    context,
    exchange,
    market,
    trader,
    {
      side,
      lotLNS: exit.startLotLNS,
      entryPricePNS: exit.entryPricePNS ?? 0n,
      depositCNS: exit.startDepositCNS,
      leverageHdths: 0n,
      entryPriceKnown: exit.entryPricePNS !== undefined,
    },
    meta,
  );
  let position = opened.position;
  trader = opened.trader;
  // ensurePosition may have written Market and Exchange (adopting a position
  // bumps both open counts), so every later change must build on the copies it
  // returned.
  const marketAfterAdopt = opened.market;
  let nextExchange = opened.exchange;

  const depositBeforeCNS = position.depositCNS;
  const marginLostCNS =
    depositBeforeCNS > exit.remainingDepositCNS ? depositBeforeCNS - exit.remainingDepositCNS : 0n;
  const notionalCNS = notional(marketAfterAdopt, decimals, exit.execPricePNS, exit.lotLNS);

  // What it would have taken to keep this position above maintenance margin at
  // the mark it died on. Null when we never learned the entry price.
  const marginToSurvive =
    position.entryPriceKnown && position.lotLNS > 0n && marketAfterAdopt.maintMarginFracHdths > 0n
      ? marginToSurviveCNS(
          {
            side: toRiskSide(position.side),
            lotLNS: position.lotLNS,
            entryPricePNS: position.entryPricePNS,
            depositCNS: depositBeforeCNS,
            // The contract settles funding into the position at each funding
            // event and publishes no accrual between them, so there is nothing
            // outstanding to carry here.
            fundingCNS: 0n,
            maintMarginFracHdths: marketAfterAdopt.maintMarginFracHdths,
          },
          exit.markPricePNS,
          scaleOf(marketAfterAdopt, decimals),
        )
      : undefined;

  const freeBalanceBeforeCNS = exit.freeBalanceBeforeCNS ?? trader.freeBalanceCNS;
  const hadSpareBalance = freeBalanceBeforeCNS > 0n;
  const wasRescuable =
    marginToSurvive === undefined
      ? undefined
      : marginToSurvive > 0n && freeBalanceBeforeCNS >= marginToSurvive;

  const id = logId(meta.txHash, meta.logIndex);
  context.Liquidation.set({
    id,
    kind: exit.kind,
    market_id: marketAfterAdopt.id,
    trader_id: trader.id,
    position_id: position.id,
    side,
    markPricePNS: exit.markPricePNS,
    execPricePNS: exit.execPricePNS,
    lotLNS: exit.lotLNS,
    remainingLotLNS: exit.remainingLotLNS,
    isFull: exit.remainingLotLNS === 0n,
    notionalCNS,
    realizedPnlCNS: exit.realizedPnlCNS,
    fundingCNS: exit.fundingCNS,
    marginLostCNS,
    insuranceCreditCNS: 0n,
    badDebtCNS: exit.badDebtCNS,
    onOrderBook: exit.onOrderBook,
    freeBalanceBeforeCNS,
    hadSpareBalance,
    marginToSurviveCNS: marginToSurvive,
    wasRescuable,
    blockNumber: meta.blockNumber,
    timestamp: meta.timestamp,
    txHash: meta.txHash,
    logIndex: meta.logIndex,
  });
  await offerLiquidation(context, meta, id);

  // Realize the PnL on the position, then either shrink it or close it.
  position = {
    ...position,
    realizedPnlCNS: position.realizedPnlCNS + exit.realizedPnlCNS,
    fundingCNS: position.fundingCNS + exit.fundingCNS,
    lotLNS: exit.remainingLotLNS,
    depositCNS: exit.remainingDepositCNS,
  };
  context.Position.set(position);

  trader = {
    ...trader,
    realizedPnlCNS: trader.realizedPnlCNS + exit.realizedPnlCNS,
    fundingCNS: trader.fundingCNS + exit.fundingCNS,
    netPnlCNS:
      trader.realizedPnlCNS +
      exit.realizedPnlCNS +
      trader.fundingCNS +
      exit.fundingCNS -
      trader.feesPaidCNS,
    liquidationCount: trader.liquidationCount + 1,
    liquidatedNotionalCNS: trader.liquidatedNotionalCNS + notionalCNS,
    liquidationsWithSpareBalanceCount:
      trader.liquidationsWithSpareBalanceCount + (hadSpareBalance ? 1 : 0),
    rescuableLiquidationCount: trader.rescuableLiquidationCount + (wasRescuable === true ? 1 : 0),
    spareBalanceAtLiquidationCNS: trader.spareBalanceAtLiquidationCNS + freeBalanceBeforeCNS,
    lastActiveAt: meta.timestamp,
  };
  context.Trader.set(trader);

  let nextMarket = withOiDelta(marketAfterAdopt, side, -exit.lotLNS);
  nextMarket = {
    ...nextMarket,
    liquidationCount: nextMarket.liquidationCount + 1,
    liquidatedNotionalCNS: nextMarket.liquidatedNotionalCNS + notionalCNS,
    rescuableLiquidationCount:
      nextMarket.rescuableLiquidationCount + (wasRescuable === true ? 1 : 0),
  };
  context.Market.set(nextMarket);
  await observeOi(context, nextMarket, meta);

  if (exit.remainingLotLNS === 0n) {
    const closed = await closePosition(
      context,
      position,
      nextExchange,
      nextMarket,
      trader,
      { status: exit.closedStatus, forced: true },
      meta,
    );
    trader = closed.trader;
    nextMarket = closed.market;
    nextExchange = closed.exchange;
  }

  const day = await loadMarketDay(context, nextMarket, meta);
  context.MarketDay.set({
    ...day,
    liquidationCount: day.liquidationCount + 1,
    liquidatedNotionalCNS: day.liquidatedNotionalCNS + notionalCNS,
    liquidatedMarginCNS: day.liquidatedMarginCNS + marginLostCNS,
    liquidationsWithSpareBalanceCount:
      day.liquidationsWithSpareBalanceCount + (hadSpareBalance ? 1 : 0),
    rescuableLiquidationCount: day.rescuableLiquidationCount + (wasRescuable === true ? 1 : 0),
    spareBalanceAtLiquidationCNS: day.spareBalanceAtLiquidationCNS + freeBalanceBeforeCNS,
  });

  const traderDay = await loadTraderDay(context, trader, meta);
  context.TraderDay.set({
    ...traderDay,
    liquidationCount: traderDay.liquidationCount + 1,
    rescuableLiquidationCount:
      traderDay.rescuableLiquidationCount + (wasRescuable === true ? 1 : 0),
    realizedPnlCNS: traderDay.realizedPnlCNS + exit.realizedPnlCNS,
    fundingCNS: traderDay.fundingCNS + exit.fundingCNS,
    losses: traderDay.losses + (exit.remainingLotLNS === 0n ? 1 : 0),
  });

  // Built on nextExchange, the copy the position lifecycle returned -- NOT on a
  // fresh loadExchange, which would drop the openPositionCount decrement that
  // closePosition just made.
  context.Exchange.set({
    ...nextExchange,
    liquidationCount: nextExchange.liquidationCount + 1,
    liquidatedNotionalCNS: nextExchange.liquidatedNotionalCNS + notionalCNS,
    liquidationsWithSpareBalanceCount:
      nextExchange.liquidationsWithSpareBalanceCount + (hadSpareBalance ? 1 : 0),
    rescuableLiquidationCount:
      nextExchange.rescuableLiquidationCount + (wasRescuable === true ? 1 : 0),
    spareBalanceAtLiquidationCNS: nextExchange.spareBalanceAtLiquidationCNS + freeBalanceBeforeCNS,
    liquidationsWithUnknownPositionCount:
      nextExchange.liquidationsWithUnknownPositionCount + (marginToSurvive === undefined ? 1 : 0),
    updatedBlock: meta.blockNumber,
  });
}

indexer.onEvent(
  { contract: "Exchange", event: "PositionLiquidated", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const p = event.params;
    await recordForcedExit(
      context,
      {
        kind: "LIQUIDATION",
        perpId: p.perpId,
        accountId: p.posAccountId,
        positionType: p.positionType,
        markPricePNS: p.markPricePNS,
        // The price the engine closed at, per the docs. Not a computed threshold.
        execPricePNS: p.liqPricePNS,
        lotLNS: p.liqLotLNS,
        remainingLotLNS: p.posLotLNS,
        remainingDepositCNS: p.posDepositCNS,
        realizedPnlCNS: p.deltaPnlCNS,
        fundingCNS: p.fundingCNS,
        badDebtCNS: 0n,
        onOrderBook: p.onOrderBook,
        // Exact: the post-state balance less the signed amount applied to reach it.
        freeBalanceBeforeCNS: p.accBalanceCNS - p.accAmountCNS,
        closedStatus: "LIQUIDATED",
        startLotLNS: p.liqLotLNS + p.posLotLNS,
        // `posDepositCNS` is what REMAINS, and `posAmountCNS` the signed amount
        // applied to get there, so the margin the position held going in is
        // exact even for a position we adopted rather than watched open. Without
        // this, marginLostCNS would read 0 on every adopted liquidation.
        startDepositCNS: p.posDepositCNS - p.posAmountCNS,
        entryPricePNS: undefined,
      },
      meta,
    );
  },
);

/** The insurance fund topping a liquidated position back up. */
indexer.onEvent(
  { contract: "Exchange", event: "PositionLiquidationCredit", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const creditCNS = event.params.endDepositCNS - event.params.startDepositCNS;
    const id = await pendingLiquidation(context, meta);
    if (!id) {
      context.log.warn(`liquidation credit at ${meta.txHash} with no liquidation to attach it to`);
      return;
    }
    const liquidation = await context.Liquidation.get(id);
    if (liquidation) {
      context.Liquidation.set({
        ...liquidation,
        insuranceCreditCNS: liquidation.insuranceCreditCNS + creditCNS,
      });
    }
  },
);

/** Auto-deleverage: a profitable position force-closed against an insolvent one. */
for (const event of ["PositionDeleveragedV2", "PositionDeleveraged"] as const) {
  indexer.onEvent({ contract: "Exchange", event, fields }, async ({ event, context }) => {
    const meta = metaOf(event);
    const p = event.params;
    await recordForcedExit(
      context,
      {
        kind: "DELEVERAGE",
        perpId: p.perpId,
        accountId: p.accountId,
        positionType: p.positionType,
        markPricePNS: p.markPricePNS,
        execPricePNS: p.deleveragePricePNS,
        lotLNS: p.startLotLNS - p.endLotLNS,
        remainingLotLNS: p.endLotLNS,
        remainingDepositCNS: p.endDepositCNS,
        realizedPnlCNS: p.deltaPnlCNS,
        fundingCNS: p.fundingCNS,
        badDebtCNS: 0n,
        onOrderBook: false,
        freeBalanceBeforeCNS: p.balanceCNS - p.amountCNS,
        closedStatus: "DELEVERAGED",
        startLotLNS: p.startLotLNS,
        startDepositCNS: p.startDepositCNS,
        // This event publishes the position's entry price outright.
        entryPricePNS: p.entryPricePNS,
      },
      meta,
    );
  });
}

/** Market-wide unwind: the position is settled at the unwind price and paid out. */
for (const event of ["PositionUnwoundV2", "PositionUnwound"] as const) {
  indexer.onEvent({ contract: "Exchange", event, fields }, async ({ event, context }) => {
    const meta = metaOf(event);
    const p = event.params;
    await recordForcedExit(
      context,
      {
        kind: "UNWIND",
        perpId: p.perpId,
        accountId: p.accountId,
        positionType: p.positionType,
        markPricePNS: p.markPricePNS,
        execPricePNS: p.pricePNS,
        lotLNS: p.lotLNS,
        remainingLotLNS: 0n,
        remainingDepositCNS: 0n,
        realizedPnlCNS: p.positionFmvCNS,
        fundingCNS: 0n,
        badDebtCNS: 0n,
        onOrderBook: false,
        freeBalanceBeforeCNS: p.balanceCNS - p.paymentCNS,
        closedStatus: "UNWOUND",
        startLotLNS: p.lotLNS,
        startDepositCNS: p.depositCNS,
        entryPricePNS: undefined,
      },
      meta,
    );
  });
}

/**
 * An unwind that could not pay: `amountOwedCNS` is a debt the trader never
 * receives, so it is recorded as bad debt rather than as a payout.
 */
for (const event of ["PositionUnwoundWithoutPaymentV2", "PositionUnwoundWithoutPayment"] as const) {
  indexer.onEvent({ contract: "Exchange", event, fields }, async ({ event, context }) => {
    const meta = metaOf(event);
    const p = event.params;
    await recordForcedExit(
      context,
      {
        kind: "UNWIND_UNPAID",
        perpId: p.perpId,
        accountId: p.accountId,
        positionType: p.positionType,
        markPricePNS: p.markPricePNS,
        execPricePNS: p.pricePNS,
        lotLNS: p.lotLNS,
        remainingLotLNS: 0n,
        remainingDepositCNS: 0n,
        realizedPnlCNS: p.positionFmvCNS,
        fundingCNS: 0n,
        badDebtCNS: p.amountOwedCNS,
        onOrderBook: false,
        freeBalanceBeforeCNS: undefined,
        closedStatus: "UNWOUND",
        startLotLNS: p.lotLNS,
        startDepositCNS: p.depositCNS,
        entryPricePNS: undefined,
      },
      meta,
    );
  });
}
