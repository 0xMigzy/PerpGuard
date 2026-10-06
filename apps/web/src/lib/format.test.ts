import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMoney,
  formatMoneyExact,
  formatSignedMoney,
  formatCompactCount,
  formatAusdExact,
  formatMultiple,
  formatFundingPct,
  blocksToApproxMs,
  formatAge,
  formatDecimalString,
  formatPrice,
  formatSignedPct,
  microsToAusdString,
  shortAddress,
} from './format.ts';

test('money has ONE rule: $, compact from 1,000, two decimals below', () => {
  assert.equal(formatMoney(1_990_209_053.25), '$1.99B');
  assert.equal(formatMoney(42_760_000), '$42.76M');
  assert.equal(formatMoney(111_817.62), '$111.8K');
  assert.equal(formatMoney(98_000), '$98K');
  assert.equal(formatMoney(4_120), '$4.1K');
  assert.equal(formatMoney(1_000), '$1K');
  assert.equal(formatMoney(999.994), '$999.99');
  assert.equal(formatMoney(8.5), '$8.50');
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(-1_087_223.31), '−$1.09M');
  assert.equal(formatMoney(-80_936), '−$80.9K');
});

test('a tiny amount is never $0.00, and rounding never prints $1,000K', () => {
  assert.equal(formatMoney(0.000032), '<$0.01');
  assert.equal(formatMoney(-0.004), '−<$0.01');
  assert.equal(formatMoney(999_960), '$1M');
  assert.equal(formatMoney(999_960_000), '$999.96M');
  assert.equal(formatMoney(999_996_000), '$1B');
});

test('signed money for flows and PnL', () => {
  assert.equal(formatSignedMoney(66_060), '+$66.1K');
  assert.equal(formatSignedMoney(-33_958), '−$34K');
  assert.equal(formatSignedMoney(0), '$0.00');
});

test('exact money where exactness is the point, and the hover form', () => {
  assert.equal(formatMoneyExact(3_838_376.912802), '$3,838,376.91');
  assert.equal(formatMoneyExact(-27.700465), '−$27.70');
  assert.equal(formatAusdExact(0.000032), '$0.000032');
  assert.equal(formatAusdExact(-1_234.5), '−$1,234.50');
});

test('a count on an axis is compact without a dollar', () => {
  assert.equal(formatCompactCount(1_500), '1.5K');
  assert.equal(formatCompactCount(360), '360');
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

test('floored money, for a loss: never rounded up, never into the next unit', () => {
  assert.equal(formatMoney(5_318_345, { floor: true }), '$5.31M');
  assert.equal(formatMoney(428_599.99, { floor: true }), '$428.5K');
  assert.equal(formatMoney(999.999, { floor: true }), '$999.99');
  assert.equal(formatMoney(999_999, { floor: true }), '$999.9K');
  assert.equal(formatMoney(1_259_000_000, { floor: true }), '$1.25B');
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
