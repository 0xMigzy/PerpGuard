import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketBreakdown, MarketDailySeries, MarketOpenInterest } from '@perpguard/shared';
import { RISK_WEIGHT, buildMarketTable, markWindow, riskScore, sortRows } from './markets.ts';

const day = (n: number) => Date.parse('2026-09-01T00:00:00Z') + n * 86_400_000;

const breakdown = (over: Partial<MarketBreakdown> & { readonly marketId: number; readonly symbol: string | undefined }): MarketBreakdown => ({
  market: { marketId: over.marketId, symbol: over.symbol, indexerName: `m${over.marketId}` },
  volumeAusd: 0,
  tradeCount: 0,
  feesAusd: 0,
  openPositions: 0,
  longPositions: 0,
  shortPositions: 0,
  longShareOfPositions: undefined,
  openInterestDeltaLots: 0,
  liquidationCount: 0,
  rescuableLiquidationCount: 0,
  markPrice: undefined,
  lastFundingRatePct: undefined,
  ...over,
});

const point = (n: number, open: number, high: number, low: number, close: number) => ({
  dayMs: day(n),
  volumeAusd: 0,
  tradeCount: 0,
  feesAusd: 0,
  liquidationCount: 0,
  rescuableLiquidationCount: 0,
  openInterestDeltaLots: 0,
  markOpen: open,
  markHigh: high,
  markLow: low,
  markClose: close,
});

test('a score of all-zero inputs is 0 and every component says why', () => {
  const r = riskScore({ dailyRanges: [], liquidationCount: 0, openPositions: 0, longShare: undefined, fundingPct: undefined });
  assert.equal(r.score, 0);
  assert.equal(r.tier, 'safe');
  assert.equal(r.components.length, 4);
  assert.match(r.components[0]!.detail, /no marks/);
  assert.match(r.components[2]!.detail, /no sided/);
  assert.match(r.components[3]!.detail, /no funding/);
});

