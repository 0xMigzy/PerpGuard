import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderDayPoint } from '@perpguard/shared';
import { RANKINGS, bufferTier, cumulativeDays, cumulativePnl, pageRange, parseTraderQuery, rankingFromQuery, searchParam, shareOf, sumDays, tradersCsv, flowsCsv, nextFlowSort, DEFAULT_FLOW_SORT, unrealisedByAccount, winRateOf } from './traders.ts';

test('a checksummed address is accepted as an address, in the case it was given', () => {
  assert.deepEqual(parseTraderQuery(' 0x83107A83F5fA8c419F131aa970eb975Bd0225D4D '), {
    kind: 'address',
    address: '0x83107A83F5fA8c419F131aa970eb975Bd0225D4D',
  });
  assert.equal(parseTraderQuery('0x83107a83f5fa8c419f131aa970eb975bd0225d4d').kind, 'address');
});

test('digits are an account id; anything else is refused with a reason', () => {
  assert.deepEqual(parseTraderQuery('4734'), { kind: 'account', accountId: 4734 });
  assert.equal(parseTraderQuery('vitalik.eth').kind, 'invalid');
  assert.equal(parseTraderQuery('0xzz1234').kind, 'invalid');
  assert.equal(parseTraderQuery('').kind, 'invalid');
});

test('part of an address is a prefix search, with its 0x restored if it was left off', () => {
  assert.deepEqual(parseTraderQuery('0x5982eE63'), { kind: 'prefix', prefix: '0x5982eE63' });
  assert.deepEqual(parseTraderQuery('5982eE63'), { kind: 'prefix', prefix: '0x5982eE63' });
  assert.deepEqual(parseTraderQuery('0x1234'), { kind: 'prefix', prefix: '0x1234' }, 'the floor is three hex characters');
  // 41 hex characters is not an address and not a prefix of one.
  assert.equal(parseTraderQuery('0x' + 'a'.repeat(41)).kind, 'invalid');
  // Too short to search without listing every recorded owner.
  const short = parseTraderQuery('0xab');
  assert.equal(short.kind, 'invalid');
  assert.match((short as { reason: string }).reason, /at least 3 hex/);
  // A bare 40-hex string is a full address, 0x restored.
  assert.deepEqual(parseTraderQuery('83107A83F5fA8c419F131aa970eb975Bd0225D4D'), { kind: 'address', address: '0x83107A83F5fA8c419F131aa970eb975Bd0225D4D' });
});

test('the PnL curve runs oldest first from zero over the trips given', () => {
  const trip = (netPnlAusd: number) => ({ netPnlAusd }) as never;
  assert.deepEqual(cumulativePnl([trip(5), trip(-2), trip(10)]), [10, 8, 13], 'served newest first: 10, then −2, then +5');
  assert.deepEqual(cumulativePnl([]), []);
});

test('a negative buffer is PAST liquidation, never a small buffer', () => {
  assert.equal(bufferTier(-0.01), 'past');
  assert.equal(bufferTier(0.01), 'danger');
  assert.equal(bufferTier(0.05), 'watch');
  assert.equal(bufferTier(0.2), 'safe');
  assert.equal(bufferTier(undefined), 'unknown');
});

test('days fold into window totals with every count kept, and a round trip is a win or a loss', () => {
  const day = (over: Partial<TraderDayPoint>): TraderDayPoint => ({
    dayMs: 0, volumeAusd: 0, tradeCount: 0, realisedPnlAusd: 0, fundingAusd: 0, feesAusd: 0, netPnlAusd: 0, wins: 0, losses: 0,
    liquidationCount: 0, rescuableLiquidationCount: 0, marginAddedAusd: 0, marginRemovedAusd: 0, depositedAusd: 0, withdrawnAusd: 0, endFreeBalanceAusd: 0, ...over,
  });
  const totals = sumDays([day({ netPnlAusd: 10, wins: 2, losses: 1, volumeAusd: 100, liquidationCount: 1, rescuableLiquidationCount: 1 }), day({ netPnlAusd: -4, wins: 0, losses: 3, volumeAusd: 50 })]);
  assert.equal(totals.days, 2);
  assert.equal(totals.netPnlAusd, 6);
  assert.equal(totals.roundTrips, 6);
  assert.equal(totals.wins, 2);
  assert.equal(totals.volumeAusd, 150);
  assert.equal(totals.rescuableLiquidationCount, 1);
  const curve = cumulativeDays([day({ dayMs: 1, netPnlAusd: 10 }), day({ dayMs: 2, netPnlAusd: -4 })]);
  assert.deepEqual(curve.map((p) => p.cumulativeAusd), [10, 6]);
});

test('a win rate is withheld under the floor the backend named, never computed off three trades', () => {
  assert.equal(winRateOf(2, 3, 10), undefined);
  assert.equal(winRateOf(0, 0, 10), undefined);
  assert.equal(winRateOf(6, 10, 10), 0.6);
  assert.deepEqual(pageRange(50, 25, 1_478), { from: 51, to: 75, total: 1_478 });
  assert.deepEqual(pageRange(0, 0, 0), { from: 0, to: 0, total: 0 });
});

