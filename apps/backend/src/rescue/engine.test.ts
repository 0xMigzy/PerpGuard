import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RescueEngine, type RescueAccount } from './engine.ts';
import { InMemoryAutomationStore } from './automation.ts';
import { InMemoryRescueStore, type NewRule } from './store.ts';
import { renderRescue, type RescueNotice } from './render.ts';
import type { ActionCommand, ActionOutcome } from '../actions/types.ts';
import type { ActionAvailability } from '@perpguard/shared';
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
  /** Moves the test clock inside the executor, as pre-flight's awaits would. */
  clockStep: (() => void) | undefined;
  snapshot(): readonly RiskAssessment[] {
    return [{ marketId: 16, symbol: 'BTC', side: 'long', positionId: PID, state: 'DANGER', liqBufferPct: this.buffer, marginCNS: this.margin, markPricePNS: 855_952n } as unknown as RiskAssessment];
  }
  feedConnected(): boolean {
    return true;
  }
  /** The fully loaded list of open position ids; `live = false` means not loaded. */
  open = new Set<number>([PID]);
  openPositionIds(): ReadonlySet<number> | undefined {
    return this.live ? this.open : undefined;
  }
  availabilityAnswer: ActionAvailability = { actionable: true, network: 'testnet', marketId: 16 };
  availabilityAsked = 0;
  async availability(): Promise<ActionAvailability> {
    this.availabilityAsked += 1;
    return this.availabilityAnswer;
  }
  freeFloorCNS(): bigint | undefined {
    return this.floor;
  }
  async execute(c: ActionCommand): Promise<ActionOutcome> {
    this.commands.push(c);
    this.during(c);
    this.clockStep?.();
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
  // Like the exchange: the free balance pays for it.
  if (acct.floor !== undefined) acct.floor -= amount;
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
  acct.clockStep = () => {
    clock.t += 5;
  };
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
  assert.ok(a.sentAtMs !== undefined && a.sentAtMs > a.triggeredAtMs, 'sent_at is the moment of the send, after the trigger and the claim');
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
  const html = renderRescue(n, 6).html;
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
  const html = renderRescue(handovers[0]!, 6).html;
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
  r.acct.open = new Set();
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

// ── 7 Oct 2026: the account-wide floor, reservations, retired markets, proof of "gone" ──

/** Two positions on one account, and an exchange whose balance falls only when told to (the real lag). */
class TwoPositions implements RescueAccount {
  floor: bigint | undefined;
  /** When false, an applied top-up does NOT lower the floor until `catchUp()`: the seconds before the exchange reports it. */
  balanceFollows = true;
  pendingDebits: bigint[] = [];
  commands: ActionCommand[] = [];
  respond: (c: ActionCommand) => ActionOutcome = (c) => this.#applied(c);
  constructor(floorAusd: bigint) {
    this.floor = floorAusd * AUSD;
  }
  snapshot(): readonly RiskAssessment[] {
    return [16, 32].map((marketId, i) => ({ marketId, symbol: marketId === 16 ? 'BTC' : 'ETH', positionId: i + 1, state: 'DANGER', liqBufferPct: 0.02, marginCNS: 100n * AUSD, markPricePNS: 1n }) as unknown as RiskAssessment);
  }
  feedConnected(): boolean {
    return true;
  }
  openPositionIds(): ReadonlySet<number> {
    return new Set([1, 2]);
  }
  freeFloorCNS(): bigint | undefined {
    return this.floor;
  }
  async availability(): Promise<ActionAvailability> {
    return { actionable: true, network: 'testnet', marketId: 16 };
  }
  async execute(c: ActionCommand): Promise<ActionOutcome> {
    this.commands.push(c);
    await new Promise((r) => setTimeout(r, 5));
    return this.respond(c);
  }
  catchUp(): void {
    for (const d of this.pendingDebits.splice(0)) this.floor = (this.floor ?? 0n) - d;
  }
  #applied(c: ActionCommand): ActionOutcome {
    const amount = c.kind === 'add-margin' ? c.amountCNS : 0n;
    if (this.balanceFollows) this.floor = (this.floor ?? 0n) - amount;
    else this.pendingDebits.push(amount);
    return { kind: 'applied', command: c, at: 0, detail: '', reported: { status: 'rejected', reason: 'sr 32', venueRef: undefined }, reconciliation: { verdict: 'applied', field: 'margin', requested: amount, before: 100n * AUSD, after: 100n * AUSD + amount, delta: amount, detail: '' } };
  }
}

