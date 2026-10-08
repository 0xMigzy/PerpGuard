/**
 * A DISCONNECT SAYS "YOUR KEY IS DELETED" ONLY WHEN IT IS (owner, 8 Oct 2026).
 * The Postgres row goes first and is awaited; a refused delete leaves the key
 * where it was and throws, so nothing can claim it is gone and a restart
 * cannot reopen a session on a key someone was told was deleted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresKeyStore } from './stores.ts';

const KEY = { userId: 'tg:1', accountId: 711, blob: 'sealed', storedAtMs: 0 };

function pool(refuseDelete: boolean) {
  const queries: string[] = [];
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.startsWith('select')) return { rows: [{ user_id: KEY.userId, account_id: KEY.accountId, blob: KEY.blob, stored_at: new Date(0) }] };
      if (refuseDelete && sql.startsWith('delete')) throw new Error('connection terminated');
      return { rows: [] };
    },
  };
}

test('deleteConfirmed: the row is deleted and awaited before the key leaves memory', async () => {
  const p = pool(false);
  const store = await PostgresKeyStore.load({ pool: p as never, logger: { warn: () => {} } });
  assert.equal(await store.deleteConfirmed(KEY.userId), true);
  assert.equal(store.get(KEY.userId), undefined);
  assert.ok(p.queries.includes('delete from account_keys'));
  assert.equal(await store.deleteConfirmed(KEY.userId), false, 'nothing left to delete');
});

test('deleteConfirmed: a refused delete THROWS and leaves the key stored, so nothing may say it is gone', async () => {
  const store = await PostgresKeyStore.load({ pool: pool(true) as never, logger: { warn: () => {} } });
  await assert.rejects(store.deleteConfirmed(KEY.userId), /connection terminated/);
  assert.ok(store.get(KEY.userId) !== undefined);
});