test('the five rankings, in tab order, each tied to the column it orders', () => {
  assert.deepEqual(RANKINGS.map((r) => [r.key, r.label, r.column]), [
    ['pnl', 'Top PnL', 'netPnl'],
    ['losses', 'Top losses', 'netPnl'],
    ['volume', 'Volume', 'volume'],
    ['liquidated', 'Liquidated', 'liquidations'],
    ['flows', 'Flows', 'netFlow'],
  ]);
  assert.match(RANKINGS[0]!.describe(10), /at least 10 round trips/);
  assert.equal(rankingFromQuery('spare'), 'pnl', 'the retired tab falls back to the default');
  assert.equal(rankingFromQuery('richest'), 'pnl', 'an unknown ?rank= falls back to the default');
  assert.equal(rankingFromQuery(null), 'pnl');
});

test('the panel search sends a normalised address, prefix or id, and refuses junk with a reason', () => {
  assert.deepEqual(searchParam(''), { q: undefined });
  assert.deepEqual(searchParam('0xB7854953A71e45D1033B3d619E76d56391291765'), { q: '0xb7854953a71e45d1033b3d619e76d56391291765' });
  assert.deepEqual(searchParam('b78549'), { q: '0xb78549' });
  assert.deepEqual(searchParam('#2260'), { q: '2260' });
  assert.ok('invalid' in searchParam('whale'));
});

test('unrealised PnL is summed per account over priced positions; an unpriced account is absent, not zero', () => {
  const m = unrealisedByAccount([
    { accountId: 1, unrealisedPnlAusd: 10 },
    { accountId: 1, unrealisedPnlAusd: -25 },
    { accountId: 2, unrealisedPnlAusd: 3 },
  ]);
  assert.deepEqual(m.get(1), { ausd: -15, positions: 2 });
  assert.equal(m.get(3), undefined);
});

test('a share is withheld below the floor and never divides by zero', () => {
  assert.equal(shareOf(363, 1048, 10), 363 / 1048);
  assert.equal(shareOf(3, 4, 10), undefined);
  assert.equal(shareOf(0, 0, 0), undefined);
});

test('the CSV keeps the backend order, leaves unserved fields empty and quotes what needs it', () => {
  const base = {
    accountId: 1, address: '0xabc', netPnlAusd: 12.5, volumeAusd: 1000, tradeCount: 4, roundTrips: 12, wins: 9, losses: 3, winRate: 0.75,
    liquidationCount: 2, rescuableLiquidationCount: 1, marginLostAusd: 5, maxSpareHeldAusd: 40, freeBalanceAusd: 1, openPositionCount: 0, lastActiveAtMs: 0,
    depositedAusd: 1_000, withdrawnAusd: 250.5, netFlowAusd: 749.5,
  };
  const csv = tradersCsv([base, { ...base, accountId: 2, address: '', netPnlAusd: -3, roundTrips: 2, wins: 1, winRate: undefined }], 'Top PnL', 'Sep 4, 2026 – Oct 4, 2026');
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'rank,account_id,address,net_pnl_ausd,volume_ausd,trades,round_trips,wins,win_rate_pct,liquidations,rescuable_liquidations,ranking,window');
  assert.equal(lines[1], '1,1,0xabc,12.5,1000,4,12,9,75,2,1,Top PnL,"Sep 4, 2026 – Oct 4, 2026"');
  assert.equal(lines[2], '2,2,,-3,1000,4,2,1,,2,1,Top PnL,"Sep 4, 2026 – Oct 4, 2026"', 'no address and a withheld rate are empty, not zero');
  assert.equal(lines.length, 3);
});

test('Flows sorting: net flow cycles size, inflows, outflows; amounts start largest-first and flip', () => {
  const a = nextFlowSort(DEFAULT_FLOW_SORT, 'netFlow');
  assert.deepEqual(a, { key: 'netFlow', direction: 'desc' }, 'largest inflows');
  const b = nextFlowSort(a, 'netFlow');
  assert.deepEqual(b, { key: 'netFlow', direction: 'asc' }, 'largest outflows');
  assert.deepEqual(nextFlowSort(b, 'netFlow'), DEFAULT_FLOW_SORT, 'back to size either way');
  const d = nextFlowSort(DEFAULT_FLOW_SORT, 'deposits');
  assert.deepEqual(d, { key: 'deposits', direction: 'desc' });
  assert.deepEqual(nextFlowSort(d, 'deposits'), { key: 'deposits', direction: 'asc' });
  assert.deepEqual(nextFlowSort(d, 'withdrawals'), { key: 'withdrawals', direction: 'desc' });
});

test('the Flows CSV has its own five columns and leaves an unrecorded owner empty', () => {
  const row = {
    accountId: 7, address: '0xabc', netPnlAusd: 0, volumeAusd: 0, tradeCount: 0, roundTrips: 0, wins: 0, losses: 0, winRate: undefined,
    liquidationCount: 0, rescuableLiquidationCount: 0, marginLostAusd: 0, maxSpareHeldAusd: undefined, freeBalanceAusd: 0, openPositionCount: 0, lastActiveAtMs: 0,
    depositedAusd: 1_000, withdrawnAusd: 1_250.5, netFlowAusd: -250.5,
  };
  const lines = flowsCsv([row, { ...row, accountId: 8, address: '' }]).trimEnd().split('\r\n');
  assert.equal(lines[0], 'Account,Account ID,Deposits (AUSD),Withdrawals (AUSD),Net Flow (AUSD)');
  assert.equal(lines[1], '0xabc,7,1000,1250.5,-250.5');
  assert.equal(lines[2], ',8,1000,1250.5,-250.5');
});
