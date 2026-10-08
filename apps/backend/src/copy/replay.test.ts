/**
 * The copy replay: proportional size, markets by canonical ticker, skips with
 * reasons, the free balance moving through time, and results that round
 * against the reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CopySource, CopySourcePosition } from '@perpguard/shared';
import { replayCopy, type CopyMarket, type ReplayInput, type ReplayTrade } from './replay.ts';

const AUSD = 1_000_000n;
const T0 = Date.parse('2026-09-07T00:00:00Z');
const H = 3_600_000;

// Testnet: BTC and SOL, no HYPE. Sizes in 5 and 2 decimals.
const ACTING: readonly CopyMarket[] = [
  { marketId: 1, symbol: 'BTC', sizeDecimals: 5, maxLeverage: 50, takerFeeMicros: 0 },
  { marketId: 31, symbol: 'SOL', sizeDecimals: 2, maxLeverage: 20, takerFeeMicros: 0 },
];

let n = 0;
/** A mainnet position: BTC (market 1) by default, lots in 5 decimals, prices in 1. */
function pos(p: Partial<CopySourcePosition> & { openedH: number; closedH?: number }): CopySourcePosition {
  n += 1;
  const { openedH, closedH, ...rest } = p;
  return {
    key: `p${n}`,
    market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC' },
    side: 'long',
    status: closedH === undefined ? 'open' : 'closed',
    lotDecimals: 5,
    priceDecimals: 1,
    peakLotLNS: 200_000n, // 2 BTC
    lotLNS: closedH === undefined ? 200_000n : 0n,
    entryPricePNS: 1_000_000n, // 100,000.0
    peakMarginCNS: 20_000n * AUSD, // 10x
    netPnlCNS: 0n,
    leverageHdths: 1000n,
    openedAtMs: T0 + openedH * H,
    closedAtMs: closedH === undefined ? undefined : T0 + closedH * H,
    ...rest,
  };
}

function source(positions: CopySourcePosition[], extra: Partial<CopySource> = {}): CopySource {
  return {
    accountId: 4886,
    fromMs: T0,
    toMs: T0 + 30 * 24 * H,
    collateralDecimals: 6,
    equityAtStartCNS: 100_000n * AUSD,
    feesByDay: [],
    flows: [],
    closedFromBefore: [],
    openAtStart: 0,
    openedInWindow: positions.length,
    positions,
    now: { freeCNS: 0n, openMarginCNS: 0n, openResultCNS: 0n },
    ...extra,
  };
}

function run(src: CopySource, over: Partial<ReplayInput> = {}) {
  const r = replayCopy({ source: src, followerEquityCNS: 1_000n * AUSD, actingNetwork: 'mainnet', actingMarkets: ACTING, markOf: () => undefined, cap: 3_000, ...over });
  assert.equal(r.kind, 'replayed');
  if (r.kind !== 'replayed') throw new Error('not replayed');
  return r;
}

