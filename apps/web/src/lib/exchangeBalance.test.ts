import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProtocolTreasuryDays } from '@perpguard/shared';
import { balanceBefore, balanceCheck, rebuiltBalance } from './exchangeBalance.ts';

const D = (n: number) => Date.UTC(2026, 6, n);
const treasury = (days: ProtocolTreasuryDays['days'], movements: ProtocolTreasuryDays['movements'] = []): ProtocolTreasuryDays => ({ throughBlock: 1, days, movements, lastEventAtMs: undefined });

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

test('the check states both figures; 27.70 apart out of 3.84M matches, 1% does not', () => {
  const ok = balanceCheck(3_838_349.21, 3_838_376.91);
  assert.equal(ok.gapAusd.toFixed(2), '27.70');
  assert.equal(ok.matches, true);
  assert.equal(balanceCheck(3_800_000, 3_838_376.91).matches, false);
});

test('the balance before a window takes out the treasury movements inside it, not only collateral', () => {
  const moves = [
    { atMs: 100, ausd: -300 },
    { atMs: 500, ausd: 100 },
  ];
  assert.equal(balanceBefore(1_000, 50, moves, 400), 1_000 - 50 - 100);
  assert.equal(balanceBefore(1_000, 50, moves, undefined), 1_000 - 50 + 200, 'All: every movement');
});
