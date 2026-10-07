import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RescueControlService, type RescueDraftInput } from './control.ts';
import { ArmSigner } from './arming.ts';

/** The tap that arms: the linked person, from their own chat. */
const TAP = { telegramUserId: 7, chatId: 7 };
import { InMemoryAutomationStore } from './automation.ts';
import { InMemoryRescueStore } from './store.ts';
import type { RiskAssessment } from '../risk/types.ts';

const PID = 4508933292033;
const open = [{ marketId: 16, symbol: 'BTC', positionId: PID, liqBufferPct: 0.0316 } as RiskAssessment];
const draft = (o: Partial<RescueDraftInput> = {}): RescueDraftInput => ({ marketId: 16, positionId: PID, triggerPct: 0.04, amountCNS: 25_000_000n, maxRescues: 2, maxTotalCNS: 50_000_000n, minRemainingCNS: 500_000_000n, cooldownMs: 900_000, ...o });

function rig(snapshot: readonly RiskAssessment[] | 'no-session' = open) {
  const store = new InMemoryRescueStore();
  const automation = new InMemoryAutomationStore();
  return { store, automation, control: new RescueControlService({ store, automation, collateralDecimals: 6, signer: new ArmSigner('11'.repeat(32)), isLinked: (tg, chat, acct) => tg === 7 && chat === 7 && acct === 710, alertPctOf: () => 4, snapshot: () => (snapshot === 'no-session' ? undefined : snapshot) }) };
}

test('enable creates the rule with its four limits as sent, and moves the account into Rescue', async () => {
  const r = rig();
  const res = await r.control.enable(710, draft(), TAP);
  assert.equal(res.ok, true);
  const [rule] = r.store.enabledRules();
  assert.equal(rule?.maxTotalCNS, 50_000_000n);
  assert.equal(rule?.triggerPct, 0.04);
  assert.equal(r.automation.get(710).mode, 'LIQUIDATION_RESCUE');
});

test('SERVER-SIDE: a draft for a position that is gone, or replaced by a new one, is refused', async () => {
  assert.equal((await rig([]).control.enable(710, draft(), TAP)).ok, false);
  assert.equal((await rig([{ ...open[0]!, positionId: 1 }]).control.enable(710, draft(), TAP)).ok, false);
  assert.equal((await rig('no-session').control.enable(710, draft(), TAP)).ok, false);
});

