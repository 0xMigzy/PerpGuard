import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  liquidationPricePNS,
  maintenanceMarginCNS,
  marginToSurviveCNS,
  notionalCNS,
  unrealizedPnlCNS,
  type IsolatedPosition,
  type MarketScale,
} from './liquidation.ts';

/**
 * Ground truth: fixtures/position1.json, a real BTC position read off the Perpl
 * app, plus the BTC market's on-chain scaling and margin fractions:
 *   getPerpetualInfoV2(1)  -> priceDecimals 1, lotDecimals 5
 *   getMarginFractions(1,0) -> init 1500, maint 2500
 * Collateral is AUSD at 6 decimals.
 */
const BTC: MarketScale = { priceDecimals: 1, lotDecimals: 5, collateralDecimals: 6 };

// size 0.5 BTC, entry 84029.5, margin 2810.33 AUSD, mark 84007.3
const FIXTURE: IsolatedPosition = {
  side: 'long',
  lotLNS: 50_000n, // 0.5 at 5 decimals
  entryPricePNS: 840_295n, // 84029.5 at 1 decimal
  depositCNS: 2_810_330_000n, // 2810.33 AUSD at 6 decimals
  fundingCNS: 0n,
  maintMarginFracHdths: 2500n,
};
const FIXTURE_MARK = 840_073n; // 84007.3

test('notional matches the fixture: 0.5 BTC at mark 84007.3 = 42003.65 AUSD', () => {
  assert.equal(notionalCNS(FIXTURE_MARK, FIXTURE.lotLNS, BTC), 42_003_650_000n);
});

test('notional handles a market with different decimals (MON: 6 price, 0 lot)', () => {
  const mon: MarketScale = { priceDecimals: 6, lotDecimals: 0, collateralDecimals: 6 };
  // 495038 MON at 0.02774 = 13732.354120 AUSD
  assert.equal(notionalCNS(27_740n, 495_038n, mon), 13_732_354_120n);
});

test('unrealized PnL matches the fixture: -11.10 AUSD', () => {
  const pnl = unrealizedPnlCNS('long', FIXTURE.lotLNS, FIXTURE.entryPricePNS, FIXTURE_MARK, BTC);
  assert.equal(pnl, -11_100_000n);
});

test('a short makes money when the price falls', () => {
  const pnl = unrealizedPnlCNS('short', FIXTURE.lotLNS, FIXTURE.entryPricePNS, FIXTURE_MARK, BTC);
  assert.equal(pnl, 11_100_000n);
});

test('maintenance margin matches the fixture: 1680.59 AUSD at mmr 0.04', () => {
  const mmr = maintenanceMarginCNS(FIXTURE.entryPricePNS, FIXTURE.lotLNS, 2500n, BTC);
  assert.equal(mmr, 1_680_590_000n);
});

test('liquidation price matches the fixture: 81770, within its 1.0 tolerance', () => {
  const liq = liquidationPricePNS(FIXTURE, BTC);
  assert.ok(liq !== undefined);
  // 817700 = 81770.0 at 1 decimal; the fixture allows +/- 1.0 price unit.
  assert.ok(liq >= 817_690n && liq <= 817_710n, `liqPrice was ${liq}`);
});

test('a short of the same position liquidates above entry, symmetrically', () => {
  const short: IsolatedPosition = { ...FIXTURE, side: 'short' };
  const liq = liquidationPricePNS(short, BTC);
  const long = liquidationPricePNS(FIXTURE, BTC);
  assert.ok(liq !== undefined && long !== undefined);
  assert.equal(liq - FIXTURE.entryPricePNS, FIXTURE.entryPricePNS - long);
});

test('a zero-lot position has no liquidation price', () => {
  assert.equal(liquidationPricePNS({ ...FIXTURE, lotLNS: 0n }, BTC), undefined);
});

test('a healthy position needs no extra margin', () => {
  assert.equal(marginToSurviveCNS(FIXTURE, FIXTURE_MARK, BTC), 0n);
});

