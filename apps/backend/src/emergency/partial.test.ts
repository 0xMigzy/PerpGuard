import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatePartial, judgePartial, partialLots, realisedFromFill } from './partial.ts';

// Testnet BTC: prices to 1 decimal, sizes to 5, AUSD to 6.
const BTC = { priceDecimals: 1, lotDecimals: 5, collateralDecimals: 6 };

test('A PERCENTAGE IS WHOLE SIZE UNITS, ROUNDED DOWN: 25%, 50%, 75% of 0.5 BTC', () => {
  assert.deepEqual(partialLots(50_000n, 25), { ok: true, closeLNS: 12_500n, remainLNS: 37_500n });
  assert.deepEqual(partialLots(50_000n, 50), { ok: true, closeLNS: 25_000n, remainLNS: 25_000n });
  assert.deepEqual(partialLots(50_000n, 75), { ok: true, closeLNS: 37_500n, remainLNS: 12_500n });
  // 7 units: 25% is 1.75, which is 1 unit; 75% is 5.25, which is 5.
  assert.deepEqual(partialLots(7n, 25), { ok: true, closeLNS: 1n, remainLNS: 6n });
  assert.deepEqual(partialLots(7n, 75), { ok: true, closeLNS: 5n, remainLNS: 2n });
});

test('BELOW THE MINIMUM LOT IS NOT AN OPTION: an option that rounds under one size unit is refused', () => {
  // 3 units: 25% is 0.75 of a unit.
  assert.deepEqual(partialLots(3n, 25), { ok: false, why: 'too-small' });
  assert.deepEqual(partialLots(3n, 50), { ok: true, closeLNS: 1n, remainLNS: 2n });
  assert.deepEqual(partialLots(1n, 50), { ok: false, why: 'too-small' });
  assert.deepEqual(partialLots(1n, 99), { ok: false, why: 'too-small' });
});

test('100% is the whole position (its own confirmation); 0, negatives, over 100 and nonsense are refused', () => {
  assert.deepEqual(partialLots(50_000n, 100), { ok: false, why: 'whole' });
  for (const pct of [0, -5, 100.5, 250, Number.NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(partialLots(50_000n, pct), { ok: false, why: 'bad-percent' });
  assert.deepEqual(partialLots(50_000n, 1), { ok: true, closeLNS: 500n, remainLNS: 49_500n });
  assert.deepEqual(partialLots(50_000n, 12.5), { ok: true, closeLNS: 6_250n, remainLNS: 43_750n });
});

test('THE ESTIMATE: the closed part’s share of the unrealised P&L, and the taker fee on the value closed, rounded up', () => {
  // 0.5 BTC at 83,063.3, closing half; −120 AUSD unrealised; taker fee 345 per million.
  const e = estimatePartial({ sizeLNS: 50_000n, closeLNS: 25_000n, unrealisedPnlCNS: -120_000_000n, markPricePNS: 830_633n, scale: BTC, takerFeeMicros: 345 });
  assert.equal(e.realisedCNS, -60_000_000n);
  // 0.25 BTC × 83,063.3 = 20,765.825 AUSD; × 0.000345 = 7.164209625 -> 7.164210 (up).
  assert.equal(e.feeCNS, 7_164_210n);
});

test('the fee rate matches the exchange: the recorded reduce charged 288 micros on 1 unit at 83,197.7 (345 per million, rounded up)', () => {
  const e = estimatePartial({ sizeLNS: 3n, closeLNS: 1n, unrealisedPnlCNS: 0n, markPricePNS: 831_977n, scale: BTC, takerFeeMicros: 345 });
  assert.equal(e.feeCNS, 288n);
});

test('what cannot be priced is not estimated', () => {
  const e = estimatePartial({ sizeLNS: 50_000n, closeLNS: 25_000n, unrealisedPnlCNS: undefined, markPricePNS: undefined, scale: BTC, takerFeeMicros: 345 });
  assert.deepEqual(e, { realisedCNS: undefined, feeCNS: undefined });
});

test('REALISED FROM THE FILL: (exit − entry) × size closed, signed for the side', () => {
  const fill = { exitPricePNS: 830_000n, closedLNS: 25_000n, feeCNS: 7_160_000n };
  // Long from 84,000.0 out at 83,000.0 on 0.25 BTC: −250 AUSD. The same fill on a short: +250.
  assert.equal(realisedFromFill({ side: 'long', entryPricePNS: 840_000n, fill, scale: BTC }), -250_000_000n);
  assert.equal(realisedFromFill({ side: 'short', entryPricePNS: 840_000n, fill, scale: BTC }), 250_000_000n);
});

test('JUDGED BY THE POSITION BEFORE AND AFTER, not the receipt', () => {
  const base = { beforeLNS: 50_000n, requestedLNS: 25_000n };
  assert.deepEqual(judgePartial({ ...base, after: 25_000n, receipt: 'confirmed' }), { kind: 'reduced', beforeLNS: 50_000n, afterLNS: 25_000n, closedLNS: 25_000n, asAsked: true });
  // The receipt said rejected, the position is smaller: the position wins.
  assert.equal(judgePartial({ ...base, after: 25_000n, receipt: 'rejected' }).kind, 'reduced');
  // A different amount landed: said, never rounded to what was asked.
  assert.deepEqual(judgePartial({ ...base, after: 40_000n, receipt: 'confirmed' }), { kind: 'reduced', beforeLNS: 50_000n, afterLNS: 40_000n, closedLNS: 10_000n, asAsked: false });
  // The receipt said confirmed, the position is the same: NOT reported as done.
  const same = judgePartial({ ...base, after: 50_000n, receipt: 'confirmed' });
  assert.equal(same.kind, 'unchanged');
  assert.match((same as { why: string }).why, /"confirmed" and the position is the same size/);
  assert.match((judgePartial({ ...base, after: 50_000n, receipt: undefined }) as { why: string }).why, /did not go out/);
  assert.deepEqual(judgePartial({ ...base, after: null, receipt: 'confirmed' }), { kind: 'gone', beforeLNS: 50_000n });
  assert.equal(judgePartial({ ...base, after: undefined, receipt: 'confirmed' }).kind, 'not-seen');
});
