import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryIdentityStore, identityUserId } from './identity.ts';

test('a first /start creates an identity named by the Telegram user id; a second is a return', () => {
  const store = new InMemoryIdentityStore();
  const first = store.register(4242, 5150, 1_000);
  assert.deepEqual(first, { identity: { userId: 'tg:4242', telegramUserId: 4242, chatId: 5150, firstSeenAtMs: 1_000 }, created: true });
  const again = store.register(4242, 5150, 2_000);
  assert.equal(again.created, false);
  assert.equal(again.identity.firstSeenAtMs, 1_000, 'first sight is kept');
  assert.equal(store.byUserId('tg:4242')?.telegramUserId, 4242);
  assert.equal(identityUserId(7), 'tg:7');
});

test('speaking from a new chat moves the identity there without changing who it is', () => {
  const store = new InMemoryIdentityStore();
  store.register(4242, 5150, 1_000);
  const moved = store.register(4242, -100_200, 3_000);
  assert.equal(moved.created, false);
  assert.equal(moved.identity.chatId, -100_200);
  assert.equal(moved.identity.userId, 'tg:4242');
  assert.equal(store.list().length, 1);
});
