import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeToLiquidation } from './time.ts';
import { positionMetrics } from './metrics.ts';
import { marketById } from './testMarkets.ts';
import type { RiskPosition } from './position.ts';

const BTC = marketById(1);
const long: RiskPosition = {
  marketId: 1, symbol: 'BTC', side: 'long',
  lotLNS: 50_000n, entryPricePNS: 840_295n, depositCNS: 2_810_330_000n, fundingCNS: 0n,
};
const MARK = 840_073n;

test('at a steady rate, time to liquidation is distance over rate', () => {
  const liq = positionMetrics(long, MARK, BTC).liquidationPricePNS!;
  const distance = MARK - liq; // in price units
  const hours = timeToLiquidation(long, MARK, { pricePnsPerHour: 1_000n }, BTC);
  assert.notEqual(hours, null);
  assert.equal(hours, Number(distance) / 1000);
});

test('a short is in danger from the price rising, not falling', () => {
  const short: RiskPosition = { ...long, side: 'short' };
  const hours = timeToLiquidation(short, MARK, { pricePnsPerHour: 1_000n }, BTC);
  const liq = positionMetrics(short, MARK, BTC).liquidationPricePNS!;
  assert.equal(hours, Number(liq - MARK) / 1000);
  assert.ok(hours! > 0);
});

test('a faster market gives less time', () => {
  const slow = timeToLiquidation(long, MARK, { pricePnsPerHour: 100n }, BTC)!;
  const fast = timeToLiquidation(long, MARK, { pricePnsPerHour: 10_000n }, BTC)!;
  assert.ok(fast < slow);
});

test('zero volatility returns null, not infinity', () => {
  assert.equal(timeToLiquidation(long, MARK, { pricePnsPerHour: 0n }, BTC), null);
});

test('unknown volatility returns null', () => {
  assert.equal(timeToLiquidation(long, MARK, undefined, BTC), null);
});

test('negative volatility is treated as unknown rather than reversed', () => {
  assert.equal(timeToLiquidation(long, MARK, { pricePnsPerHour: -500n }, BTC), null);
});

test('a position with no size has no time to liquidation', () => {
  const empty: RiskPosition = { ...long, lotLNS: 0n };
  assert.equal(timeToLiquidation(empty, MARK, { pricePnsPerHour: 1_000n }, BTC), null);
});

test('a position already past liquidation has no time left, and says zero not negative', () => {
  const liq = positionMetrics(long, MARK, BTC).liquidationPricePNS!;
  assert.equal(timeToLiquidation(long, liq, { pricePnsPerHour: 1_000n }, BTC), 0);
  assert.equal(timeToLiquidation(long, liq - 5_000n, { pricePnsPerHour: 1_000n }, BTC), 0);
});
