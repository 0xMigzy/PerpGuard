import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerDirectory } from './ownerDirectory.ts';

test('index first, chain for the rest, every answer kept; a miss is retried later, not on every read', async () => {
  const chainAsked: number[] = [];
  let now = 0;
  const dir = new OwnerDirectory({
    fromIndex: async (ids) => new Map(ids.filter((id) => id === 1).map((id) => [id, '0xAAAA'])),
    fromChain: async (id) => {
      chainAsked.push(id);
      return id === 2 ? '0xBBBB' : undefined;
    },
    now: () => now,
    retryMs: 1_000,
  });
  const first = await dir.ownersOf([1, 2, 3]);
  assert.deepEqual([...first], [[1, '0xaaaa'], [2, '0xbbbb']], 'lowercased; an unknown owner is absent, never guessed');
  assert.deepEqual(chainAsked, [2, 3]);
  await dir.ownersOf([1, 2, 3]);
  assert.deepEqual(chainAsked, [2, 3], 'kept: nothing asked again; the miss waits for its retry');
  now = 2_000;
  await dir.ownersOf([3]);
  assert.deepEqual(chainAsked, [2, 3, 3], 'the miss is retried after retryMs');
});

test('a failing index or chain never throws at the reader', async () => {
  const dir = new OwnerDirectory({ fromIndex: async () => Promise.reject(new Error('db down')), fromChain: async () => Promise.reject(new Error('rpc down')) });
  assert.equal((await dir.ownersOf([7])).size, 0);
});
