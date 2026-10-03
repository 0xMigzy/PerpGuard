import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketFundingSeries } from '@perpguard/shared';
import { fundingPanels, payerOf } from './funding.ts';

const series = (marketId: number, symbol: string | undefined, rates: readonly number[], cumulativeRatePct: number, resolution: 'event' | 'utc-day' = 'event'): MarketFundingSeries => ({
  market: { marketId, symbol, indexerName: symbol ?? `m${marketId}` },
  resolution,
  points: rates.map((ratePct, i) => ({ atMs: i * 2_580_000, ratePct })),
  eventCount: rates.length,
  cumulativeRatePct,
  firstAtMs: 0,
  lastAtMs: (rates.length - 1) * 2_580_000,
});

test('only markets the venue lists are drawn, in market id order', () => {
  const panels = fundingPanels([
    series(31, 'SOL', [-0.00001], -0.00001),
    series(120, undefined, [0, 0], 0),
    series(1, 'BTC', [0.00004, -0.0005], -0.00046),
    series(30, undefined, [0.00002], 0.00002),
  ]);
  assert.deepEqual(panels.markets.map((m) => m.symbol), ['BTC', 'SOL'], 'upcoming (120) and retired (30) are not drawn');
});

test('one symmetric scale for every panel, from the largest rate anywhere', () => {
  const panels = fundingPanels([series(1, 'BTC', [0.00004, -0.0005], -0.00046), series(10, 'MON', [0.00002], 0.00002)]);
  assert.equal(panels.maxAbsRatePct, 0.0005);
  assert.equal(fundingPanels([series(80, 'TAO', [0, 0], 0)]).maxAbsRatePct, 0.00001, 'all-zero still has a scale');
});

test('who paid: positive is longs, and the ranking puts the largest payer first', () => {
  assert.equal(payerOf(0.0127), 'longs');
  assert.equal(payerOf(-0.0067), 'shorts');
  assert.equal(payerOf(0), 'neither');
  const panels = fundingPanels([series(1, 'BTC', [0], 0.00027), series(10, 'MON', [0], 0.01277), series(31, 'SOL', [0], -0.00674)]);
  assert.deepEqual(panels.byCumulative.map((m) => m.symbol), ['MON', 'BTC', 'SOL']);
  assert.equal(panels.maxAbsCumulativePct, 0.01277);
});

test('a daily-mean panel has no "last rate": a day’s mean is not a rate that was applied', () => {
  const [btc] = fundingPanels([series(1, 'BTC', [0.00002, 0.00003], 0.0013, 'utc-day')]).markets;
  assert.equal(btc!.lastRatePct, undefined);
  assert.equal(btc!.resolution, 'utc-day');
});
