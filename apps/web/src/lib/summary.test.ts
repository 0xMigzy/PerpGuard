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

const dir = (move: number, notionalAusd: number, shortfallAusd: number, positions = 3) => ({
  move,
  side: move < 0 ? ('long' as const) : ('short' as const),
  positions,
  notionalAusd,
  shortfallAusd,
  shortfallPositions: shortfallAusd > 0 ? 1 : 0,
  shareOfOpenInterest: 0.1,
});
type Dir = ReturnType<typeof dir>;
const fall = (n: number, sf: number, p = 3) => dir(-0.1, n, sf, p);
const rise = (n: number, sf: number, p = 3) => dir(0.1, n, sf, p);
const NO_RISE = rise(0, 0, 0);
const pair = (f: Dir, r: Dir) => ({ size: 0.1, fall: f, rise: r, worse: r.shortfallAusd > f.shortfallAusd ? r : f });
const market = (symbol: string, f: Dir, insuranceAusd: number | undefined, r: Dir = NO_RISE) =>
  ({ market: { marketId: symbol.length, symbol, indexerName: symbol }, insuranceAusd, atRisk: { '0.100': pair(f, r) } }) as unknown as MarketExposure;
const snap = (f: Dir, markets: MarketExposure[], r: Dir = NO_RISE): Pick<RiskSnapshot, 'atRisk' | 'markets'> => ({ atRisk: { '0.100': pair(f, r) }, markets });

test('BOTH directions, the larger first: a rise that closes more shorts than a fall closes longs leads (owner, 9 Oct)', () => {
  const s = riskSentence(snap(fall(196_000, 0), [market('BTC', fall(196_000, 0), 1_000, rise(212_900, 0))], rise(212_900, 0)))!;
  assert.equal(
    s,
    'A 10% rise would liquidate $212.9K of shorts; none would lose more than its own collateral. ' +
      'A 10% fall would liquidate $196K of longs; none would lose more than its own collateral.',
  );
  // The other way round, the fall leads.
  const f = riskSentence(snap(fall(300_000, 0), [], rise(100_000, 0)))!;
  assert.match(f, /^A 10% fall would liquidate \$300K of longs.* A 10% rise would liquidate \$100K of shorts/);
});

test('the two directions are never added: no figure is their sum', () => {
  const s = riskSentence(snap(fall(165_000, 0), [], rise(90_000, 0)))!;
  assert.doesNotMatch(s, /255/);
});

test('each direction carries its OWN insurance verdict, from its own losses', () => {
  // A fall puts BTC's longs 800 past collateral (fund 50,000: covered); a rise puts ETH's shorts 100 past (fund 50: not).
  const s = riskSentence(
    snap(fall(334_000, 800), [market('BTC', fall(334_000, 800), 50_000), market('ETH', fall(0, 0, 0), 50, rise(40_000, 100))], rise(40_000, 100)),
  )!;
  assert.equal(
    s,
    "A 10% fall would liquidate $334K of longs, fully covered by each market's own insurance fund. " +
      'A 10% rise would liquidate $40K of shorts; on ETH the losses beyond collateral ($100.00) exceed its insurance fund ($50.00).',
  );
});

test('"fully covered" only when EVERY market\'s own fund covers its own losses beyond collateral', () => {
  const covered = snap(fall(334_000, 900), [market('BTC', fall(300_000, 800), 50_000), market('ETH', fall(34_000, 100), 200)]);
  assert.equal(riskSentence(covered), "A 10% fall would liquidate $334K of longs, fully covered by each market's own insurance fund. A 10% rise would liquidate no shorts.");
  // Pooled, 50,200 would cover 900 twice over; per market, ETH's 50 does not cover its 100.
  const notCovered = snap(fall(334_000, 900), [market('BTC', fall(300_000, 800), 50_000), market('ETH', fall(34_000, 100), 50)]);
  assert.match(riskSentence(notCovered)!, /^A 10% fall would liquidate \$334K of longs; on ETH the losses beyond collateral \(\$100\.00\) exceed its insurance fund \(\$50\.00\)\./);
});

test('a market with losses beyond collateral and no insurance reading is said, not assumed covered', () => {
  const s = snap(fall(10_000, 5), [market('MON', fall(10_000, 5), undefined)]);
  assert.match(riskSentence(s)!, /^A 10% fall would liquidate \$10K of longs; 1 market with losses beyond collateral has no insurance reading\./);
});

test('nothing at risk either way, or no rung yet', () => {
  assert.equal(riskSentence(snap(fall(0, 0, 0), [])), 'A 10% fall would liquidate no longs. A 10% rise would liquidate no shorts.');
  assert.equal(riskSentence({ atRisk: {}, markets: [] }), undefined);
});
