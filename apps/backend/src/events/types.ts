/**
 * NORMALIZED EVENTS: what happened, in one shape, whatever noticed it.
 *
 * Every event has a STABLE id, so the same fact seen twice (a re-read
 * overlap, a restart, two sources) is delivered to a chat at most once: the
 * delivery ledger keys on (event id, chat). Ids are built from the fact
 * itself, never from when we noticed it.
 *
 *   position-*    `<account>:<market>:<openedAtMs>:<kind>[:<size>]`
 *   liquidation   `<txHash>-<logIndex>`, the index's own id
 *   large-trade   `<txHash>:<account>:<market>`, one taker order
 *
 * Every event carries how fresh the index was when it was read, because
 * every one of them comes from the index, and the index trails the chain.
 */
import type { FeedLiquidation, FillAction, MarketRef, Side, TakerOrder } from '@perpguard/shared';

/** How far behind the chain the index was when this was read. */
export interface EventFreshness {
  readonly indexerBlock: number | undefined;
  readonly blocksBehind: number | undefined;
}

export type PositionChangeKind = 'position-opened' | 'position-increased' | 'position-reduced' | 'position-closed';

export interface PositionChangeEvent {
  readonly kind: PositionChangeKind;
  readonly id: string;
  readonly accountId: number;
  readonly market: MarketRef;
  readonly side: Side;
  /** Lots before and after: 0 before an open, 0 after a close. */
  readonly sizeBefore: number;
  readonly sizeAfter: number;
  readonly entryPrice: number | undefined;
  readonly marginAusd: number | undefined;
  readonly leverage: number | undefined;
  /** When the position (as it stands, or stood) was opened. */
  readonly openedAtMs: number;
  /** When we noticed: a pass of the watch loop, not the chain's time. */
  readonly seenAtMs: number;
  readonly freshness: EventFreshness;
}

export interface LiquidationEvent {
  readonly kind: 'liquidation';
  readonly id: string;
  readonly liquidation: FeedLiquidation;
  readonly freshness: EventFreshness;
}

export interface LargeTradeEvent {
  readonly kind: 'large-trade';
  readonly id: string;
  readonly order: TakerOrder;
  /** From the transaction's position event. Undefined when it could not be read: blank, never guessed. */
  readonly direction: { readonly action: FillAction; readonly side: 'long' | 'short' } | undefined;
  readonly freshness: EventFreshness;
}

export type PerpEvent = PositionChangeEvent | LiquidationEvent | LargeTradeEvent;

/** The account an event is about. */
export function accountOf(event: PerpEvent): number {
  switch (event.kind) {
    case 'liquidation':
      return event.liquidation.accountId;
    case 'large-trade':
      return event.order.accountId;
    default:
      return event.accountId;
  }
}
