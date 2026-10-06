import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTakerOrders, type TakerFill } from './feed.ts';

const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC' };
const fill = (over: Partial<TakerFill>): TakerFill => ({
  id: 'x', txHash: '0xAA', blockNumber: 10, atMs: 1_000, market: BTC, takerAccountId: 7, sizeLots: 1, price: 100, notionalAusd: 100, ...over,
});

test('one taker order filled against three makers is ONE order, its size and notional summed, its price size-weighted', () => {
  const orders = groupTakerOrders([
    fill({ id: 'a', sizeLots: 1, price: 100, notionalAusd: 100 }),
    fill({ id: 'b', sizeLots: 2, price: 101, notionalAusd: 202 }),
    fill({ id: 'c', sizeLots: 1, price: 103, notionalAusd: 103 }),
  ]);
  assert.equal(orders.length, 1);
  const o = orders[0]!;
  assert.equal(o.id, '0xaa:7:1', 'stable id, lower-case hash');
  assert.equal(o.sizeLots, 4);
  assert.equal(o.notionalAusd, 405);
  assert.equal(o.averagePrice, (100 + 202 + 103) / 4);
  assert.equal(o.fills, 3);
});

test('different transactions, takers or markets are different orders', () => {
  const orders = groupTakerOrders([
    fill({ id: 'a' }),
    fill({ id: 'b', txHash: '0xBB', blockNumber: 11 }),
    fill({ id: 'c', takerAccountId: 8 }),
    fill({ id: 'd', market: { marketId: 2, symbol: 'ETH', indexerName: 'ETH' } }),
  ]);
  assert.equal(orders.length, 4);
  assert.equal(new Set(orders.map((o) => o.id)).size, 4, 'no two share an id');
  assert.deepEqual(orders.map((o) => o.blockNumber), [10, 10, 10, 11], 'oldest first');
});

test('an order whose fills carry no price has no average price, rather than a zero', () => {
  assert.equal(groupTakerOrders([fill({ price: undefined })])[0]!.averagePrice, undefined);
});
