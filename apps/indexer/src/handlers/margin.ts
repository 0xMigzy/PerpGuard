/**
 * Per-position collateral: the isolated-margin actions themselves.
 *
 * `IncreasePositionCollateral` is exactly the action PerpGuard offers a trader
 * who is about to be liquidated, so this feed is how we can say how often people
 * top a position up versus how often they get liquidated holding spare AUSD.
 *
 * Removing margin is two-phase: a request that must later settle, expire, be
 * cancelled or be declined. No `CollateralDecreaseRequested` or
 * `PositionCollateralDecreased` has ever fired on Perpl mainnet -- both are zero
 * across all 53.8M blocks of its history -- so these handlers exist to be
 * correct when the first one does, not because they are hot paths.
 */
import { indexer } from "envio";
import { loadMarket, loadMarketDay, loadTrader, loadTraderDay, metaOf } from "../lib/entities.ts";
import { logId } from "../lib/ids.ts";
import { livePosition } from "../lib/positions.ts";
import { sideOf } from "../lib/scale.ts";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

/** ADD MARGIN: free balance moved into one position. */
indexer.onEvent(
  { contract: "Exchange", event: "IncreasePositionCollateral", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    const trader = await loadTrader(context, event.params.accountId, meta);
    const position = await livePosition(context, event.params.perpId, event.params.accountId);

    if (position) {
      context.Position.set({
        ...position,
        depositCNS: event.params.positionDepositCNS,
        peakDepositCNS:
          event.params.positionDepositCNS > position.peakDepositCNS
            ? event.params.positionDepositCNS
            : position.peakDepositCNS,
        marginAddedCNS: position.marginAddedCNS + event.params.amountCNS,
        marginActionCount: position.marginActionCount + 1,
      });
      context.MarginAction.set({
        id: logId(meta.txHash, meta.logIndex),
        kind: "ADD",
        market_id: market.id,
        trader_id: trader.id,
        position_id: position.id,
        amountCNS: event.params.amountCNS,
        positionDepositAfterCNS: event.params.positionDepositCNS,
        freeBalanceAfterCNS: event.params.balanceCNS,
        reason: undefined,
        blockNumber: meta.blockNumber,
        timestamp: meta.timestamp,
        txHash: meta.txHash,
      });
    } else {
      // A top-up on a position we never saw opened. The counters below are still
      // true; only the per-position row is missing, so no MarginAction is written
      // rather than one pointing at a position that does not exist.
      context.log.info(
        `margin added to a position opened before our start block: perp ${event.params.perpId} account ${event.params.accountId}`,
      );
    }

    context.Trader.set({
      ...trader,
      freeBalanceCNS: event.params.balanceCNS,
      marginAddCount: trader.marginAddCount + 1,
      marginAddedCNS: trader.marginAddedCNS + event.params.amountCNS,
      marginDeployedCNS: trader.marginDeployedCNS + event.params.amountCNS,
      lastActiveAt: meta.timestamp,
    });

    const day = await loadMarketDay(context, market, meta);
    context.MarketDay.set({ ...day, marginAddedCNS: day.marginAddedCNS + event.params.amountCNS });

    const traderDay = await loadTraderDay(context, trader, meta);
    context.TraderDay.set({
      ...traderDay,
      marginAddedCNS: traderDay.marginAddedCNS + event.params.amountCNS,
      endFreeBalanceCNS: event.params.balanceCNS,
    });
  },
);

/** REMOVE MARGIN settled: margin returned to free balance, entry price re-struck. */
indexer.onEvent(
  { contract: "Exchange", event: "PositionCollateralDecreased", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    const trader = await loadTrader(context, event.params.accountId, meta);
    const position = await livePosition(context, event.params.perpId, event.params.accountId);

    if (position) {
      context.Position.set({
        ...position,
        depositCNS: event.params.endDepositCNS,
        // Removing margin re-strikes the entry price, which moves the whole
        // position's liquidation price.
        entryPricePNS: event.params.endEntryPricePNS,
        entryPriceKnown: true,
        marginRemovedCNS: position.marginRemovedCNS + event.params.decreaseCNS,
        marginActionCount: position.marginActionCount + 1,
      });
      context.MarginAction.set({
        id: logId(meta.txHash, meta.logIndex),
        kind: "REMOVE_SETTLED",
        market_id: market.id,
        trader_id: trader.id,
        position_id: position.id,
        amountCNS: event.params.decreaseCNS,
        positionDepositAfterCNS: event.params.endDepositCNS,
        freeBalanceAfterCNS: event.params.balanceCNS,
        reason: undefined,
        blockNumber: meta.blockNumber,
        timestamp: meta.timestamp,
        txHash: meta.txHash,
      });
    }

    context.Trader.set({
      ...trader,
      freeBalanceCNS: event.params.balanceCNS,
      marginRemovedCNS: trader.marginRemovedCNS + event.params.decreaseCNS,
      marginDeployedCNS: trader.marginDeployedCNS - event.params.decreaseCNS,
      lastActiveAt: meta.timestamp,
    });

    const day = await loadMarketDay(context, market, meta);
    context.MarketDay.set({
      ...day,
      marginRemovedCNS: day.marginRemovedCNS + event.params.decreaseCNS,
    });

    const traderDay = await loadTraderDay(context, trader, meta);
    context.TraderDay.set({
      ...traderDay,
      marginRemovedCNS: traderDay.marginRemovedCNS + event.params.decreaseCNS,
      endFreeBalanceCNS: event.params.balanceCNS,
    });
  },
);

/** The four non-settling outcomes of a margin-withdrawal request. */
const requestOutcomes = [
  ["CollateralDecreaseRequested", "REMOVE_REQUESTED"],
  ["CollateralDecreaseRequestCancelled", "REMOVE_CANCELLED"],
  ["CollateralDecreaseRequestExpired", "REMOVE_EXPIRED"],
  ["CollateralDecreaseDeclined", "REMOVE_DECLINED"],
] as const;

for (const [event, kind] of requestOutcomes) {
  indexer.onEvent({ contract: "Exchange", event, fields }, async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    const trader = await loadTrader(context, event.params.accountId, meta);
    const position = await livePosition(context, event.params.perpId, event.params.accountId);
    if (!position) return;

    // Only the request itself carries an amount; the three terminal events say
    // what happened to it, not how much.
    const amountCNS = "amountCNS" in event.params ? event.params.amountCNS : 0n;
    // `positionType` rides along on the request, and is the usual 0/1.
    if ("positionType" in event.params && position.side !== sideOf(event.params.positionType)) {
      context.log.warn(
        `margin request side ${event.params.positionType} disagrees with position ${position.id} (${position.side})`,
      );
    }

    context.MarginAction.set({
      id: logId(meta.txHash, meta.logIndex),
      kind,
      market_id: market.id,
      trader_id: trader.id,
      position_id: position.id,
      amountCNS,
      positionDepositAfterCNS: position.depositCNS,
      freeBalanceAfterCNS: trader.freeBalanceCNS,
      reason: "reason" in event.params ? event.params.reason : undefined,
      blockNumber: meta.blockNumber,
      timestamp: meta.timestamp,
      txHash: meta.txHash,
    });
    context.Position.set({ ...position, marginActionCount: position.marginActionCount + 1 });
  });
}
