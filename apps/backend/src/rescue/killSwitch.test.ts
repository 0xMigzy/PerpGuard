/**
 * Spec 80, the Kill Switch tests, against the real engine, stores and control
 * with only the account faked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionAvailability } from '@perpguard/shared';
import type { ActionCommand, ActionOutcome } from '../actions/types.ts';
import type { RiskAssessment } from '../risk/types.ts';
import { InMemoryAutomationStore } from './automation.ts';
import { RescueControlService } from './control.ts';
import { RescueEngine, type RescueAccount } from './engine.ts';
import { KillSwitch } from './killSwitch.ts';
import { InMemoryRescueStore, type NewRule } from './store.ts';

const AUSD = 1_000_000n;
const PID = 4508933292033;

const rule = (o: Partial<NewRule> = {}): NewRule => ({
  accountId: 710, marketId: 16, symbol: 'BTC', positionId: PID, triggerPct: 0.04, amountCNS: 25n * AUSD,
  maxRescues: 2, maxTotalCNS: 50n * AUSD, minRemainingCNS: 500n * AUSD, cooldownMs: 900_000, ...o,
});

class Account implements RescueAccount {
  commands: ActionCommand[] = [];
  /** Runs while the executor is "awaiting" pre-flight, before its last gate. */
  during: () => Promise<void> = async () => {};
  snapshot(): readonly RiskAssessment[] {
    return [{ marketId: 16, symbol: 'BTC', positionId: PID, state: 'DANGER', liqBufferPct: 0.03, marginCNS: 100n * AUSD, markPricePNS: 1n } as unknown as RiskAssessment];
  }
  feedConnected(): boolean {
    return true;
  }
  openPositionIds(): ReadonlySet<number> {
    return new Set([PID]);
  }
  freeFloorCNS(): bigint {
    return 9_000n * AUSD;
  }
  async availability(): Promise<ActionAvailability> {
    return { actionable: true, network: 'testnet', marketId: 16 };
  }
  async execute(c: ActionCommand): Promise<ActionOutcome> {
    this.commands.push(c);
    await this.during();
    // The executor's last gate, exactly as `ActionsExecutor` runs it before the one send.
    const stop = c.stopCheck?.();
    if (stop !== undefined) return { kind: 'refused', command: c, at: 0, code: 'automation-stopped', detail: `${stop} Nothing was sent.` };
    const amount = c.kind === 'add-margin' ? c.amountCNS : 0n;
    return { kind: 'applied', command: c, at: 0, detail: '', reported: { status: 'rejected', reason: 'sr 32', venueRef: undefined }, reconciliation: { verdict: 'applied', field: 'margin', requested: amount, before: 100n * AUSD, after: 100n * AUSD + amount, delta: amount, detail: '' } };
  }
  /** What actually reached the venue: commands whose last gate let them through. */
  sent(): number {
    return this.commands.filter((c) => c.stopCheck?.() === undefined).length;
  }
}

function rig(stores?: { automation: InMemoryAutomationStore; rescueStore: InMemoryRescueStore }) {
  const clock = { t: 1_000_000 };
  const automation = stores?.automation ?? new InMemoryAutomationStore(() => clock.t);
  const rescueStore = stores?.rescueStore ?? new InMemoryRescueStore();
  const account = new Account();
  const logs: string[] = [];
  const engine = new RescueEngine({ store: rescueStore, automation, account: () => account, notify: async () => {}, logger: { info: () => {}, warn: () => {} }, now: () => clock.t, remeasureMs: 0, transientHoldMs: 0 });
  const killSwitch = new KillSwitch({ automation, rescueStore, rescueEngine: engine, log: (l) => logs.push(l), now: () => clock.t, settleWaitMs: 2_000 });
  const control = new RescueControlService({ store: rescueStore, automation, collateralDecimals: 6, snapshot: () => account.snapshot() });
  const look = async () => {
    await engine.tick();
    clock.t += 1_000;
    await engine.tick();
    await engine.settle();
  };
  return { clock, automation, rescueStore, account, engine, killSwitch, control, logs, look };
}

/** A real enable through the control, as the bot does it. */
async function enable(r: ReturnType<typeof rig>) {
  const res = await r.control.enable(710, { marketId: 16, positionId: PID, triggerPct: 0.04, amountCNS: 25n * AUSD, maxRescues: 2, maxTotalCNS: 50n * AUSD, minRemainingCNS: 500n * AUSD, cooldownMs: 900_000 });
  assert.equal(res.ok, true, res.text);
}

test('SPEC 80: the Kill Switch stops Rescue — a rule at its trigger sends nothing once it is on', async () => {
  const r = rig();
  await enable(r);
  const report = await r.killSwitch.stop(710, 'test');
  await r.look();
  assert.equal(r.account.commands.length, 0);
  assert.deepEqual(report.rescueStopped, ['BTC']);
  assert.equal(r.rescueStore.enabledRules().length, 0);
  assert.equal(r.rescueStore.rulesFor(710)[0]?.pausedReason, 'kill switch');
});

