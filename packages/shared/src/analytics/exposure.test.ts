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
import { LADDER_MOVES, adverseAt, buildRiskSnapshot, rungIndex } from './exposure.ts';
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
  assert.equal(snapshot.totals.longNotionalAusd, 80_000);

  const at = (move: number) => snapshot.ladder[rungIndex(move)]!;
  assert.equal(at(-0.05).positions, 0, 'a 5% fall liquidates neither');
  assert.equal(at(0.05).positions, 0);
  assert.equal(at(-0.1).positions, 1, 'a 10% fall takes the long');
  assert.equal(at(-0.1).notionalAusd, 80_000);
  assert.equal(at(0.1).positions, 1, 'a 10% rise takes the short');
  assert.equal(at(0).positions, 0, 'nothing is past liquidation now');

  // The tile at 10% is BOTH adverse directions, read off the same ladder.
  const tile = snapshot.atRisk['0.100']!;
  assert.equal(tile.positions, 2);
  assert.equal(tile.notionalAusd, 160_000);
  assert.equal(tile.shareOfNotional, 1);
  assert.deepEqual(tile, adverseAt(snapshot.ladder, 0.1, snapshot.totals.notionalAusd, snapshot.insurance.totalAusd));
  assert.equal(snapshot.atRisk['0.050']!.positions, 0);

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
  assert.equal(snapshot.atRisk['0.100']!.insuranceCover, undefined, 'no shortfall means nothing to cover, not infinite cover');
  const twenty = adverseAt(snapshot.ladder, 0.2, snapshot.totals.notionalAusd, snapshot.insurance.totalAusd);
  assert.equal(twenty.shortfallAusd, 8_000);
  assert.ok(Math.abs(twenty.insuranceCover! - 177_437.095975 / 8_000) < 1e-9);
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
  const twenty = adverseAt(m.ladder, 0.2, m.notionalAusd, m.insuranceAusd);
  assert.ok(twenty.shortfallAusd > 0);
  assert.ok(twenty.insuranceCover! > 0);
});
