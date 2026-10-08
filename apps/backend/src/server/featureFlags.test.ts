import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryFeatureFlags, PostgresFeatureFlags } from './featureFlags.ts';

class FakePool {
  rows: Array<{ name: string; enabled: boolean }> = [];
  fail = false;
  async query(sql: string): Promise<{ rows: unknown[] }> {
    if (this.fail && sql.startsWith('select')) throw new Error('db down');
    return { rows: sql.startsWith('select') ? this.rows : [] };
  }
}

test('A FLAG WITH NO ROW IS OFF; a row turns it on, and a later read turns it off again', async () => {
  const pool = new FakePool();
  const flags = await PostgresFeatureFlags.load(pool as never, { refreshMs: 60_000, warn: () => undefined });
  assert.equal(flags.isOn('wallet-key'), false, 'never set: off');
  pool.rows = [{ name: 'wallet-key', enabled: true }];
  await flags.refresh();
  assert.equal(flags.isOn('wallet-key'), true);
  pool.rows = [{ name: 'wallet-key', enabled: false }];
  await flags.refresh();
  assert.equal(flags.isOn('wallet-key'), false);
  flags.stop();
});

test('A DATABASE BLIP NEVER FLIPS A SWITCH: a failed read keeps the last answer', async () => {
  const pool = new FakePool();
  pool.rows = [{ name: 'wallet-key', enabled: true }];
  const warned: string[] = [];
  const flags = await PostgresFeatureFlags.load(pool as never, { refreshMs: 60_000, warn: (l) => warned.push(l) });
  pool.fail = true;
  await flags.refresh();
  assert.equal(flags.isOn('wallet-key'), true);
  assert.equal(warned.length, 1);
  flags.stop();
});

test('in memory, for tests and a backend without Postgres', () => {
  const f = new InMemoryFeatureFlags();
  assert.equal(f.isOn('wallet-key'), false);
  f.set('wallet-key', true);
  assert.equal(f.isOn('wallet-key'), true);
});
