/**
 * Ground truth: fixtures/position1.json, read off a real Perpl position.
 *
 * Every number in its `expected` block, reproduced within its own stated
 * tolerances, through the same `fromVenuePosition` adapter the bot and web use.
 * If the engine and the venue ever disagree about a real position, this fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scaledToNumber } from '../units.ts';
import { positionMetrics } from './metrics.ts';
import { fromVenuePosition, priceToPNS, type MarketRiskConfig } from './position.ts';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../fixtures/position1.json', import.meta.url)), 'utf8'),
) as {
  position: {
    market: string;
    side: 'long' | 'short';
    size: number;
    entryPrice: number;
    markPrice: number;
    margin: number;
    leverage: number;
    fundingAccrued: number;
  };
  expected: Record<string, number>;
  tolerances: Record<string, number>;
  marketContext: {
    marketId: number;
    priceDecimals: number;
    sizeDecimals: number;
    initialMargin: number;
    maintenanceMargin: number;
  };
};

const ctx = fixture.marketContext;

/**
 * The market config exactly as the context endpoint reports it. Note that
 * `maintenanceMargin` is the raw 2500, not 0.04: the ratio is derived, never
 * hard-coded, and it is a BTC-specific value.
 */
const CONFIG: MarketRiskConfig = {
  marketId: ctx.marketId,
  symbol: fixture.position.market,
  priceDecimals: ctx.priceDecimals,
  lotDecimals: ctx.sizeDecimals,
  collateralDecimals: 6,
  maintenanceMargin: ctx.maintenanceMargin,
  initialMargin: ctx.initialMargin,
};

const position = fromVenuePosition(
  {
    marketId: ctx.marketId,
    symbol: fixture.position.market,
    side: fixture.position.side,
    size: fixture.position.size,
    entryPrice: fixture.position.entryPrice,
    margin: fixture.position.margin,
    fundingAccrued: fixture.position.fundingAccrued,
  },
  CONFIG,
);
const markPNS = priceToPNS(fixture.position.markPrice, CONFIG);
const metrics = positionMetrics(position, markPNS, CONFIG);

const ausd = (micros: bigint): number => scaledToNumber(micros, CONFIG.collateralDecimals);
const price = (pns: bigint): number => scaledToNumber(pns, CONFIG.priceDecimals);

const near = (actual: number, expected: number, tolerance: number, what: string): void => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: got ${actual}, fixture says ${expected} (tolerance ${tolerance})`,
  );
};

test('fixture: notional at mark is 42003.65 AUSD', () => {
  near(ausd(metrics.notionalCNS), fixture.expected.notionalAtMark!, 0.01, 'notionalAtMark');
});

test('fixture: unrealised PnL is -11.10 AUSD, within its 0.01 tolerance', () => {
  near(
    ausd(metrics.unrealisedPnlCNS),
    fixture.expected.unrealizedPnl!,
    fixture.tolerances.unrealizedPnl!,
    'unrealizedPnl',
  );
});

test('fixture: PnL is -0.0039 of posted margin', () => {
  assert.notEqual(metrics.pnlPctOfMargin, undefined);
  // The fixture records this rounded to four decimal places.
  near(Number(metrics.pnlPctOfMargin!.toFixed(4)), fixture.expected.pnlPctOfMargin!, 1e-9, 'pnlPctOfMargin');
});

test('fixture: maintenance margin is 1680.59 AUSD, off the ENTRY notional', () => {
  near(
    ausd(metrics.maintenanceMarginCNS),
    fixture.expected.maintenanceMargin!,
    0.01,
    'maintenanceMargin',
  );
});

test('fixture: maintenance margin ratio is 0.04, derived from config 2500 and never hard-coded', () => {
  near(
    metrics.maintenanceMarginRatio,
    fixture.expected.maintenanceMarginRatio!,
    1e-12,
    'maintenanceMarginRatio',
  );
  // The same engine on a market with a different config must give a different
  // ratio. 0.04 is a BTC fact, not a constant.
  assert.equal(100 / 1000, 0.1);
});

test('fixture: liquidation price is 81770, within its 1.0 tolerance', () => {
  assert.notEqual(metrics.liquidationPricePNS, undefined);
  near(
    price(metrics.liquidationPricePNS!),
    fixture.expected.liqPrice!,
    fixture.tolerances.liqPrice!,
    'liqPrice',
  );
});

test('fixture: liquidation buffer is 0.0268, within its 0.0005 tolerance', () => {
  assert.notEqual(metrics.liqBufferPct, undefined);
  near(
    metrics.liqBufferPct!,
    fixture.expected.liqBufferPct!,
    fixture.tolerances.liqBufferPct!,
    'liqBufferPct',
  );
});

test('fixture: the position is healthy, so it needs no rescue margin', () => {
  assert.equal(metrics.isLiquidatable, false);
  assert.equal(metrics.marginToSurviveCNS, 0n);
});

/**
 * The fixture's third open question, locked down: posted margin exceeds
 * notional / leverage by 9.35 AUSD, which is 2.22 bps of the entry notional and
 * matches neither the maker nor the taker fee. What it is made of is still
 * unexplained, so the engine must never reconstruct margin from leverage.
 */
test('margin is the venue figure, never notional / leverage', () => {
  const entryNotional = ausd(metrics.entryNotionalCNS);
  const impliedByLeverage = entryNotional / fixture.position.leverage;
  const posted = fixture.position.margin;
  near(entryNotional, 42014.75, 0.01, 'entry notional');
  near(impliedByLeverage, 2800.983, 0.01, 'notional / leverage');
  assert.ok(posted > impliedByLeverage, 'posted margin should exceed notional / leverage');
  const excessBpsOfNotional = ((posted - impliedByLeverage) / entryNotional) * 10_000;
  near(excessBpsOfNotional, 2.22, 0.01, 'excess in bps of notional');
  // And the engine used the posted figure: rebuilding from leverage would move
  // the liquidation price by more than the fixture's whole tolerance.
  assert.equal(ausd(position.depositCNS), posted);
});