function twoRig(floorAusd: bigint) {
  const clock = { t: 1_000_000 };
  const store = new InMemoryRescueStore();
  const acct = new TwoPositions(floorAusd);
  const notices: RescueNotice[] = [];
  const logs: string[] = [];
  const engine = new RescueEngine({
    store,
    automation: new InMemoryAutomationStore(() => clock.t),
    account: () => acct,
    notify: async (_id, n) => void notices.push(n),
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    now: () => clock.t,
    remeasureMs: 0,
    transientHoldMs: 0,
  });
  const rules = async () => {
    for (const [marketId, positionId, symbol] of [[16, 1, 'BTC'], [32, 2, 'ETH']] as const) {
      await store.create(newRule({ marketId, positionId, symbol }), clock.t);
    }
  };
  const look = async () => {
    await engine.tick();
    clock.t += 1_000;
    await engine.tick();
    await engine.settle();
    await new Promise((r) => setTimeout(r, 20));
    await engine.tick();
    await engine.settle();
  };
  return { clock, store, acct, notices, logs, engine, rules, look };
}

test('THE FLOOR IS ACCOUNT-WIDE: two positions triggering together cannot take the account below its minimum', async () => {
  // 540 free, 500 kept, 25 each: either alone leaves 515, both would leave 490.
  const r = twoRig(540n);
  await r.rules();
  await r.look();
  assert.equal(r.acct.commands.length, 1, 'exactly one send');
  assert.ok((r.acct.floor ?? 0n) >= 500n * AUSD, `the account is at ${(r.acct.floor ?? 0n) / AUSD} AUSD`);
  assert.ok(r.notices.some((n) => n.kind === 'held' && n.reason === 'balance-low'), 'the other position is told it waits');
});

test('RESERVATION, APPLIED: while the exchange lags, the sent amount stays reserved, so the lag cannot let a second rescue through', async () => {
  // 540 free, room for one. The exchange has NOT yet reported the first top-up,
  // so its figure still says 540: without the reservation the second would go.
  const r = twoRig(540n);
  r.acct.balanceFollows = false;
  await r.rules();
  await r.look();
  assert.equal(r.acct.commands.length, 1);
  assert.equal(r.acct.floor, 540n * AUSD, 'the exchange has not caught up');
  assert.equal(r.engine.reservedCNS(710), 25n * AUSD, 'so the amount is still reserved');
  r.acct.catchUp();
  await r.look();
  assert.equal(r.engine.reservedCNS(710), 0n, 'released once the exchange shows it');
  assert.ok(r.logs.some((l) => /reservation released \(applied, and the exchange balance has caught up\)/.test(l)));
  assert.equal(r.acct.commands.length, 1, 'and still only one: 515 left, a second would go below 500');
  assert.ok((r.acct.floor ?? 0n) >= 500n * AUSD);
});

test('RESERVATION: with room for both, both go, and each is reserved until the exchange shows it', async () => {
  const r = twoRig(600n);
  r.acct.balanceFollows = false;
  await r.rules();
  await r.look();
  assert.equal(r.acct.commands.length, 2);
  assert.equal(r.engine.reservedCNS(710), 50n * AUSD);
  r.acct.catchUp();
  await r.engine.tick();
  assert.equal(r.engine.reservedCNS(710), 0n);
  assert.equal(r.acct.floor, 550n * AUSD);
});

test('RESERVATION, REFUSED: a send refused before sending releases its amount, and the next rescue can use it', async () => {
  // 530 free, 500 kept, 25: room for exactly one. Refuse the first; if its 25
  // leaked as a hold, the retry would see 505 - 25 = 480 and wait forever.
  const r = rig();
  r.acct.floor = 530n * AUSD;
  await r.store.create(newRule(), r.clock.t);
  let refuseNext = true;
  r.acct.respond = (c) => {
    if (refuseNext) {
      refuseNext = false;
      return { kind: 'refused', command: c, at: 0, code: 'feed-down', detail: 'the feed dropped' };
    }
    return applied(c, r.acct);
  };
  await r.fireTwice();
  assert.equal(r.engine.reservedCNS(710), 0n, 'nothing was sent, so nothing is held');
  r.clock.t += 61_000;
  await r.fireTwice();
  assert.equal(r.acct.commands.length, 2);
  assert.equal(r.store.attempts(1).at(-1)?.outcome, 'applied', 'the retry used the amount the refusal gave back');
});

test('RESERVATION, UNKNOWN: held (the money may have left), and gone after a restart', async () => {
  const r = twoRig(600n);
  await r.rules();
  r.acct.respond = (c) => ({ kind: 'unknown', command: c, at: 0, detail: 'gone', reported: { status: 'timeout', reason: undefined, venueRef: undefined }, reconciliation: undefined, nextStep: 'Check the position.' });
  await r.look();
  // 600 had room for both, so both went, and neither can be confirmed.
  assert.equal(r.engine.reservedCNS(710), 50n * AUSD, 'unknown: still held');
  r.clock.t += 60 * 60_000;
  await r.engine.tick();
  assert.equal(r.engine.reservedCNS(710), 50n * AUSD, 'no timer releases an unknown');
  // A restart: a new engine over the same store trusts the exchange balance alone.
  const after = new RescueEngine({ store: r.store, automation: new InMemoryAutomationStore(), account: () => r.acct, notify: async () => {}, logger: { info: () => {}, warn: () => {} } });
  assert.equal(after.reservedCNS(710), 0n, 'no phantom hold survives a restart');
});

