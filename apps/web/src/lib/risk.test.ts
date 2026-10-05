import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExposedPosition, LadderPoint } from '@perpguard/shared';
import { CHART_SIZES, chartRungs, exposedAt, formatMove, rungAt, sideExposed } from './risk.ts';

const moves = Array.from({ length: 201 }, (_, i) => (i - 100) * 0.005);
const ladder: LadderPoint[] = moves.map((move) => ({ move, positions: move <= -0.1 ? 1 : move >= 0.05 ? 2 : 0, notionalAusd: move <= -0.1 ? 80_000 : move >= 0.05 ? 30_000 : 0, marginAusd: 0, shortfallAusd: 0, shortfallPositions: 0 }));

const pos = (over: Partial<ExposedPosition>): ExposedPosition => ({
  accountId: 1, market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' }, side: 'long', sizeLots: 1, notionalAusd: 80_000, marginAusd: 8_000, leverage: 10,
  entryPrice: 80_000, markPrice: 80_000, liquidationPrice: 75_200, liqBufferPct: 0.06, unrealisedPnlAusd: 0, openedAtMs: 0, liquidatedFromMove: -0.065, ...over,
});

test('rungs are picked by move off the fixed grid, and the chart pairs −size with +size', () => {
  assert.equal(rungAt(ladder, moves, -0.1)!.notionalAusd, 80_000);
  assert.equal(rungAt(ladder, moves, 0.05)!.positions, 2);
  assert.equal(rungAt(ladder, moves, 0.0123), undefined);
  const rows = chartRungs(ladder, moves);
  assert.equal(rows.length, CHART_SIZES.length);
  const ten = rows.find((r) => r.size === 0.1)!;
  assert.equal(ten.longsAusd, 80_000);
  assert.equal(ten.shortsAusd, 30_000);
  assert.equal(rows.find((r) => r.size === 0.03)!.longsAusd, 0);
});

test('exposedAt selects by the rung the backend recorded, per side, so it matches the ladder count', () => {
  const long = pos({});
  const short = pos({ accountId: 2, side: 'short', liquidatedFromMove: 0.04, notionalAusd: 10_000 });
  const safe = pos({ accountId: 3, liquidatedFromMove: undefined });
  const gone = pos({ accountId: 4, liquidatedFromMove: 0.02, liqBufferPct: -0.01, notionalAusd: 5_000 });
  const all = [long, short, safe, gone];
  assert.deepEqual(exposedAt(all, -0.1, undefined).map((p) => p.accountId), [1, 4], 'largest first; the long past liquidation is liquidated by a fall too');
  assert.deepEqual(exposedAt(all, -0.05, undefined).map((p) => p.accountId), [4], 'a 5% fall misses the 6.5% long');
  assert.deepEqual(exposedAt(all, 0.05, undefined).map((p) => p.accountId), [2]);
  assert.deepEqual(exposedAt(all, 0, undefined).map((p) => p.accountId), [4], 'at zero only what is already past');
  assert.deepEqual(exposedAt(all, -0.1, 99), [], 'another market');
  assert.equal(sideExposed(-0.1), 'long');
  assert.equal(sideExposed(0.1), 'short');
  assert.equal(formatMove(-0.1), '−10%');
  assert.equal(formatMove(0.025), '+2.5%');
  assert.equal(formatMove(0), '0%');
});

test('direction words and whole days for the backstop line', async () => {
  const { directionWord, wholeDays } = await import('./risk.ts');
  assert.equal(directionWord(-0.1), 'falls');
  assert.equal(directionWord(0.1), 'rises');
  assert.equal(wholeDays(Date.UTC(2026, 1, 11, 23), Date.UTC(2026, 9, 5, 12)), 235);
  assert.equal(wholeDays(10, 0), 0);
});

test('the page and the builder agree on what counts as a shortfall', async () => {
  const page = (await import('./risk.ts')).hasShortfall;
  const builder = (await import('../../../../packages/shared/src/analytics/exposure.ts')).hasShortfall;
  for (const v of [0, 0.000059, 0.0049, 0.005, 0.01, 0.57, 4_399.96]) assert.equal(page(v), builder(v), String(v));
});
