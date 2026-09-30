import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAlertLog, PostgresAlertLog, entryFromRow } from './log.pg.ts';
import type { AlertLogEntry } from './types.ts';

const entry = (over: Partial<AlertLogEntry> = {}): AlertLogEntry => ({
  alertKey: '16:DANGER:1', userId: 'trader-1', marketId: 16, symbol: 'BTC', kind: 'danger', state: 'DANGER', previousState: 'WATCH',
  text: 'DANGER · BTC long\nBuffer 2.7% — liquidation 81,770.1, mark 84,007.3', actions: [
    { type: 'add-margin', intent: 'clear-danger', marketId: 16, symbol: 'BTC', positionId: 4242, amountCNS: 562_000_000n, label: 'Add 562 → buffer 4.0%, liquidation 80,647.1' },
  ],
  attempts: 1, outcome: 'delivered', lastError: undefined, createdAtMs: 1_000, deliveredAtMs: 1_500, ...over,
});

test('the in-memory log reads back one user\'s rows newest first, capped', async () => {
  const log = new InMemoryAlertLog();
  await log.record(entry({ alertKey: 'a', createdAtMs: 1_000 }));
  await log.record(entry({ alertKey: 'b', createdAtMs: 3_000 }));
  await log.record(entry({ alertKey: 'c', createdAtMs: 2_000, userId: 'someone-else' }));
  await log.record(entry({ alertKey: 'd', createdAtMs: 4_000 }));
  assert.deepEqual((await log.recent('trader-1', 2)).map((r) => r.alertKey), ['d', 'b']);
  assert.deepEqual((await log.recent('someone-else', 10)).map((r) => r.alertKey), ['c']);
});

test('a Postgres row round-trips, with amountCNS back through BigInt and never Number', async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const log = new PostgresAlertLog({
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/^\s*insert/i.test(sql)) return {};
      return {
        rows: [
          {
            alert_key: '16:DANGER:1', user_id: 'trader-1', market_id: 16, symbol: 'BTC', kind: 'danger', state: 'DANGER', previous_state: 'WATCH',
            message: 'DANGER · BTC long', actions: JSON.parse(String(calls[0]!.values[8])), attempts: 1, outcome: 'delivered', last_error: null,
            created_at: new Date(1_000), delivered_at: '1970-01-01T00:00:01.500Z',
          },
        ],
      };
    },
  });
  await log.record(entry({ actions: [{ ...entry().actions[0]!, amountCNS: 12_345_678_901_234_567_890n }] }));
  const [row] = await log.recent('trader-1', 100_000);
  assert.equal(calls[1]!.values[1], 500, 'capped');
  assert.equal(row!.actions[0]!.amountCNS, 12_345_678_901_234_567_890n, 'exact past float64');
  assert.equal(row!.createdAtMs, 1_000);
  assert.equal(row!.deliveredAtMs, 1_500);
  assert.equal(row!.previousState, 'WATCH');
  assert.throws(() => entryFromRow({ alert_key: 'x' }), /created_at/);
});
