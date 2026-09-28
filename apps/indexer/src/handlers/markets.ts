/**
 * Market definition, risk parameters, mark price and funding.
 *
 * `ContractAdded`/`ContractAddedV2` are where the indexer learns a market's
 * `priceDecimals` and `lotDecimals`. Only 4 of the 9 live markets were listed
 * with the V2 form, and none of the listings fall inside a recent start window,
 * so `loadMarket` bootstraps from the contract as well — see src/lib/chain.ts.
 */
import { indexer } from "envio";
import {
  loadMarket,
  loadMarketDay,
  metaOf,
  withMarkObservation,
} from "../lib/entities.ts";
import { fundingEventId } from "../lib/ids.ts";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

indexer.onEvent(
  { contract: "Exchange", event: "ContractAddedV2", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    context.Market.set({
      ...market,
      name: event.params.name,
      symbol: event.params.symbol,
      priceDecimals: Number(event.params.priceDecimals),
      lotDecimals: Number(event.params.lotDecimals),
      status: Number(event.params.status),
      listed: true,
      initMarginFracHdths: event.params.initMarginFracHdths,
      maintMarginFracHdths: event.params.maintMarginFracHdths,
      maxOpenInterestLNS: event.params.maxOpenInterestLNS,
    });
  },
);

/** Pre-upgrade listing. Same fields, with maker/taker fees inline. */
indexer.onEvent(
  { contract: "Exchange", event: "ContractAdded", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    context.Market.set({
      ...market,
      name: event.params.name,
      symbol: event.params.symbol,
      priceDecimals: Number(event.params.priceDecimals),
      lotDecimals: Number(event.params.lotDecimals),
      status: Number(event.params.status),
      listed: true,
      initMarginFracHdths: event.params.initMarginFracHdths,
      maintMarginFracHdths: event.params.maintMarginFracHdths,
      maxOpenInterestLNS: event.params.maxOpenInterestLNS,
    });
  },
);

/**
 * A paused market is the "watch but do not act" case. Never hide the position or
 * drop the alert: record the pause and let the UI disable the buttons.
 */
indexer.onEvent(
  { contract: "Exchange", event: "ContractPaused", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    context.Market.set({ ...market, paused: event.params.paused });
  },
);

indexer.onEvent(
  { contract: "Exchange", event: "ContractRemoved", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    context.Market.set({ ...market, listed: false });
  },
);

indexer.onEvent(
  { contract: "Exchange", event: "InitialMarginFractionUpdated", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    context.Market.set({ ...market, initMarginFracHdths: event.params.initMarginFracHdths });
  },
);

/** Every liquidation price in the market moves with this one. */
indexer.onEvent(
  { contract: "Exchange", event: "MaintenanceMarginFractionUpdated", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    context.Market.set({ ...market, maintMarginFracHdths: event.params.maintMarginFracHdths });
  },
);

indexer.onEvent(
  { contract: "Exchange", event: "MaxOpenInterestUpdated", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    context.Market.set({ ...market, maxOpenInterestLNS: event.params.maxOpenInterestLNS });
  },
);

/**
 * Latest mark price and the day's OHLC only.
 *
 * Mainnet emits this roughly 0.6 times per block, which would be tens of
 * millions of rows for a price series the trading websocket already streams
 * live. On Perpl a mark price only changes when it moves, so an old price is a
 * quiet market, not a broken feed: age is recorded, never used as a gate.
 */
indexer.onEvent(
  { contract: "Exchange", event: "MarkUpdated", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    const next = {
      ...market,
      markPricePNS: event.params.pricePNS,
      markUpdatedBlock: meta.blockNumber,
      markUpdatedAt: meta.timestamp,
    };
    context.Market.set(next);
    const day = await loadMarketDay(context, next, meta);
    context.MarketDay.set(withMarkObservation(day, event.params.pricePNS));
  },
);

/** The ongoing cost of holding a position. */
indexer.onEvent(
  { contract: "Exchange", event: "FundingEventCompleted", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const market = await loadMarket(context, event.params.perpId, meta);
    const next = {
      ...market,
      lastFundingRatePct100k: event.params.actualRatePct100k,
      lastFundingAt: meta.timestamp,
    };
    context.Market.set(next);

    context.FundingEvent.set({
      id: fundingEventId(event.params.perpId, event.params.fundingEventBlock),
      market_id: next.id,
      specifiedRatePct100k: event.params.specifiedRatePct100k,
      actualRatePct100k: event.params.actualRatePct100k,
      fundingPricePNS: event.params.fundingPricePNS,
      fundingPaymentPNS: event.params.fundingPaymentPNS,
      fundingSumPNS: event.params.fundingSumPNS,
      blockNumber: meta.blockNumber,
      timestamp: meta.timestamp,
    });

    const day = await loadMarketDay(context, next, meta);
    context.MarketDay.set({
      ...day,
      fundingRateSumPct100k: day.fundingRateSumPct100k + event.params.actualRatePct100k,
      fundingEventCount: day.fundingEventCount + 1,
    });
  },
);
