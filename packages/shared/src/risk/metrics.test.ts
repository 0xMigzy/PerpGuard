/**
 * The rescue-button maths, and the edges where a naive implementation breaks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afterAddMargin,
  afterReduceKeepingMargin,
  afterReduceReleasingMargin,
  marginToReachBuffer,
  positionMetrics,
} from './metrics.ts';
import { marginToSurviveCNS } from './liquidation.ts';
import { toIsolated } from './metrics.ts';
import { scaleOf, type RiskPosition } from './position.ts';
import { MARKETS, marketById } from './testMarkets.ts';

const BTC = marketById(1);
const base: RiskPosition = {
  marketId: 1,
  symbol: 'BTC',
  side: 'long',
  lotLNS: 50_000n, // 0.5 BTC
  entryPricePNS: 840_295n, // 84029.5
  depositCNS: 2_810_330_000n, // 2810.33 AUSD
  fundingCNS: 0n,
};
const MARK = 840_073n;

test('marginToReachBuffer at zero buffer is exactly marginToSurvive', () => {
  // A position under water enough to need rescuing.
  const stressed = { ...base, depositCNS: 1_700_000_000n };
  const mark = 820_000n;
  assert.equal(
    marginToReachBuffer(stressed, mark, 0, BTC),
    marginToSurviveCNS(toIsolated(stressed, BTC), mark, scaleOf(BTC)),
  );
});

test('a wider target buffer always costs more margin', () => {
  const stressed = { ...base, depositCNS: 1_700_000_000n };
  const mark = 820_000n;
  const amounts = [0, 0.01, 0.02, 0.05, 0.1].map((b) =>
    marginToReachBuffer(stressed, mark, b, BTC),
  );
  for (let i = 1; i < amounts.length; i += 1) {
    assert.ok(amounts[i]! > amounts[i - 1]!, `buffer ${i} should cost more than ${i - 1}`);
  }
});

test('adding exactly marginToReachBuffer lands on that buffer', () => {
  const stressed = { ...base, depositCNS: 1_700_000_000n };
  const mark = 820_000n;
  const target = 0.05;
  const needed = marginToReachBuffer(stressed, mark, target, BTC);
  const after = afterAddMargin(stressed, needed, mark, BTC);
  // Within a hundredth of a percentage point, which is the integer granularity
  // of a price at one decimal place on a half-BTC position.
  assert.ok(
    Math.abs(after.metrics.liqBufferPct! - target) < 1e-4,
    `buffer landed at ${after.metrics.liqBufferPct}, wanted ${target}`,
  );
});

test('a healthy position needs nothing to reach a buffer it already has', () => {
  const m = positionMetrics(base, MARK, BTC);
  assert.ok(m.liqBufferPct! > 0.02);
  assert.equal(marginToReachBuffer(base, MARK, 0.02, BTC), 0n);
});

test('reducing realises PnL and releases margin; keeping it releases nothing', () => {
  const released = afterReduceReleasingMargin(base, 0.5, MARK, BTC);
  const kept = afterReduceKeepingMargin(base, 0.5, MARK, BTC);
  // Both realise the same loss on the half that closed.
  assert.equal(released.realisedPnlCNS, kept.realisedPnlCNS);
  assert.equal(released.realisedPnlCNS, -5_550_000n); // half of -11.10 AUSD
  assert.equal(released.marginReleasedCNS, 1_405_165_000n);
  assert.equal(kept.marginReleasedCNS, 0n);
  assert.equal(kept.position.depositCNS, base.depositCNS);
});

test('reducing to nothing leaves a position with no liquidation price', () => {
  const gone = afterReduceReleasingMargin(base, 1, MARK, BTC);
  assert.equal(gone.position.lotLNS, 0n);
  assert.equal(gone.metrics.liquidationPricePNS, undefined);
  assert.equal(gone.metrics.liqBufferPct, undefined);
  assert.equal(gone.metrics.marginToSurviveCNS, 0n);
  assert.equal(gone.metrics.isLiquidatable, false);
});

test('a fraction outside 0..1 is rejected rather than producing nonsense', () => {
  for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => afterReduceReleasingMargin(base, bad, MARK, BTC), RangeError);
    assert.throws(() => afterReduceKeepingMargin(base, bad, MARK, BTC), RangeError);
  }
  assert.throws(() => afterAddMargin(base, -1n, MARK, BTC), RangeError);
});

// ── edges ────────────────────────────────────────────────────────────────────

test('edge: zero margin liquidates at once, and above entry for a long', () => {
  const broke: RiskPosition = { ...base, depositCNS: 0n };
  const m = positionMetrics(broke, MARK, BTC);
  assert.equal(m.isLiquidatable, true);
  assert.ok(m.marginToSurviveCNS > 0n);
  assert.equal(m.pnlPctOfMargin, undefined, 'no margin means no ratio, not a division by zero');
  // With no collateral the position is past saving: its liquidation price sits
  // ABOVE entry, i.e. on the wrong side, which is the engine saying so plainly.
  assert.ok(m.liquidationPricePNS! > broke.entryPricePNS);
  assert.ok(m.liqBufferPct! < 0, 'a doomed position reports a negative buffer, not absolute room');
});

test('edge: margin below maintenance is already liquidatable', () => {
  const m0 = positionMetrics(base, MARK, BTC);
  const thin: RiskPosition = { ...base, depositCNS: m0.maintenanceMarginCNS - 1n };
  const m = positionMetrics(thin, MARK, BTC);
  assert.equal(m.isLiquidatable, true);
  assert.ok(m.marginToSurviveCNS > 0n);
});

test('edge: margin exactly at maintenance is NOT yet liquidatable', () => {
  // The venue liquidates when equity falls BELOW maintenance, so the threshold
  // itself still stands. Off by one here is a false alarm on every position.
  const m0 = positionMetrics(base, base.entryPricePNS, BTC);
  const atEdge: RiskPosition = { ...base, depositCNS: m0.maintenanceMarginCNS };
  const m = positionMetrics(atEdge, base.entryPricePNS, BTC);
  assert.equal(m.equityCNS, m.maintenanceMarginCNS);
  assert.equal(m.isLiquidatable, false);
  assert.equal(m.marginToSurviveCNS, 0n);
});

test('edge: mark exactly at the liquidation price is the threshold, not past it', () => {
  const liq = positionMetrics(base, MARK, BTC).liquidationPricePNS!;
  const m = positionMetrics(base, liq, BTC);
  assert.equal(m.liqBufferPct, 0);
  assert.equal(m.isLiquidatable, false);
  assert.equal(m.marginToSurviveCNS, 0n);
  // One price unit worse and it is gone.
  const past = positionMetrics(base, liq - 1n, BTC);
  assert.equal(past.isLiquidatable, true);
  assert.ok(past.liqBufferPct! < 0);
});

test('edge: a zero-size position has no metrics to speak of and does not divide by zero', () => {
  const empty: RiskPosition = { ...base, lotLNS: 0n, depositCNS: 0n };
  const m = positionMetrics(empty, MARK, BTC);
  assert.equal(m.notionalCNS, 0n);
  assert.equal(m.maintenanceMarginCNS, 0n);
  assert.equal(m.liquidationPricePNS, undefined);
  assert.equal(m.liqBufferPct, undefined);
  assert.equal(m.pnlPctOfMargin, undefined);
  assert.equal(m.isLiquidatable, false);
  assert.equal(marginToReachBuffer(empty, MARK, 0.05, BTC), 0n);
});

test('a short mirrors a long exactly', () => {
  const short: RiskPosition = { ...base, side: 'short' };
  const longM = positionMetrics(base, MARK, BTC);
  const shortM = positionMetrics(short, MARK, BTC);
  assert.equal(shortM.unrealisedPnlCNS, -longM.unrealisedPnlCNS);
  assert.equal(shortM.maintenanceMarginCNS, longM.maintenanceMarginCNS);
  assert.equal(
    shortM.liquidationPricePNS! - base.entryPricePNS,
    base.entryPricePNS - longM.liquidationPricePNS!,
  );
});

test('the maintenance ratio is read from each market, never assumed to be BTC 0.04', () => {
  const ratios = MARKETS.map((m) => positionMetrics(
    { ...base, marketId: m.marketId, symbol: m.symbol },
    base.entryPricePNS,
    m,
  ).maintenanceMarginRatio);
  assert.deepEqual(ratios, [0.04, 0.05, 0.05, 100 / 1800, 0.1]);
  assert.equal(new Set(ratios).size, 4, 'these markets must not all share one ratio');
});
