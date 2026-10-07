import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketRiskConfig } from '@perpguard/shared';
import { applyMarketRefresh } from './marketRefresh.ts';

const zec = (maintenanceMargin: number): MarketRiskConfig => ({ marketId: 50, symbol: 'ZEC', priceDecimals: 2, lotDecimals: 4, collateralDecimals: 6, maintenanceMargin, initialMargin: 1000 });
const btc: MarketRiskConfig = { marketId: 1, symbol: 'BTC', priceDecimals: 1, lotDecimals: 5, collateralDecimals: 6, maintenanceMargin: 2500, initialMargin: 1500 };

test('a tightened maintenance margin is applied IN PLACE and logged as a warning naming both figures', () => {
  const current = new Map([[50, zec(1800)], [1, btc]]);
  const held = current; // the loops hold this same map
  const changes = applyMarketRefresh(current, new Map([[50, zec(1500)], [1, btc]]));
  assert.equal(held.get(50)?.maintenanceMargin, 1500);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.severity, 'warn');
  assert.match(changes[0]!.line, /market 50 \(ZEC\) MAINTENANCE MARGIN CHANGED: 1800 \(5\.56%\) -> 1500 \(6\.67%\)/);
});

test('nothing changed says nothing', () => {
  assert.deepEqual(applyMarketRefresh(new Map([[1, btc]]), new Map([[1, btc]])), []);
});

test('a market dropped from the list is KEPT (still monitored) and named; a new one is added', () => {
  const current = new Map([[30, { ...btc, marketId: 30, symbol: 'SOL' }]]);
  const changes = applyMarketRefresh(current, new Map([[31, { ...btc, marketId: 31, symbol: 'SOL' }]]));
  assert.ok(current.has(30), 'kept');
  assert.ok(current.has(31), 'added');
  assert.ok(changes.some((c) => /market 30 \(SOL\) is no longer in the venue's list/.test(c.line)));
  assert.ok(changes.some((c) => /market 31 \(SOL\) is new/.test(c.line)));
});
