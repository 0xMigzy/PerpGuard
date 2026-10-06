import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenPosition } from '@perpguard/shared';
import { diffPositions } from './positionDiff.ts';

const ctx = { accountId: 4088, seenAtMs: 9_000, freshness: { indexerBlock: 100, blocksBehind: 140 } };
const pos = (marketId: number, over: Partial<OpenPosition> = {}): OpenPosition => ({
  market: { marketId, symbol: marketId === 1 ? 'BTC' : 'ETH', indexerName: 'x' },
  side: 'long',
  sizeLots: 1,
  entryPrice: 100,
  marginAusd: 10,
  leverage: 10,
  openedAtMs: 1_000,
  marginAddedAusd: 0,
  ...over,
});
const kinds = (prev: OpenPosition[] | undefined, next: OpenPosition[]) => diffPositions(prev, next, ctx).map((e) => `${e.kind}:${e.market.symbol}:${e.sizeBefore}->${e.sizeAfter}`);

test('the first read is a baseline: nothing was "opened", it was already open', () => {
  assert.deepEqual(kinds(undefined, [pos(1)]), []);
});

test('open, increase, reduce, close: one event each, sizes before and after', () => {
  assert.deepEqual(kinds([], [pos(1)]), ['position-opened:BTC:0->1']);
  assert.deepEqual(kinds([pos(1)], [pos(1, { sizeLots: 3 })]), ['position-increased:BTC:1->3']);
  assert.deepEqual(kinds([pos(1, { sizeLots: 3 })], [pos(1, { sizeLots: 2 })]), ['position-reduced:BTC:3->2']);
  assert.deepEqual(kinds([pos(1)], []), ['position-closed:BTC:1->0']);
  assert.deepEqual(kinds([pos(1)], [pos(1)]), [], 'nothing changed, nothing said');
});

test('a close and a reopen inside one pass, or a flip, is the old one closed AND a new one opened', () => {
  assert.deepEqual(kinds([pos(1)], [pos(1, { openedAtMs: 5_000 })]), ['position-closed:BTC:1->0', 'position-opened:BTC:0->1']);
  assert.deepEqual(kinds([pos(1)], [pos(1, { side: 'short', openedAtMs: 5_000 })]), ['position-closed:BTC:1->0', 'position-opened:BTC:0->1']);
});

test('markets are independent; ids are stable and built from the fact, not from when it was seen', () => {
  const a = diffPositions([pos(1)], [pos(1, { sizeLots: 2 }), pos(2)], ctx);
  const b = diffPositions([pos(1)], [pos(1, { sizeLots: 2 }), pos(2)], { ...ctx, seenAtMs: 99_999 });
  assert.deepEqual(a.map((e) => e.id), ['4088:1:1000:position-increased:2', '4088:2:1000:position-opened']);
  assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id), 'seen later, same ids: delivered once');
  assert.equal(a[0]!.freshness.blocksBehind, 140, 'every event carries how far behind the index was');
});

test('float noise in lot sizes is not a change', () => {
  assert.deepEqual(kinds([pos(1, { sizeLots: 0.1 + 0.2 })], [pos(1, { sizeLots: 0.3 })]), []);
});
