import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketFundingSeries } from '@perpguard/shared';
import { aprPct, fundingHeatmap, heatmapGrain, settlementsPerYear, type LiveMarket } from './funding.ts';

const DAY = 86_400_000;
// Sun 4 Oct 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 4, 12);
const CADENCE = { venueIntervalSec: 2580, measuredIntervalSec: 2587, eventsPerDay: 33 };

const series = (
  marketId: number,
  points: readonly { atMs: number; ratePct: number; events?: number }[],
  resolution: 'event' | 'utc-day' = 'event',
  cadence = CADENCE,
): MarketFundingSeries => ({
  market: { marketId, symbol: undefined, indexerName: `m${marketId}` },
  resolution,
  points: points.map((p) => ({ atMs: p.atMs, ratePct: p.ratePct, events: p.events ?? 1 })),
  eventCount: points.reduce((n, p) => n + (p.events ?? 1), 0),
  cumulativeRatePct: 0,
  firstAtMs: points[0]?.atMs,
  lastAtMs: points.at(-1)?.atMs,
  cadence,
});

const live = (marketId: number, symbol: string, currentRatePct?: number): LiveMarket => ({ marketId, symbol, currentRatePct });

test('the grain follows the timeframe: settlements, days, days, weeks', () => {
  assert.deepEqual((['24h', '7d', '30d', 'all'] as const).map(heatmapGrain), ['settlement', 'utc-day', 'utc-day', 'utc-week']);
});

test('EVERY live market gets a row, in id order, even one with no funding events', () => {
  const t0 = NOW - 3 * 2_580_000;
  const map = fundingHeatmap(
    [live(31, 'SOL'), live(1, 'BTC'), live(110, 'UNI')],
    [series(1, [{ atMs: t0, ratePct: 0.00004 }]), series(31, [{ atMs: t0, ratePct: -0.00001 }]), series(120, [{ atMs: t0 + 1000, ratePct: 0 }])],
    '24h',
    NOW,
  );
  assert.deepEqual(map.rows.map((r) => r.symbol), ['BTC', 'SOL', 'UNI'], 'row count is the live count');
  assert.deepEqual(map.rows[2]!.cells, [undefined], 'UNI has no settlement: a missing cell, not a zero');
  assert.equal(map.rows[2]!.eventCount, 0);
  assert.equal(map.columns.length, 1, "an upcoming market's settlement (120) adds no column");
});

test('a missing cell is undefined and a zero-rate cell is a reading at 0', () => {
  const a = NOW - 2 * 2_580_000;
  const b = NOW - 2_580_000;
  const map = fundingHeatmap([live(1, 'BTC'), live(100, 'NEAR')], [series(1, [{ atMs: a, ratePct: 0.00004 }, { atMs: b, ratePct: 0 }]), series(100, [{ atMs: b, ratePct: 0 }])], '24h', NOW);
  assert.deepEqual(map.rows[0]!.cells, [{ ratePct: 0.00004, events: 1 }, { ratePct: 0, events: 1 }]);
  assert.deepEqual(map.rows[1]!.cells, [undefined, { ratePct: 0, events: 1 }], 'NEAR was not listed yet at the first settlement');
});

test('7D buckets every settlement into UTC days, contiguous, and each cell says how many it averaged', () => {
  const day = (d: number, h: number) => Date.UTC(2026, 9, d, h);
  const map = fundingHeatmap(
    [live(1, 'BTC')],
    [series(1, [{ atMs: day(1, 1), ratePct: 0.00004 }, { atMs: day(1, 2), ratePct: 0.00002 }, { atMs: day(3, 5), ratePct: -0.00001 }])],
    '7d',
    NOW,
  );
  assert.equal(map.grain, 'utc-day');
  assert.equal(map.columns.length, 8, 'Sep 27 (cut by the window) to Oct 4 (so far)');
  assert.equal(map.columns[0]!.partial, true, 'the window cuts into the first day');
  assert.equal(map.columns.at(-1)!.partial, true, 'today is so far');
  assert.equal(map.columns[1]!.partial, false);
  const cells = map.rows[0]!.cells;
  const oct1 = cells[4]!;
  assert.equal(oct1.events, 2);
  assert.ok(Math.abs(oct1.ratePct - 0.00003) < 1e-12, 'the mean per settlement');
  assert.equal(cells[5], undefined, 'Oct 2: no settlement, a missing column rather than a skipped one');
});

