/**
 * The copier, through fakes: opens and closes copied once each, no caps, the
 * floor said, every open judged by the position list, unknown pauses, the
 * kill switch on every path, a rule not armed by a tap never acted on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CopySourcePosition, VenueMarket } from '@perpguard/shared';
import type { ActionCommand, ActionOutcome } from '../../actions/types.ts';
import { InMemoryAutomationStore } from '../../rescue/automation.ts';
import { CopyArmSigner } from './arming.ts';
import { CopyControlService, UNVERIFIED_LEADER_TEXT } from './control.ts';
import { CopyEngine, type CopyAccount, type CopyNotice } from './engine.ts';
import { InMemoryCopyStore } from './store.ts';

const AUSD = 1_000_000n;
const T0 = Date.parse('2026-10-07T12:00:00Z');
const TAP = { telegramUserId: 7, chatId: 7 };
const FOLLOWER = 710;
const LEADER = 5213;

const MARKETS = ['BTC', 'ETH', 'SOL', 'MON', 'ZEC', 'LIT', 'PUMP', 'NEAR'].map(
  (symbol, i) => ({ marketId: 16 + i, symbol, sizeDecimals: 5, maxLeverage: 15, priceDecimals: 1 }) as unknown as VenueMarket,
);

let k = 0;
const lp = (o: Partial<CopySourcePosition> & { symbol?: string } = {}): CopySourcePosition => {
  k += 1;
  const { symbol = 'BTC', ...rest } = o;
  return {
    key: `L${k}`, market: { marketId: 100 + k, symbol, indexerName: symbol }, side: 'long', status: 'open', lotDecimals: 5, priceDecimals: 1,
    peakLotLNS: 100_000n, lotLNS: 100_000n, entryPricePNS: 1_000_000n, peakMarginCNS: 10_000n * AUSD, netPnlCNS: 0n, leverageHdths: 1000n,
    openedAtMs: T0 + 1_000 + k, closedAtMs: undefined, ...rest,
  };
};

class FakeFollower implements CopyAccount {
  live = true;
  free: bigint | undefined = 10_000n * AUSD;
  held: Array<{ marketId: number; positionId: number | undefined; side: 'long' | 'short'; marginCNS: bigint | undefined; unrealisedPnlCNS: bigint | undefined }> = [];
  sent: ActionCommand[] = [];
  /** What the next open does: land, be refused by the venue, or stay unknown. */
  openOutcome: 'applied' | 'not-applied' | 'unknown' = 'applied';
  #pid = 9000;
  positionsLive(): boolean {
    return this.live;
  }
  positions() {
    return this.held;
  }
  freeFloorCNS(): bigint | undefined {
    return this.free;
  }
  async execute(command: ActionCommand): Promise<ActionOutcome> {
    const stopped = command.stopCheck?.();
    if (stopped !== undefined) return { kind: 'refused', code: 'automation-stopped', command, at: 0, detail: stopped };
    this.sent.push(command);
    const reported = { status: 'confirmed' as const, reason: undefined, venueRef: undefined };
    if (command.kind === 'open-position') {
      if (this.openOutcome === 'applied') {
        this.held.push({ marketId: command.marketId, positionId: this.#pid++, side: command.side, marginCNS: 100n * AUSD, unrealisedPnlCNS: -64_800_000n });
        return { kind: 'applied', command, at: 0, reported, detail: 'opened', reconciliation: { verdict: 'applied', field: 'size', requested: command.sizeLNS, before: 0n, after: command.sizeLNS, delta: command.sizeLNS, detail: 'opened' } };
      }
      if (this.openOutcome === 'not-applied') return { kind: 'not-applied', command, at: 0, reported, detail: 'no position appeared', reconciliation: { verdict: 'not-applied', field: 'size', requested: command.sizeLNS, before: 0n, after: undefined, delta: undefined, detail: 'none' } };
      return { kind: 'unknown', command, at: 0, reported, detail: 'cannot tell', reconciliation: undefined, nextStep: 'look' };
    }
    if (command.kind === 'close-position') {
      this.held = this.held.filter((x) => x.marketId !== command.marketId);
      return { kind: 'applied', command, at: 0, reported, detail: 'closed', reconciliation: { verdict: 'applied', field: 'size', requested: 0n, before: 1n, after: undefined, delta: undefined, detail: 'closed' } };
    }
    throw new Error(`unexpected ${command.kind}`);
  }
}

function rig(o: { reconciled?: boolean; indexProblem?: string } = {}) {
  const clock = { t: T0 };
  const store = new InMemoryCopyStore();
  const automation = new InMemoryAutomationStore(() => clock.t);
  const signer = new CopyArmSigner('22'.repeat(32));
  const follower = new FakeFollower();
  const leader: { positions: CopySourcePosition[]; equityCNS: bigint } = { positions: [], equityCNS: 100_000n * AUSD };
  const notices: CopyNotice[] = [];
  const logs: string[] = [];
  let engine!: CopyEngine;
  const control = new CopyControlService({
    store,
    automation,
    signer,
    isLinked: (tg, chat, acct) => tg === 7 && chat === 7 && acct === FOLLOWER,
    verifyLeader: async () => (o.reconciled === false ? { ok: false, text: UNVERIFIED_LEADER_TEXT } : { ok: true, text: '' }),
    positions: () => (follower.live ? follower.held : undefined),
    busy: (id) => engine.busy(id),
    collateralDecimals: 6,
    now: () => clock.t,
  });
  const index = { problem: o.indexProblem };
  const make = () =>
    new CopyEngine({
      store,
      automation,
      armProblem: (rule) => control.armProblem(rule),
      account: (id) => (id === FOLLOWER ? follower : undefined),
      leader: async (id) => (id === LEADER ? leader : undefined),
      indexProblem: async () => index.problem,
      actingNetwork: 'testnet',
      actingMarkets: () => MARKETS,
      markOf: () => 100_000,
      collateralDecimals: 6,
      notify: (_id, n) => notices.push(n),
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
      now: () => clock.t,
    });
  engine = make();
  return { clock, store, automation, follower, leader, notices, logs, control, engine, make, index };
}

test('A LEADER OPEN IS COPIED ONCE, judged by the position list; the leader\'s close closes it; a second pass and a restart send nothing more', async () => {
  const r = rig();
  assert.equal((await r.control.start(FOLLOWER, LEADER, 500n * AUSD, TAP)).ok, true);
  const open = lp({ openedAtMs: T0 + 5 });
  r.leader.positions.push(open);
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 1);
  const cmd = r.follower.sent[0]!;
  assert.ok(cmd.kind === 'open-position' && cmd.side === 'long' && cmd.sizeLNS === 10_000n && cmd.marketId === 16, '1% of 100,000 AUSD of BTC at 100,000: 0.1 BTC');
  assert.equal(cmd.idempotencyKey, `copy:${FOLLOWER}:${open.key}:open`);
  assert.equal(r.notices.at(-1)!.kind, 'copied');
  assert.equal(r.store.legs(1)[0]!.status, 'open');

  await r.engine.tick();
  await r.make().tick();
  assert.equal(r.follower.sent.length, 1, 'never twice: the leg was claimed before the send');

  r.leader.positions[0] = { ...open, status: 'closed', closedAtMs: T0 + 60_000 };
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 2);
  assert.equal(r.follower.sent[1]!.kind, 'close-position');
  assert.equal(r.store.legs(1)[0]!.status, 'closed');
  assert.equal(r.notices.at(-1)!.kind, 'closed');
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 2);
});

