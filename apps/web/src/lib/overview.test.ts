import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deltaOf, deltaVsPrevious, lastDays, stackByMarket, trailingMean, tvlHistory } from './overview.ts';
import type { MarketDailySeries } from '@perpguard/shared';

const day = (n: number) => Date.parse('2026-09-01T00:00:00Z') + n * 86_400_000;

test('a delta against an INCOMPLETE previous period is unknown, with the index start in the reason', () => {
  const delta = deltaVsPrevious(
    {
      indexedFromMs: Date.parse('2026-08-28T00:00:00Z'),
      previous: { complete: false, volumeAusd: 240e6 } as never,
    },
    (m) => m.volumeAusd,
    1_990e6,
  );
  assert.equal(delta.fraction, undefined);
  assert.match(delta.reason!, /2026-08-28/);
});

test('a delta against a complete previous period is the plain fraction', () => {
  const delta = deltaVsPrevious(
    { indexedFromMs: 0, previous: { complete: true, volumeAusd: 100 } as never },
    (m) => m.volumeAusd,
    122.7,
  );
  assert.ok(Math.abs(delta.fraction! - 0.227) < 1e-9);
  assert.equal(deltaVsPrevious({ indexedFromMs: 0 }, (m) => m.volumeAusd, 1).fraction, undefined);
  assert.equal(deltaOf(5, 0).fraction, undefined, 'a ratio over nothing is not a delta');
  assert.equal(deltaOf(90, 100).fraction, -0.1);
});

test('TVL history walks the level now back through the exact daily flows', () => {
  const history = tvlHistory(1000, [
    { dayMs: day(0), netFlowAusd: 50 },
    { dayMs: day(1), netFlowAusd: -200 },
    { dayMs: day(2), netFlowAusd: 100 },
  ]);
  assert.deepEqual(
    history.map((h) => h.tvlAusd),
    [1100, 900, 1000],
    'today ends at the level now; yesterday ended before today\'s +100; the day before, before the −200',
  );
  assert.deepEqual(tvlHistory(7, []), []);
});

test('stacking keeps the top markets by volume but ORDERS them by market id, and folds the rest', () => {
  const s = (marketId: number, symbol: string | undefined, volumes: number[]): MarketDailySeries => ({
    market: { marketId, symbol, indexerName: symbol ?? 'TAO' },
    points: volumes.map((v, i) => ({
      dayMs: day(i), volumeAusd: v, tradeCount: 1, feesAusd: 0, liquidationCount: 0,
      rescuableLiquidationCount: 0, openInterestDeltaLots: 0,
      markOpen: undefined, markHigh: undefined, markLow: undefined, markClose: undefined,
    })),
  });
  const stacked = stackByMarket(
    [s(1, 'BTC', [50, 60]), s(10, 'MON', [1, 1]), s(20, 'ETH', [10, 10]), s(31, 'SOL', [8, 9]), s(80, undefined, [100, 0]), s(90, 'PUMP', [2, 3])],
    3,
    2,
  );
  // Top three by volume are BTC, ETH, SOL — listed by id, not by size.
  assert.deepEqual(stacked.keys, ['BTC', 'ETH', 'SOL', 'Other']);
  assert.deepEqual(stacked.slotOf, { BTC: 0, ETH: 1, SOL: 2 });
  // TAO (no symbol, 100 on day 0) never takes a slot, however large: it folds.
  assert.equal(stacked.days[0]!.byKey['Other'], 100 + 1 + 2);
  assert.equal(stacked.days[0]!.total, 50 + 1 + 10 + 8 + 100 + 2);
  assert.deepEqual(stacked.average, [171, (171 + 83) / 2]);
});

test('the shown days are cut AFTER the average is computed, so the left edge is a real 7-day mean', () => {
  const s = (volumes: number[]): MarketDailySeries => ({
    market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC' },
    points: volumes.map((v, i) => ({
      dayMs: day(i), volumeAusd: v, tradeCount: 1, feesAusd: 0, liquidationCount: 0,
      rescuableLiquidationCount: 0, openInterestDeltaLots: 0,
      markOpen: undefined, markHigh: undefined, markLow: undefined, markClose: undefined,
    })),
  });
  const stacked = stackByMarket([s([10, 10, 10, 10, 10, 10, 10, 80, 90])], 4, 7, 2);
  assert.equal(stacked.days.length, 2);
  assert.deepEqual(stacked.days.map((d) => d.total), [80, 90]);
  assert.deepEqual(stacked.average, [20, 220 / 7]);
  assert.deepEqual(lastDays([1, 2, 3], 2), [2, 3]);
  assert.deepEqual(lastDays([1, 2, 3], undefined), [1, 2, 3]);
});

test('a trailing mean widens up to its window and no further', () => {
  assert.deepEqual(trailingMean([2, 4, 6, 8], 2), [2, 3, 5, 7]);
  assert.deepEqual(trailingMean([], 7), []);
});
