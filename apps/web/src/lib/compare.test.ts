import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderDayPoint, WalletProfile } from '@perpguard/shared';
import { alignedCumulative, compareColumn, compareHref, parseCompareIds, walletLabel, withAdded, withRemoved } from './compare.ts';
import { shortAddress } from './format.ts';

const day = (dayMs: number, netPnlAusd: number, wins = 0, losses = 0, extra: Partial<TraderDayPoint> = {}): TraderDayPoint => ({
  dayMs, volumeAusd: 1_000, tradeCount: 2, realisedPnlAusd: netPnlAusd, fundingAusd: 0, feesAusd: 0, netPnlAusd, wins, losses,
  liquidationCount: 0, rescuableLiquidationCount: 0, marginAddedAusd: 0, marginRemovedAusd: 0, depositedAusd: 0, withdrawnAusd: 0, endFreeBalanceAusd: 0,
  ...extra,
});

const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' };
const profile = (over: Partial<WalletProfile> = {}): WalletProfile => ({
  address: '0xb7854953a71e45d1033b3d619e76d56391291765', accountId: 4886, firstTradeAtMs: 1, lastActiveAtMs: 2,
  openPositions: [{ market: BTC, side: 'long', sizeLots: 0.1, entryPrice: 80_000, marginAusd: 500, leverage: 16, openedAtMs: 1, marginAddedAusd: 0 }],
  performance: {
    roundTrips: 40, wins: 22, losses: 18, winRate: 0.55, profitFactor: 1.3, minRoundTripsForRatios: 10, maxDrawdownAusd: 900,
    longestWinStreak: 5, longestLossStreak: 4, averageHoldMs: 3_600_000, bestRoundTripAusd: 300, worstRoundTripAusd: -250,
    bestMarket: { market: BTC, netPnlAusd: 700, roundTrips: 30 }, worstMarket: undefined,
  },
  rescues: { count: 3, judgeableCount: 3, unknownCount: 0, rescuableCount: 2, rate: undefined, medianCoverRatio: undefined, coverRatioCount: 0, medianSpareBalanceAusd: undefined, rescuableRealisedLossAusd: 0, withAnySpareBalanceCount: 0 },
  realisedPnlAusd: 1_000, fundingAusd: -20, feesPaidAusd: 80, netPnlAusd: 900, volumeAusd: 250_000, tradeCount: 90,
  freeBalanceAusd: 1_000, depositedAusd: 3_000, withdrawnAusd: 500,
  ...over,
} as WalletProfile);

test('the URL carries up to four accounts, in order, once each; the rest is reported, never guessed', () => {
  assert.deepEqual(parseCompareIds('4886,5201'), { ids: [4886, 5201], dropped: [] });
  assert.deepEqual(parseCompareIds(' 4886 , 4886,0x12,-3,7,8,9,10'), { ids: [4886, 7, 8, 9], dropped: ['0x12', '-3', '10'] });
  assert.deepEqual(parseCompareIds(null), { ids: [], dropped: [] });
  assert.equal(compareHref([4886, 5201]), '/compare?a=4886,5201');
  assert.equal(compareHref([]), '/compare');
});

test('adding is refused when already there or full; removing keeps the order', () => {
  assert.deepEqual(withAdded([1, 2], 3), { kind: 'added', ids: [1, 2, 3] });
  assert.deepEqual(withAdded([1, 2], 2), { kind: 'already' });
  assert.deepEqual(withAdded([1, 2, 3, 4], 5), { kind: 'full' });
  assert.deepEqual(withRemoved([1, 2, 3], 2), [1, 3]);
});

test('a column is the profile\'s own figures; the window win rate is withheld under the floor', () => {
  const days = [day(1, 50, 2, 1), day(2, -20, 1, 3, { liquidationCount: 1, rescuableLiquidationCount: 1 })];
  const c = compareColumn(profile(), days, [{ position: { marginAusd: 500 }, unrealisedPnlAusd: -40 }]);
  assert.equal(c.equityAusd, 1_460, 'free 1,000 + margin 500 − 40 unrealised');
  assert.equal(c.window.netPnlAusd, 30);
  assert.equal(c.window.roundTrips, 7);
  assert.equal(c.window.winRate, undefined, '7 round trips is under the floor of 10');
  assert.equal(c.window.rescuableLiquidations, 1);
  assert.equal(c.lifetime.winRate, 0.55);
  assert.equal(c.lifetime.rescuableLiquidations, 2);
  assert.equal(c.lifetime.judgeableLiquidations, 3);
  assert.equal(c.openPositions, 1);
  assert.equal(compareColumn(profile(), [], [{ position: { marginAusd: 1 }, unrealisedPnlAusd: 0 }, { position: { marginAusd: 1 }, unrealisedPnlAusd: 0 }]).openPositions, 2, 'counted from the priced read when it is there');
  const enough = compareColumn(profile(), [day(1, 0, 6, 4)], []);
  assert.equal(enough.window.winRate, 0.6);
});

test('equity is unknown, never partial, while open positions are not priced yet', () => {
  assert.equal(compareColumn(profile(), [], undefined).equityAusd, undefined);
  assert.equal(compareColumn(profile(), [], [{ position: { marginAusd: 500 } }]).equityAusd, undefined);
  assert.equal(compareColumn(profile({ openPositions: [] }), [], undefined).equityAusd, 1_000, 'no positions: free balance is the equity');
});

test('the chart puts every wallet on one day axis, flat on days it did not trade, from 0', () => {
  const pts = alignedCumulative([
    { accountId: 1, days: [day(10, 5), day(30, -2)] },
    { accountId: 2, days: [day(20, 7)] },
  ]);
  assert.deepEqual(
    pts.map((p) => [p.dayMs, p.values[1], p.values[2]]),
    [
      [10, 5, 0],
      [20, 5, 7],
      [30, 3, 7],
    ],
  );
  assert.deepEqual(alignedCumulative([]), []);
});

test('a wallet is always named in words beside its colour', () => {
  assert.equal(walletLabel({ accountId: 4886, address: '0xb7854953a71e45d1033b3d619e76d56391291765' }, shortAddress), `${shortAddress('0xb7854953a71e45d1033b3d619e76d56391291765')} · #4886`);
  assert.equal(walletLabel({ accountId: 10, address: '' }, shortAddress), '#10');
});