test('NO CAPS: eight opens on eight markets are eight copies; only the free balance kept stops one, and that is SAID', async () => {
  const r = rig();
  await r.control.start(FOLLOWER, LEADER, 500n * AUSD, TAP);
  for (const s of ['BTC', 'ETH', 'SOL', 'MON', 'ZEC', 'LIT', 'PUMP', 'NEAR']) r.leader.positions.push(lp({ symbol: s, openedAtMs: T0 + 10 }));
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 8);

  const s = rig();
  await s.control.start(FOLLOWER, LEADER, 500n * AUSD, TAP);
  s.follower.free = 550n * AUSD;
  s.leader.positions.push(lp({ openedAtMs: T0 + 10 }));
  await s.engine.tick();
  assert.equal(s.follower.sent.length, 0);
  const n = s.notices.at(-1)!;
  assert.equal(n.kind, 'skipped');
  assert.match(n.kind === 'skipped' ? n.leg.reason ?? '' : '', /your free balance \(550\.00 AUSD\) would fall below the 500\.00 AUSD you keep free/);
});

test('NOT OPENED is said and never retried; UNKNOWN pauses copying, says so, and nothing more is sent until resumed', async () => {
  const r = rig();
  await r.control.start(FOLLOWER, LEADER, 0n, TAP);
  r.follower.openOutcome = 'not-applied';
  r.leader.positions.push(lp({ openedAtMs: T0 + 10 }));
  await r.engine.tick();
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 1, 'not opened: never sent again');
  assert.equal(r.notices.at(-1)!.kind, 'not-opened');

  const u = rig();
  await u.control.start(FOLLOWER, LEADER, 0n, TAP);
  u.follower.openOutcome = 'unknown';
  u.leader.positions.push(lp({ symbol: 'BTC', openedAtMs: T0 + 10 }), lp({ symbol: 'ETH', openedAtMs: T0 + 20 }));
  await u.engine.tick();
  assert.equal(u.follower.sent.length, 1, 'paused after the first: the second open waits');
  assert.equal(u.notices.at(-1)!.kind, 'unknown');
  await u.engine.tick();
  assert.equal(u.follower.sent.length, 1);
  // Resume settles the unknown against the list (nothing there: not opened), then the ETH open goes.
  u.follower.openOutcome = 'applied';
  const resumed = await u.control.resume(FOLLOWER, TAP);
  assert.match(resumed.text, /BTC: not opened/);
  await u.engine.tick();
  assert.equal(u.follower.sent.length, 2);
  assert.equal(u.store.legs(1).find((l) => l.symbol === 'BTC')!.status, 'not-opened');
});

