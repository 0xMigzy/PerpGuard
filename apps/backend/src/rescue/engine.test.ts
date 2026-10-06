import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RescueEngine, type RescueAccount } from './engine.ts';
import { InMemoryAutomationStore } from './automation.ts';
import { InMemoryRescueStore, type NewRule } from './store.ts';
import { renderRescue, type RescueNotice } from './render.ts';
import type { ActionCommand, ActionOutcome } from '../actions/types.ts';
import type { RiskAssessment } from '../risk/types.ts';

const AUSD = 1_000_000n;
const PID = 4508933292033;

const newRule = (o: Partial<NewRule> = {}): NewRule => ({
  accountId: 710,
  marketId: 16,
  symbol: 'BTC',
  positionId: PID,
  triggerPct: 0.04,
  amountCNS: 25n * AUSD,
  maxRescues: 2,
  maxTotalCNS: 200n * AUSD,
  minRemainingCNS: 500n * AUSD,
  cooldownMs: 15 * 60_000,
  ...o,
});

class FakeAccount implements RescueAccount {
  buffer = 0.0316;
  margin = 122_280_000n;
  floor: bigint | undefined = 9_762n * AUSD;
  live = true;
  commands: ActionCommand[] = [];
  respond: (c: ActionCommand) => ActionOutcome = (c) => applied(c, this);
  /** Lets a test act while the executor is "awaiting". */
  during: (c: ActionCommand) => void = () => {};
  snapshot(): readonly RiskAssessment[] {
    return [{ marketId: 16, symbol: 'BTC', side: 'long', positionId: PID, state: 'DANGER', liqBufferPct: this.buffer, marginCNS: this.margin, markPricePNS: 855_952n } as unknown as RiskAssessment];
  }
  feedConnected(): boolean {
    return true;
  }
  positionsLive(): boolean {
    return this.live;
  }
  freeFloorCNS(): bigint | undefined {
    return this.floor;
  }
  async execute(c: ActionCommand): Promise<ActionOutcome> {
    this.commands.push(c);
    this.during(c);
    const stop = c.stopCheck?.();
    if (stop !== undefined) return { kind: 'refused', command: c, at: 0, code: 'automation-stopped', detail: `${stop} Nothing was sent.` };
    return this.respond(c);
  }
}

/** The sr 32 case: the receipt says rejected, the position shows the margin. */
function applied(c: ActionCommand, acct: FakeAccount): ActionOutcome {
  const amount = c.kind === 'add-margin' ? c.amountCNS : 0n;
  const before = acct.margin;
  acct.margin += amount;
  acct.buffer = 0.05;
  return {
    kind: 'applied',
    command: c,
    at: 0,
    detail: 'LANDED; the venue reported it as rejected, the normal report for a top-up that worked',
    reported: { status: 'rejected', reason: 'st: 7 Failed, sr: 32 OrderDescIdTooLow', venueRef: 'rq 21' },
    reconciliation: { verdict: 'applied', field: 'margin', requested: amount, before, after: before + amount, delta: amount, detail: '' },
  };
}