test('at its own liquidation price a position needs nothing yet: it is exactly at maintenance', () => {
  const liq = liquidationPricePNS(FIXTURE, BTC);
  assert.ok(liq !== undefined);
  assert.equal(marginToSurviveCNS(FIXTURE, liq, BTC), 0n);
});

/**
 * X = s * L * (P_Liq - P_Mark) falls out of the two formulas algebraically, so
 * the top-up is the overshoot past the liquidation price times the size. It
 * holds only up to the rounding of P_Liq itself, which is an integer number of
 * price units, so the tolerance below is one price unit's worth of notional --
 * 0.1 USD on 0.5 BTC, i.e. 0.05 AUSD.
 */
const onePriceUnitCNS = (lotLNS: bigint) => notionalCNS(1n, lotLNS, BTC);

test('past the liquidation price, the top-up needed is lot x the overshoot', () => {
  const liq = liquidationPricePNS(FIXTURE, BTC);
  assert.ok(liq !== undefined);
  const overshootPNS = 100n; // 10.0 USD below the liquidation price
  const needed = marginToSurviveCNS(FIXTURE, liq - overshootPNS, BTC);
  const expected = notionalCNS(overshootPNS, FIXTURE.lotLNS, BTC);
  assert.equal(expected, 5_000_000n); // 5 AUSD on 0.5 BTC
  const drift = needed > expected ? needed - expected : expected - needed;
  assert.ok(drift <= onePriceUnitCNS(FIXTURE.lotLNS), `needed ${needed}, expected ~${expected}`);
});

test('the top-up scales with the gap, for a short too', () => {
  const short: IsolatedPosition = { ...FIXTURE, side: 'short' };
  const liq = liquidationPricePNS(short, BTC);
  assert.ok(liq !== undefined);
  const needed = marginToSurviveCNS(short, liq + 1_000n, BTC);
  const expected = notionalCNS(1_000n, short.lotLNS, BTC);
  const drift = needed > expected ? needed - expected : expected - needed;
  assert.ok(drift <= onePriceUnitCNS(short.lotLNS), `needed ${needed}, expected ~${expected}`);
});

test('a real mainnet liquidation: MON short, the margin that would have saved it', () => {
  // From PositionLiquidated in block 108,545,897 (tx 0x7888ebe7...):
  // perpId 10 (MON), positionType 1 (SHORT), 495038 lots, mark 27740.
  // getMarginFractions(10, 0) -> maint 2000 hundredths, so mmr = 0.05.
  const mon: MarketScale = { priceDecimals: 6, lotDecimals: 0, collateralDecimals: 6 };
  const position: IsolatedPosition = {
    side: 'short',
    lotLNS: 495_038n,
    entryPricePNS: 25_000n, // the short was opened well below the liquidating mark
    depositCNS: 700_000_000n, // 700 AUSD posted
    fundingCNS: 0n,
    maintMarginFracHdths: 2000n,
  };
  const mmr = maintenanceMarginCNS(25_000n, 495_038n, 2000n, mon);
  const uPnl = unrealizedPnlCNS('short', 495_038n, 25_000n, 27_740n, mon);
  assert.equal(mmr, 618_797_500n); // 618.7975 AUSD
  assert.equal(uPnl, -1_356_404_120n); // 1356.40 AUSD under water
  // Needed = mmr - uPnl - deposit
  assert.equal(marginToSurviveCNS(position, 27_740n, mon), 1_275_201_620n);
});

test('rejects a nonsense maintenance fraction rather than dividing by zero', () => {
  assert.throws(() => maintenanceMarginCNS(840_295n, 50_000n, 0n, BTC), RangeError);
});

test('rejects nonsense decimals', () => {
  assert.throws(
    () => notionalCNS(1n, 1n, { priceDecimals: -1, lotDecimals: 0, collateralDecimals: 6 }),
    RangeError,
  );
});
