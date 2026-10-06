import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { protocolDaysOf } from './protocolDays.ts';

const D = Date.UTC(2026, 6, 23);

test('only treasury deposits and withdrawals count, summed per UTC day, oldest first', () => {
  const days = protocolDaysOf({
    scannedThroughBlock: 99,
    logs: [
      { event: 'ProtocolBalanceWithdraw', block: 3, timestampMs: D + 86_400_000 + 5, args: { amountCNS: '1703839' } },
      { event: 'ProtocolBalanceDeposit', block: 1, timestampMs: D + 10, args: { amountCNS: '130250000000' } },
      { event: 'ProtocolBalanceWithdraw', block: 2, timestampMs: D + 20, args: { amountCNS: '250000000' } },
      { event: 'TransferProtocolToAccount', block: 2, timestampMs: D + 30, args: { accountId: '7', amountCNS: '999000000', balanceCNS: '0' } },
    ],
  });
  assert.equal(days.throughBlock, 99);
  assert.deepEqual(days.days, [
    { dayMs: D, inAusd: 130_250, outAusd: 250 },
    { dayMs: D + 86_400_000, inAusd: 0, outAusd: 1.703839 },
  ]);
  assert.equal(days.lastEventAtMs, D + 86_400_000 + 5);
  assert.deepEqual(days.movements, [
    { atMs: D + 10, ausd: 130_250 },
    { atMs: D + 20, ausd: -250 },
    { atMs: D + 86_400_000 + 5, ausd: -1.703839 },
  ]);
});

test('the committed scan sums to the figures the reconciliation recorded', () => {
  const scan = JSON.parse(readFileSync(new URL('../../../../fixtures/protocol-flows-mainnet.json', import.meta.url), 'utf8'));
  const rec = JSON.parse(readFileSync(new URL('../../../../fixtures/exchange-balance-reconciliation.json', import.meta.url), 'utf8'));
  const days = protocolDaysOf(scan);
  const sum = (k: 'inAusd' | 'outAusd') => days.days.reduce((s, d) => s + d[k], 0);
  assert.equal(sum('inAusd').toFixed(6), rec.protocolBalanceDeposit.toFixed(6));
  assert.equal(sum('outAusd').toFixed(6), rec.protocolBalanceWithdraw.toFixed(6));
});
