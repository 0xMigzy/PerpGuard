import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraderDayPoint } from '@perpguard/shared';
import { bufferTier, cumulativeDays, cumulativePnl, pageRange, parseTraderQuery, sumDays, winRateOf } from './traders.ts';

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