test('every input at or past its ceiling scores 100, and the weights sum to one', () => {
  assert.ok(Math.abs(Object.values(RISK_WEIGHT).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const r = riskScore({ dailyRanges: [0.5, 0.2], liquidationCount: 10, openPositions: 10, longShare: 1, fundingPct: -0.05 });
  assert.equal(r.score, 100);
  assert.equal(r.tier, 'danger');
  for (const c of r.components) assert.equal(c.value, 1, c.key);
});

test('the score decomposes: points sum to the score and each is value × weight × 100', () => {
  const r = riskScore({ dailyRanges: [0.02, 0.04], liquidationCount: 3, openPositions: 60, longShare: 0.7, fundingPct: 0.00004 });
  const sum = r.components.reduce((s, c) => s + c.points, 0);
  assert.equal(r.score, Math.round(sum));
  const vol = r.components.find((c) => c.key === 'volatility')!;
  assert.ok(Math.abs(vol.value - 0.3) < 1e-9, 'mean 3% range against a 10% ceiling');
  assert.ok(Math.abs(vol.points - 0.3 * RISK_WEIGHT.volatility * 100) < 1e-9);
  const crowd = r.components.find((c) => c.key === 'crowding')!;
  assert.ok(Math.abs(crowd.value - 0.4) < 1e-9, '70% long is 0.4 of the way to one-sided');
  assert.match(crowd.detail, /70% long/);
});

test('liquidations with no open positions left still count, never divide by zero', () => {
  const r = riskScore({ dailyRanges: [], liquidationCount: 2, openPositions: 0, longShare: undefined, fundingPct: undefined });
  assert.equal(r.components.find((c) => c.key === 'liquidations')!.value, 1);
  assert.match(r.components.find((c) => c.key === 'liquidations')!.detail, /no open positions left/);
});

test('rows join on the MARKET ID, take the venue mark when there is one, and exclude an unlisted market by name', () => {
  const rows = [
    breakdown({ marketId: 31, symbol: 'SOL', volumeAusd: 100, markPrice: 118, openPositions: 10, longPositions: 6, shortPositions: 4, longShareOfPositions: 0.6 }),
    breakdown({ marketId: 80, symbol: undefined }),
    breakdown({ marketId: 1, symbol: 'BTC', volumeAusd: 900, markPrice: 83_000 }),
  ];
  const oi: MarketOpenInterest[] = [
    { venue: 'perpl', network: 'mainnet', marketId: 31, symbol: 'SOL_v2_wrong_name', openInterestSize: 10, markPrice: 120, openInterestNotional: 1200, atBlock: 1, atMs: day(2) },
  ];
  const series: MarketDailySeries[] = [
    { market: { marketId: 31, symbol: 'SOL', indexerName: 'SOL_v2' }, points: [point(0, 100, 130, 90, 110), point(1, 110, 125, 105, 118)] },
  ];
  const table = buildMarketTable(rows, oi, series, 8);
  assert.deepEqual(table.excluded.map((m) => m.marketId), [80]);
  assert.deepEqual(table.rows.map((r) => r.symbol), ['SOL', 'BTC'], 'input order kept; the page sorts');
  const sol = table.rows[0]!;
  assert.equal(sol.markPrice, 120, 'the venue level wins over the indexed mark');
  assert.equal(sol.openInterestNotional, 1200);
  assert.ok(Math.abs(sol.change! - 0.2) < 1e-12, '(120 − 100) / 100 from the first shown open');
  assert.equal(sol.low, 90);
  assert.equal(sol.high, 130);
  const btc = table.rows[1]!;
  assert.equal(btc.markPrice, 83_000, 'no venue reading: the indexed mark');
  assert.equal(btc.change, undefined, 'no series, no change');
  assert.equal(btc.openInterestNotional, undefined, 'a missing level is unknown, never zero');
});

test('showDays limits the buckets the change and range are read from, and the mark now widens the range', () => {
  const series: MarketDailySeries[] = [
    { market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' }, points: [point(0, 10, 50, 5, 20), point(1, 20, 25, 15, 22)] },
  ];
  const table = buildMarketTable([breakdown({ marketId: 1, symbol: 'BTC', markPrice: 30 })], undefined, series, 1);
  const btc = table.rows[0]!;
  assert.ok(Math.abs(btc.change! - 0.5) < 1e-12, '(30 − 20) / 20: only the last bucket');
  assert.equal(btc.low, 15);
  assert.equal(btc.high, 30, 'the current mark is above the bucket high');
});

test('sorting puts unknowns last in both directions and breaks ties by market id', () => {
  const table = buildMarketTable(
    [
      breakdown({ marketId: 3, symbol: 'C', markPrice: undefined, volumeAusd: 5 }),
      breakdown({ marketId: 1, symbol: 'A', markPrice: 10, volumeAusd: 5 }),
      breakdown({ marketId: 2, symbol: 'B', markPrice: 20, volumeAusd: 7 }),
    ],
    undefined,
    undefined,
    undefined,
  );
  assert.deepEqual(sortRows(table.rows, 'markPrice', 'desc').map((r) => r.symbol), ['B', 'A', 'C']);
  assert.deepEqual(sortRows(table.rows, 'markPrice', 'asc').map((r) => r.symbol), ['A', 'B', 'C']);
  assert.deepEqual(sortRows(table.rows, 'volumeAusd', 'desc').map((r) => r.symbol), ['B', 'A', 'C'], 'tie on 5 breaks by id');
  assert.deepEqual(sortRows(table.rows, 'symbol', 'asc').map((r) => r.symbol), ['A', 'B', 'C']);
});

test('the mark window for 24h is one bucket and says it is not 24h', () => {
  assert.deepEqual(markWindow('24h'), { fetch: '7d', showDays: 1, label: 'since 00:00 UTC', warn: true });
  assert.equal(markWindow('7d').showDays, 8);
  assert.equal(markWindow('all').showDays, undefined);
});
