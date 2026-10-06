import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountFill, PositionEventDirection } from '@perpguard/shared';
import { FillDirections } from './fillDirections.ts';

const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' };
const fill = (txHash: string, marketId = 1): AccountFill => ({ id: `${txHash}-0`, atMs: 1, txHash, market: { ...BTC, marketId }, role: 'maker', sizeLots: 1, price: 1, notionalAusd: 1, makerFeeAusd: 0 });

test('each fill takes its account\'s one event on its market; receipts are read once and kept', async () => {
  const reads: string[][] = [];
  const dir = new FillDirections({
    read: async (txs) => {
      reads.push([...txs]);
      const m = new Map<string, readonly PositionEventDirection[]>();
      m.set('0xa', [{ marketId: 1, accountId: 7, action: 'add', side: 'long' }, { marketId: 1, accountId: 8, action: 'reduce', side: 'short' }]);
      m.set('0xb', [{ marketId: 1, accountId: 7, action: 'close', side: 'short' }]);
      return m;
    },
  });
  const r = await dir.annotate(7, [fill('0xA'), fill('0xb'), fill('0xc'), fill('0xa', 20)], 100);
  assert.deepEqual(r.fills.map((f) => f.direction), [{ action: 'add', side: 'long' }, { action: 'close', side: 'short' }, undefined, undefined]);
  assert.equal(r.blank, 2, 'no receipt, and no event on that market: blank, never guessed');
  assert.equal(r.cappedAtTxs, undefined);
  await dir.annotate(7, [fill('0xa')], 100);
  assert.deepEqual(reads, [['0xa', '0xb', '0xc']], 'the kept receipt is not read again; the missing one is asked once per call at most');
});

test('an export resolves its newest transactions up to the cap and says it stopped', async () => {
  const dir = new FillDirections({ read: async (txs) => new Map(txs.map((t) => [t, [{ marketId: 1, accountId: 1, action: 'open' as const, side: 'long' as const }]])) });
  const r = await dir.annotate(1, [fill('0x1'), fill('0x2'), fill('0x3')], 2);
  assert.deepEqual(r.fills.map((f) => f.direction?.action), ['open', 'open', undefined]);
  assert.equal(r.cappedAtTxs, 2);
});
