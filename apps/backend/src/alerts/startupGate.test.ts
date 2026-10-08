/**
 * The startup gate: a restart never tells anyone "I cannot see this
 * position", and never swallows a real warning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartupDeliveryGate } from './startupGate.ts';
import { AlertEngine } from './engine.ts';
import { CONFIGS, FakeTransport, FIXTURE_BTC, FIXTURE_BTC_MARK, RecordingLog, RecordingLogger, assessOne } from './testSupport.ts';
import type { AlertMessage, AlertRecipient } from './types.ts';
import type { RiskChange } from '../risk/types.ts';

const OWNER: AlertRecipient = { userId: 'owner', rights: 'act' };
const msg = (kind: AlertMessage['kind'], state: AlertMessage['state'], previousState?: AlertMessage['state']): AlertMessage =>
  ({ kind, state, previousState, marketId: 1, symbol: 'BTC', positionId: 1, title: kind, lines: [], text: kind, actions: [], atMs: 0, accountId: 710 }) as AlertMessage;

function rig(clean = false) {
  const inner = new FakeTransport();
  const state = { clean, now: 0 };
  const logger = new RecordingLogger();
  const gate = new StartupDeliveryGate({ inner, isClean: () => state.clean, deadlineMs: 180_000, now: () => state.now, logger });
  return { inner, state, gate, logger };
}

test('while holding nothing is sent; a clean open drops the startup blindness and its recovery, and delivers every real severity', async () => {
  const r = rig();
  const blind = r.gate.send(OWNER, msg('positions-untrusted', 'POSITIONS_UNTRUSTED'));
  const feed = r.gate.send(OWNER, msg('feed-down', 'FEED_DOWN'));
  const recovered = r.gate.send(OWNER, msg('recovered', 'SAFE', 'POSITIONS_UNTRUSTED'));
  const danger = r.gate.send(OWNER, msg('danger', 'DANGER', 'POSITIONS_UNTRUSTED'));
  r.gate.check();
  assert.equal(r.inner.sent.length, 0, 'nothing leaves while holding');
  assert.equal(r.gate.heldCount, 4);

  r.state.clean = true;
  r.gate.check();
  assert.equal(r.gate.state, 'clean');
  assert.deepEqual((await blind).suppressed, true);
  assert.deepEqual((await feed).suppressed, true);
  assert.deepEqual((await recovered).suppressed, true);
  assert.deepEqual(await danger, { ok: true });
  assert.deepEqual(r.inner.sent.map((s) => s.message.kind), ['danger']);
  assert.match(r.logger.infos.at(-1)!, /opened for account:710 \(clean\) after 0s: 4 held, 3 startup blindness alert\(s\) dropped, 1 delivered/);
});

test('after a clean open, the first recovery for a position whose blind alert was dropped is dropped too; a later real outage is delivered', async () => {
  const r = rig();
  void r.gate.send(OWNER, msg('positions-untrusted', 'POSITIONS_UNTRUSTED'));
  r.state.clean = true;
  r.gate.check();
  assert.equal((await r.gate.send(OWNER, msg('recovered', 'SAFE', 'POSITIONS_UNTRUSTED'))).suppressed, true);
  assert.deepEqual(await r.gate.send(OWNER, msg('feed-down', 'FEED_DOWN')), { ok: true }, 'a blindness after startup is real, and said');
  assert.deepEqual(await r.gate.send(OWNER, msg('recovered', 'SAFE', 'FEED_DOWN')), { ok: true });
});

test('past the deadline still not clean: a real outage, so everything held is delivered as decided', async () => {
  const r = rig();
  const blind = r.gate.send(OWNER, msg('positions-untrusted', 'POSITIONS_UNTRUSTED'));
  r.state.now = 180_000;
  r.gate.check();
  assert.equal(r.gate.state, 'deadline');
  assert.deepEqual(await blind, { ok: true });
  assert.match(r.logger.warnings.at(-1)!, /treated as a real outage/);
});

test('through the real engine: a suppressed alert writes no alert_log row and raises no delivery failure', async () => {
  const r = rig();
  const log = new RecordingLog();
  const failures: unknown[] = [];
  const listeners = new Set<(c: RiskChange) => void>();
  const engine = new AlertEngine({
    source: { onChange: (l: (c: RiskChange) => void) => { listeners.add(l); return () => listeners.delete(l); } },
    configs: CONFIGS,
    transport: r.gate,
    log,
    userId: 'owner',
    now: () => 0,
    // The minute of quiet has passed: this is about what the gate does next.
    schedule: (fn: () => void) => { fn(); return () => {}; },
    onDeliveryFailure: (e: unknown) => failures.push(e),
  } as never);
  engine.start();
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const blind = { ...change, assessment: { ...change.assessment, state: 'POSITIONS_UNTRUSTED' as const, heldOnStalePrice: true, topUp: undefined } };
  for (const l of listeners) l(blind);
  for (let i = 0; i < 20 && r.gate.heldCount === 0; i++) await new Promise((res) => setImmediate(res));
  assert.equal(r.gate.heldCount, 1, 'the engine handed it to the gate, which is holding it');
  r.state.clean = true;
  r.gate.check();
  await engine.drain();
  assert.equal(log.rows.length, 0, JSON.stringify(log.rows.map((x) => [x.kind, x.outcome, x.lastError])));
  assert.equal(failures.length, 0);
  assert.equal(r.inner.sent.length, 0);
});

test('PER ACCOUNT: one account still blind at boot does not hold another account\'s alerts', async () => {
  const inner = new FakeTransport();
  const state = { now: 0, clean710: true, clean711: false };
  const gate = new StartupDeliveryGate({
    inner,
    isClean: (scope) => (scope === 'account:710' ? state.clean710 : scope === 'account:711' ? state.clean711 : true),
    deadlineMs: 180_000,
    now: () => state.now,
  });
  const forB = gate.send(OWNER, { ...msg('danger', 'DANGER'), accountId: 711 } as AlertMessage);
  const forA = gate.send(OWNER, msg('danger', 'DANGER'));
  await forA;
  assert.equal(inner.sent.length, 1, "710's alert went at once");
  assert.equal(gate.heldCount, 1, "711's waits for 711");
  assert.equal(gate.scopeState('account:711'), undefined);
  state.clean711 = true;
  gate.check();
  await forB;
  assert.equal(inner.sent.length, 2);
  assert.equal(gate.scopeState('account:711'), 'clean');
});
