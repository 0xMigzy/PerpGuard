import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatUsdCompact,
  formatMultiple,
  formatFundingPct,
  blocksToApproxMs,
  formatAge,
  formatCompact,
  formatDecimalString,
  formatPrice,
  formatSignedAusd,
  formatSignedPct,
  microsToAusdString,
  shortAddress,
} from './format.ts';

test('tile figures go compact above a million and stay exact below ten thousand', () => {
  assert.equal(formatCompact(1_990_209_053.25), '1.99B');
  assert.equal(formatCompact(16_776_380.96), '16.78M');
  assert.equal(formatCompact(111_817.62), '111.8K');
  assert.equal(formatCompact(4_120), '4,120.00');
  assert.equal(formatCompact(-1_087_223.31), '−1.09M');
});

test('a decimal string is grouped and truncated WITHOUT being parsed as a float', () => {
  // Past float64's exact integer range: a Number() round trip would alter the digits.
  assert.equal(formatDecimalString('123456789012345678901.123456', 2), '123,456,789,012,345,678,901.12');
  assert.equal(formatDecimalString('3842722.942327'), '3,842,722.942327');
  assert.equal(formatDecimalString('5', 2), '5.00');
  assert.equal(formatDecimalString('-0.5', 6), '−0.500000');
  assert.equal(formatDecimalString('not a number', 2), 'not a number', 'left alone rather than NaN');
});

test('collateral micros become an AUSD string exactly, whatever the decimals', () => {
  assert.equal(microsToAusdString('3842722942327', 6), '3842722.942327');
  assert.equal(microsToAusdString('100000000', 6), '100.000000');
  assert.equal(microsToAusdString('240', 6), '0.000240', 'the dust case: 0.00024 AUSD');
  assert.equal(microsToAusdString('-55900', 6), '-0.055900');
  assert.equal(microsToAusdString('12345', 0), '12345');
});

test('prices render at the market\'s own precision', () => {
  assert.equal(formatPrice(83987.7, 1), '83,987.7');
  assert.equal(formatPrice(0.026278, 6), '0.026278');
  assert.equal(formatPrice(3, 0), '3');
});

test('signs use a real minus and percentages are from fractions', () => {
  assert.equal(formatSignedPct(0.227), '+22.7%');
  assert.equal(formatSignedPct(-0.048), '−4.8%');
  assert.equal(formatSignedPct(0), '0.0%');
  assert.equal(formatSignedAusd(-33958), '−33,958.00');
});

test('ages pick the coarsest unit that still says something', () => {
  assert.equal(formatAge(168), '168 ms');
  assert.equal(formatAge(12_400), '12 s');
  assert.equal(formatAge(4_120 * 300), '21 min');
  assert.equal(formatAge(5_400_000), '1.5 h');
  assert.equal(blocksToApproxMs(4_120), 1_236_000);
});

test('short addresses keep both ends', () => {
  assert.equal(shortAddress('0xB7854953A71e45D1033B3d619E76d56391291765'), '0xB785…1765');
});

test('a funding mean too small for six places is never printed as a signed zero', () => {
  assert.equal(formatFundingPct(0), '0.000000%');
  assert.equal(formatFundingPct(0.00004), '+0.000040%');
  assert.equal(formatFundingPct(-0.0000002), '−<0.000001%');
  assert.equal(formatFundingPct(0.0000004), '+<0.000001%');
  assert.equal(formatFundingPct(0.0000006), '+0.000001%');
});

test('a multiple keeps a decimal only below 10', () => {
  assert.equal(formatMultiple(186.8), '187×');
  assert.equal(formatMultiple(1447.4), '1,447×');
  assert.equal(formatMultiple(1.43), '1.4×');
  assert.equal(formatMultiple(Number.POSITIVE_INFINITY), '—');
});

test('compact dollars: two decimals at most, floored because it prints a loss', () => {
  assert.equal(formatUsdCompact(5_312_345), '$5.31M');
  assert.equal(formatUsdCompact(428_529.99), '$428.52K');
  assert.equal(formatUsdCompact(3_029), '$3.02K');
  assert.equal(formatUsdCompact(425_343.63), '$425.34K');
  assert.equal(formatUsdCompact(146.509), '$146.5');
  assert.equal(formatUsdCompact(999.999), '$999.99', 'never rounded up into the next unit');
  assert.equal(formatUsdCompact(0), '$0');
  assert.equal(formatUsdCompact(1_250_000_000), '$1.25B');
});

test('an age is never negative: a timestamp ahead of a slow visitor clock reads "under 1 s"', async () => {
  const { formatAge } = await import('./format.ts');
  assert.equal(formatAge(-1_386_000), 'under 1 s');
  assert.equal(formatAge(-1), 'under 1 s');
  assert.equal(formatAge(0), '0 ms', 'a real age, however small, keeps its milliseconds');
  assert.equal(formatAge(Number.NaN), 'under 1 s');
  assert.equal(formatAge(39_000), '39 s');
  assert.equal(formatAge(5 * 60_000), '5 min');
});
