/**
 * The exposure builder, on hand-built positions against one mainnet config.
 *
 * The numbers are chosen so the answers are readable by eye: a 10x long at a
 * 4% maintenance ratio (BTC's) has a liquidation price about 6% below entry,
 * so it survives a 5% fall and not a 10% one; the same position short survives
 * a 5% rise and not a 10% one. The two must land on DIFFERENT rungs, which is
 * what makes "both adverse directions" a sum of disjoint sets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketRiskConfig } from '../risk/position.ts';
import { LADDER_MOVES, atRiskPair, buildRiskSnapshot, directionalAt, hasShortfall, rungIndex } from './exposure.ts';
import type { IndexedOpenPosition, MarketRef } from './types.ts';

const BTC: MarketRiskConfig = { marketId: 1, symbol: 'BTC', priceDecimals: 1, lotDecimals: 5, collateralDecimals: 6, maintenanceMargin: 2500, initialMargin: 1500 };
const REF: MarketRef = { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' };
const MARK = 80_000;

function position(accountId: number, side: 'long' | 'short', sizeLots: number, marginAusd: number, entryPrice = MARK): IndexedOpenPosition {
  return {
    accountId,
    position: { market: REF, side, sizeLots, entryPrice, marginAusd, leverage: (sizeLots * entryPrice) / marginAusd, openedAtMs: 1_790_000_000_000, marginAddedAusd: 0 },
  };
}

const CONFIGS = new Map([[1, BTC]]);
const MARKS = new Map([[1, { markPrice: MARK, atMs: 1_790_800_000_000 }]]);
const INSURANCE = new Map([[1, { marketId: 1, insuranceBalanceCNS: 177_437_095_975n, positionBalanceCNS: 0n, markPNS: 800_000n, markAtMs: 1_790_800_100_000, longOpenInterestLNS: 0n, shortOpenInterestLNS: 0n }]]);

test('the ladder has 201 rungs from −50% to +50% and each tile move is a rung', () => {
  assert.equal(LADDER_MOVES.length, 201);
  assert.equal(LADDER_MOVES[0], -0.5);
  assert.equal(LADDER_MOVES[100], 0);
  assert.equal(LADDER_MOVES[200], 0.5);
  assert.equal(rungIndex(-0.1), 80);
  assert.equal(rungIndex(0.05), 110);
  assert.throws(() => rungIndex(0.0123), /not a rung/);
});

test('a 10x long is exposed at −10% and not at −5%; the mirror short at +10% and not at +5%', () => {
  // 1 BTC at 80,000 with 8,000 margin: liquidation ≈ 80,000 − (8,000 − 3,200)/1 = 75,200, a 6% buffer.
  const snapshot = buildRiskSnapshot({
    positions: [position(7, 'long', 1, 8_000), position(8, 'short', 1, 8_000)],
    configs: CONFIGS,
    marks: MARKS,
    insurance: INSURANCE,
    indexerBlock: 109_000_000,
    nowMs: 1_790_800_200_000,
  });
  assert.equal(snapshot.counted.priced, 2);
  assert.equal(snapshot.totals.notionalAusd, 160_000);
  assert.equal(snapshot.totals.longMarginAusd, 8_000, 'per side by margin, not notional');
  assert.equal(snapshot.totals.shortMarginAusd, 8_000);

  const at = (move: number) => snapshot.ladder[rungIndex(move)]!;
  assert.equal(at(-0.05).positions, 0, 'a 5% fall liquidates neither');
  assert.equal(at(0.05).positions, 0);
  assert.equal(at(-0.1).positions, 1, 'a 10% fall takes the long');
  assert.equal(at(-0.1).notionalAusd, 80_000);
  assert.equal(at(0.1).positions, 1, 'a 10% rise takes the short');
  assert.equal(at(0).positions, 0, 'nothing is past liquidation now');

  // Open interest is ONE side: the long and the short are one 80,000 contract.
  assert.equal(snapshot.totals.openInterestAusd, 80_000, 'half the two-sided sum');
  assert.equal(snapshot.markets[0]!.openInterestAusd, 80_000);

  // The 10% pair is a fall and a rise SIDE BY SIDE, never added: no single
  // move liquidates both the long and the short.
  const tile = snapshot.atRisk['0.100']!;
  assert.equal(tile.fall.positions, 1, 'a 10% fall closes the long only');
  assert.equal(tile.fall.side, 'long');
  assert.equal(tile.rise.positions, 1, 'a 10% rise closes the short only');
  assert.equal(tile.rise.side, 'short');
  assert.equal(tile.fall.notionalAusd, 80_000);
  assert.equal(tile.fall.shareOfOpenInterest, 1, 'a share of ONE-SIDED open interest');
  assert.ok(!('positions' in tile) && !('notionalAusd' in tile), 'no summed field exists to render by mistake');
  assert.deepEqual(tile, atRiskPair(snapshot.ladder, 0.1, snapshot.totals.openInterestAusd));
  assert.equal(snapshot.atRisk['0.050']!.fall.positions, 0);
  assert.equal(snapshot.atRisk['0.050']!.rise.positions, 0);

  // The least adverse rung per position agrees with the ladder: the long goes at
  // some rung between −10% and −5%, the short between +5% and +10%.
  const long = snapshot.positions.find((p) => p.side === 'long')!;
  const short = snapshot.positions.find((p) => p.side === 'short')!;
  assert.ok(long.liquidatedFromMove! <= -0.05 && long.liquidatedFromMove! > -0.1);
  assert.ok(short.liquidatedFromMove! >= 0.05 && short.liquidatedFromMove! < 0.1);
  assert.equal(long.liquidatedFromMove! <= -0.1, false, 'not exposed at −10%? it IS: −0.1 <= liquidatedFromMove');
  assert.ok(-0.1 <= long.liquidatedFromMove!, 'a long is exposed at m when m <= liquidatedFromMove');
  assert.ok(0.1 >= short.liquidatedFromMove!, 'a short is exposed at m when m >= liquidatedFromMove');

  // Per market ladder equals the total ladder when there is one market.
  assert.deepEqual(snapshot.markets[0]!.ladder, snapshot.ladder);
  assert.equal(snapshot.markets[0]!.insuranceAusd, 177_437.095975);
  assert.equal(snapshot.insurance.marketsWithReading, 1);
  assert.equal(snapshot.asOf.indexerBlock, 109_000_000);
  assert.equal(snapshot.asOf.marksAtMs, 1_790_800_000_000);
  assert.equal(snapshot.statements.length, 2);
});

test('shortfall is equity below zero at the shocked mark, and cover is insurance over it', () => {
  // At −10% the long's uPnL is −8,000 against 8,000 margin: equity exactly 0, no shortfall.
  // At −20% it is −16,000: 8,000 of shortfall.
  const snapshot = buildRiskSnapshot({
    positions: [position(7, 'long', 1, 8_000)],
    configs: CONFIGS,
    marks: MARKS,
    insurance: INSURANCE,
    indexerBlock: undefined,
    nowMs: 0,
  });
  const at = (move: number) => snapshot.ladder[rungIndex(move)]!;
  assert.equal(at(-0.1).shortfallAusd, 0);
  assert.equal(at(-0.2).shortfallAusd, 8_000);
  assert.equal(snapshot.markets[0]!.cover10.cover, undefined, 'no shortfall means nothing to cover, not infinite cover');
  const twenty = directionalAt(snapshot.ladder, -0.2, snapshot.totals.openInterestAusd);
  assert.equal(twenty.shortfallAusd, 8_000);
  assert.equal(twenty.shortfallPositions, 1, 'one position loses more than its own collateral');
  assert.equal(directionalAt(snapshot.ladder, 0.2, snapshot.totals.openInterestAusd).shortfallAusd, 0, 'a rise costs a long nothing');
  assert.equal(snapshot.weakestCover, undefined, 'no market has a shortfall at 10%');
});

test('a position already past liquidation is counted at every rung, including zero, with a negative buffer', () => {
  // Entry 90,000, mark 80,000: 1 BTC long with 8,000 margin is 11% under water.
  const snapshot = buildRiskSnapshot({
    positions: [position(9, 'long', 1, 8_000, 90_000)],
    configs: CONFIGS,
    marks: MARKS,
    insurance: new Map(),
    indexerBlock: 1,
    nowMs: 0,
  });
  assert.ok(snapshot.positions[0]!.liqBufferPct! < 0, 'signed, never abs()');
  assert.ok(snapshot.positions[0]!.liquidatedFromMove! > 0, 'liquidated even at a small rise: the least adverse rung is above zero');
  assert.equal(snapshot.ladder[rungIndex(0)]!.positions, 1, 'counted at zero move: it is past liquidation now');
  assert.equal(snapshot.ladder[rungIndex(-0.5)]!.positions, 1);
  // A static shock UPWARDS puts a long back above maintenance: the rung says so,
  // because the ladder reports the state at the shocked mark and nothing else.
  assert.equal(snapshot.ladder[rungIndex(0.5)]!.positions, 0);
  assert.equal(snapshot.markets[0]!.insuranceAusd, undefined, 'no reading is a hole, never zero');
  assert.equal(snapshot.insurance.totalAusd, undefined);
  assert.equal(snapshot.insurance.marketsWithout, 1);
});

test('positions that cannot be priced are counted with their reasons, never silently dropped', () => {
  const unknownEntry: IndexedOpenPosition = { accountId: 1, position: { ...position(1, 'long', 1, 8_000).position, entryPrice: undefined } };
  const unlisted: IndexedOpenPosition = { accountId: 2, position: { ...position(2, 'long', 1, 8_000).position, market: { marketId: 80, symbol: undefined, indexerName: 'TAO' } } };
  const snapshot = buildRiskSnapshot({
    positions: [unknownEntry, unlisted, position(3, 'short', 0.5, 4_000)],
    configs: CONFIGS,
    marks: MARKS,
    insurance: new Map(),
    indexerBlock: 1,
    nowMs: 0,
  });
  assert.equal(snapshot.counted.positions, 3);
  assert.equal(snapshot.counted.priced, 1);
  assert.equal(snapshot.counted.unpriced, 2);
  assert.deepEqual(snapshot.counted.unpricedReasons, {
    'the entry price is unknown: the position was opened before the index starts': 1,
    'the venue does not list this market, so its maintenance margin is unknown': 1,
  });
});

test('shortfall and its count are per direction; cover is per market against its worse direction only', () => {
  // A 20x long and a 20x short of different sizes: both go past their collateral
  // at 10%, but in DIFFERENT worlds. 1 BTC long with 4,000 margin: equity at −10%
  // is 4,000 − 8,000 = −4,000. 0.5 BTC short with 2,000: at +10%, 2,000 − 4,000 = −2,000.
  const snapshot = buildRiskSnapshot({
    positions: [position(1, 'long', 1, 4_000), position(2, 'short', 0.5, 2_000)],
    configs: CONFIGS,
    marks: MARKS,
    insurance: INSURANCE,
    indexerBlock: 1,
    nowMs: 0,
  });
  const ten = snapshot.atRisk['0.100']!;
  assert.equal(ten.fall.shortfallAusd, 4_000);
  assert.equal(ten.fall.shortfallPositions, 1);
  assert.equal(ten.rise.shortfallAusd, 2_000);
  assert.equal(ten.rise.shortfallPositions, 1);
  assert.equal(ten.worse, ten.fall, 'the worse single direction, never 6,000 for both');
  const m = snapshot.markets[0]!;
  assert.equal(m.cover10.direction, 'fall');
  assert.equal(m.cover10.shortfallAusd, 4_000);
  assert.ok(Math.abs(m.cover10.cover! - 177_437.095975 / 4_000) < 1e-9, 'insurance over ONE direction, not over 6,000');
  assert.deepEqual(snapshot.weakestCover, { market: m.market, cover: m.cover10.cover, direction: 'fall', shortfallAusd: 4_000 });
});

test('top-five share and the weakest cover come from the per-market ladders', () => {
  // Six equal shorts and one big long on one market; the long is 70% of notional.
  const positions = [
    position(1, 'long', 7, 56_000),
    ...Array.from({ length: 6 }, (_, i) => position(10 + i, 'short', 0.5, 4_000)),
  ];
  const snapshot = buildRiskSnapshot({ positions, configs: CONFIGS, marks: MARKS, insurance: INSURANCE, indexerBlock: 1, nowMs: 0 });
  const m = snapshot.markets[0]!;
  assert.equal(m.positions, 7);
  assert.equal(m.longs, 1);
  assert.equal(m.shorts, 6);
  // top five: the long (560,000) + four shorts (4 × 40,000) over 800,000
  assert.ok(Math.abs(m.topFiveShare! - 720_000 / 800_000) < 1e-12);
  // At a 20% move every position has 8,000-per-BTC of shortfall: 7 × 16,000 − 56,000 … compute via the ladder instead of by hand.
  const twenty = atRiskPair(m.ladder, 0.2, m.openInterestAusd);
  assert.ok(twenty.fall.shortfallAusd > 0);
  assert.ok(twenty.rise.shortfallAusd > 0);
});

test('a shortfall that rounds to zero at the cent is no shortfall: no ratio, never insurance over dust', () => {
  assert.equal(hasShortfall(0), false);
  assert.equal(hasShortfall(0.000059), false, 'the MON +10% case that printed 423,268,560x');
  assert.equal(hasShortfall(0.0049), false);
  assert.equal(hasShortfall(0.005), true, 'prints as 0.01');
  assert.equal(hasShortfall(0.57), true);
  // A position just past its collateral by dust: the market gets no cover ratio.
  // 1 BTC long, 8,000 margin, entry 80,000: at -10% equity is exactly 0; nudge the margin down by dust.
  const snapshot = buildRiskSnapshot({ positions: [position(7, 'long', 1, 7_999.99999)], configs: CONFIGS, marks: MARKS, insurance: INSURANCE, indexerBlock: 1, nowMs: 0 });
  const m = snapshot.markets[0]!;
  assert.ok(m.cover10.shortfallAusd > 0 && m.cover10.shortfallAusd < 0.005);
  assert.equal(m.cover10.cover, undefined);
  assert.equal(snapshot.weakestCover, undefined);
});
