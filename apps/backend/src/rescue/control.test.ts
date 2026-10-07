import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RescueControlService, type RescueDraftInput } from './control.ts';
import { InMemoryAutomationStore } from './automation.ts';
import { InMemoryRescueStore } from './store.ts';
import type { RiskAssessment } from '../risk/types.ts';

const PID = 4508933292033;
const open = [{ marketId: 16, symbol: 'BTC', positionId: PID, liqBufferPct: 0.0316 } as RiskAssessment];
const draft = (o: Partial<RescueDraftInput> = {}): RescueDraftInput => ({ marketId: 16, positionId: PID, triggerPct: 0.04, amountCNS: 25_000_000n, maxRescues: 2, maxTotalCNS: 50_000_000n, minRemainingCNS: 500_000_000n, cooldownMs: 900_000, ...o });

function rig(snapshot: readonly RiskAssessment[] | 'no-session' = open) {
  const store = new InMemoryRescueStore();
  const automation = new InMemoryAutomationStore();
  return { store, automation, control: new RescueControlService({ store, automation, collateralDecimals: 6, snapshot: () => (snapshot === 'no-session' ? undefined : snapshot) }) };
}

test('enable creates the rule with its four limits as sent, and moves the account into Rescue', async () => {
  const r = rig();
  const res = await r.control.enable(710, draft());
  assert.equal(res.ok, true);
  const [rule] = r.store.enabledRules();
  assert.equal(rule?.maxTotalCNS, 50_000_000n);
  assert.equal(rule?.triggerPct, 0.04);
  assert.equal(r.automation.get(710).mode, 'LIQUIDATION_RESCUE');
});

test('SERVER-SIDE: a draft for a position that is gone, or replaced by a new one, is refused', async () => {
  assert.equal((await rig([]).control.enable(710, draft())).ok, false);
  assert.equal((await rig([{ ...open[0]!, positionId: 1 }]).control.enable(710, draft())).ok, false);
  assert.equal((await rig('no-session').control.enable(710, draft())).ok, false);
});

test('SERVER-SIDE: every limit is checked, whatever the screens allowed', async () => {
  const r = rig();
  for (const bad of [{ triggerPct: 0.5 }, { triggerPct: undefined }, { amountCNS: 0n }, { maxRescues: 0 }, { maxTotalCNS: 10_000_000n }, { cooldownMs: 0 }, { minRemainingCNS: -1n }]) {
    assert.equal((await r.control.enable(710, draft(bad))).ok, false, JSON.stringify(bad, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
  }
  assert.equal(r.store.enabledRules().length, 0);
});

test('ONE AUTOMATION AT A TIME: Copy Trading running refuses Rescue', async () => {
  const r = rig();
  await r.automation.transition(710, 'NONE', 'COPY_TRADING');
  const res = await r.control.enable(710, draft());
  assert.equal(res.ok, false);
  assert.match(res.text, /Copy Trading/);
});

test('a second enable on the same position REPLACES the rule, never stacks it', async () => {
  const r = rig();
  await r.control.enable(710, draft());
  await r.control.enable(710, draft({ amountCNS: 100_000_000n, maxTotalCNS: 200_000_000n }));
  const on = r.store.enabledRules();
  assert.equal(on.length, 1);
  assert.equal(on[0]?.amountCNS, 100_000_000n);
});

test('stop turns it off and frees the mode; resume clears only a self-imposed pause', async () => {
  const r = rig();
  await r.control.enable(710, draft());
  const rule = r.store.enabledRules()[0]!;
  await r.store.update(rule.id, { pausedReason: 'unknown outcome', rescueCount: 1 });
  assert.equal((await r.control.resume(710, 16)).ok, true);
  assert.equal(r.store.rule(rule.id)?.pausedReason, undefined);
  assert.equal(r.store.rule(rule.id)?.rescueCount, 1, 'counts kept');
  await r.control.disable(710, 16);
  assert.equal(r.store.enabledRules().length, 0);
  assert.equal(r.automation.get(710).mode, 'NONE');
});

// ── spec 79: the critical concurrency test ─────────────────────────────────

test('SPEC 79: Rescue active -> Copy must fail; Copy active -> Rescue must fail; both at once -> exactly one succeeds', async () => {
  const active = rig();
  assert.equal((await active.control.enable(710, draft())).ok, true);
  assert.equal(await active.automation.transition(710, 'NONE', 'COPY_TRADING'), false, 'Rescue active: Copy fails');

  const copying = rig();
  await copying.automation.transition(710, 'NONE', 'COPY_TRADING');
  assert.equal((await copying.control.enable(710, draft())).ok, false, 'Copy active: Rescue fails');

  for (let round = 0; round < 50; round++) {
    const r = rig();
    const [rescue, copy] = await Promise.all([r.control.enable(710, draft()), r.automation.transition(710, 'NONE', 'COPY_TRADING')]);
    assert.equal(Number(rescue.ok) + Number(copy), 1, `round ${round}: exactly one of the two, never both`);
    assert.equal(r.automation.get(710).mode, rescue.ok ? 'LIQUIDATION_RESCUE' : 'COPY_TRADING');
    assert.equal(r.store.enabledRules().length, rescue.ok ? 1 : 0, 'a refused Rescue leaves no rule behind');
  }
});
