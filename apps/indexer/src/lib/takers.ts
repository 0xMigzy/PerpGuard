/**
 * Attributing the taker side of a match.
 *
 * `MakerOrderFilledV2` names its own account; the taker side names nobody. When
 * the transaction-scope join (src/lib/txScope.ts) identifies the taker, this
 * fills in the trade and credits the taker's own volume.
 *
 * Note the two different volume conventions, which are both deliberate:
 *   Market.volumeCNS  counts a match ONCE, from the maker fill.
 *   Trader.volumeCNS  counts a match for EACH of the two traders in it.
 * A market traded X of notional; both participants traded X of notional.
 */
import type { EvmOnEventContext, Trader } from "envio";
import { loadTraderDay } from "./entities.ts";
import type { EventMeta } from "./entities.ts";

type Context = EvmOnEventContext;

export async function attributeTaker(
  context: Context,
  tradeId: string,
  taker: Trader,
  meta: EventMeta,
): Promise<Trader> {
  const trade = await context.Trade.get(tradeId);
  if (!trade) return taker;

  context.Trade.set({ ...trade, taker_id: taker.id, takerSide: trade.takerSide });

  const next: Trader = {
    ...taker,
    volumeCNS: taker.volumeCNS + trade.notionalCNS,
    tradeCount: taker.tradeCount + 1,
    takerTradeCount: taker.takerTradeCount + 1,
    firstTradeAt: taker.firstTradeAt ?? meta.timestamp,
    lastActiveAt: meta.timestamp,
  };
  context.Trader.set(next);

  const day = await loadTraderDay(context, next, meta);
  context.TraderDay.set({
    ...day,
    volumeCNS: day.volumeCNS + trade.notionalCNS,
    tradeCount: day.tradeCount + 1,
  });
  return next;
}
