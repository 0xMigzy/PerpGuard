import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TreasuryMovement } from '@perpguard/shared';
import { movementsFromScanFile, treasuryDaysOf } from './protocolDays.ts';

const D = Date.UTC(2026, 6, 23);
const m = (atMs: number, direction: 'in' | 'out', amountCNS: bigint, logIndex = 0): TreasuryMovement => ({ block: 1, txHash: `0x${atMs}`, logIndex, atMs, direction, amountCNS });
const scan = { throughBlock: 99, scannedAtMs: 5, intervalMs: 900_000 };

test('movements become treasury in/out per UTC day and a signed list, with the scan beside them', () => {
  const days = treasuryDaysOf([m(D + 86_400_000 + 5, 'out', 1_703_839n), m(D + 10, 'in', 130_250_000_000n), m(D + 20, 'out', 250_000_000n)], scan);
  assert.equal(days.throughBlock, 99);
  assert.deepEqual(days.days, [
    { dayMs: D, inAusd: 130_250, outAusd: 250 },
    { dayMs: D + 86_400_000, inAusd: 0, outAusd: 1.703839 },
  ]);
  assert.deepEqual(days.movements, [
    { atMs: D + 10, ausd: 130_250 },
    { atMs: D + 20, ausd: -250 },
    { atMs: D + 86_400_000 + 5, ausd: -1.703839 },
  ]);
  assert.equal(days.lastEventAtMs, D + 86_400_000 + 5);
  assert.equal(days.scan, scan);
});

test('the seed takes only the two balance events from the committed scan, and they sum to the recorded figures', () => {
  const file = JSON.parse(readFileSync(new URL('../../../../fixtures/protocol-flows-mainnet.json', import.meta.url), 'utf8'));
  const rec = JSON.parse(readFileSync(new URL('../../../../fixtures/exchange-balance-reconciliation.json', import.meta.url), 'utf8'));
  const seed = movementsFromScanFile(file);
  assert.equal(seed.throughBlock, file.scannedThroughBlock);
  assert.equal(seed.movements.length, 20, '4 deposits and 16 withdrawals since launch');
  const sum = (dir: 'in' | 'out') => seed.movements.filter((x) => x.direction === dir).reduce((s, x) => s + x.amountCNS, 0n);
  assert.equal(Number(sum('in')) / 1e6, rec.protocolBalanceDeposit);
  assert.equal(Number(sum('out')) / 1e6, rec.protocolBalanceWithdraw);
});
