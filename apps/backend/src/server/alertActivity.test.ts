/**
 * What `/health` knows about the alert path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlertLogEntry } from '../alerts/types.ts';
import { InMemoryAlertLog } from '../alerts/log.pg.ts';
import { AlertActivity } from './alertActivity.ts';

const entry = (patch: Partial<AlertLogEntry> = {}): AlertLogEntry => ({
  alertKey: '1:DANGER:1000',
  userId: 'trader-1',
  marketId: 1,
  symbol: 'BTC',
  kind: 'danger',
  state: 'DANGER',
  previousState: 'WATCH',
  text: 'DANGER · BTC long',
  actions: [],
  attempts: 1,
  outcome: 'delivered',
  lastError: undefined,
  createdAtMs: 1_000,
  deliveredAtMs: 1_050,
  ...patch,
});

test('nothing sent yet is reported as nothing sent, not as healthy silence', async () => {
  const activity = new AlertActivity({
    inner: new InMemoryAlertLog(),
    durable: true,
    transportConfigured: true,
  });
  const status = activity.status();
  assert.equal(status.delivered, 0);
  assert.equal(status.failed, 0);
  assert.equal(status.lastDeliveredAtMs, undefined);
});

test('a delivery is counted and named, with the time it landed', async () => {
  const inner = new InMemoryAlertLog();
  const activity = new AlertActivity({ inner, durable: true, transportConfigured: true });

  await activity.record(entry());

  const status = activity.status();
  assert.equal(status.delivered, 1);
  assert.equal(status.lastDelivered, 'BTC DANGER');
  assert.equal(status.lastDeliveredAtMs, 1_050);
  // The row still reaches the real log.
  assert.equal(inner.rows.length, 1);
});

test('a failure is counted and quotes the transport’s own reason', async () => {
  const activity = new AlertActivity({
    inner: new InMemoryAlertLog(),
    durable: true,
    transportConfigured: true,
  });

  await activity.record(
    entry({ outcome: 'failed', deliveredAtMs: undefined, lastError: 'Telegram 403: blocked' }),
  );

  const status = activity.status();
  assert.equal(status.failed, 1);
  assert.equal(status.lastFailure, 'BTC DANGER: Telegram 403: blocked');
  assert.equal(status.lastFailureAtMs, 1_000);
});

test('a later success clears the failure, and nothing else does', async () => {
  const activity = new AlertActivity({
    inner: new InMemoryAlertLog(),
    durable: true,
    transportConfigured: true,
  });

  await activity.record(entry({ outcome: 'failed', deliveredAtMs: undefined, lastError: 'nope' }));
  assert.notEqual(activity.status().lastFailure, undefined);

  await activity.record(entry());
  assert.equal(activity.status().lastFailure, undefined);
  assert.equal(activity.status().failed, 1, 'the count is history and stays');
});

test('a database that rejects does not also erase what we know landed', async () => {
  // The engine has its own handling for a failing log; a decorator that quietly
  // succeeded would remove it, and one that forgot the outcome would leave
  // /health unable to say anything.
  const activity = new AlertActivity({
    inner: {
      async record() {
        throw new Error('connection terminated');
      },
    },
    durable: true,
    transportConfigured: true,
  });

  await assert.rejects(() => activity.record(entry()), /connection terminated/);
  assert.equal(activity.status().delivered, 1);
  assert.equal(activity.status().lastDelivered, 'BTC DANGER');
});

test('the transport and durability facts are carried through to the status', () => {
  const activity = new AlertActivity({
    inner: new InMemoryAlertLog(),
    durable: false,
    durableReason: 'Postgres was configured but could not be reached: ECONNREFUSED',
    transportConfigured: false,
    transportReason: 'TELEGRAM_BOT_TOKEN is not set',
  });
  const status = activity.status();
  assert.equal(status.transportConfigured, false);
  assert.equal(status.durableLog, false);
  assert.equal(status.transportReason, 'TELEGRAM_BOT_TOKEN is not set');
  assert.match(status.durableReason ?? '', /ECONNREFUSED/);
});

test('a durable log carries no reason, because there is nothing to explain', () => {
  const activity = new AlertActivity({
    inner: new InMemoryAlertLog(),
    durable: true,
    transportConfigured: true,
  });
  assert.equal(activity.status().durableLog, true);
  assert.equal(activity.status().durableReason, undefined);
});
