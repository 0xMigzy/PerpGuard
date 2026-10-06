import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketDailyPoint, MarketDailySeries, MarketOpenInterest } from '@perpguard/shared';
import { oiHistory } from './oiHistory.ts';

const D = (n: number) => Date.UTC(2026, 9, n);
const pt = (dayMs: number, lots: number, markClose: number | undefined): MarketDailyPoint => ({
  dayMs, volumeAusd: 0, tradeCount: 0, feesAusd: 0, liquidationCount: 0, rescuableLiquidationCount: 0,
  openInterestDeltaLots: lots, markOpen: markClose, markHigh: markClose, markLow: markClose, markClose,
});
const market = (marketId: number, symbol: string, points: MarketDailyPoint[]): MarketDailySeries => ({ market: { marketId, symbol, indexerName: symbol }, points });
const venue = (marketId: number, symbol: string, size: number, mark: number, atMs = 5): MarketOpenInterest => ({
  venue: 'perpl', network: 'mainnet', marketId, symbol, openInterestSize: size, markPrice: mark, openInterestNotional: size * mark, atBlock: 1, atMs,
} as MarketOpenInterest);

test('each day is lots × that day\'s close, summed over markets', () => {
  const h = oiHistory(
    [market(1, 'BTC', [pt(D(1), 8, 80_000), pt(D(2), 8.14921, 85_000)]), market(20, 'ETH', [pt(D(2), 190, 2_700)])],
    undefined,
  );
  assert.deepEqual(h.days.map((d) => [d.dayMs, Math.round(d.totalAusd)]), [
    [D(1), 640_000],
    [D(2), Math.round(8.14921 * 85_000 + 190 * 2_700)],
  ]);
  assert.equal(h.days[1]!.byMarket[20], 513_000);
  assert.equal(h.now, undefined, 'no venue reading, no anchor point');
});

test('a day with no mark carries the last close; lots with no mark yet are left out and counted, never priced at 0', () => {
  const h = oiHistory([market(1, 'BTC', [pt(D(1), 2, undefined), pt(D(2), 2, 100), pt(D(3), 3, undefined)])], undefined);
  assert.deepEqual(h.days.map((d) => [d.totalAusd, d.unpriced]), [
    [0, 1],
    [200, 0],
    [300, 0],
  ]);
});

test('the series ends on the venue\'s level now, and history is never shifted to meet it', () => {
  const h = oiHistory([market(1, 'BTC', [pt(D(2), 8.14921, 85_000)])], [venue(1, 'BTC', 8.14836, 85_300, 7), venue(20, 'ETH', 190.032, 2_696, 4)]);
  assert.equal(h.now!.totalAusd, 8.14836 * 85_300 + 190.032 * 2_696);
  assert.equal(h.now!.atMs, 4, 'dated by the oldest reading');
  assert.equal(h.days[0]!.totalAusd, 8.14921 * 85_000, 'unchanged by the anchor');
  assert.deepEqual(h.mismatches, [], 'BTC differs by 0.01%: inside the tolerance');
});

test('a disagreement beyond the tolerance is reported, never hidden', () => {
  const h = oiHistory(
    [market(1, 'BTC', [pt(D(2), 9, 85_000)]), market(30, 'SOL', [pt(D(2), 0, 120)]), market(99, 'GHOST', [pt(D(2), 4, 1)])],
    [venue(1, 'BTC', 8, 85_000)],
  );
  assert.deepEqual(h.mismatches, [
    { marketId: 1, symbol: 'BTC', indexedLots: 9, venueLots: 8 },
    { marketId: 99, symbol: 'GHOST', indexedLots: 4, venueLots: undefined },
  ]);
  // A retired market (SOL v1) at exactly 0 lots is what the venue's silence means: no report.
});
