/**
 * Properties that must hold for every position, on every market.
 *
 * Run over a seeded generator, so a failure names a seed and a case that can be
 * replayed exactly. 2,000 cases across five markets whose maintenance margins
 * range from 4% to 10% and whose price scaling ranges from 1 to 6 decimals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afterAddMargin,
  afterReduceKeepingMargin,
  afterReduceReleasingMargin,
  positionMetrics,
} from './metrics.ts';
import {
  MARKETS,
  generateCase,
  mulberry32,
  onePriceUnitCNS,
  relativeDrift,
} from './testMarkets.ts';

const CASES = 2_000;
const SEED = 0x9e3779b9;

const eachCase = (fn: (c: ReturnType<typeof generateCase>, i: number) => void): void => {
  const rand = mulberry32(SEED);
  for (let i = 0; i < CASES; i += 1) fn(generateCase(rand), i);
};

/**
 * A long is liquidated below its entry and a short above it — strictly so for
 * any position carrying more margin than its maintenance requirement, which is
 * every position that was legally opened, since every market's initial margin
 * requirement exceeds its maintenance one.
 *
 * The boundary is real and is asserted rather than generated away: a position
 * whose margin sits exactly AT maintenance is liquidated at its entry price. It
 * has no room at all, and the engine says so.
 */
test("a long's liquidation price is below entry, a short's above", () => {
  let strict = 0;
  let atBoundary = 0;
  eachCase(({ position, config, markPricePNS }, i) => {
    const m = positionMetrics(position, markPricePNS, config);
    assert.notEqual(m.liquidationPricePNS, undefined, `case ${i}: no liquidation price`);
    const liq = m.liquidationPricePNS!;
    const entry = position.entryPricePNS;
    const where = `case ${i} (${config.symbol} ${position.side}, entry ${entry}, liq ${liq})`;

    if (position.side === 'long') {
      assert.ok(liq <= entry, `${where}: long liq should never be above entry`);
    } else {
      assert.ok(liq >= entry, `${where}: short liq should never be below entry`);
    }

    // Strict as soon as the spare margin is worth at least one price unit.
    const spare = position.depositCNS - m.maintenanceMarginCNS;
    if (spare >= onePriceUnitCNS(position.lotLNS, config) && spare > 0n) {
      strict += 1;
      if (position.side === 'long') {
        assert.ok(liq < entry, `${where}: spare margin ${spare} should put liq below entry`);
      } else {
        assert.ok(liq > entry, `${where}: spare margin ${spare} should put liq above entry`);
      }
    } else if (spare === 0n) {
      atBoundary += 1;
      assert.equal(liq, entry, `${where}: margin exactly at maintenance liquidates at entry`);
    }
  });
  assert.ok(strict > CASES / 2, `only ${strict} cases were strict, expected most of ${CASES}`);
  assert.ok(atBoundary > 0, 'expected the generator to produce the at-maintenance boundary');
});

test('adding margin always moves the liquidation price further away, never closer', () => {
  eachCase(({ position, config, markPricePNS }, i) => {
    const before = positionMetrics(position, markPricePNS, config);
    // Add a quarter of the posted margin, so the move is well clear of rounding.
    const added = position.depositCNS / 4n + 1n;
    const after = afterAddMargin(position, added, markPricePNS, config);
    const liqBefore = before.liquidationPricePNS!;
    const liqAfter = after.metrics.liquidationPricePNS!;
    const where = `case ${i} (${config.symbol} ${position.side})`;
    if (position.side === 'long') {
      assert.ok(liqAfter < liqBefore, `${where}: long liq ${liqAfter} should be below ${liqBefore}`);
    } else {
      assert.ok(liqAfter > liqBefore, `${where}: short liq ${liqAfter} should be above ${liqBefore}`);
    }
    assert.ok(
      after.metrics.liqBufferPct! > before.liqBufferPct!,
      `${where}: buffer should widen`,
    );
  });
});

test('adding zero margin changes nothing', () => {
  eachCase(({ position, config, markPricePNS }, i) => {
    const before = positionMetrics(position, markPricePNS, config);
    const after = afterAddMargin(position, 0n, markPricePNS, config);
    assert.equal(after.metrics.liquidationPricePNS, before.liquidationPricePNS, `case ${i}`);
  });
});

/**
 * THE property behind the two differently-named reduce functions: releasing
 * margin in proportion leaves the liquidation price exactly where it was.
 *
 * Size, margin, funding and the maintenance requirement all scale by the same
 * factor, so it cancels. Reducing this way buys no room whatsoever. Only adding
 * margin, or reducing while keeping it posted, moves the price away.
 *
 * Algebraically the drift is zero. In integers an odd lot count has no exact
 * half, so the reduced position ends up at most ONE LOT UNIT smaller than the
 * arithmetic says, and its liquidation price moves with it.
 *
 * That gives the bound asserted here: the movement is a relative size error of
 * at most 1/lot, so `drift * lot` is a small constant regardless of market,
 * scaling or position size. Measured across these 2,000 cases the worst is
 * 4.07, on markets from 1 to 6 price decimals; the assertion allows 8. A real
 * bug that moved the price would not scale with 1/lot and would blow through it.
 *
 * The exact case after this one proves the property outright, with no bound at
 * all, on a position that halves cleanly.
 */
