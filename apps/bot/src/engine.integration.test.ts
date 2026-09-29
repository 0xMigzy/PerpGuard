/**
 * The Telegram transport driven by the REAL alerts engine.
 *
 * `retryable` is only worth getting right if something acts on it, and the thing
 * that acts on it is the engine's retry loop. These two tests close that circuit:
 * a 429 has to be retried until it lands, and a 403 has to stop the loop dead.
 *
 * No network and no clock — the engine's sleep is injected, and Telegram is the
 * same fake the rest of the package uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '@perpguard/backend/alerts/engine';
import {
  FakeSleep,
  RecordingLog,
  RecordingLogger,
} from '@perpguard/backend/alerts/test-support';
import { TelegramAlertTransport } from './transport.ts';
import {
  CONFIGS,
  FIXTURE_BTC,
  FIXTURE_BTC_MARK,
  FakeExecutor,
  FakeTelegram,
  OWNER_CHAT,
  TEST_TOKEN,
  USER_ID,
  assessOne,
  fakeBot,
  newLinks,
  newStore,
} from './testSupport.ts';

function wired(): {
  readonly engine: AlertEngine;
  readonly telegram: FakeTelegram;
  readonly log: RecordingLog;
  readonly sleep: FakeSleep;
} {
  const { bot, telegram } = fakeBot();
  const transport = new TelegramAlertTransport({
    api: bot.api,
    token: TEST_TOKEN,
    links: newLinks(),
    store: newStore(),
    executor: new FakeExecutor(),
  });
  const log = new RecordingLog();
  const sleep = new FakeSleep();
  const engine = new AlertEngine({
    source: { onChange: () => () => {} },
    configs: CONFIGS,
    transport,
    log,
    userId: USER_ID,
    sleep: sleep.sleep,
    logger: new RecordingLogger(),
  });
  return { engine, telegram, log, sleep };
}

test('a 429 is retried until the alert lands, and the row records both attempts', async () => {
  const { engine, telegram, log, sleep } = wired();
  telegram.reply(FakeTelegram.error(429, 'Too Many Requests', 1));

  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const decision = engine.handle(change);
  assert.equal(decision.send, true);
  await engine.drain();

  assert.equal(telegram.of('sendMessage').length, 2);
  assert.equal(telegram.last('sendMessage').payload['chat_id'], OWNER_CHAT);
  assert.equal(sleep.slept.length, 1);

  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0]!.outcome, 'delivered');
  assert.equal(log.rows[0]!.attempts, 2);
});

test('a 403 stops the retry loop after one attempt, and the failure is recorded', async () => {
  // Three attempts against a blocked chat is three ways of failing the same way,
  // and it delays every alert queued behind it.
  const { engine, telegram, log, sleep } = wired();
  telegram.reply(
    FakeTelegram.error(403, 'Forbidden: bot was blocked by the user'),
    FakeTelegram.error(403, 'Forbidden: bot was blocked by the user'),
    FakeTelegram.error(403, 'Forbidden: bot was blocked by the user'),
  );

  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  engine.handle(change);
  await engine.drain();

  assert.equal(telegram.of('sendMessage').length, 1);
  assert.equal(sleep.slept.length, 0);

  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0]!.outcome, 'failed');
  assert.equal(log.rows[0]!.attempts, 1);
  assert.match(log.rows[0]!.lastError ?? '', /blocked by the user/);
});
