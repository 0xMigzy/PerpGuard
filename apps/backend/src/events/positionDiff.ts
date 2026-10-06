/**
 * What changed in one account's open positions between two reads of the
 * index. Pure.
 *
 * The index has ONE open position per account per market (isolated margin)
 * and no position id on the read we take, so a position is keyed by market
 * and told apart from a later one on the same market by when it opened. A
 * different opening time, or a different side, is the old one closed and a
 * new one opened, even inside one pass.
 *
 * THE FIRST READ IS A BASELINE: nothing is reported, because "opened" would
 * be a lie about a position that was already open before we looked. After a
 * restart, the first pass is a baseline again; anything that changed while we
 * were down is not reported, and the alerts never claim it was.
 *
 * WHAT A 30-SECOND POLL CANNOT SEE: an add and a reduce that cancel out
 * between two reads. Said on the screens, not hidden.
 */
import type { OpenPosition } from '@perpguard/shared';
import type { EventFreshness, PositionChangeEvent, PositionChangeKind } from './types.ts';

/** Lots are floats here (display units); a change smaller than this is the same size. */
const SAME_SIZE = 1e-9;

export interface DiffContext {
  readonly accountId: number;
  readonly seenAtMs: number;
  readonly freshness: EventFreshness;
}

const key = (p: OpenPosition): number => p.market.marketId;
const sameOpening = (a: OpenPosition, b: OpenPosition): boolean => a.openedAtMs === b.openedAtMs && a.side === b.side;

export function diffPositions(previous: readonly OpenPosition[] | undefined, next: readonly OpenPosition[], ctx: DiffContext): readonly PositionChangeEvent[] {
  if (previous === undefined) return [];
  const before = new Map(previous.map((p) => [key(p), p]));
  const after = new Map(next.map((p) => [key(p), p]));
  const events: PositionChangeEvent[] = [];

  const event = (kind: PositionChangeKind, p: OpenPosition, sizeBefore: number, sizeAfter: number): PositionChangeEvent => ({
    kind,
    id: `${ctx.accountId}:${p.market.marketId}:${p.openedAtMs}:${kind}${kind === 'position-increased' || kind === 'position-reduced' ? `:${sizeAfter}` : ''}`,
    accountId: ctx.accountId,
    market: p.market,
    side: p.side,
    sizeBefore,
    sizeAfter,
    entryPrice: p.entryPrice,
    marginAusd: p.marginAusd,
    leverage: p.leverage,
    openedAtMs: p.openedAtMs,
    seenAtMs: ctx.seenAtMs,
    freshness: ctx.freshness,
  });

  for (const [market, old] of before) {
    const now = after.get(market);
    if (now === undefined) {
      events.push(event('position-closed', old, old.sizeLots, 0));
    } else if (!sameOpening(old, now)) {
      events.push(event('position-closed', old, old.sizeLots, 0), event('position-opened', now, 0, now.sizeLots));
    } else if (now.sizeLots > old.sizeLots + SAME_SIZE) {
      events.push(event('position-increased', now, old.sizeLots, now.sizeLots));
    } else if (now.sizeLots < old.sizeLots - SAME_SIZE) {
      events.push(event('position-reduced', now, old.sizeLots, now.sizeLots));
    }
  }
  for (const [market, now] of after) {
    if (!before.has(market)) events.push(event('position-opened', now, 0, now.sizeLots));
  }
  return events;
}