test('reducing and releasing margin leaves the liquidation price where it was', () => {
  eachCase(({ position, config, markPricePNS }, i) => {
    const before = positionMetrics(position, markPricePNS, config);
    const after = afterReduceReleasingMargin(position, 0.5, markPricePNS, config);
    if (after.position.lotLNS === 0n) return; // nothing left to have a price
    const liqBefore = before.liquidationPricePNS!;
    const liqAfter = after.metrics.liquidationPricePNS!;
    const drift = relativeDrift(liqAfter, liqBefore);
    const scaled = drift * Number(after.position.lotLNS);
    assert.ok(
      scaled < 8,
      `case ${i} (${config.symbol} ${position.side}): liq moved from ${liqBefore} to ${liqAfter}, ` +
        `relative drift ${drift} on lot ${after.position.lotLNS} = ${scaled.toFixed(3)} lot-units`,
    );
  });
});

test('releasing margin leaves the liquidation price EXACTLY unchanged when the halving is exact', () => {
  // Every quantity divides by two without remainder, so truncation cannot hide
  // a real movement.
  const config = MARKETS[0]!; // BTC: 1 price decimal, 5 lot decimals
  const position = {
    marketId: config.marketId,
    symbol: config.symbol,
    side: 'long' as const,
    lotLNS: 50_000n,
    entryPricePNS: 840_295n,
    depositCNS: 2_810_330_000n,
    fundingCNS: 0n,
  };
  const markPNS = 840_073n;
  const before = positionMetrics(position, markPNS, config);
  const after = afterReduceReleasingMargin(position, 0.5, markPNS, config);
  assert.equal(after.position.lotLNS, 25_000n);
  assert.equal(after.position.depositCNS, 1_405_165_000n);
  assert.equal(
    after.metrics.liquidationPricePNS,
    before.liquidationPricePNS,
    'halving the position must not move its liquidation price at all',
  );
  // And it does return the margin: this is the difference from keeping it.
  assert.equal(after.marginReleasedCNS, 1_405_165_000n);
  const kept = afterReduceKeepingMargin(position, 0.5, markPNS, config);
  assert.equal(kept.marginReleasedCNS, 0n);
  assert.ok(
    kept.metrics.liquidationPricePNS! < before.liquidationPricePNS!,
    'keeping the margin posted must move a long liquidation price down',
  );
});

test('reducing while keeping margin never moves the liquidation price closer', () => {
  eachCase(({ position, config, markPricePNS }, i) => {
    const before = positionMetrics(position, markPricePNS, config);
    const after = afterReduceKeepingMargin(position, 0.5, markPricePNS, config);
    if (after.position.lotLNS === 0n) return;
    const liqBefore = before.liquidationPricePNS!;
    const liqAfter = after.metrics.liquidationPricePNS!;
    const where = `case ${i} (${config.symbol} ${position.side})`;
    if (position.side === 'long') {
      assert.ok(liqAfter <= liqBefore, `${where}: long liq ${liqAfter} should not exceed ${liqBefore}`);
    } else {
      assert.ok(liqAfter >= liqBefore, `${where}: short liq ${liqAfter} should not fall below ${liqBefore}`);
    }
  });
});

test('reducing by any fraction never moves the liquidation price closer, either way', () => {
  const rand = mulberry32(SEED ^ 0x5bf03635);
  for (let i = 0; i < CASES; i += 1) {
    const { position, config, markPricePNS } = generateCase(rand);
    const fraction = rand();
    const before = positionMetrics(position, markPricePNS, config);
    for (const [name, projection] of [
      ['releasing', afterReduceReleasingMargin(position, fraction, markPricePNS, config)],
      ['keeping', afterReduceKeepingMargin(position, fraction, markPricePNS, config)],
    ] as const) {
      if (projection.position.lotLNS === 0n) continue;
      const liqBefore = before.liquidationPricePNS!;
      const liqAfter = projection.metrics.liquidationPricePNS!;
      const where = `case ${i} ${name} f=${fraction.toFixed(4)} (${config.symbol} ${position.side})`;
      // One price unit of slack for integer truncation.
      if (position.side === 'long') {
        assert.ok(liqAfter <= liqBefore + 1n, `${where}: ${liqAfter} > ${liqBefore}`);
      } else {
        assert.ok(liqAfter >= liqBefore - 1n, `${where}: ${liqAfter} < ${liqBefore}`);
      }
    }
  }
});

test('marginToSurvive is zero exactly when the position is not liquidatable', () => {
  eachCase(({ position, config, markPricePNS }, i) => {
    const m = positionMetrics(position, markPricePNS, config);
    assert.equal(m.isLiquidatable, m.marginToSurviveCNS > 0n, `case ${i}`);
  });
});

test('equity at the liquidation price equals the maintenance margin', () => {
  eachCase(({ position, config }, i) => {
    const liq = positionMetrics(position, position.entryPricePNS, config).liquidationPricePNS!;
    const atLiq = positionMetrics(position, liq, config);
    // Integer truncation in the liquidation price is worth at most one price
    // unit of notional, which is what this tolerance is.
    const slack = (position.lotLNS * 10n ** BigInt(config.collateralDecimals)) /
      10n ** BigInt(config.priceDecimals + config.lotDecimals) + 1n;
    const gap = atLiq.equityCNS - atLiq.maintenanceMarginCNS;
    const magnitude = gap < 0n ? -gap : gap;
    assert.ok(magnitude <= slack, `case ${i}: equity - mmr was ${gap}, slack ${slack}`);
  });
});