test('THE KILL SWITCH stops every path: nothing judged while on, and a switch flipped mid-pass stops the send', async () => {
  const r = rig();
  await r.control.start(FOLLOWER, LEADER, 0n, TAP);
  await r.automation.setKillSwitch(FOLLOWER, true);
  r.leader.positions.push(lp({ openedAtMs: T0 + 10 }));
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 0);
  assert.equal(r.store.legs(1).length, 0, 'not even claimed: it is copied once resumed, if still open');
  assert.equal((await r.control.start(FOLLOWER, 999, 0n, TAP)).ok, false);
});

test('A RULE NOT STARTED BY A TAP is never acted on: switched off and said', async () => {
  const r = rig();
  // A script or a database insert: no signature.
  await r.store.create({ followerAccountId: FOLLOWER, leaderAccountId: LEADER, keepFreeCNS: 0n, startedAtMs: T0, armedBy: 7, armedChat: 7, armedAtMs: T0, armProof: undefined });
  r.leader.positions.push(lp({ openedAtMs: T0 + 10 }));
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 0);
  assert.equal(r.store.enabledRules().length, 0);
  assert.equal(r.notices.at(-1)!.kind, 'ignored');
});

test('HELD, NEVER GUESSED, while the index is behind or the account blind; said once', async () => {
  const r = rig({ indexProblem: 'the indexer is 4 minutes behind' });
  await r.control.start(FOLLOWER, LEADER, 0n, TAP);
  r.leader.positions.push(lp({ openedAtMs: T0 + 10 }));
  await r.engine.tick();
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 0);
  assert.deepEqual(r.notices.map((n) => n.kind), ['held']);
  r.index.problem = undefined;
  await r.engine.tick();
  assert.equal(r.follower.sent.length, 1, 'carries on by itself once current, while the leader still holds it');
});

test('STARTING: a leader whose books do not reconcile is refused with the sentence; Auto top-up running refuses; only the linked tap starts', async () => {
  const r = rig({ reconciled: false });
  const res = await r.control.start(FOLLOWER, LEADER, 0n, TAP);
  assert.equal(res.ok, false);
  assert.match(res.text, /PerpGuard won't copy a trader whose books it can't verify against the chain\./);
  const s = rig();
  assert.equal((await s.control.start(FOLLOWER, LEADER, 0n, { telegramUserId: 8, chatId: 8 })).ok, false);
  await s.automation.transition(FOLLOWER, 'NONE', 'LIQUIDATION_RESCUE');
  assert.match((await s.control.start(FOLLOWER, LEADER, 0n, TAP)).text, /Auto top-up is on/);
});

test('STOPPING leaves copied positions open and says so; it never moves money', async () => {
  const r = rig();
  await r.control.start(FOLLOWER, LEADER, 0n, TAP);
  r.leader.positions.push(lp({ symbol: 'BTC', openedAtMs: T0 + 10 }), lp({ symbol: 'ETH', openedAtMs: T0 + 20 }));
  await r.engine.tick();
  const sent = r.follower.sent.length;
  const stop = await r.control.stop(FOLLOWER);
  assert.match(stop.text, /2 copied positions are still open: PerpGuard did not close them\. Stopping never moves money\./);
  assert.equal(r.follower.sent.length, sent, 'nothing sent by stopping');
  assert.equal(r.automation.get(FOLLOWER).mode, 'NONE');
  r.leader.positions[0] = { ...r.leader.positions[0]!, status: 'closed', closedAtMs: T0 + 99 };
  await r.engine.tick();
  assert.equal(r.follower.sent.length, sent, 'and after stopping, nothing is copied');
});