test('GONE ONLY ON PROOF: after a restart with no price feed yet, the rule survives and never says "closed"', async () => {
  const r = rig();
  const rule = await r.store.create(newRule(), r.clock.t);
  // A fresh process: the position list is loaded (the position IS open), no price has arrived, so no reading.
  r.acct.snapshot = () => [];
  for (let i = 0; i < 40; i++) {
    r.clock.t += 1_000;
    await r.engine.tick();
  }
  assert.equal(r.store.rule(rule.id)?.enabled, true, 'still on');
  assert.equal(r.notices.some((n) => n.kind === 'ended'), false, 'never ended');
  const said = r.notices.map((n) => renderRescue(n, 6).html).join('\n');
  assert.doesNotMatch(said, /no longer open|RESCUE ENDED/i);
  assert.ok(r.notices.some((n) => n.kind === 'held' && n.reason === 'unassessed'), 'it says it cannot price it yet (after 30 s)');
  assert.match(said, /It is not closed/);
});

test('RETIRED MARKET: the rule ends itself, says it is the MARKET, writes no attempt row, and claims nothing about the position', async () => {
  const r = rig();
  const rule = await r.store.create(newRule({ marketId: 30, symbol: 'SOL' }), r.clock.t);
  r.acct.snapshot = () => [{ marketId: 30, symbol: 'SOL', positionId: PID, state: 'DANGER', liqBufferPct: 0.02, marginCNS: 1n, markPricePNS: 1n } as unknown as RiskAssessment];
  r.acct.availabilityAnswer = { actionable: false, network: 'mainnet', code: 'not-listed-on-acting-network', reason: 'SOL (market 30) is not listed' };
  await r.fireTwice();
  assert.equal(r.acct.commands.length, 0);
  assert.equal(r.store.attempts(rule.id).length, 0, 'no attempt row');
  assert.equal(r.store.rule(rule.id)?.enabled, false);
  const ended = r.notices.find((n) => n.kind === 'ended');
  assert.ok(ended !== undefined && ended.kind === 'ended' && ended.cause === 'market');
  const html = renderRescue(ended, 6).html;
  assert.match(html, /no longer lists SOL \(market 30\)/);
  assert.match(html, /says nothing about the position itself/);
  assert.doesNotMatch(html, /no longer open/);
});

test('CLOSED MARKET: waits without a row a minute — no attempt row at all, one message', async () => {
  const r = rig();
  const rule = await r.store.create(newRule(), r.clock.t);
  r.acct.availabilityAnswer = { actionable: false, network: 'testnet', code: 'market-closed', reason: 'BTC is closed' };
  for (let i = 0; i < 30; i++) {
    r.clock.t += 61_000;
    await r.fireTwice();
  }
  assert.equal(r.store.attempts(rule.id).length, 0);
  assert.equal(r.acct.commands.length, 0);
  assert.equal(r.notices.filter((n) => n.kind === 'held' && n.reason === 'market-closed').length, 1);
  r.acct.availabilityAnswer = { actionable: true, network: 'testnet', marketId: 16 };
  r.clock.t += 61_000;
  await r.fireTwice();
  assert.equal(r.acct.commands.length, 1, 'reopened: it acts');
});

test('A DEAD CAUSE IS CAPPED: the same refusal twice pauses the rule; two rows, never one a minute', async () => {
  const r = rig();
  const rule = await r.store.create(newRule(), r.clock.t);
  r.acct.respond = (c) => ({ kind: 'refused', command: c, at: 0, code: 'not-actionable', detail: 'nope' });
  for (let i = 0; i < 20; i++) {
    r.clock.t += 61_000;
    await r.fireTwice();
  }
  assert.equal(r.store.attempts(rule.id).length, 2);
  assert.match(r.store.rule(rule.id)?.pausedReason ?? '', /refused twice: not-actionable/);
  assert.equal(r.notices.filter((n) => n.kind === 'paused-refused').length, 1);
});

test('THE HANDOVER IS SAID ONCE: the rule ends, and a recovery and a second dip say nothing more', async () => {
  const r = rig();
  const rule = await r.store.create(newRule({ maxRescues: 1 }), r.clock.t);
  await r.fireTwice();
  r.acct.buffer = 0.02;
  r.clock.t += 20 * 60_000;
  await r.fireTwice();
  r.acct.buffer = 0.06; // recovers
  await r.fireTwice();
  r.acct.buffer = 0.02; // and dips again
  r.clock.t += 20 * 60_000;
  await r.fireTwice();
  assert.equal(r.notices.filter((n) => n.kind === 'exhausted').length, 1);
  assert.equal(r.store.rule(rule.id)?.enabled, false);
  assert.equal(r.store.rule(rule.id)?.pausedReason, 'limits reached');
  assert.equal(r.acct.commands.length, 1);
});