function rig(o: { clock?: { t: number } } = {}) {
  const clock = o.clock ?? { t: 1_000_000 };
  const store = new InMemoryRescueStore();
  const automation = new InMemoryAutomationStore(() => clock.t);
  const acct = new FakeAccount();
  const notices: RescueNotice[] = [];
  const logs: string[] = [];
  const engine = new RescueEngine({
    store,
    automation,
    account: (id) => (id === 710 ? acct : undefined),
    notify: async (_id, n) => {
      notices.push(n);
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    now: () => clock.t,
    sleep: async () => {
      clock.t += 10;
    },
    remeasureMs: 1_000,
    transientHoldMs: 30_000,
  });
  /** Two looks a second apart, then let the attempt finish. */
  const fireTwice = async () => {
    await engine.tick();
    clock.t += 1_000;
    await engine.tick();
    await engine.settle();
  };
  return { clock, store, automation, acct, notices, logs, engine, fireTwice };
}

test('THE LIVE-FIRE SHAPE: 25 AUSD at a 4% trigger, sr 32, one send, applied off the position, every field recorded', async () => {
  const r = rig();
  const rule = await r.store.create(newRule(), r.clock.t);
  await r.engine.tick();
  assert.equal(r.acct.commands.length, 0, 'the first look only arms');
  await r.fireTwice();

  assert.equal(r.acct.commands.length, 1, 'exactly one send');
  const c = r.acct.commands[0]!;
  assert.equal(c.kind, 'add-margin');
  assert.ok(c.kind === 'add-margin' && c.amountCNS === 25n * AUSD);
  assert.equal(c.idempotencyKey, `rescue:710:${PID}:${rule.id}:1`);

  const [a] = r.store.attempts(rule.id);
  assert.ok(a);
  assert.equal(a.attemptNo, 1);
  assert.equal(a.triggerDistancePct, 0.0316);
  assert.equal(a.amountCNS, 25n * AUSD);
  // RECEIPT and VERIFIED OUTCOME, separate, and they disagree.
  assert.equal(a.receiptStatus, 'rejected');
  assert.match(a.receiptReason ?? '', /sr: 32/);
  assert.equal(a.outcome, 'applied');
  assert.equal(a.marginBeforeCNS, 122_280_000n);
  assert.equal(a.marginAfterCNS, 147_280_000n);
  assert.equal(a.appliedCNS, 25n * AUSD);
  assert.equal(a.distanceAfterPct, 0.05, 're-measured off the loop, not computed');

  const after = r.store.rule(rule.id)!;
  assert.equal(after.rescueCount, 1);
  assert.equal(after.totalRescuedCNS, 25n * AUSD);

  const n = r.notices.at(-1)!;
  assert.equal(n.kind, 'rescued');
  const html = renderRescue(n).html;
  assert.match(html, /POSITION RESCUED/);
  assert.match(html, /Margin: <b>122 AUSD<\/b> → <b>147 AUSD<\/b>/);
  assert.match(html, /Rescues: 1 \/ 2/);
  assert.match(html, /The margin applied — I checked the position itself, not the receipt\./);
  assert.doesNotMatch(html, /failed|rejection/i);
});

test('one attempt in flight per rule: ticks during a slow send do not send again', async () => {
  const r = rig();
  await r.store.create(newRule(), r.clock.t);
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const respond = r.acct.respond;
  r.acct.respond = (c) => respond(c);
  const slowExecute = r.acct.execute.bind(r.acct);
  r.acct.execute = async (c) => {
    await gate;
    return slowExecute(c);
  };
  await r.engine.tick();
  r.clock.t += 1_000;
  await r.engine.tick();
  await r.engine.tick();
  await r.engine.tick();
  release();
  await r.engine.settle();
  assert.equal(r.acct.commands.length, 1);
});

test('KILL SWITCH ON before the trigger: nothing is claimed, nothing sent, and the person is told once', async () => {
  const r = rig();
  const rule = await r.store.create(newRule(), r.clock.t);
  await r.automation.setKillSwitch(710, true);
  await r.fireTwice();
  await r.engine.tick();
  assert.equal(r.acct.commands.length, 0);
  assert.equal(r.store.attempts(rule.id).length, 0);
  assert.deepEqual(r.notices.map((n) => n.kind), ['held']);
});

test('KILL SWITCH flipped WHILE IN FLIGHT: the executor\'s last gate stops the send; the row says refused', async () => {
  const r = rig();
  const rule = await r.store.create(newRule(), r.clock.t);
  r.acct.during = () => void r.automation.setKillSwitch(710, true);
  await r.fireTwice();
  const [a] = r.store.attempts(rule.id);
  assert.equal(a?.outcome, 'refused');
  assert.equal(a?.receiptReason, 'automation-stopped');
  assert.equal(a?.sentAtMs, undefined, 'never sent');
  assert.equal(r.store.rule(rule.id)?.rescueCount, 0);
  assert.equal(r.store.rule(rule.id)?.lastAttemptAtMs, undefined, 'no cooldown for something never sent');
});

test('UNKNOWN pauses the rule, counts against the limits as if it landed, and never sends again', async () => {
  const r = rig();
  const rule = await r.store.create(newRule(), r.clock.t);
  r.acct.respond = (c) => ({ kind: 'unknown', command: c, at: 0, detail: 'gone', reported: { status: 'timeout', reason: undefined, venueRef: undefined }, reconciliation: undefined, nextStep: 'Check the position before adding anything.' });
  await r.fireTwice();
  for (let i = 0; i < 5; i++) {
    r.clock.t += 20 * 60_000;
    await r.engine.tick();
    await r.engine.settle();
  }
  assert.equal(r.acct.commands.length, 1);
  const after = r.store.rule(rule.id)!;
  assert.equal(after.pausedReason, 'unknown outcome');
  assert.equal(after.rescueCount, 1);
  assert.equal(after.totalRescuedCNS, 25n * AUSD);
  assert.equal(r.notices.at(-1)?.kind, 'paused');
});

test('THE HANDOVER: limits spent and still falling says it once, with every figure the owner asked for', async () => {
  const r = rig();
  const rule = await r.store.create(newRule({ maxRescues: 1 }), r.clock.t);
  await r.fireTwice();
  r.acct.buffer = 0.02; // still falling after the rescue
  r.clock.t += 20 * 60_000;
  await r.fireTwice();
  await r.fireTwice();
  assert.equal(r.acct.commands.length, 1);
  const handovers = r.notices.filter((n) => n.kind === 'exhausted');
  assert.equal(handovers.length, 1, 'said once');
  const html = renderRescue(handovers[0]!).html;
  assert.match(html, /OVER TO YOU/);
  assert.match(html, /Rescues used: 1 \/ 1/);
  assert.match(html, /Total added: <b>25 AUSD<\/b> of a <b>200 AUSD<\/b> cap/);
  assert.match(html, /2\.0% from being closed/);
  assert.match(html, /PerpGuard has stopped adding margin/);
  assert.match(html, /Add margin yourself/);
  assert.match(html, /Reduce the position/);
  assert.match(html, /Close it/);
  assert.doesNotMatch(html, /fail/i);
  assert.equal(r.store.rule(rule.id)?.lastNotice, 'exhausted');
});

test('MAX TOTAL stops a rule before MAX RESCUES does', async () => {
  const r = rig();
  await r.store.create(newRule({ maxRescues: 5, maxTotalCNS: 50n * AUSD }), r.clock.t);
  for (let i = 0; i < 4; i++) {
    r.acct.buffer = 0.02;
    r.clock.t += 20 * 60_000;
    await r.fireTwice();
  }
  assert.equal(r.acct.commands.length, 2, '2 x 25 = the 50 cap; the third would pass it');
  assert.ok(r.notices.some((n) => n.kind === 'exhausted'));
});

test('COOLDOWN: a second rescue waits 15 minutes, and the wait is said once', async () => {
  const r = rig();
  await r.store.create(newRule(), r.clock.t);
  await r.fireTwice();
  r.acct.buffer = 0.02;
  await r.fireTwice();
  await r.fireTwice();
  assert.equal(r.acct.commands.length, 1);
  assert.equal(r.notices.filter((n) => n.kind === 'held').length, 1);
  r.clock.t += 15 * 60_000;
  await r.fireTwice();
  assert.equal(r.acct.commands.length, 2);
});

test('the minimum kept is never spent: held, never a smaller amount', async () => {
  const r = rig();
  await r.store.create(newRule(), r.clock.t);
  r.acct.floor = 520n * AUSD;
  await r.fireTwice();
  assert.equal(r.acct.commands.length, 0);
  const n = r.notices.at(-1);
  assert.ok(n?.kind === 'held' && n.reason === 'balance-low');
});

test('a transient hold (balance not known yet at boot) is said only once it has lasted 30 s', async () => {
  const r = rig();
  await r.store.create(newRule(), r.clock.t);
  r.acct.floor = undefined;
  await r.fireTwice();
  assert.equal(r.notices.length, 0);
  r.clock.t += 30_000;
  await r.engine.tick();
  assert.equal(r.notices.length, 1);
});

test('a refusal waits a minute before the rule is judged again: nothing loops', async () => {
  const r = rig();
  await r.store.create(newRule(), r.clock.t);
  r.acct.respond = (c) => ({ kind: 'refused', command: c, at: 0, code: 'not-actionable', detail: 'market closed' });
  await r.fireTwice();
  for (let i = 0; i < 30; i++) {
    r.clock.t += 1_000;
    await r.engine.tick();
    await r.engine.settle();
  }
  assert.equal(r.acct.commands.length, 1);
  r.clock.t += 31_000;
  await r.engine.tick();
  await r.engine.settle();
  assert.equal(r.acct.commands.length, 2);
});

test('the position closed ends the rule and frees the automation mode', async () => {
  const r = rig();
  const rule = await r.store.create(newRule(), r.clock.t);
  await r.automation.transition(710, 'NONE', 'LIQUIDATION_RESCUE');
  r.acct.snapshot = () => [];
  await r.engine.tick();
  assert.equal(r.store.rule(rule.id)?.enabled, false);
  assert.equal(r.automation.get(710).mode, 'NONE');
  assert.equal(r.notices.at(-1)?.kind, 'ended');
});

test('a claim is unique: the same (rule, attempt) cannot be claimed twice', async () => {
  const store = new InMemoryRescueStore();
  const rule = await store.create(newRule(), 0);
  const claim = { ruleId: rule.id, attemptNo: 1, idempotencyKey: 'k', accountId: 710, marketId: 16, positionId: PID, triggerDistancePct: 0.03, triggerMark: '1', triggeredAtMs: 0, amountCNS: 1n };
  assert.equal(await store.claim(claim), true);
  assert.equal(await store.claim(claim), false);
});
