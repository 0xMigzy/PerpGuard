import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileOpenInterest } from './oiReconcile.ts';

test('LIKE FOR LIKE: the index’s live total beside the venue’s, both blocks kept, the largest gap named', () => {
  const r = reconcileOpenInterest(
    { block: 111_679_505, markets: [{ marketId: 100, lots: 2304.22 }, { marketId: 60, lots: 2965.8 }, { marketId: 1, lots: 8.2921 }] },
    [
      { marketId: 100, symbol: 'NEAR', lots: 2304.22, block: 111_679_431 },
      { marketId: 60, symbol: 'LIT', lots: 2965.8, block: 111_679_431 },
      { marketId: 1, symbol: 'BTC', lots: 8.29675, block: 111_679_431 },
    ],
    1_000,
  );
  assert.equal(r.indexBlock, 111_679_505);
  assert.equal(r.matched, 2);
  assert.equal(r.largest?.symbol, 'BTC');
  assert.ok(Math.abs(r.largest!.gapShare - 0.00056) < 0.00001, `BTC 0.056%, got ${r.largest!.gapShare}`);
  assert.equal(r.markets.find((m) => m.symbol === 'NEAR')!.gapLots, 0);
});

test('every market matching names no largest gap; a market the index has never seen counts as 0 lots, never skipped', () => {
  const same = reconcileOpenInterest({ block: 1, markets: [{ marketId: 1, lots: 5 }] }, [{ marketId: 1, symbol: 'BTC', lots: 5, block: 1 }], 0);
  assert.equal(same.largest, undefined);
  const missing = reconcileOpenInterest({ block: 1, markets: [] }, [{ marketId: 110, symbol: 'UNI', lots: 10, block: 1 }], 0);
  assert.equal(missing.markets[0]!.indexedLots, 0);
  assert.equal(missing.largest?.symbol, 'UNI');
});
