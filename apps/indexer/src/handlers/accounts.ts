/**
 * Accounts and the FREE (cross) balance.
 *
 * This is the balance that isolated margin never touches. A trader can hold
 * thousands of AUSD here and still be liquidated on a position that ran out of
 * its own collateral — the reason PerpGuard exists — so it is tracked precisely.
 */
import { indexer } from "envio";
import { loadExchange, loadTrader, loadTraderDay, metaOf } from "../lib/entities.ts";
import { logId } from "../lib/ids.ts";

const fields = { transaction: ["hash"], block: ["timestamp"] } as const;

/** The only on-chain link from a wallet to an account id. */
indexer.onEvent(
  { contract: "Exchange", event: "AccountCreated", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const trader = await loadTrader(context, event.params.id, meta);
    context.Trader.set({
      ...trader,
      owner: event.params.account,
      createdBlock: meta.blockNumber,
      createdAt: meta.timestamp,
    });
  },
);

indexer.onEvent(
  { contract: "Exchange", event: "CollateralDeposit", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const trader = await loadTrader(context, event.params.accountId, meta);
    const next = {
      ...trader,
      // balanceCNS is the post-state, so it replaces our running figure rather
      // than being added to it. No drift.
      freeBalanceCNS: event.params.balanceCNS,
      depositedCNS: trader.depositedCNS + event.params.amountCNS,
      lastActiveAt: meta.timestamp,
    };
    context.Trader.set(next);

    context.CollateralFlow.set({
      id: logId(meta.txHash, meta.logIndex),
      kind: "DEPOSIT",
      trader_id: next.id,
      amountCNS: event.params.amountCNS,
      balanceAfterCNS: event.params.balanceCNS,
      blockNumber: meta.blockNumber,
      timestamp: meta.timestamp,
      txHash: meta.txHash,
    });

    const day = await loadTraderDay(context, next, meta);
    context.TraderDay.set({
      ...day,
      depositedCNS: day.depositedCNS + event.params.amountCNS,
      endFreeBalanceCNS: event.params.balanceCNS,
    });
  },
);

/** Needs a wallet signature; an API key can never move funds out. */
indexer.onEvent(
  { contract: "Exchange", event: "CollateralWithdrawal", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const trader = await loadTrader(context, event.params.accountId, meta);
    const next = {
      ...trader,
      freeBalanceCNS: event.params.balanceCNS,
      withdrawnCNS: trader.withdrawnCNS + event.params.amountCNS,
      lastActiveAt: meta.timestamp,
    };
    context.Trader.set(next);

    context.CollateralFlow.set({
      id: logId(meta.txHash, meta.logIndex),
      kind: "WITHDRAWAL",
      trader_id: next.id,
      amountCNS: event.params.amountCNS,
      balanceAfterCNS: event.params.balanceCNS,
      blockNumber: meta.blockNumber,
      timestamp: meta.timestamp,
      txHash: meta.txHash,
    });

    const day = await loadTraderDay(context, next, meta);
    context.TraderDay.set({
      ...day,
      withdrawnCNS: day.withdrawnCNS + event.params.amountCNS,
      endFreeBalanceCNS: event.params.balanceCNS,
    });
  },
);

/**
 * The `fw` flag. There is no on-chain getter for it, so this event is the only
 * source: an account is assumed to forbid API-key-forwarded orders until one
 * arrives saying otherwise.
 */
indexer.onEvent(
  { contract: "Exchange", event: "OrderForwardingUpdated", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const trader = await loadTrader(context, event.params.accountId, meta);
    context.Trader.set({ ...trader, forwardingAllowed: event.params.allowed });
  },
);

indexer.onEvent(
  { contract: "Exchange", event: "AccountFeeTierSet", fields },
  async ({ event, context }) => {
    const meta = metaOf(event);
    const trader = await loadTrader(context, event.params.accountId, meta);
    context.Trader.set({ ...trader, feeTier: Number(event.params.tier) });
  },
);

/** Keeps the Exchange row's block watermark moving even on a quiet market. */
export async function touchExchange(
  context: Parameters<typeof loadExchange>[0],
  meta: Parameters<typeof loadExchange>[1],
): Promise<void> {
  const exchange = await loadExchange(context, meta);
  if (exchange.updatedBlock < meta.blockNumber) {
    context.Exchange.set({ ...exchange, updatedBlock: meta.blockNumber });
  }
}
