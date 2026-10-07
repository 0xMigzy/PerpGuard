import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryManualAlertState, ManualAlerts, type ManualAlertAccount } from './alerts.ts';
import { replacedByManualAlert } from './replaced.ts';
import type { RiskAssessment } from '../risk/types.ts';

const pos = (positionId: number, buffer: number | undefined, state = 'DANGER'): RiskAssessment =>
  ({ marketId: 16, symbol: 'BTC', positionId, liqBufferPct: buffer, state }) as unknown as RiskAssessment;

function rig(options: { alertPct?: number } = {}) {
  const sent: Array<{ accountId: number; positionId: number | undefined; pct: number }> = [];
  const state = new InMemoryManualAlertState();
  const alertPct = new Map<number, number>([[710, options.alertPct ?? 5], [711, 5]]);
  const accounts: Array<ManualAlertAccount & { list: RiskAssessment[]; live: boolean }> = [];
  const add = (accountId: number) => {
    const a = { accountId, list: [] as RiskAssessment[], live: true, positionsLive() { return this.live; }, assessments() { return this.list; } };
    accounts.push(a);
    return a;
  };
  const make = () =>
    new ManualAlerts({
      accounts: () => accounts,
      alertPctOf: (id) => alertPct.get(id) ?? 5,
      state,
      deliver: async (accountId, a, pct) => void sent.push({ accountId, positionId: a.positionId, pct }),
      logger: { info: () => {}, warn: () => {} },
    });
  return { sent, state, alertPct, add, make, engine: make() };
}

test('ONE ALERT PER POSITION PER CROSSING: it fires once at the distance, stays quiet while below, and re-arms only after a real recovery', async () => {
  const r = rig();
  const a = r.add(710);
  for (const b of [0.06, 0.049, 0.045, 0.03, 0.045]) {
    a.list = [pos(1, b)];
    await r.engine.tick();
  }
  assert.equal(r.sent.length, 1, 'one message for the whole dip');
  a.list = [pos(1, 0.06)]; // 6%: not yet a quarter of 5% above it (6.25%)
  await r.engine.tick();
  a.list = [pos(1, 0.049)];
  await r.engine.tick();
  assert.equal(r.sent.length, 1, 'a wobble around the line is not a new crossing');
  a.list = [pos(1, 0.07)]; // recovered past 6.25%: re-armed
  await r.engine.tick();
  a.list = [pos(1, 0.048)];
  await r.engine.tick();
  assert.equal(r.sent.length, 2, 'a real second crossing is said');
});

test('HELD WHILE BLIND: a list that is not live, a blind position or an unpriced one says nothing and changes nothing', async () => {
  const r = rig();
  const a = r.add(710);
  a.live = false;
  a.list = [pos(1, 0.02)];
  await r.engine.tick();
  a.live = true;
  a.list = [pos(1, 0.02, 'FEED_DOWN'), pos(2, undefined)];
  await r.engine.tick();
  assert.equal(r.sent.length, 0);
  assert.equal(r.state.get(710, 1), undefined, 'nothing remembered while blind');
});

test('A RESTART DOES NOT SAY IT AGAIN: a new engine over the same remembered state stays quiet below the line', async () => {
  const r = rig();
  const a = r.add(710);
  a.list = [pos(1, 0.04)];
  await r.engine.tick();
  await r.make().tick();
  assert.equal(r.sent.length, 1);
});

test('CHANGING THE DISTANCE starts fresh: a position already below the new line is told at the new line', async () => {
  const r = rig();
  const a = r.add(710);
  a.list = [pos(1, 0.04)];
  await r.engine.tick();
  r.alertPct.set(710, 8);
  await r.engine.tick();
  assert.deepEqual(r.sent.map((s) => s.pct), [5, 8]);
});

test('Each account at its own distance, each position on its own', async () => {
  const r = rig({ alertPct: 3 });
  const a = r.add(710);
  const b = r.add(711);
  a.list = [pos(1, 0.04), pos(2, 0.02)];
  b.list = [pos(9, 0.04)];
  await r.engine.tick();
  assert.deepEqual(r.sent.map((s) => [s.accountId, s.positionId]), [[710, 2], [711, 9]]);
});

test('A slow send never holds the tick, and a failed one does not stop the next', async () => {
  const sent: number[] = [];
  const state = new InMemoryManualAlertState();
  const engine = new ManualAlerts({
    accounts: () => [
      { accountId: 710, positionsLive: () => true, assessments: () => [pos(1, 0.02)] },
      { accountId: 711, positionsLive: () => true, assessments: () => [pos(2, 0.02)] },
    ],
    alertPctOf: () => 5,
    state,
    deliver: (id) => (id === 710 ? new Promise<void>(() => {}) : (sent.push(id), Promise.reject(new Error('telegram down')))),
    logger: { info: () => {}, warn: () => {} },
  });
  const done = await Promise.race([engine.tick().then(() => true), new Promise((res) => setTimeout(() => res(false), 300))]);
  assert.equal(done, true);
  assert.deepEqual(sent, [711]);
});

test('The manual alert replaces a linked account\'s WATCH, DANGER and their recovery; never past-liquidation, blindness, or a watched wallet\'s', () => {
  assert.equal(replacedByManualAlert({ kind: 'watch', previousState: 'SAFE', watch: undefined }), true);
  assert.equal(replacedByManualAlert({ kind: 'danger', previousState: 'WATCH', watch: undefined }), true);
  assert.equal(replacedByManualAlert({ kind: 'recovered', previousState: 'DANGER', watch: undefined }), true);
  assert.equal(replacedByManualAlert({ kind: 'past-liquidation', previousState: 'DANGER', watch: undefined }), false);
  assert.equal(replacedByManualAlert({ kind: 'positions-untrusted', previousState: 'DANGER', watch: undefined }), false);
  assert.equal(replacedByManualAlert({ kind: 'recovered', previousState: 'FEED_DOWN', watch: undefined }), false);
  assert.equal(replacedByManualAlert({ kind: 'danger', previousState: 'WATCH', watch: {} as never }), false);
});
