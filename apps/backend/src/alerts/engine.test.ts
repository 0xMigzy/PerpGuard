/**
 * The engine: delivery, retry, and the guarantee that nothing vanishes.
 *
 * Transport, log, clock and sleep are all injected, so these run instantly and
 * without a Telegram token or a database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RiskChange } from '../risk/types.ts';
import { AlertEngine, type RiskChangeSource } from './engine.ts';
import { InMemoryAlertLog } from './log.pg.ts';
import {
  DEFAULT_ALERT_CONFIG,
  type AlertLogEntry,
  type AlertMessage,
  type DeliveryResult,
  type Unsubscribe,
} from './types.ts';
import {
  BTC,
  CONFIGS,
  FIXTURE_BTC,
  FIXTURE_BTC_MARK,
  FakeSleep,
  FakeTransport,
  RecordingLog,
  RecordingLogger,
  SAFE_BTC,
  assessOne,
} from './testSupport.ts';

const T0 = 7_000_000;
const USER = 'trader-1';

/** A risk-change source the test pushes into by hand. */
class Source implements RiskChangeSource {
  readonly listeners = new Set<(c: RiskChange) => void>();

  onChange(listener: (c: RiskChange) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change: RiskChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

interface Rig {
  readonly engine: AlertEngine;
  readonly source: Source;
  readonly transport: FakeTransport;
  readonly log: RecordingLog;
  readonly logger: RecordingLogger;
  readonly sleeper: FakeSleep;
  readonly failures: Array<{ entry: AlertLogEntry; message: AlertMessage }>;
}

function rig(overrides: { readonly maxAttempts?: number } = {}): Rig {
  const source = new Source();
  const transport = new FakeTransport();
  const log = new RecordingLog();
  const logger = new RecordingLogger();
  const sleeper = new FakeSleep();
  const failures: Array<{ entry: AlertLogEntry; message: AlertMessage }> = [];
  const engine = new AlertEngine({
    source,
    configs: CONFIGS,
    transport,
    log,
    userId: USER,
    now: () => T0,
    sleep: sleeper.sleep,
    logger,
    onDeliveryFailure: (entry, message) => failures.push({ entry, message }),
    ...(overrides.maxAttempts === undefined ? {} : { alerts: { maxAttempts: overrides.maxAttempts } }),
  });
  engine.start();
  return { engine, source, transport, log, logger, sleeper, failures };
}

const dangerChange = (): RiskChange => assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change;

// ── the happy path ───────────────────────────────────────────────────────────

test('a DANGER alert is delivered once and logged as delivered', async () => {
  const r = rig();
  r.source.emit(dangerChange());
  await r.engine.drain();

  assert.equal(r.transport.sent.length, 1);
  assert.equal(r.transport.sent[0]!.userId, USER);
  assert.ok(r.transport.sent[0]!.message.text.startsWith('DANGER · BTC'));

  assert.equal(r.log.rows.length, 1);
  const row = r.log.rows[0]!;
  assert.equal(row.outcome, 'delivered');
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, undefined);
  assert.equal(row.deliveredAtMs, T0);
  assert.equal(row.userId, USER);
  assert.equal(row.marketId, BTC.marketId);
  assert.equal(row.symbol, 'BTC');
  assert.equal(row.kind, 'danger');
  assert.equal(row.state, 'DANGER');
  assert.equal(row.actions.length, 2);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.logger.errors, []);
});

test('the alert key identifies the assessment it came from', async () => {
  const r = rig();
  const change = dangerChange();
  r.source.emit(change);
  await r.engine.drain();
  assert.equal(r.log.rows[0]!.alertKey, `1:DANGER:${change.assessment.atMs}`);
});

// ── retry ────────────────────────────────────────────────────────────────────

test('a transport failure then a success delivers, and records both facts', async () => {
  const r = rig();
  r.transport.script({ ok: false, reason: 'telegram 502' });
  r.source.emit(dangerChange());
  await r.engine.drain();

  assert.equal(r.transport.attempts, 2, 'it tried twice');
  assert.equal(r.transport.sent.length, 1, 'and landed once');

  assert.equal(r.log.rows.length, 1, 'one row per attempt sequence, not per attempt');
  const row = r.log.rows[0]!;
  assert.equal(row.outcome, 'delivered');
  assert.equal(row.attempts, 2);
  assert.equal(row.lastError, 'telegram 502', 'the failure is kept even though it succeeded');

  assert.deepEqual(r.sleeper.slept, [DEFAULT_ALERT_CONFIG.backoffMs[0]], 'it backed off once');
  assert.deepEqual(r.failures, []);
});

