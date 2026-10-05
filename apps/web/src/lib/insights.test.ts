import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletInsights, type InsightInputs } from './insights.ts';

const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' };
const MON = { marketId: 10, symbol: 'MON', indexerName: 'MON Perp' };
const base: InsightInputs = {
  facts: { accountId: 4734, roundTrips: 5679, averageLeverage: 9.174, holdThresholdHours: 48, losingTrips: 3111, losingTripsHeldOver: 27, tripsHeldOver: 40, longTrips: 2837, shortTrips: 2842, longNetPnlAusd: -17_593.31, shortNetPnlAusd: -134_573.14 },
  baseline: { medianLeverage: 10.21, accounts: 3231, minRoundTrips: 10 },
  floor: 10,
  rescues: { count: 32, judgeableCount: 32, rescuableCount: 30 },
  bestMarket: { market: BTC, netPnlAusd: 1_200, roundTrips: 900 },
  worstMarket: { market: MON, netPnlAusd: -90_000, roundTrips: 2_000 },
  openPositions: [{ market: BTC, side: 'long', notionalAusd: 147_569 }, { market: MON, side: 'short', notionalAusd: 20_000 }, { market: MON, side: 'long', notionalAusd: undefined }],
  equityAusd: 37_600,
};

test('every rule states its numbers, and the thesis rule uses the Liquidations page test', () => {
  const r = walletInsights(base);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  const by = Object.fromEntries(r.insights.map((i) => [i.key, i]));
  assert.equal(by.rescuable!.text, 'Liquidated 30 times while holding enough free AUSD to prevent it.');
  assert.equal(by.rescuable!.tone, 'danger');
  assert.match(by.rescuable!.detail, /^30 of 32 liquidations/);
  assert.equal(by.leverage!.text, "9.2× average leverage at open, 0.9× the median trader's 10.2×.");
  assert.match(by.leverage!.detail, /3,231 accounts with 10\+ round trips/);
  assert.equal(by.hold!.text, '0.9% of losing round trips were held over 48 hours.');
  assert.match(by.hold!.detail, /27 of 3,111 losses; 40 of all 5,679/);
  assert.equal(by.markets!.text, 'Best market BTC (+1,200), worst MON (−90K).');
  assert.equal(by.direction!.text, '50.0% of round trips were long. Longs lost 17.6K, shorts lost 134.6K.');
  assert.equal(by.sizing!.text, 'Largest open position: BTC long, 147.6K notional, 3.9× equity.');
  assert.deepEqual(r.insights.map((i) => i.key), ['rescuable', 'leverage', 'hold', 'markets', 'direction', 'sizing'], 'the thesis leads');
});

test('under the round-trip floor the panel is silent, whatever else is known', () => {
  const r = walletInsights({ ...base, facts: { ...base.facts, roundTrips: 9 } });
  assert.deepEqual(r, { kind: 'silent', roundTrips: 9, floor: 10 });
});

test('a rule with nothing to say stays silent; never a made-up comparison', () => {
  const r = walletInsights({
    ...base,
    baseline: { medianLeverage: undefined, accounts: 0, minRoundTrips: 10 },
    rescues: { count: 0, judgeableCount: 0, rescuableCount: 0 },
    worstMarket: base.bestMarket,
    openPositions: [],
    equityAusd: undefined,
  });
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.insights.map((i) => i.key), ['hold', 'direction'], 'no baseline, no liquidations, one market, no open position');
});

test('liquidated but never rescuable says so; no losses and no long holds read plainly; equity unknown means no sizing', () => {
  const r = walletInsights({ ...base, rescues: { count: 3, judgeableCount: 3, rescuableCount: 0 }, equityAusd: undefined, facts: { ...base.facts, losingTripsHeldOver: 0, longNetPnlAusd: 500, shortNetPnlAusd: 0 } });
  if (r.kind !== 'ok') return assert.fail();
  const by = Object.fromEntries(r.insights.map((i) => [i.key, i]));
  assert.equal(by.rescuable!.text, 'Liquidated 3 times, never while holding enough free AUSD to prevent it.');
  assert.equal(by.rescuable!.tone, 'neutral');
  assert.equal(by.hold!.text, 'None of the 3,111 losing round trips was held over 48 hours.');
  assert.equal(by.direction!.text, '50.0% of round trips were long. Longs made 500, shorts broke even.');
  assert.equal(by.sizing, undefined);
  const once = walletInsights({ ...base, rescues: { count: 1, judgeableCount: 1, rescuableCount: 1 } });
  if (once.kind !== 'ok') return assert.fail();
  assert.equal(once.insights[0]!.text, 'Liquidated once while holding enough free AUSD to prevent it.');
});

test('a share that is not zero never prints as 0.0% (account #10: 2 of 824,883 losses held long)', () => {
  const r = walletInsights({ ...base, facts: { ...base.facts, losingTrips: 824_883, losingTripsHeldOver: 2 } });
  if (r.kind !== 'ok') return assert.fail();
  assert.equal(r.insights.find((i) => i.key === 'hold')!.text, 'Under 0.1% of losing round trips were held over 48 hours.');
});

test('"best market" is never a loss: all markets down, or all up, is said as such', () => {
  const allDown = walletInsights({ ...base, bestMarket: { market: BTC, netPnlAusd: -9, roundTrips: 10 } });
  if (allDown.kind !== 'ok') return assert.fail();
  assert.equal(allDown.insights.find((i) => i.key === 'markets')!.text, 'Lost on every market traded: least on BTC (−9), most on MON (−90K).');
  const allUp = walletInsights({ ...base, worstMarket: { market: MON, netPnlAusd: 40, roundTrips: 10 } });
  if (allUp.kind !== 'ok') return assert.fail();
  assert.equal(allUp.insights.find((i) => i.key === 'markets')!.text, 'Made money on every market traded: most on BTC (+1,200), least on MON (+40).');
});
