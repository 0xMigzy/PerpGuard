/** Exchange-wide state: the halt switch and the proxy upgrade tripwire. */
import { indexer } from "envio";
import { loadExchange, metaOf } from "../lib/entities.ts";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

indexer.onEvent(
  { contract: "Exchange", event: "ExchangeInitialized", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const exchange = await loadExchange(context, meta);
    context.Exchange.set({
      ...exchange,
      collateralToken: event.params.collateralToken,
      collateralDecimals: Number(event.params.collateralDecimals),
      updatedBlock: meta.blockNumber,
    });
  },
);

/**
 * The clearest "we can monitor but nobody can act" signal there is. A halted
 * exchange must never make the monitor look healthy.
 */
indexer.onEvent(
  { contract: "Exchange", event: "ExchangeHalted", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const exchange = await loadExchange(context, meta);
    context.Exchange.set({
      ...exchange,
      halted: event.params.halted,
      updatedBlock: meta.blockNumber,
    });
    context.log.warn(`exchange halted=${event.params.halted} at block ${meta.blockNumber}`);
  },
);

/**
 * The implementation behind the address we index changed, so our ABI snapshot
 * may no longer match it. Recorded as a tripwire: an upgrade is when to re-check
 * the ABI, not something to discover later from a decode failure.
 */
indexer.onEvent(
  { contract: "Exchange", event: "Upgraded", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const exchange = await loadExchange(context, meta);
    context.Exchange.set({
      ...exchange,
      implementation: event.params.implementation,
      lastUpgradeBlock: meta.blockNumber,
      lastUpgradeAt: meta.timestamp,
      updatedBlock: meta.blockNumber,
    });
    context.log.warn(
      `Exchange proxy upgraded to ${event.params.implementation} at block ${meta.blockNumber}: re-check abis/Exchange.json`,
    );
  },
);
