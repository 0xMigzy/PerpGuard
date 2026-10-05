import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAVED_KEY, SAVED_MAX, readSaved, withSaved, withoutSaved, writeSaved } from './savedWallets.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };

test('saved wallets survive a write and a read, newest first, one entry per account', () => {
  const s = memory();
  let list = withSaved([], { accountId: 1, address: '0xa', savedAtMs: 1 });
  list = withSaved(list, { accountId: 2, address: '0xb', savedAtMs: 2 });
  list = withSaved(list, { accountId: 1, address: '0xa', savedAtMs: 3 });
  assert.equal(writeSaved(list, s), true);
  assert.deepEqual(readSaved(s).map((w) => w.accountId), [1, 2]);
  assert.deepEqual(readSaved(s).map((w) => w.accountId), withoutSaved(withSaved(list, list[0]!), 3).map((w) => w.accountId));
  assert.deepEqual(withoutSaved(list, 1).map((w) => w.accountId), [2]);
});

test('storage that throws, is missing, or holds junk is an empty list, never an error', () => {
  assert.deepEqual(readSaved(throwing), []);
  assert.equal(writeSaved([{ accountId: 1, address: '', savedAtMs: 0 }], throwing), false);
  assert.deepEqual(readSaved(undefined), []);
  assert.equal(writeSaved([], undefined), false);
  const s = memory();
  s.m.set(SAVED_KEY, '{not json');
  assert.deepEqual(readSaved(s), []);
  s.m.set(SAVED_KEY, JSON.stringify([{ accountId: 'x' }, { accountId: 5, address: '0xc', savedAtMs: 1 }, null]));
  assert.deepEqual(readSaved(s).map((w) => w.accountId), [5], 'bad entries are dropped, good ones kept');
});

test('the list is capped', () => {
  let list: ReturnType<typeof withSaved> = [];
  for (let i = 0; i < SAVED_MAX + 5; i++) list = withSaved(list, { accountId: i, address: '', savedAtMs: i });
  assert.equal(list.length, SAVED_MAX);
  assert.equal(list[0]!.accountId, SAVED_MAX + 4, 'the newest stays');
});