test('SPEC 80: the Kill Switch stops Copy — whatever strategy held the account, it holds nothing after', async () => {
  const r = rig();
  await r.automation.transition(710, 'NONE', 'COPY_TRADING');
  const report = await r.killSwitch.stop(710, 'test');
  assert.equal(report.modeBefore, 'COPY_TRADING');
  assert.equal(r.automation.get(710).mode, 'NONE');
  assert.equal(r.automation.automationStopped(710), true, 'every automated path, Copy included, reads this flag');
});

test('SPEC 80: the Kill Switch blocks NEW automation — Rescue cannot be turned on until it is resumed', async () => {
  const r = rig();
  await r.killSwitch.stop(710, 'test');
  const res = await r.control.enable(710, { marketId: 16, positionId: PID, triggerPct: 0.04, amountCNS: 25n * AUSD, maxRescues: 2, maxTotalCNS: 50n * AUSD, minRemainingCNS: 500n * AUSD, cooldownMs: 900_000 });
  assert.equal(res.ok, false);
  assert.match(res.text, /Automation is stopped/);
  await r.killSwitch.resume(710, 'test');
  await enable(r);
});

test('SPEC 80: the Kill Switch persists after a restart — a new engine over the same stores stays blocked', async () => {
  const first = rig();
  await enable(first);
  await first.killSwitch.stop(710, 'test');
  // Turn a rule back on behind the switch's back, as a stale row might: the flag must still hold it.
  const [r1] = first.rescueStore.rulesFor(710);
  await first.rescueStore.update(r1!.id, { enabled: true, pausedReason: undefined });
  const after = rig({ automation: first.automation, rescueStore: first.rescueStore });
  await after.look();
  assert.equal(after.account.commands.length, 0);
  assert.equal(after.killSwitch.stopped(710), true);
});

test('SPEC 80: existing positions remain open — stopping sends nothing to the venue at all', async () => {
  const r = rig();
  await enable(r);
  await r.killSwitch.stop(710, 'test');
  assert.equal(r.account.commands.length, 0, 'no close, no reduce, no margin removed');
  assert.match(r.logs.at(-1) ?? '', /positions untouched/);
});

test('SPEC 80: repeated Kill Switch calls are safe and idempotent', async () => {
  const r = rig();
  await enable(r);
  const first = await r.killSwitch.stop(710, 'test');
  const second = await r.killSwitch.stop(710, 'test');
  assert.equal(first.alreadyStopped, false);
  assert.equal(second.alreadyStopped, true);
  assert.deepEqual(second.rescueStopped, []);
  assert.equal(r.automation.get(710).mode, 'NONE');
  assert.equal(r.killSwitch.stopped(710), true);
});

test('SPEC 80: a delayed worker cannot execute after the Kill Switch — an attempt mid pre-flight is stopped at the last gate', async () => {
  const r = rig();
  await enable(r);
  let report: Awaited<ReturnType<KillSwitch['stop']>> | undefined;
  // The switch is pressed while the executor is awaiting pre-flight. The stop
  // waits for the attempt in flight, so it is started here, not awaited here.
  r.account.during = async () => {
    void r.killSwitch.stop(710, 'test').then((x) => (report = x));
    await new Promise((res) => setTimeout(res, 10));
  };
  await r.look();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.account.sent(), 0, 'nothing reached the venue');
  const attempt = r.rescueStore.attempts(r.rescueStore.rulesFor(710)[0]!.id)[0];
  assert.equal(attempt?.outcome, 'refused');
  assert.equal(attempt?.receiptReason, 'automation-stopped');
  assert.equal(report?.inFlight, 'stopped-before-send');
});

test('SPEC 80: queued automation respects the Kill Switch — a rule armed on its first look never fires after the stop', async () => {
  const r = rig();
  await enable(r);
  await r.engine.tick(); // first look: armed, waiting for the second
  await r.killSwitch.stop(710, 'test');
  r.clock.t += 1_000;
  await r.engine.tick(); // second look, after the stop
  await r.engine.settle();
  assert.equal(r.account.commands.length, 0);
});

test('resume lifts the block only: no strategy starts by itself', async () => {
  const r = rig();
  await enable(r);
  await r.killSwitch.stop(710, 'test');
  const res = await r.killSwitch.resume(710, 'test');
  assert.equal(res.wasStopped, true);
  assert.equal(r.killSwitch.stopped(710), false);
  assert.equal(r.rescueStore.enabledRules().length, 0, 'Rescue stays off until turned on');
  await r.look();
  assert.equal(r.account.commands.length, 0);
});
