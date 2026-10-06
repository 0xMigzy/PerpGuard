import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProtocolTreasuryDays } from '@perpguard/shared';
import { balanceBefore, rebuiltBalance, treasuryLines } from './exchangeBalance.ts';

const D = (n: number) => Date.UTC(2026, 6, n);
const treasury = (days: ProtocolTreasuryDays['days'], movements: ProtocolTreasuryDays['movements'] = []): ProtocolTreasuryDays => ({ throughBlock: 1, days, movements, lastEventAtMs: undefined, scan: { throughBlock: 1, scannedAtMs: 1, intervalMs: 900_000 } });

test('the balance runs forward from launch: collateral net plus treasury net, day by day', () => {
  const b = rebuiltBalance(
    [
      { dayMs: D(1), netFlowAusd: 1_000 },
      { dayMs: D(2), netFlowAusd: -200 },
      { dayMs: D(4), netFlowAusd: 50 },
    ],
    treasury([
      { dayMs: D(2), inAusd: 0, outAusd: 300 },
      { dayMs: D(3), inAusd: 100, outAusd: 0 },
    ]),
  );
  assert.deepEqual(b.map((d) => [d.dayMs, d.levelAusd]), [
    [D(1), 1_000],
    [D(2), 500],
    [D(3), 600],
    [D(4), 650],
  ], 'a treasury-only day still appears');
});

test('it never starts below zero the way the backward walk did', () => {
  // Today's balance 3,838,377 with 4,017,092 net deposits: walking back put launch at −178.6K.
  const b = rebuiltBalance([{ dayMs: D(1), netFlowAusd: 4_017_092 }], treasury([{ dayMs: D(2), inAusd: 130_250, outAusd: 308_868 }]));
  assert.ok(b.every((d) => d.levelAusd >= 0));
  assert.equal(b.at(-1)!.levelAusd, 4_017_092 + 130_250 - 308_868);
});

const recon = (gapAusd: number, withinExpected: boolean) => ({
  atBlock: 111_028_717, checkedAtMs: 0, rebuiltAusd: 3_838_349.21, contractAusd: 3_838_349.21 + gapAusd, gapAusd, expectedGapAusd: 27.700465, toleranceAusd: 1, withinExpected,
});

test('inside the known difference the page says it matches, with both figures and the block', () => {
  const l = treasuryLines({ throughBlock: 111_028_900, scannedAtMs: 1_000, intervalMs: 900_000, reconciliation: recon(27.700465, true) }, 241_000);
  assert.equal(l.reconciliation!.tone, 'ok');
  assert.match(l.reconciliation!.text, /^Rebuilt from events, matches the contract at block 111,028,717: \$3,838,349\.21 rebuilt, \$3,838,376\.91 held, \$27\.70 apart/);
  assert.equal(l.scan.text, 'Treasury events scanned through block 111,028,900, 4 min ago; rescanned every 15 min.');
  assert.deepEqual(l.short, { tone: 'ok', text: 'Matches the contract to within $27.70 · scanned 4 min ago' });
  assert.equal(l.scan.tone, 'ok');
});

test('outside it, the difference is shown in words, never smoothed over', () => {
  const l = treasuryLines({ throughBlock: 1, scannedAtMs: 1, intervalMs: 900_000, reconciliation: recon(5_027.7, false) }, 1);
  assert.equal(l.reconciliation!.tone, 'watch');
  assert.deepEqual(l.short.tone, 'watch', 'the problem is in the short line, never behind "details"');
  assert.match(l.short.text, /^Off the contract by \$5,027\.70, beyond the known \$27\.70 ± \$1/);
  assert.match(l.reconciliation!.text, /^Rebuilt and contract differ by \$5,027\.70 at block 111,028,717, outside the known \$27\.70 ± \$1: a movement the rebuild does not explain/);
});

test('a failed scan and a scan not yet run both say so', () => {
  const failed = treasuryLines({ throughBlock: 9, scannedAtMs: 1_000, intervalMs: 900_000, lastError: 'the RPC timed out', lastErrorAtMs: 61_000 }, 181_000);
  assert.equal(failed.scan.tone, 'watch');
  assert.match(failed.scan.text, /The last scan failed 2 min ago \(the RPC timed out\); it retries every 15 min\.$/);
  assert.equal(failed.reconciliation, undefined, 'no reconciliation is invented');
  assert.equal(failed.short.tone, 'watch');
  assert.match(failed.short.text, /not yet checked against the contract · scanned 3 min ago · last scan failed$/);
  const first = treasuryLines({ throughBlock: 9, scannedAtMs: undefined, intervalMs: 900_000 }, 1);
  assert.match(first.scan.text, /the first scan since start-up has not finished/);
});

test('the balance before a window takes out the treasury movements inside it, not only collateral', () => {
  const moves = [
    { atMs: 100, ausd: -300 },
    { atMs: 500, ausd: 100 },
  ];
  assert.equal(balanceBefore(1_000, 50, moves, 400), 1_000 - 50 - 100);
  assert.equal(balanceBefore(1_000, 50, moves, undefined), 1_000 - 50 + 200, 'All: every movement');
});
