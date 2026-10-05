import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VenueFundingCell, VenueFundingPayload } from '@perpguard/shared';
import { formatAprCell, formatInterval, formatPts, scannerRows, type PerplFunding } from './fundingScanner.ts';

const q = (aprPct: number, intervalSec = 3600): VenueFundingCell => ({
  kind: 'quote',
  instrument: 'X',
  ratePct: (aprPct * intervalSec) / (365 * 86_400),
  intervalSec,
  intervalSource: 'stated',
  aprPct,
  interestAprPct: 10.95,
  markPrice: 1,
});

const perpl = (marketId: number, symbol: string, aprPct: number | undefined): PerplFunding => ({ marketId, symbol, ratePct: 0, intervalSec: 2580, aprPct });

// Today's shape, 5 Oct 2026: Perpl near zero, the others at or above their 10.95% interest floor.
const payload: VenueFundingPayload = {
  venues: { hyperliquid: { state: 'ok', lastGoodAtMs: 1 }, binance: { state: 'ok', lastGoodAtMs: 1 } },
  markets: [
    { marketId: 1, symbol: 'BTC', perplMarkPrice: 1, venues: { hyperliquid: q(10.95), binance: q(0.24, 28_800) } },
    { marketId: 100, symbol: 'NEAR', perplMarkPrice: 1, venues: { hyperliquid: q(48.85), binance: q(10.95, 28_800) } },
    { marketId: 31, symbol: 'SOL', perplMarkPrice: 1, venues: { hyperliquid: q(5.94), binance: q(-4.96, 28_800) } },
    { marketId: 7, symbol: 'ONLYHERE', perplMarkPrice: 1, venues: { hyperliquid: { kind: 'not-listed' }, binance: { kind: 'different-asset', instrument: 'ONLYHEREUSDT', markPrice: 9 } } },
    { marketId: 8, symbol: 'HALF', perplMarkPrice: 1, venues: { hyperliquid: { kind: 'not-listed' }, binance: q(2) } },
    { marketId: 9, symbol: 'DARK', perplMarkPrice: 1, venues: { hyperliquid: { kind: 'unavailable' }, binance: { kind: 'not-listed' } } },
  ],
};
const ours = [perpl(1, 'BTC', 0.24), perpl(100, 'NEAR', 0.49), perpl(31, 'SOL', 0), perpl(7, 'ONLYHERE', 1), perpl(8, 'HALF', 0), perpl(9, 'DARK', 0)];

test('raw: spread is Perpl minus the FURTHEST venue, named; sorted by its size', () => {
  const rows = scannerRows(ours, payload, 'raw');
  assert.deepEqual(
    rows.map((r) => [r.symbol, r.spread?.vs, r.spread?.pts.toFixed(2)]),
    [
      ['NEAR', 'hyperliquid', '-48.36'],
      ['BTC', 'hyperliquid', '-10.71'],
      ['SOL', 'hyperliquid', '-5.94'],
      ['HALF', 'binance', '-2.00'],
      ['DARK', undefined, undefined],
    ],
  );
});

test('only markets on both sides: a market no venue lists as the same asset is left out; an unreadable venue is not "not listed"', () => {
  const rows = scannerRows(ours, payload, 'raw');
  assert.equal(rows.some((r) => r.symbol === 'ONLYHERE'), false);
  assert.equal(rows.find((r) => r.symbol === 'HALF')!.venues.hyperliquid.cell.kind, 'not-listed', 'empty cell, never 0');
  assert.equal(rows.find((r) => r.symbol === 'HALF')!.venues.hyperliquid.aprPct, undefined);
  assert.ok(rows.some((r) => r.symbol === 'DARK'), 'kept: the venue may list it, we cannot see');
});

test('like-for-like strips each quote\'s own interest term; Perpl has none, so it is unchanged', () => {
  const rows = scannerRows(ours, payload, 'like-for-like');
  const btc = rows.find((r) => r.symbol === 'BTC')!;
  assert.equal(btc.venues.hyperliquid.aprPct!.toFixed(2), '0.00');
  assert.equal(btc.venues.binance.aprPct!.toFixed(2), '-10.71');
  assert.equal(btc.perpl.aprPct, 0.24);
  assert.equal(btc.spread!.vs, 'binance', 'the furthest venue changes with the mode');
  assert.equal(btc.spread!.pts.toFixed(2), '10.95');
  // NEAR on Hyperliquid stays far away: that gap is premium, not the interest term.
  const near = rows.find((r) => r.symbol === 'NEAR')!;
  assert.equal(near.spread!.pts.toFixed(2), '-37.41');
});

test('without a Perpl APR there is no spread, and the row sorts last', () => {
  const rows = scannerRows([perpl(1, 'BTC', undefined), perpl(100, 'NEAR', 0.49)], payload, 'raw');
  assert.deepEqual(rows.map((r) => r.symbol), ['NEAR', 'BTC']);
  assert.equal(rows[1]!.spread, undefined);
});

test('formatting: signed, tiny never zero, points named, intervals in words', () => {
  assert.equal(formatAprCell(10.9512), '+10.95%');
  assert.equal(formatAprCell(-4.8), '−4.80%');
  assert.equal(formatAprCell(0.001), '+<0.01%');
  assert.equal(formatAprCell(0), '0.00%');
  assert.equal(formatPts(-53.771), '−53.77 pts');
  assert.equal(formatInterval(2580), '43 min');
  assert.equal(formatInterval(28_800), '8 h');
  assert.equal(formatInterval(3600), '1 h');
});