const copied = (t: ReplayTrade) => {
  assert.equal(t.copy.kind, 'copied', JSON.stringify(t.copy, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  if (t.copy.kind !== 'copied') throw new Error('skipped');
  return t.copy;
};

test('2% -> 2%: a 1,000 AUSD follower of a 100,000 AUSD leader copies 1% of every position, margin and result alike', () => {
  const r = run(source([pos({ openedH: 1, closedH: 5, netPnlCNS: 5_000n * AUSD })]));
  const c = copied(r.trades[0]!);
  assert.equal(c.actingMarketId, 1, 'the same market, by id');
  assert.equal(c.sizeUnits, 2_000n, '0.02 BTC in the market\'s units');
  assert.equal(c.marginCNS, 200n * AUSD);
  assert.equal(c.resultCNS, 50n * AUSD);
  assert.equal(c.estimate, false);
  assert.equal(r.totals.closedResultCNS, 50n * AUSD);
  assert.equal(r.totals.followerEndEquityCNS, 1_050n * AUSD);
  assert.equal(r.totals.leaderResultOnCopiedCNS, 5_000n * AUSD);
  assert.equal(r.totals.wins, 1);
});

test('ONE NETWORK, MATCHED BY MARKET ID: SOL_v2 (31) copies to SOL 31; a market the context no longer lists is still copied, on the leader\'s size step and the highest listed fee', () => {
  const r = run(source([
    pos({ openedH: 1, closedH: 2, market: { marketId: 31, symbol: 'SOL', indexerName: 'SOL_v2' }, lotDecimals: 2, peakLotLNS: 50_000n, entryPricePNS: 2_000n, priceDecimals: 1, peakMarginCNS: 10_000n * AUSD }),
    pos({ openedH: 3, closedH: 4, market: { marketId: 30, symbol: 'SOL', indexerName: 'SOL' }, lotDecimals: 2, peakLotLNS: 50_000n, entryPricePNS: 2_000n, priceDecimals: 1, peakMarginCNS: 10_000n * AUSD }),
  ]), { actingMarkets: [ACTING[0]!, { ...ACTING[1]!, takerFeeMicros: 300 }] });
  assert.equal(copied(r.trades[0]!).actingMarketId, 31);
  const retired = copied(r.trades[1]!);
  assert.equal(retired.actingMarketId, 30, 'never moved onto SOL 31');
  assert.equal(retired.sizeDecimals, 2, 'the leader\'s own size step');
  assert.ok(retired.feeCNS > 0n, 'charged the highest listed fee, never free');
  assert.equal(r.totals.skipped, 0);
});

test('a copy that rounds to nothing at the follower\'s size is skipped as too small, never rounded up', () => {
  // 0.00099 BTC × 1% = 0.0000099, under the market's 0.00001 step.
  const r = run(source([pos({ openedH: 1, closedH: 2, peakLotLNS: 99n, peakMarginCNS: 10n * AUSD })]));
  const t = r.trades[0]!.copy;
  assert.equal(t.kind, 'skipped');
  assert.equal(t.kind === 'skipped' && t.reason, 'too-small');
  assert.match(t.kind === 'skipped' ? t.text : '', /under 0\.00001 BTC/);
});

test('AFFORDABILITY SCALES, NEVER SKIPS: a copy the free balance cannot fully cover is cut to what it covers, and says by how much', () => {
  // Each copy needs 600 AUSD (1% of 60,000): the second opens while the first is open, with 400 free.
  const big = { peakMarginCNS: 60_000n * AUSD };
  const r = run(source([
    pos({ openedH: 1, closedH: 10, ...big }),
    pos({ openedH: 2, closedH: 3, ...big }),
    pos({ openedH: 10, closedH: 12, ...big }),
  ]));
  assert.equal(copied(r.trades[0]!).affordScale, undefined, 'a full copy carries no cut');
  const second = copied(r.trades[1]!);
  assert.ok(second.affordScale !== undefined && second.affordScale > 0.66 && second.affordScale <= 0.6667, `cut to two thirds, got ${second.affordScale}`);
  assert.ok(second.marginCNS <= 400n * AUSD, 'never more margin than the free balance held');
  assert.equal(second.sizeUnits, 1_333n, '0.02 BTC × 400/600, rounded down');
  assert.equal(copied(r.trades[2]!).affordScale, undefined, 'the first closed at hour 10, the same instant: freed first');
  assert.equal(r.totals.skipped, 0);
});

test('a deposit by the leader halves the copy\'s proportion for every open after it', () => {
  const r = run(source([pos({ openedH: 1, closedH: 2 }), pos({ openedH: 5, closedH: 6 })], { flows: [{ atMs: T0 + 3 * H, deltaCNS: 100_000n * AUSD }] }));
  assert.equal(copied(r.trades[0]!).sizeUnits, 2_000n);
  assert.equal(copied(r.trades[1]!).sizeUnits, 1_000n);
});

test('the leader\'s results move its equity too: after a 100,000 win, the same follower copies half the share', () => {
  const r = run(source([pos({ openedH: 1, closedH: 2, netPnlCNS: 100_000n * AUSD }), pos({ openedH: 3, closedH: 4 })]));
  // Follower: 1,000 + 1,000 = 2,000; leader 200,000: still 1%.
  assert.equal(copied(r.trades[1]!).sizeUnits, 2_000n);
  const r2 = run(source([pos({ openedH: 1, closedH: 2 }), pos({ openedH: 3, closedH: 4 })], { closedFromBefore: [{ atMs: T0 + 2 * H, netPnlCNS: 100_000n * AUSD }] }));
  assert.equal(copied(r2.trades[1]!).sizeUnits, 1_000n, 'a position from before the window still moves the leader\'s equity');
});

test('RESULTS ROUND AGAINST THE READER: a loss away from zero, a gain toward it', () => {
  // 1% of −1.234567 is −0.01234567: −0.012346 AUSD, never −0.012345.
  const loss = run(source([pos({ openedH: 1, closedH: 2, netPnlCNS: -1_234_567n })]));
  assert.equal(copied(loss.trades[0]!).resultCNS, -12_346n);
  const gain = run(source([pos({ openedH: 1, closedH: 2, netPnlCNS: 1_234_567n })]));
  assert.equal(copied(gain.trades[0]!).resultCNS, 12_345n);
  // Margin needed rounds UP.
  const margin = run(source([pos({ openedH: 1, closedH: 2, peakMarginCNS: 20_000n * AUSD + 1n })]));
  assert.equal(copied(margin.trades[0]!).marginCNS, 200n * AUSD + 1n);
});

test('a forced exit is copied with the leader and counted as one, and as a loss whatever the arithmetic', () => {
  const r = run(source([pos({ openedH: 1, closedH: 2, status: 'forced', netPnlCNS: -20_000n * AUSD })]));
  assert.equal(copied(r.trades[0]!).resultCNS, -200n * AUSD);
  assert.equal(r.totals.forcedExits, 1);
  assert.equal(r.totals.losses, 1);
  assert.equal(r.totals.followerEndEquityCNS, 800n * AUSD);
});

test('a position still open is valued at the current mark, marked as an estimate, and kept out of the end equity', () => {
  // Long 2 BTC from 100,000.0, mark 101,000.0: +2,000 AUSD to the leader, +20 to the copy.
  const r = run(source([pos({ openedH: 1 })]), { markOf: (id) => (id === 1 ? 101_000 : undefined) });
  const c = copied(r.trades[0]!);
  assert.equal(c.estimate, true);
  assert.equal(c.resultCNS, 20n * AUSD);
  assert.equal(r.totals.openEstimateCNS, 20n * AUSD);
  assert.equal(r.totals.followerEndEquityCNS, 1_000n * AUSD);
  const blind = run(source([pos({ openedH: 1 })]));
  assert.equal(copied(blind.trades[0]!).resultCNS, undefined, 'no mark: no figure, never zero');
});

test('NO LEVERAGE CHECK: the leader\'s leverage was allowed on the network it used, so a 25x position is copied', () => {
  const r = run(source([pos({ openedH: 1, closedH: 2, market: { marketId: 31, symbol: 'SOL', indexerName: 'SOL_v2' }, lotDecimals: 2, peakLotLNS: 50_000n, entryPricePNS: 2_000n, peakMarginCNS: 4_000n * AUSD })]));
  assert.equal(r.trades[0]!.copy.kind, 'copied');
  assert.equal(r.totals.skippedBy['leverage'], undefined);
});

test('positions already open when the window began are counted as skipped, never copied', () => {
  const r = run(source([pos({ openedH: 1, closedH: 2 })], { openAtStart: 3 }));
  assert.equal(r.totals.skippedBy['open-at-start'], 3);
  assert.equal(r.totals.skipped, 3);
  assert.equal(r.totals.copied, 1);
});

test('A LEADER TOO BUSY TO REPLAY IS REFUSED WHOLE, never replayed in part', () => {
  const r = replayCopy({ source: source([pos({ openedH: 1, closedH: 2 })], { openedInWindow: 36_639 }), followerEquityCNS: 1_000n * AUSD, actingNetwork: 'mainnet', actingMarkets: ACTING, markOf: () => undefined, cap: 3_000 });
  assert.deepEqual(r, { kind: 'too-busy', accountId: 4886, openedInWindow: 36_639, cap: 3_000, fromMs: T0, toMs: T0 + 30 * 24 * H });
});

test('a follower with nothing to copy with is told so, not shown a replay of zeros', () => {
  const r = replayCopy({ source: source([pos({ openedH: 1, closedH: 2 })]), followerEquityCNS: 0n, actingNetwork: 'mainnet', actingMarkets: ACTING, markOf: () => undefined, cap: 3_000 });
  assert.equal(r.kind, 'no-follower-equity');
});

test('ausdText: cents, a need rounded up and a holding down, a loss with a real minus sign', async () => {
  const { ausdText } = await import('./replay.ts');
  assert.equal(ausdText(1_234_567n, 'ceil'), '1.24 AUSD');
  assert.equal(ausdText(1_234_567n, 'floor'), '1.23 AUSD');
  assert.equal(ausdText(-1_234_567n, 'floor'), '−1.24 AUSD', 'a loss rounds away from zero');
  assert.equal(ausdText(1_234_567_890_000n, 'floor'), '1,234,567.89 AUSD');
});

test('FEES ARE THE COPY\'S OWN: the taker rate on opening and closing its full size at entry, rounded up, taken off the result', () => {
  // 0.02 BTC at 100,000.0 = 2,000 AUSD each way; 4.5 bps taker: 0.9 AUSD each way, 1.8 AUSD in all.
  const markets = [{ ...ACTING[0]!, takerFeeMicros: 450 }];
  const r = run(source([pos({ openedH: 1, closedH: 5, netPnlCNS: 5_000n * AUSD })]), { actingMarkets: markets });
  const c = copied(r.trades[0]!);
  assert.equal(c.feeCNS, 1_800_000n);
  assert.equal(c.resultCNS, 50n * AUSD - 1_800_000n);
  assert.equal(r.totals.feesCNS, 1_800_000n);
  assert.equal(r.totals.followerEndEquityCNS, 1_050n * AUSD - 1_800_000n);
  // A fee of a fraction of a micro rounds UP to one.
  // 0.00001 BTC at 100,000.1: 1.000001 AUSD each way at 1 micro is 2.000002 micros: 3.
  const tiny = run(source([pos({ openedH: 1, closedH: 2, peakLotLNS: 100n, entryPricePNS: 1_000_001n, peakMarginCNS: 10n * AUSD })]), { actingMarkets: [{ ...ACTING[0]!, takerFeeMicros: 1 }] });
  assert.equal(copied(tiny.trades[0]!).feeCNS, 3n);
});

test('the leader\'s daily fees come off its equity when each day ends, and so move the scale', () => {
  const r = run(source([pos({ openedH: 1, closedH: 2 }), pos({ openedH: 30, closedH: 31 })], { feesByDay: [{ atMs: T0 + 24 * H, feesCNS: 50_000n * AUSD }] }));
  assert.equal(copied(r.trades[0]!).sizeUnits, 2_000n, 'before the day ended: 1%');
  assert.equal(copied(r.trades[1]!).sizeUnits, 4_000n, 'after: 1,000 of 50,000 is 2%');
});

test('THE LEADER\'S BOOKS: rebuilt to today and set against the index; a gap past 1 AUSD or 0.1% is NOT RECONCILED and carries its size', async () => {
  const { reconcile } = await import('./replay.ts');
  // #4886, measured 7 Oct 2026: rebuilt 2,007.40 against 0.004 on record.
  const r4886 = reconcile(2_007_404_211n, 4_211n, 6);
  assert.equal(r4886.reconciled, false);
  assert.equal(r4886.gapCNS, 2_007_400_000n);
  // #5213: 0.31 AUSD out.
  assert.equal(reconcile(-310_000n, 0n, 6).reconciled, true);
  // 0.1% of 40,000 is 40 AUSD.
  assert.equal(reconcile(40_030_000_000n, 40_000_000_000n, 6).reconciled, true);
  assert.equal(reconcile(40_050_000_000n, 40_000_000_000n, 6).reconciled, false);
  // In a replay: the walk is start + flows + results − fees + open results, against free + open margin.
  const books = run(source([pos({ openedH: 1, closedH: 2, netPnlCNS: 5_000n * AUSD })], { now: { freeCNS: 105_000n * AUSD, openMarginCNS: 0n, openResultCNS: 0n } })).books;
  assert.deepEqual(books, { rebuiltCNS: 105_000n * AUSD, indexCNS: 105_000n * AUSD, gapCNS: 0n, reconciled: true });
});