test('it backs off between attempts, growing then holding at the last value', async () => {
  const r = rig({ maxAttempts: 4 });
  r.transport.script(
    { ok: false, reason: 'a' },
    { ok: false, reason: 'b' },
    { ok: false, reason: 'c' },
  );
  r.source.emit(dangerChange());
  await r.engine.drain();

  assert.equal(r.transport.attempts, 4);
  // [1000, 4000] with a fourth attempt: the last value repeats rather than
  // needing the schedule lengthened to match.
  assert.deepEqual(r.sleeper.slept, [1_000, 4_000, 4_000]);
  assert.equal(r.log.rows[0]!.outcome, 'delivered');
});

test('a transport that throws is retried, not treated as final', async () => {
  const r = rig();
  r.transport.throwOnAttempt.add(1);
  r.source.emit(dangerChange());
  await r.engine.drain();

  assert.equal(r.transport.attempts, 2);
  const row = r.log.rows[0]!;
  assert.equal(row.outcome, 'delivered');
  assert.match(row.lastError!, /blew up on attempt 1/);
});

// ── exhausted retries ────────────────────────────────────────────────────────

test('exhausted retries are logged, surfaced, and never silently dropped', async () => {
  const r = rig();
  r.transport.script(
    { ok: false, reason: 'down 1' },
    { ok: false, reason: 'down 2' },
    { ok: false, reason: 'down 3' },
  );
  r.source.emit(dangerChange());
  await r.engine.drain();

  assert.equal(r.transport.attempts, 3, 'three attempts, the configured maximum');
  assert.equal(r.transport.sent.length, 0);

  // Recorded.
  assert.equal(r.log.rows.length, 1);
  const row = r.log.rows[0]!;
  assert.equal(row.outcome, 'failed');
  assert.equal(row.attempts, 3);
  assert.equal(row.lastError, 'down 3');
  assert.equal(row.deliveredAtMs, undefined);

  // Surfaced at error level. A DANGER alert that did not arrive is not a debug
  // detail: the user is exposed and does not know it.
  assert.equal(r.logger.errors.length, 1);
  assert.match(r.logger.errors[0]!, /was NOT delivered after 3 attempt\(s\): down 3/);
  assert.match(r.logger.errors[0]!, /DANGER/);

  // And handed to the caller.
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0]!.entry.outcome, 'failed');
  assert.ok(r.failures[0]!.message.text.startsWith('DANGER · BTC'));
});

test('a permanent failure stops retrying but is still recorded and surfaced', async () => {
  const r = rig();
  r.transport.script({ ok: false, reason: 'bot was blocked by the user', retryable: false });
  r.source.emit(dangerChange());
  await r.engine.drain();

  assert.equal(r.transport.attempts, 1, 'three attempts against a blocked chat is three failures');
  assert.deepEqual(r.sleeper.slept, [], 'and no backoff waited for nothing');

  assert.equal(r.log.rows[0]!.outcome, 'failed');
  assert.equal(r.log.rows[0]!.attempts, 1);
  assert.equal(r.failures.length, 1);
  assert.equal(r.logger.warnings.length, 1);
  assert.equal(r.logger.errors.length, 1);
});

// ── every delivery path writes a row ─────────────────────────────────────────

test('every delivery path ends in exactly one alert_log row', async () => {
  const paths: Array<{ readonly name: string; readonly script: readonly DeliveryResult[] }> = [
    { name: 'first attempt', script: [] },
    { name: 'retry then success', script: [{ ok: false, reason: 'x' }] },
    { name: 'permanent failure', script: [{ ok: false, reason: 'y', retryable: false }] },
    {
      name: 'exhausted',
      script: [
        { ok: false, reason: 'a' },
        { ok: false, reason: 'b' },
        { ok: false, reason: 'c' },
      ],
    },
  ];

  for (const path of paths) {
    const r = rig();
    r.transport.script(...path.script);
    r.source.emit(dangerChange());
    await r.engine.drain();
    assert.equal(r.log.rows.length, 1, `${path.name} should write one row`);
    assert.ok(
      r.log.rows[0]!.outcome === 'delivered' || r.log.rows[0]!.outcome === 'failed',
      `${path.name} should record a real outcome`,
    );
    assert.ok(r.log.rows[0]!.attempts >= 1);
  }
});

