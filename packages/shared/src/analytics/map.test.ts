/**
 * The mapping layer, which is where indexed rows become numbers people read.
 *
 * Three failure modes are tested hardest, because each one produces a plausible
 * wrong answer rather than an error: the wrong decimals, the wrong symbol, and a
 * guess where there should have been a gap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bigintOrUndefined,
  bigintOrZero,
  count,
  profitFactor,
  requireMs,
  rescueRate,
  share,
  sideFromRow,
  symbolResolver,
  toAusd,
  toLots,
  toMarketRef,
  toMs,
  toPrice,
  toRatePct,
  windowFor,
} from './map.ts';
import { describeMarket } from './types.ts';

// ── numbers off the wire ────────────────────────────────────────────────────

test('numeric columns arrive as strings and parse exactly', () => {
  // node-pg hands back `numeric` as a string on purpose: these exceed float64's
  // exact range. The all-time mainnet volume is one of them.
  assert.equal(bigintOrZero('2229336389548745'), 2_229_336_389_548_745n);
  assert.equal(bigintOrZero(null), 0n);
  assert.equal(bigintOrZero(''), 0n);
  assert.equal(bigintOrZero('-500'), -500n);
  assert.equal(bigintOrUndefined(null), undefined);
  assert.equal(bigintOrUndefined('0'), 0n);
});

test('a column that is not an integer throws rather than becoming NaN', () => {
  for (const value of ['1.5', 'abc', '1e6', {}]) {
    assert.throws(() => bigintOrZero(value), /expected an integer column/);
  }
});

test('AUSD micros convert at the decimals the Exchange row reports', () => {
  // 6 on mainnet, but read rather than assumed: a hard-coded 6 is the same class
  // of bug as a hard-coded maintenance margin.
  assert.equal(toAusd('1126526379973', 6), 1_126_526.379973);
  assert.equal(toAusd('1126526379973', 2), 11_265_263_799.73);
  assert.equal(toAusd(null, 6), 0);
});

test('prices convert at each market’s OWN priceDecimals', () => {
  // The real spread on mainnet: BTC is 1, MON and PUMP are 6. A constant that is
  // right for BTC is wrong by five orders of magnitude for MON.
  assert.equal(toPrice('844111', 1), 84_411.1);
  assert.equal(toPrice('50000', 6), 0.05);
  assert.equal(toPrice('269228', 2), 2_692.28);
  assert.equal(toPrice(null, 1), undefined, 'a mark the indexer never saw stays absent');
});

test('sizes convert at each market’s OWN lotDecimals', () => {
  assert.equal(toLots('50000', 5), 0.5);
  assert.equal(toLots('10000', 0), 10_000, 'MON trades in whole lots');
});

test('a funding rate is a fraction × 100,000: 4 is 0.004% per settlement, as positions paid', () => {
  assert.equal(toRatePct('4'), 0.004);
  assert.equal(toRatePct('-1'), -0.001);
  assert.equal(toRatePct('1000'), 1);
  assert.equal(toRatePct(null), undefined);
  // The measured case: a 0.00004-lot BTC long across one settlement at rate 4 and $84,538.80 paid $0.000132.
  const paid = 0.00004 * 84_538.8 * (toRatePct('4')! / 100);
  assert.ok(Math.abs(paid - 0.000132) / 0.000132 < 0.03, `${paid} vs 0.000132 paid`);
});

test('timestamps parse from a Date or an ISO string, and throw on anything else', () => {
  const when = new Date('2026-09-30T05:04:14Z');
  assert.equal(toMs(when), when.getTime());
  assert.equal(toMs('2026-09-30T05:04:14Z'), when.getTime());
  assert.equal(toMs(null), undefined);
  // A NaN timestamp renders as "Invalid Date" in one place and sorts
  // unpredictably everywhere else, so it is refused at the boundary.
  assert.throws(() => toMs('not a date'), /expected a timestamp column/);
  assert.throws(() => requireMs(null), /expected a non-null timestamp/);
});

test('counts tolerate bigint strings, because count(*) is a bigint', () => {
  assert.equal(count('5570901'), 5_570_901);
  assert.equal(count(null), 0);
  assert.throws(() => count('abc'), /expected a numeric count/);
});

// ── the side, which must never be guessed ───────────────────────────────────

test('a side maps from the indexer’s enum', () => {
  assert.equal(sideFromRow('LONG'), 'long');
  assert.equal(sideFromRow('SHORT'), 'short');
});

test('an unrecognised side THROWS rather than defaulting to long', () => {
  // An inverted side corrupts every PnL, skew and rescue figure for that row, and
  // nothing downstream could see it. Same rule as sideOf on contract events.
  for (const value of [null, undefined, 0, 1, 'long', 'Long', 'BUY', '']) {
    assert.throws(() => sideFromRow(value), /Refusing to guess/, JSON.stringify(value));
  }
});

// ── symbols: by market id, never by name ────────────────────────────────────

const CONTEXT = symbolResolver([
  { marketId: 1, symbol: 'BTC' },
  { marketId: 10, symbol: 'MON' },
  { marketId: 20, symbol: 'ETH' },
  // The venue calls market 31 SOL. The chain, and therefore the indexer, calls it
  // SOL_v2.
  { marketId: 31, symbol: 'SOL' },
]);

test('market 31 resolves to SOL even though the indexer stored SOL_v2', () => {
  // THE case this indirection exists for. Matching on the name would silently
  // drop this market from every join.
  const ref = toMarketRef('31', 'SOL_v2', CONTEXT);
  assert.equal(ref.symbol, 'SOL');
  assert.equal(ref.indexerName, 'SOL_v2');
  assert.equal(ref.marketId, 31);
  assert.equal(describeMarket(ref), 'SOL');
});

test('a market the venue does not list resolves to UNDEFINED, not to the chain’s name', () => {
  // Mainnet market 80 (TAO) is listed on chain with real scaling, and
  // GET /v1/pub/context does not mention it. Anything user-facing follows the
  // context; a fallback to the indexer's name would look canonical and not be.
  const ref = toMarketRef('80', 'TAO', CONTEXT);
  assert.equal(ref.symbol, undefined);
  assert.equal(ref.indexerName, 'TAO');
  assert.match(describeMarket(ref), /^market 80 \(TAO, not listed by the venue\)$/);
});

test('every listed market round-trips', () => {
  for (const [id, name, expected] of [
    ['1', 'BTC Perp', 'BTC'],
    ['10', 'MON Perp', 'MON'],
    ['20', 'ETH', 'ETH'],
  ] as const) {
    assert.equal(toMarketRef(id, name, CONTEXT).symbol, expected);
  }
});

// ── the rescue rate and its hole ────────────────────────────────────────────

test('the rescue rate is taken over the liquidations we can JUDGE', () => {
  // The real mainnet figures: 680 liquidations, 485 rescuable, 33 whose position
  // opened before the start block and cannot be judged.
  const { judgeableCount, rate } = rescueRate(485, 680, 33);
  assert.equal(judgeableCount, 647);
  assert.ok(rate !== undefined);
  assert.equal(rate.toFixed(4), '0.7496');
  // NOT 485/680. Dividing by the full count understates the finding and invites
  // the obvious question about the missing rows.
  assert.notEqual(rate, 485 / 680);
});

test('unknowns are excluded, never counted as failures', () => {
  // Counting them as not-rescuable would be an assertion about rows we cannot see.
  const withUnknowns = rescueRate(50, 100, 50);
  assert.equal(withUnknowns.judgeableCount, 50);
  assert.equal(withUnknowns.rate, 1, 'all 50 judgeable ones were rescuable');
});

test('nothing judgeable gives undefined, not a zero rate', () => {
  // No data and a zero rate are different claims.
  const none = rescueRate(0, 12, 12);
  assert.equal(none.judgeableCount, 0);
  assert.equal(none.rate, undefined);
  assert.equal(rescueRate(0, 0, 0).rate, undefined);
});

// ── derived ratios ──────────────────────────────────────────────────────────

test('profit factor is undefined with no losses, not Infinity', () => {
  // Infinity in a UI reads as a bug rather than as a flawless record.
  assert.equal(profitFactor(100, 0), undefined);
  assert.equal(profitFactor(100, 50), 2);
  assert.equal(profitFactor(0, 50), 0);
});

test('a share over a zero denominator is undefined', () => {
  assert.equal(share(3, 0), undefined);
  assert.equal(share(3, 4), 0.75);
});

// ── the window, which is the bug this layer was built to fix ────────────────

test('a rolling window is measured to the millisecond from now, not to a day boundary', () => {
  // 05:04:14 UTC, the time the volume bug was measured at: a day-bucket 24h
  // window held five hours of data and reported 0.23x.
  const nowMs = Date.parse('2026-09-30T05:04:14Z');

  const day = windowFor('24h', nowMs);
  assert.equal(day.untilMs, nowMs);
  assert.equal(new Date(day.sinceMs!).toISOString(), '2026-09-29T05:04:14.000Z');
  // Emphatically NOT UTC midnight, which is what the buggy query effectively used.
  assert.notEqual(new Date(day.sinceMs!).toISOString(), '2026-09-30T00:00:00.000Z');

  assert.equal(new Date(windowFor('7d', nowMs).sinceMs!).toISOString(), '2026-09-23T05:04:14.000Z');
  assert.equal(new Date(windowFor('30d', nowMs).sinceMs!).toISOString(), '2026-08-31T05:04:14.000Z');
});

test('all-time has no start, so nothing is filtered out of it', () => {
  const all = windowFor('all', Date.parse('2026-09-30T05:04:14Z'));
  assert.equal(all.sinceMs, undefined);
});

test('each window is exactly its own length', () => {
  const nowMs = 1_800_000_000_000;
  assert.equal(nowMs - windowFor('24h', nowMs).sinceMs!, 86_400_000);
  assert.equal(nowMs - windowFor('7d', nowMs).sinceMs!, 7 * 86_400_000);
  assert.equal(nowMs - windowFor('30d', nowMs).sinceMs!, 30 * 86_400_000);
});
