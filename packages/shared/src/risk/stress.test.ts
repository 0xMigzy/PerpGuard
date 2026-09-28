import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shockPricePNS, stressTest } from './stress.ts';
import { positionMetrics } from './metrics.ts';
import { marketById } from './testMarkets.ts';
import type { MarketRiskConfig, RiskPosition } from './position.ts';

const BTC = marketById(1);
const ETH = marketById(20);

const btcLong: RiskPosition = {
  marketId: 1, symbol: 'BTC', side: 'long',
  lotLNS: 50_000n, entryPricePNS: 840_295n, depositCNS: 2_810_330_000n, fundingCNS: 0n,
};
// 10 ETH at 3000.00 is a 30,000 AUSD notional. ETH's initial margin config of
// 1000 is 10x, so 3,000 AUSD is the least that could have opened this; anything
// thinner would be liquidated the moment it existed.
const ethShort: RiskPosition = {
  marketId: 20, symbol: 'ETH', side: 'short',
  lotLNS: 10_000n, entryPricePNS: 300_000n, depositCNS: 3_000_000_000n, fundingCNS: 0n,
};

const marks = new Map([[1, 840_073n], [20, 300_000n]]);
const configs = new Map<number, MarketRiskConfig>([[1, BTC], [20, ETH]]);

test('a price shock moves the mark by the stated fraction', () => {
  assert.equal(shockPricePNS(1_000_000n, -0.2), 800_000n);
  assert.equal(shockPricePNS(1_000_000n, 0.5), 1_500_000n);
  assert.equal(shockPricePNS(1_000_000n, 0), 1_000_000n);
  // A price can go to zero but never through it.
  assert.equal(shockPricePNS(1_000_000n, -2), 0n);
});

test('a single-market scenario leaves other markets untouched', () => {
  const result = stressTest(
    [btcLong, ethShort],
    { kind: 'market', marketId: 1, priceMoveFraction: -0.1 },
    marks,
    configs,
  );
  const [btc, eth] = result.perPosition;
  // 840073 - floor(840073 * 0.1) = 840073 - 84007
  assert.equal(btc!.shockedMarkPricePNS, 756_066n);
  assert.equal(eth!.shockedMarkPricePNS, eth!.markPricePNS, 'ETH must not move');
  assert.equal(eth!.survives, true);
});

test('a market-wide fall liquidates the long and spares the short', () => {
  const result = stressTest(
    [btcLong, ethShort],
    { kind: 'all', priceMoveFraction: -0.2 },
    marks,
    configs,
  );
  const [btc, eth] = result.perPosition;
  assert.equal(btc!.survives, false, 'a 20% fall should take out a 15x long');
  assert.equal(eth!.survives, true, 'a short gains when the market falls');
  assert.equal(result.liquidatedCount, 1);
  assert.equal(result.survivedCount, 1);
  assert.ok(btc!.marginLostCNS > 0n);
  assert.equal(eth!.marginLostCNS, 0n, 'a surviving position realises nothing');
});

test('margin lost is the deposit less what still stands behind the position', () => {
  const result = stressTest(
    [btcLong],
    { kind: 'all', priceMoveFraction: -0.2 },
    marks,
    configs,
  );
  const outcome = result.perPosition[0]!;
  const mmr = positionMetrics(btcLong, outcome.shockedMarkPricePNS, BTC).maintenanceMarginCNS;
  assert.equal(outcome.marginLostCNS, btcLong.depositCNS - mmr);
  assert.equal(result.totalMarginLostCNS, outcome.marginLostCNS);
});

test('a rise is survivable for the long and fatal for the short', () => {
  const result = stressTest(
    [btcLong, ethShort],
    { kind: 'all', priceMoveFraction: 0.2 },
    marks,
    configs,
  );
  assert.equal(result.perPosition[0]!.survives, true);
  assert.equal(result.perPosition[1]!.survives, false);
});

test('a zero move changes nothing, and both positions are healthy today', () => {
  const result = stressTest([btcLong, ethShort], { kind: 'all', priceMoveFraction: 0 }, marks, configs);
  assert.equal(result.liquidatedCount, 0);
  for (const outcome of result.perPosition) {
    assert.equal(outcome.shockedMarkPricePNS, outcome.markPricePNS);
  }
});

test('an empty book stresses to nothing rather than throwing', () => {
  const result = stressTest([], { kind: 'all', priceMoveFraction: -0.5 }, marks, configs);
  assert.deepEqual(result.perPosition, []);
  assert.equal(result.totalMarginLostCNS, 0n);
  assert.equal(result.totalUnrealisedPnlCNS, 0n);
});

test('a missing mark price or config is refused, never guessed', () => {
  assert.throws(
    () => stressTest([btcLong], { kind: 'all', priceMoveFraction: 0 }, new Map(), configs),
    /no mark price supplied for market 1/,
  );
  assert.throws(
    () => stressTest([btcLong], { kind: 'all', priceMoveFraction: 0 }, marks, new Map()),
    /no market config supplied for market 1/,
  );
});
