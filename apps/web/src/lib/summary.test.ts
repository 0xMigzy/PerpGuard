import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MarketExposure, RiskSnapshot } from '@perpguard/shared';
import { activitySentence, riskSentence } from './summary.ts';

test('the activity sentence: window, volume with its change, traders, net flow', () => {
  assert.equal(
    activitySentence({ timeframe: '30d', sinceLabel: undefined, volumeAusd: 1_425_819_885, volumeChange: -0.38, traders: 1_069, netFlowAusd: -167_979 }),
    '30-day volume $1.43B (−38%), 1,069 traders, $168K net outflow.',
  );
  assert.equal(
    activitySentence({ timeframe: 'all', sinceLabel: 'Feb 11, 2026', volumeAusd: 9_100_000_000, volumeChange: undefined, traders: 5_409, netFlowAusd: 4_017_092 }),
    'Since Feb 11, 2026, volume $9.1B, 5,409 traders, $4.02M net inflow.',
  );
  assert.match(activitySentence({ timeframe: '24h', sinceLabel: undefined, volumeAusd: 1, volumeChange: 0.1, traders: 1, netFlowAusd: 0 }), /^24-hour volume \$1\.00 \(\+10%\), 1 trader, no net flow\.$/);
});

const fall = (notionalAusd: number, shortfallAusd: number, positions = 3) => ({ move: -0.1, side: 'long' as const, positions, notionalAusd, shortfallAusd, shortfallPositions: shortfallAusd > 0 ? 1 : 0, shareOfOpenInterest: 0.1 });
const rise = { move: 0.1, side: 'short' as const, positions: 9, notionalAusd: 999_999, shortfallAusd: 999_999, shortfallPositions: 9, shareOfOpenInterest: 0.5 };
const pair = (f: ReturnType<typeof fall>) => ({ size: 0.1, fall: f, rise, worse: rise });
const market = (symbol: string, f: ReturnType<typeof fall>, insuranceAusd: number | undefined) =>
  ({ market: { marketId: symbol.length, symbol, indexerName: symbol }, insuranceAusd, atRisk: { '0.100': pair(f) } }) as unknown as MarketExposure;
const snap = (total: ReturnType<typeof fall>, markets: MarketExposure[]): Pick<RiskSnapshot, 'atRisk' | 'markets'> => ({ atRisk: { '0.100': pair(total) }, markets });

test('a fall closes LONGS only: the rise is never added in', () => {
  const s = riskSentence(snap(fall(334_000, 0), [market('BTC', fall(334_000, 0), 1_000)]))!;
  assert.equal(s, 'A 10% fall would liquidate $334K of longs; none would lose more than its own collateral.');
  assert.doesNotMatch(s, /999/);
});

test('"fully covered" only when EVERY market\'s own fund covers its own losses beyond collateral', () => {
  const covered = snap(fall(334_000, 900), [market('BTC', fall(300_000, 800), 50_000), market('ETH', fall(34_000, 100), 200)]);
  assert.equal(riskSentence(covered), "A 10% fall would liquidate $334K of longs, fully covered by each market's own insurance fund.");
  // Pooled, 50,200 would cover 900 twice over; per market, ETH's 50 does not cover its 100.
  const notCovered = snap(fall(334_000, 900), [market('BTC', fall(300_000, 800), 50_000), market('ETH', fall(34_000, 100), 50)]);
  assert.equal(riskSentence(notCovered), 'A 10% fall would liquidate $334K of longs; on ETH the losses beyond collateral ($100.00) exceed its insurance fund ($50.00).');
});

test('a market with losses beyond collateral and no insurance reading is said, not assumed covered', () => {
  const s = snap(fall(10_000, 5), [market('MON', fall(10_000, 5), undefined)]);
  assert.equal(riskSentence(s), 'A 10% fall would liquidate $10K of longs; 1 market with losses beyond collateral has no insurance reading.');
});

test('no longs at risk, or no rung yet', () => {
  assert.equal(riskSentence(snap(fall(0, 0, 0), [])), 'A 10% fall would liquidate no longs.');
  assert.equal(riskSentence({ atRisk: {}, markets: [] }), undefined);
});
