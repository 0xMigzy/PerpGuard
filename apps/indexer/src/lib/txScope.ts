/**
 * Joining up the events that carry no ids.
 *
 * `TakerOrderFilledV2` names no account, and `OrderCancelled`, `OrderPlaced` and
 * friends name neither account nor market: on this contract those events are
 * scoped by their position in the transaction's log, not by an id. A real
 * mainnet match reads:
 *
 *   PositionDecreased(maker)  -> MakerOrderFilledV2(maker)
 *   PositionIncreasedV2(taker) -> TakerOrderFilledV2(no ids)
 *
 * So the taker of a fill is whoever the position event just before it belonged
 * to, and the taker of a match is the next position event after the maker fill
 * for the same market but a different account.
 *
 * This is a heuristic, and it is treated as one. Everything it produces is
 * nullable: when the join does not line up we leave a gap rather than attribute
 * a trade to the wrong trader.
 */
import type { EvmOnEventContext, TxScope } from "envio";
import type { EventMeta } from "./entities.ts";

type Context = EvmOnEventContext;

const empty = (id: string): TxScope => ({
  id,
  pendingTradeId: undefined,
  pendingTradePerpId: undefined,
  pendingTradeMakerId: undefined,
  lastActorId: undefined,
  lastActorPerpId: undefined,
  pendingLiquidationId: undefined,
  pendingCloseId: undefined,
  pendingClosePerpId: undefined,
  pendingCloseAccountId: undefined,
});

const load = async (context: Context, meta: EventMeta): Promise<TxScope> =>
  (await context.TxScope.get(meta.txHash)) ?? empty(meta.txHash);

/** A maker fill is now waiting to learn who took it. */
export async function offerTrade(
  context: Context,
  meta: EventMeta,
  tradeId: string,
  perpId: bigint,
  makerId: string,
): Promise<void> {
  const scope = await load(context, meta);
  context.TxScope.set({
    ...scope,
    pendingTradeId: tradeId,
    pendingTradePerpId: perpId,
    pendingTradeMakerId: makerId,
  });
}

/**
 * Called by every position handler. Claims any maker fill waiting for a taker,
 * and records this account as the taker of any fill that follows.
 *
 * One read-modify-write, so two updates in the same handler cannot lose each
 * other.
 */
export async function claimTradeAndBecomeActor(
  context: Context,
  meta: EventMeta,
  perpId: bigint,
  accountId: bigint,
): Promise<string | undefined> {
  const scope = await load(context, meta);
  const actorId = accountId.toString();
  const claimable =
    scope.pendingTradeId !== undefined &&
    scope.pendingTradePerpId === perpId &&
    scope.pendingTradeMakerId !== actorId;

  context.TxScope.set({
    ...scope,
    pendingTradeId: undefined,
    pendingTradePerpId: undefined,
    pendingTradeMakerId: undefined,
    lastActorId: actorId,
    lastActorPerpId: perpId,
  });
  return claimable ? scope.pendingTradeId : undefined;
}

/** The account a taker fill belongs to: the last position event in this tx. */
export async function currentActor(
  context: Context,
  meta: EventMeta,
): Promise<{ accountId: bigint; perpId: bigint } | undefined> {
  const scope = await context.TxScope.get(meta.txHash);
  if (!scope?.lastActorId || scope.lastActorPerpId === undefined) return undefined;
  return { accountId: BigInt(scope.lastActorId), perpId: scope.lastActorPerpId };
}

/** A liquidation is now waiting for an insurance credit, if one follows it. */
export async function offerLiquidation(
  context: Context,
  meta: EventMeta,
  liquidationId: string,
): Promise<void> {
  const scope = await load(context, meta);
  context.TxScope.set({ ...scope, pendingLiquidationId: liquidationId });
}

export async function pendingLiquidation(
  context: Context,
  meta: EventMeta,
): Promise<string | undefined> {
  return (await context.TxScope.get(meta.txHash))?.pendingLiquidationId;
}

/**
 * A `PositionClosed` arrived for a position whose size we never learned, because
 * that event publishes no lot figure. Park it: a fill for the same account
 * follows it in the transaction, on either side of the match --
 *
 *   PositionClosed(taker) -> TakerOrderFilledV2
 *   PositionClosed(maker) -> MakerOrderFilledV2(maker)
 *
 * -- and that fill says how many lots were matched, which for a full close is
 * the whole position.
 */
export async function offerUnsizedClose(
  context: Context,
  meta: EventMeta,
  positionId: string,
  perpId: bigint,
  accountId: bigint,
): Promise<void> {
  const scope = await load(context, meta);
  context.TxScope.set({
    ...scope,
    pendingCloseId: positionId,
    pendingClosePerpId: perpId,
    pendingCloseAccountId: accountId.toString(),
  });
}

/** Claim a parked close, if one belongs to this account and market. */
export async function claimUnsizedClose(
  context: Context,
  meta: EventMeta,
  perpId: bigint,
  accountId: bigint,
): Promise<string | undefined> {
  const scope = await context.TxScope.get(meta.txHash);
  if (
    !scope?.pendingCloseId ||
    scope.pendingClosePerpId !== perpId ||
    scope.pendingCloseAccountId !== accountId.toString()
  ) {
    return undefined;
  }
  context.TxScope.set({
    ...scope,
    pendingCloseId: undefined,
    pendingClosePerpId: undefined,
    pendingCloseAccountId: undefined,
  });
  return scope.pendingCloseId;
}