test('All is weekly (Monday UTC), weighting each day by its settlements', () => {
  const map = fundingHeatmap(
    [live(1, 'BTC')],
    [
      series(
        1,
        [
          { atMs: Date.UTC(2026, 8, 21), ratePct: 0.00003, events: 33 }, // Mon 21 Sep
          { atMs: Date.UTC(2026, 8, 27), ratePct: -0.00003, events: 11 }, // Sun 27 Sep: same week
          { atMs: Date.UTC(2026, 8, 28), ratePct: 0.00001, events: 34 }, // Mon 28 Sep
        ],
        'utc-day',
      ),
    ],
    'all',
    NOW,
  );
  assert.equal(map.grain, 'utc-week');
  assert.deepEqual(map.columns.map((c) => new Date(c.startMs).toISOString().slice(0, 10)), ['2026-09-21', '2026-09-28']);
  assert.equal(map.columns[0]!.partial, false, 'All starts at the first settlement: nothing was cut off');
  assert.equal(map.columns[1]!.partial, true, 'this week is so far');
  const week = map.rows[0]!.cells[0]!;
  assert.equal(week.events, 44);
  assert.ok(Math.abs(week.ratePct - (0.00003 * 33 - 0.00003 * 11) / 44) < 1e-12);
  assert.equal(map.eventsPerColumn, undefined, "the only whole week is BTC's first, its listing: not counted");

});

test('too many settlements for 24H falls back to UTC days rather than drawing slivers', () => {
  const points = Array.from({ length: 70 }, (_, i) => ({ atMs: NOW - DAY + i * 60_000, ratePct: 0 }));
  assert.equal(fundingHeatmap([live(1, 'BTC')], [series(1, points)], '24h', NOW).grain, 'utc-day');
});

test('APR is simple: the current rate × settlements a year from the venue interval', () => {
  assert.ok(Math.abs(settlementsPerYear(CADENCE)! - (365 * 86_400) / 2580) < 1e-9);
  assert.ok(Math.abs(aprPct(0.00004, CADENCE)! - 0.00004 * ((365 * 86_400) / 2580)) < 1e-12);
  assert.ok(Math.abs(settlementsPerYear({ venueIntervalSec: undefined, measuredIntervalSec: 3600, eventsPerDay: 24 })! - 8760) < 1e-9, 'measured when the venue gives none');
  assert.equal(aprPct(undefined, CADENCE), undefined, 'no rate, no APR');
  assert.equal(aprPct(0.00004, undefined), undefined, 'no cadence, no APR: never an assumed hour');
});

test('the stated cadence is the one most live markets were measured at', () => {
  const t = NOW - 1000;
  const map = fundingHeatmap(
    [live(1, 'BTC', 0.00004), live(10, 'MON'), live(100, 'NEAR')],
    [series(1, [{ atMs: t, ratePct: 0 }]), series(10, [{ atMs: t, ratePct: 0 }]), series(100, [{ atMs: t, ratePct: 0 }], 'event', { ...CADENCE, eventsPerDay: 12 })],
    '24h',
    NOW,
  );
  assert.deepEqual(map.cadence, CADENCE);
  assert.ok(map.rows[0]!.aprPct! > 0);
  assert.equal(map.rows[1]!.aprPct, undefined, 'MON has no current rate');
});

test('one symmetric scale, never zero', () => {
  const t = NOW - 1000;
  assert.equal(fundingHeatmap([live(1, 'BTC')], [series(1, [{ atMs: t, ratePct: -0.0005 }])], '24h', NOW).maxAbsRatePct, 0.0005);
  assert.equal(fundingHeatmap([live(1, 'BTC')], [series(1, [{ atMs: t, ratePct: 0 }])], '24h', NOW).maxAbsRatePct, 0.00001);
});

test("the per-column range leaves out partial columns and each market's listing column", () => {
  const d = (n: number) => Date.UTC(2026, 8, 24 + n); // Thu 24 Sep onwards
  const map = fundingHeatmap(
    [live(1, 'BTC'), live(100, 'NEAR')],
    [
      series(1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ atMs: d(n), ratePct: 0, events: n === 10 ? 20 : 33 })), 'utc-day'),
      series(100, [{ atMs: d(6), ratePct: 0, events: 17 }, { atMs: d(7), ratePct: 0, events: 34 }, { atMs: d(8), ratePct: 0, events: 33 }], 'utc-day'),
    ],
    '30d',
    NOW,
  );
  assert.deepEqual(map.eventsPerColumn, { min: 33, max: 34 }, "NEAR's listing day (17) and today so far (20) are not whole columns");
});
