import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ausdFromRaw,
  ausdToRaw,
  bpsToFraction,
  initialMarginRatioFromConfig,
  maintenanceMarginRatioFromConfig,
  maxLeverageFromConfig,
  numberToScaled,
  priceFromRaw,
  scaledToNumber,
  sizeFromRaw,
} from './units.ts';

describe('scaledToNumber', () => {
  it('divides by 10^decimals, matching live mainnet market state', () => {
    // Real values from GET /v1/pub/context, chain 143.
    assert.equal(scaledToNumber(839877, 1), 83987.7); // BTC
    assert.equal(scaledToNumber(269031, 2), 2690.31); // ETH
    assert.equal(scaledToNumber(121602, 3), 121.602); // SOL
    assert.equal(scaledToNumber(4339, 6), 0.004339); // PUMP
  });

  it('handles zero decimals, as MON and PUMP sizes use', () => {
    assert.equal(scaledToNumber(6598227, 0), 6598227);
  });

  it('accepts bigint and decimal-string raws', () => {
    assert.equal(scaledToNumber(100000000n, 6), 100);
    assert.equal(scaledToNumber('4831947009261', 6), 4831947.009261);
  });

  it('handles negatives and values below one', () => {
    assert.equal(scaledToNumber(-11100000, 6), -11.1);
    assert.equal(scaledToNumber(7, 6), 0.000007);
  });

  it('rejects non-integer raw amounts rather than silently truncating', () => {
    assert.throws(() => scaledToNumber(1.5, 2), RangeError);
    assert.throws(() => scaledToNumber('12.5', 2), RangeError);
    assert.throws(() => scaledToNumber(1, -1), RangeError);
  });
});

describe('numberToScaled', () => {
  it('round-trips every representable value', () => {
    const cases: Array<[number, number]> = [
      [83987.7, 1],
      [2690.31, 2],
      [0.004339, 6],
      [6598227, 0],
      [-11.1, 6],
      [100, 6],
    ];
    for (const [value, decimals] of cases) {
      assert.equal(scaledToNumber(numberToScaled(value, decimals), decimals), value);
    }
  });

  it('rounds to the market precision', () => {
    assert.equal(numberToScaled(83987.74, 1), 839877n);
    assert.equal(numberToScaled(83987.76, 1), 839878n);
    assert.equal(numberToScaled(0.5, 0), 1n); // sizeDecimals 0 markets
  });

  it('rejects non-finite values', () => {
    assert.throws(() => numberToScaled(Number.NaN, 2), RangeError);
    assert.throws(() => numberToScaled(Number.POSITIVE_INFINITY, 2), RangeError);
  });
});

describe('AUSD', () => {
  it('treats raw 100000000 at 6 decimals as 100.0, per the project brief', () => {
    assert.equal(ausdFromRaw(100000000, 6), 100);
    assert.equal(ausdToRaw(100, 6), 100000000n);
  });

  it('round-trips the fixture margin exactly', () => {
    assert.equal(ausdToRaw(2810.33, 6), 2810330000n);
    assert.equal(ausdFromRaw(2810330000n, 6), 2810.33);
  });
});

describe('price and size helpers', () => {
  const scaling = { priceDecimals: 1, sizeDecimals: 5 }; // mainnet BTC

  it('reads the exponents off the market rather than assuming', () => {
    assert.equal(priceFromRaw(839877, scaling), 83987.7);
    assert.equal(sizeFromRaw(837897, scaling), 8.37897);
  });
});

describe('bpsToFraction', () => {
  it('converts the taker fee field', () => {
    assert.equal(bpsToFraction(345), 0.0345);
    assert.equal(bpsToFraction(45), 0.0045);
    assert.equal(bpsToFraction(0), 0);
  });
});

describe('margin config decoding', () => {
  it('reads initial_margin as hundredths of max leverage', () => {
    assert.equal(maxLeverageFromConfig(1500), 15); // BTC
    assert.equal(maxLeverageFromConfig(1200), 12); // ETH
    assert.equal(maxLeverageFromConfig(300), 3); // LIT
  });

  it('derives the initial margin ratio as 1 / maxLeverage', () => {
    assert.ok(Math.abs(initialMarginRatioFromConfig(1500) - 0.0666667) < 1e-6);
  });

  it('reads maintenance_margin as hundredths of the maintenance leverage', () => {
    assert.equal(maintenanceMarginRatioFromConfig(2500), 0.04); // BTC
    assert.equal(maintenanceMarginRatioFromConfig(2000), 0.05); // ETH, SOL, MON
    assert.equal(maintenanceMarginRatioFromConfig(1000), 0.1); // LIT, VVV, PUMP
  });

  it('keeps maintenance below initial margin on every live market', () => {
    // Sanity check on the encoding itself: a maintenance requirement above the
    // initial one would mean positions open already liquidatable.
    const live: Array<[number, number]> = [
      [1500, 2500],
      [1000, 2000],
      [1200, 2000],
      [1000, 1800],
      [300, 1000],
      [500, 1000],
    ];
    for (const [initial, maintenance] of live) {
      assert.ok(
        maintenanceMarginRatioFromConfig(maintenance) < initialMarginRatioFromConfig(initial),
        `maintenance ${maintenance} should sit below initial ${initial}`,
      );
    }
  });

  it('rejects nonsense config values', () => {
    assert.throws(() => maxLeverageFromConfig(0), RangeError);
    assert.throws(() => maintenanceMarginRatioFromConfig(-1), RangeError);
  });
});