test('SERVER-SIDE: every limit is checked, whatever the screens allowed', async () => {
  const r = rig();
  // The trigger is no longer the screen's to set (it is the alert distance), so it is not in this list.
  for (const bad of [{ amountCNS: 0n }, { maxRescues: 0 }, { maxTotalCNS: 10_000_000n }, { cooldownMs: 0 }, { minRemainingCNS: -1n }]) {
    assert.equal((await r.control.enable(710, draft(bad), TAP)).ok, false, JSON.stringify(bad, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
  }
  assert.equal(r.store.enabledRules().length, 0);
});

test('ONE AUTOMATION AT A TIME: Copy Trading running refuses Rescue', async () => {
  const r = rig();
  await r.automation.transition(710, 'NONE', 'COPY_TRADING');
  const res = await r.control.enable(710, draft(), TAP);
  assert.equal(res.ok, false);
  assert.match(res.text, /Copy Trading/);
});

test('a second enable on the same position REPLACES the rule, never stacks it', async () => {
  const r = rig();
  await r.control.enable(710, draft(), TAP);
  await r.control.enable(710, draft({ amountCNS: 100_000_000n, maxTotalCNS: 200_000_000n }), TAP);
  const on = r.store.enabledRules();
  assert.equal(on.length, 1);
  assert.equal(on[0]?.amountCNS, 100_000_000n);
});

test('stop turns it off and frees the mode; resume clears only a self-imposed pause', async () => {
  const r = rig();
  await r.control.enable(710, draft(), TAP);
  const rule = r.store.enabledRules()[0]!;
  await r.store.update(rule.id, { pausedReason: 'unknown outcome', rescueCount: 1 });
  assert.equal((await r.control.resume(710, 16, TAP)).ok, true);
  assert.equal(r.store.rule(rule.id)?.pausedReason, undefined);
  assert.equal(r.store.rule(rule.id)?.rescueCount, 1, 'counts kept');
  await r.control.disable(710, 16);
  assert.equal(r.store.enabledRules().length, 0);
  assert.equal(r.automation.get(710).mode, 'NONE');
});

// ── spec 79: the critical concurrency test ─────────────────────────────────

test('SPEC 79: Rescue active -> Copy must fail; Copy active -> Rescue must fail; both at once -> exactly one succeeds', async () => {
  const active = rig();
  assert.equal((await active.control.enable(710, draft(), TAP)).ok, true);
  assert.equal(await active.automation.transition(710, 'NONE', 'COPY_TRADING'), false, 'Rescue active: Copy fails');

  const copying = rig();
  await copying.automation.transition(710, 'NONE', 'COPY_TRADING');
  assert.equal((await copying.control.enable(710, draft(), TAP)).ok, false, 'Copy active: Rescue fails');

  for (let round = 0; round < 50; round++) {
    const r = rig();
    const [rescue, copy] = await Promise.all([r.control.enable(710, draft(), TAP), r.automation.transition(710, 'NONE', 'COPY_TRADING')]);
    assert.equal(Number(rescue.ok) + Number(copy), 1, `round ${round}: exactly one of the two, never both`);
    assert.equal(r.automation.get(710).mode, rescue.ok ? 'LIQUIDATION_RESCUE' : 'COPY_TRADING');
    assert.equal(r.store.enabledRules().length, rescue.ok ? 1 : 0, 'a refused Rescue leaves no rule behind');
  }
});

// ── AUTO is armed by a tap, and only by a tap ───────────────────────────────

test('ARMING: only the linked person, from their own chat, can arm; the rule records who, where and when, signed', async () => {
  const r = rig();
  assert.equal((await r.control.enable(710, draft(), { telegramUserId: 8, chatId: 7 })).ok, false, 'another person');
  assert.equal((await r.control.enable(710, draft(), { telegramUserId: 7, chatId: 99 })).ok, false, 'the right person from another chat');
  assert.equal(r.store.enabledRules().length, 0);
  const res = await r.control.enable(710, draft(), TAP);
  assert.equal(res.ok, true);
  const [rule] = r.store.enabledRules();
  assert.equal(rule?.armedBy, 7);
  assert.equal(rule?.armedChat, 7);
  assert.ok(rule?.armedAtMs !== undefined);
  assert.equal(r.control.armProblem(rule!), undefined, 'a tap-armed rule verifies');
});

test('ARMING: AUTO acts at the alert distance (one number), and moves with it', async () => {
  const r = rig();
  await r.control.enable(710, draft({ triggerPct: 0.15 }), TAP);
  assert.equal(r.store.enabledRules()[0]?.triggerPct, 0.04, 'the screen cannot pick another trigger');
  await r.control.followAlertDistance(710, 0.07);
  assert.equal(r.store.enabledRules()[0]?.triggerPct, 0.07);
  assert.equal(r.control.armProblem(r.store.enabledRules()[0]!), undefined, 'moving the trigger keeps the signature valid');
});

test('ARMING: a rule written straight into the store (a script, an operator, a database insert) never verifies', async () => {
  const r = rig();
  const forged = await r.store.create({ accountId: 710, marketId: 16, symbol: 'BTC', positionId: PID, triggerPct: 0.04, amountCNS: 25_000_000n, maxRescues: 2, maxTotalCNS: 50_000_000n, minRemainingCNS: 500_000_000n, cooldownMs: 900_000, armedBy: undefined, armedChat: undefined, armedAtMs: undefined, armProof: undefined }, 0);
  assert.match(r.control.armProblem(forged) ?? '', /not armed by a tap/);
  const guessed = await r.store.create({ ...forged, armedBy: 7, armedChat: 7, armedAtMs: 1, armProof: 'a'.repeat(64) }, 0);
  assert.match(r.control.armProblem(guessed) ?? '', /signature does not verify/);
});

test('ARMING: changing any signed field after the tap (a bigger amount, another position) voids it', async () => {
  const r = rig();
  await r.control.enable(710, draft(), TAP);
  const rule = r.store.enabledRules()[0]!;
  assert.match(r.control.armProblem({ ...rule, amountCNS: rule.amountCNS * 10n }) ?? '', /does not verify/);
  assert.match(r.control.armProblem({ ...rule, positionId: rule.positionId + 1 }) ?? '', /does not verify/);
  assert.match(r.control.armProblem({ ...rule, accountId: 711 }) ?? '', /no longer linked|does not verify/);
});

test('ARMING: once the person who armed it is no longer linked, the rule is no longer acted on', async () => {
  let linked = true;
  const store = new InMemoryRescueStore();
  const automation = new InMemoryAutomationStore();
  const control = new RescueControlService({ store, automation, collateralDecimals: 6, signer: new ArmSigner('11'.repeat(32)), isLinked: (tg, chat) => linked && tg === 7 && chat === 7, alertPctOf: () => 4, snapshot: () => open });
  await control.enable(710, draft(), TAP);
  const rule = store.enabledRules()[0]!;
  assert.equal(control.armProblem(rule), undefined);
  linked = false;
  assert.match(control.armProblem(rule) ?? '', /no longer linked/);
});

test('ARMED AT THE LINE: turned on inside the alert distance, the person chooses "now" or "from the next crossing", and each is said in words', async () => {
  // open[0] is at 3.16%, inside the 4% alert distance.
  const now = rig();
  const a = await now.control.enable(710, draft(), TAP);
  assert.match(a.text, /already inside that distance, so as you chose the first top-up goes out now/);
  assert.notEqual(now.store.enabledRules()[0]!.waitForCrossing, true);

  const later = rig();
  const b = await later.control.enable(710, draft(), TAP, { fromNextCrossing: true });
  assert.match(b.text, /it acts only after the position has been back above 4\.0% and falls to it again/);
  assert.equal(later.store.enabledRules()[0]!.waitForCrossing, true);

  // Outside the line the choice means nothing: no wait is stored.
  const outside = rig([{ ...open[0]!, liqBufferPct: 0.09 } as RiskAssessment]);
  await outside.control.enable(710, draft(), TAP, { fromNextCrossing: true });
  assert.notEqual(outside.store.enabledRules()[0]!.waitForCrossing, true);
});

test('TURNING OFF WHILE A TOP-UP IS ON ITS WAY says it cannot be recalled and that its result will come', async () => {
  const store = new InMemoryRescueStore();
  const automation = new InMemoryAutomationStore();
  let busy = false;
  const control = new RescueControlService({ store, automation, collateralDecimals: 6, signer: new ArmSigner('11'.repeat(32)), isLinked: () => true, alertPctOf: () => 4, snapshot: () => open, busy: () => busy });
  await control.enable(710, draft(), TAP);
  busy = true;
  const off = await control.disable(710, 16);
  assert.match(off.text, /One top-up was already on its way when you tapped: it cannot be recalled, and you will get its result/);
  assert.doesNotMatch(off.text, /^Auto top-up is off for BTC\. Nothing more will be added automatically\./);
  await control.enable(710, draft(), TAP);
  busy = false;
  assert.match((await control.disable(710, 16)).text, /^Auto top-up is off for BTC\. Nothing more will be added automatically\./);
});