test('a failing log does not swallow the failing alert', async () => {
  const r = rig();
  r.log.failWith = new Error('postgres is down');
  r.transport.script(
    { ok: false, reason: 'a' },
    { ok: false, reason: 'b' },
    { ok: false, reason: 'c' },
  );
  r.source.emit(dangerChange());
  await r.engine.drain();

  assert.equal(r.log.rows.length, 0, 'the row really was lost');
  // But the two things that make the loss visible still happened.
  assert.equal(r.failures.length, 1);
  assert.ok(r.logger.errors.some((e) => e.includes('postgres is down')));
  assert.ok(r.logger.errors.some((e) => e.includes('was NOT delivered')));
});

// ── the engine honours the rules ─────────────────────────────────────────────

test('a suppressed decision sends nothing and writes no database row', async () => {
  const r = rig();
  const change = dangerChange();
  r.source.emit(change);
  await r.engine.drain();
  assert.equal(r.log.rows.length, 1);

  // The same DANGER again, inside the cooldown.
  r.source.emit(change);
  await r.engine.drain();
  assert.equal(r.transport.sent.length, 1, 'still one delivery');
  assert.equal(r.log.rows.length, 1, 'and no row for a suppression');
});

test('every suppression and its reason reaches the application log', async () => {
  // "Why didn't I get an alert?" has to be answerable. The table is for delivery
  // outcomes; the reason lives in the app log.
  const r = rig();
  const change = dangerChange();
  r.source.emit(change);
  await r.engine.drain();
  assert.deepEqual(r.logger.infos, [], 'nothing suppressed yet');

  r.source.emit(change);
  await r.engine.drain();

  assert.equal(r.logger.infos.length, 1);
  assert.match(r.logger.infos[0]!, /no alert for BTC \(DANGER\)/);
  assert.match(r.logger.infos[0]!, /cooldown left/, 'the reason, not just the fact');
});

test('the suppression reason is specific to which rule held the alert', async () => {
  const r = rig();
  // First sight of a healthy position: suppressed for a different reason.
  r.engine.handle(assessOne(SAFE_BTC, FIXTURE_BTC_MARK).change);
  await r.engine.drain();
  assert.match(r.logger.infos[0]!, /nothing to recover from/);

  // An outage, twice: the second is the same blind spell.
  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  harness.advance(1_000);
  harness.health = { state: 'disconnected', reconnectAttempt: 1 };
  harness.evaluate();
  const down = harness.changeFor(1);
  r.engine.handle(down);
  r.engine.handle(down);
  await r.engine.drain();
  assert.match(r.logger.infos.at(-1)!, /still the same blind spell/);
});

test('the history is kept per position, so two markets do not share a cooldown', async () => {
  const r = rig();
  r.source.emit(dangerChange());
  await r.engine.drain();

  const eth = assessOne(
    { ...FIXTURE_BTC, symbol: 'ETH', marketId: 20, positionId: 5, size: 10, entryPrice: 3000, margin: 2310, side: 'short' },
    3000,
  ).change;
  r.source.emit(eth);
  await r.engine.drain();

  assert.equal(r.transport.sent.length, 2, 'BTC and ETH each get their own alert');
  assert.equal(r.engine.historyFor(1)!.lastAlertedSeverity, 'DANGER');
  assert.equal(r.engine.historyFor(20)!.lastAlertedSeverity, 'DANGER');
});

test('an unknown market is refused rather than rendered with the wrong scaling', async () => {
  const source = new Source();
  const transport = new FakeTransport();
  const log = new RecordingLog();
  const logger = new RecordingLogger();
  const engine = new AlertEngine({
    source,
    configs: new Map(),
    transport,
    log,
    userId: USER,
    now: () => T0,
    logger,
  });
  engine.start();

  const decision = engine.handle(dangerChange());
  await engine.drain();

  assert.equal(decision.send, false);
  assert.match(decision.suppressedReason!, /no market config/);
  assert.equal(transport.sent.length, 0);
  assert.equal(log.rows.length, 0);
  assert.equal(logger.warnings.length, 1);
});

test('stop() unsubscribes', async () => {
  const r = rig();
  r.engine.stop();
  r.source.emit(dangerChange());
  await r.engine.drain();
  assert.equal(r.transport.sent.length, 0);
});

