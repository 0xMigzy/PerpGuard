/**
 * The activity feed: what happened on the exchange since a moment, read off
 * the index, for the event engine. Venue-agnostic, like the rest of the
 * analytics interface: market ids and tickers, never a contract's own words.
 *
 * TWO STREAMS. Forced exits (liquidations and their kin), one row per event,
 * each with a stable id (`<txHash>-<logIndex>`). And TAKER FILLS, which the
 * engine groups into orders: a large taker order fills against many makers,
 * one row per maker, so a per-fill threshold would understate every big order
 * and fire on none of them. `groupTakerOrders` is that grouping, pure.
 *
 * THE INDEX HAS NO TAKER SIDE. `Trade.takerSide` exists in the schema but the
 * indexer never writes it (empty on all 3,778,089 fills of the 30 days to
 * 6 Oct 2026: `attributeTaker` copies the fill's own, always-empty value).
 * Fixing it means a full re-sync, so it stays. A taker order's side and action
 * ("Open long", "Close short") come from the position event in the same
 * transaction, which the backend reads off the receipt, and stay blank when
 * that cannot be read.
 *
 * About 6% of fills have no recorded taker (measured 6 Oct 2026). Those
 * cannot be attributed to an order and are not in this stream; the screens
 * say so rather than pretending to completeness.
 */
import type { LiquidationRecord, MarketRef } from './types.ts';

/** A forced exit, with what the engine needs to word it and where it sits in the chain. */
export interface FeedLiquidation extends LiquidationRecord {
  readonly blockNumber: number;
  readonly logIndex: number;
  /** The position's entry. Undefined when the index could not know it. Never guessed. */
  readonly entryPrice: number | undefined;
  /** The position's realised PnL and funding as the event left them. */
  readonly realizedPnlAusd: number;
  readonly fundingAusd: number;
}

/** One maker fill with a known taker. */
export interface TakerFill {
  /** The fill's own id, `<txHash>-<logIndex>`. */
  readonly id: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly atMs: number;
  readonly market: MarketRef;
  readonly takerAccountId: number;
  readonly sizeLots: number;
  readonly price: number | undefined;
  readonly notionalAusd: number;
}

/** One taker's order in one transaction on one market: its fills, summed. */
export interface TakerOrder {
  /** `<txHash>:<accountId>:<marketId>`, stable across polls. */
  readonly id: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly atMs: number;
  readonly market: MarketRef;
  readonly accountId: number;
  readonly sizeLots: number;
  readonly notionalAusd: number;
  /** Size-weighted across the fills that carry a price. Undefined when none does. */
  readonly averagePrice: number | undefined;
  readonly fills: number;
}

export interface ActivityFeed {
  /** Forced exits at or after `sinceMs`, OLDEST FIRST, at most `limit`. */
  liquidationsSince(sinceMs: number, limit: number): Promise<readonly FeedLiquidation[]>;
  /** Fills with a known taker at or after `sinceMs`, OLDEST FIRST, at most `limit`. */
  takerFillsSince(sinceMs: number, limit: number): Promise<readonly TakerFill[]>;
}

export const takerOrderId = (txHash: string, accountId: number, marketId: number): string => `${txHash.toLowerCase()}:${accountId}:${marketId}`;

/**
 * Fills -> orders, by transaction, taker and market. Pure. Sizes are summed,
 * never netted: the index cannot say which way each fill went (see above), so
 * a taker on both sides of one market in one transaction, which would be
 * rare, reads as one larger order.
 */
export function groupTakerOrders(fills: readonly TakerFill[]): readonly TakerOrder[] {
  const groups = new Map<string, TakerFill[]>();
  for (const fill of fills) {
    const key = takerOrderId(fill.txHash, fill.takerAccountId, fill.market.marketId);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [fill]);
    else group.push(fill);
  }
  const orders: TakerOrder[] = [];
  for (const [id, group] of groups) {
    const first = group[0]!;
    const sizeLots = group.reduce((s, f) => s + f.sizeLots, 0);
    const priced = group.filter((f) => f.price !== undefined);
    const pricedLots = priced.reduce((s, f) => s + f.sizeLots, 0);
    orders.push({
      id,
      txHash: first.txHash,
      blockNumber: first.blockNumber,
      atMs: first.atMs,
      market: first.market,
      accountId: first.takerAccountId,
      sizeLots,
      notionalAusd: group.reduce((s, f) => s + f.notionalAusd, 0),
      averagePrice: pricedLots > 0 ? priced.reduce((s, f) => s + f.price! * f.sizeLots, 0) / pricedLots : undefined,
      fills: group.length,
    });
  }
  return orders.sort((a, b) => a.blockNumber - b.blockNumber || a.id.localeCompare(b.id));
}