test('deliveries are serialised, so alerts cannot land out of order', async () => {
  const source = new Source();
  const log = new RecordingLog();
  const order: string[] = [];
  // A transport that resolves slowly on the first call and fast on the second:
  // without serialisation the second would land first.
  let call = 0;
  const engine = new AlertEngine({
    source,
    configs: CONFIGS,
    transport: {
      send: async (_userId, message) => {
        call += 1;
        const delay = call === 1 ? 20 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(message.state);
        return { ok: true };
      },
    },
    log,
    userId: USER,
    now: () => T0,
  });
  engine.start();

  const { harness } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  source.emit(harness.changeFor(1));

  // Now a recovery, which the rules will allow because the first was DANGER.
  const recovered = assessOne(SAFE_BTC, FIXTURE_BTC_MARK).change;
  source.emit({ assessment: recovered.assessment, previousState: 'DANGER' });

  await engine.drain();
  assert.deepEqual(order, ['DANGER', 'SAFE'], 'the warning arrives before the all-clear');
});

// ── the in-memory log ────────────────────────────────────────────────────────

test('the in-memory log records what the engine hands it', async () => {
  const source = new Source();
  const log = new InMemoryAlertLog();
  const engine = new AlertEngine({
    source,
    configs: CONFIGS,
    transport: new FakeTransport(),
    log,
    userId: USER,
    now: () => T0,
  });
  engine.start();
  source.emit(dangerChange());
  await engine.drain();

  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0]!.outcome, 'delivered');
});

// ── fan-out: one decision, many recipients ──────────────────────────────────

test('one decision fans out to every recipient with its own rights, and they share the cooldown', async () => {
  const source = new Source();
  const transport = new FakeTransport();
  const log = new RecordingLog();
  const logger = new RecordingLogger();
  const engine = new AlertEngine({
    source,
    configs: CONFIGS,
    transport,
    log,
    recipients: () => [
      { userId: 'trader-1', rights: 'act' },
      { userId: 'watch:111', rights: 'watch', chatId: 111 },
      { userId: 'watch:222', rights: 'watch', chatId: 222 },
    ],
    now: () => T0,
    sleep: async () => {},
    logger,
  });
  engine.start();

  const change = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change;
  source.emit(change);
  await engine.drain();

  assert.deepEqual(
    transport.sent.map((s) => [s.recipient.userId, s.recipient.rights, s.recipient.chatId]),
    [['trader-1', 'act', undefined], ['watch:111', 'watch', 111], ['watch:222', 'watch', 222]],
  );
  assert.equal(new Set(transport.sent.map((s) => s.message)).size, 1, 'the SAME message object: rendered once, shaped by the transport');
  assert.deepEqual(log.rows.map((r) => r.userId), ['trader-1', 'watch:111', 'watch:222'], 'one row per copy');

  // The decision is per position: a repeat inside the cooldown is suppressed
  // for everyone, not re-sent to the watchers.
  source.emit(change);
  await engine.drain();
  assert.equal(transport.sent.length, 3);
  assert.match(logger.infos.at(-1) ?? '', /cooldown left/);
});

test('a watched position keeps its own history, so two accounts on one market never share a cooldown', async () => {
  const r = rig();
  const own = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change;
  const watched: RiskChange = {
    ...own,
    assessment: { ...own.assessment, watch: { accountId: 5293, label: '#5293', indexerBlock: 1, blocksBehind: 0, indexerState: 'synced' } },
  };
  r.source.emit(own);
  r.source.emit(watched);
  await r.engine.drain();
  assert.equal(r.transport.sent.length, 2, 'both delivered: different positions');
  assert.ok(r.transport.sent[1]!.message.text.startsWith('Watching #5293 · DANGER · BTC long'));
  assert.deepEqual(r.transport.sent[1]!.message.actions, [], 'no actions on a watched alert');
  assert.equal(r.log.rows[1]!.accountId, 5293);
  assert.match(r.log.rows[1]!.alertKey, /^5293:1:DANGER:/);
  assert.notEqual(r.engine.historyFor(BTC.marketId), undefined);
  assert.notEqual(r.engine.historyFor(BTC.marketId, 5293), undefined);
});

test('a decision with nobody subscribed is logged and sends nothing', async () => {
  const source = new Source();
  const transport = new FakeTransport();
  const logger = new RecordingLogger();
  const engine = new AlertEngine({ source, configs: CONFIGS, transport, log: new RecordingLog(), recipients: () => [], now: () => T0, sleep: async () => {}, logger });
  engine.start();
  source.emit(assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change);
  await engine.drain();
  assert.equal(transport.sent.length, 0);
  assert.match(logger.infos.at(-1) ?? '', /nobody is subscribed/);
});
