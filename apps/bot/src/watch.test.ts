/**
 * The public tier's bookkeeping: who watches what, how many, how often.
 *
 * Pure and in-memory, so these run instantly. The caps and the limiter are
 * the whole safety story of a public bot — a stranger can only cost a bounded
 * number of index reads per minute — so each limit is a test, not a comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_SUBSCRIPTION_MS, InMemoryWatchStore, RateLimiter, describeWatchFreshness, labelFor, parseWatchTarget, renderWatching, watchRecipients } from './watch.ts';
import type { RiskChange } from '@perpguard/backend/risk';

const sub = (chatId: number, accountId: number, addedAtMs = 1_000) => ({ chatId, accountId, label: `#${accountId}`, addedAtMs });

test('a chat may watch up to the cap, and the same account twice is one subscription', () => {
  const store = new InMemoryWatchStore({ maxPerChat: 2 });
  assert.equal(store.add(sub(1, 10)).ok, true);
  const again = store.add(sub(1, 10, 2_000));
  assert.ok(again.ok && again.already, 'already watching, not refused');
  assert.equal(store.add(sub(1, 11)).ok, true);
  const third = store.add(sub(1, 12));
  assert.ok(!third.ok && third.refusal === 'chat-at-capacity');
  assert.match(third.text, /You're watching 2 wallets, the most I can watch for one chat/);
  assert.deepEqual(store.byChat(1).map((s) => s.accountId), [10, 11]);
});

test('the bot-wide cap counts DISTINCT accounts, so following a watched account is always allowed', () => {
  const store = new InMemoryWatchStore({ maxPerChat: 5, maxAccounts: 2 });
  assert.equal(store.add(sub(1, 10)).ok, true);
  assert.equal(store.add(sub(2, 11)).ok, true);
  const third = store.add(sub(3, 12));
  assert.ok(!third.ok && third.refusal === 'bot-at-capacity');
  assert.equal(store.add(sub(3, 10)).ok, true, 'account 10 is already assessed; a second watcher costs nothing');
  assert.deepEqual(store.accountIds(), [10, 11]);
  assert.deepEqual(store.watchersOf(10).map((s) => s.chatId), [1, 3]);
});

test('unwatching the last account in a chat forgets the chat, and an unknown unwatch is false', () => {
  const store = new InMemoryWatchStore();
  store.add(sub(1, 10));
  assert.equal(store.remove(1, 99), false);
  assert.equal(store.remove(1, 10), true);
  assert.deepEqual(store.byChat(1), []);
  assert.deepEqual(store.accountIds(), []);
});

test('the rate limiter allows the limit per window per key and says how long to wait', () => {
  let now = 100_000;
  const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
  assert.equal(limiter.allow('chat-1').ok, true);
  now += 10_000;
  assert.equal(limiter.allow('chat-1').ok, true);
  assert.equal(limiter.allow('chat-1').ok, true);
  const fourth = limiter.allow('chat-1');
  assert.ok(!fourth.ok);
  assert.equal(fourth.retryInMs, 50_000, 'until the oldest event leaves the window');
  assert.equal(limiter.allow('chat-2').ok, true, 'another chat is another key');
  now += 50_000;
  assert.equal(limiter.allow('chat-1').ok, true, 'the window slid');
});

test('a target is a full address in any case, or an account id with or without #', () => {
  assert.deepEqual(parseWatchTarget('/watch 0xB7854953A71e45D1033B3d619E76d56391291765'), { kind: 'address', address: '0xb7854953a71e45d1033b3d619e76d56391291765' });
  assert.deepEqual(parseWatchTarget('/watch@PerpGuardBot 5293'), { kind: 'account', accountId: 5293 });
  assert.deepEqual(parseWatchTarget('/watch #710'), { kind: 'account', accountId: 710 });
  assert.match((parseWatchTarget('/watch') as { error: string }).error, /Tell me what to watch/);
  assert.match((parseWatchTarget('/watch 0xb785') as { error: string }).error, /not a full address/);
  assert.match((parseWatchTarget('/watch bob') as { error: string }).error, /did not understand/);
});

test('labels show the address the watcher typed, or the id with the owner when known', () => {
  const address = '0xb7854953a71e45d1033b3d619e76d56391291765';
  assert.equal(labelFor({ kind: 'address', address }, { accountId: 5293, address, resolvedBy: 'chain' }), '0xb785…1765');
  assert.equal(labelFor({ kind: 'account', accountId: 5293 }, { accountId: 5293, address, resolvedBy: 'index' }), '#5293 (0xb785…1765)');
  assert.equal(labelFor({ kind: 'account', accountId: 5293 }, { accountId: 5293, address: undefined, resolvedBy: 'index' }), '#5293');
});

test('/watching says what is followed and how current the index is, never implying live data', () => {
  const store = new InMemoryWatchStore({ maxPerChat: 5 });
  store.add({ chatId: 1, accountId: 5293, label: '0xb785…1765', addedAtMs: 1 });
  const text = renderWatching(store.byChat(1), { state: 'lagging', blocksBehind: 120, latestProcessedBlock: 109_000_000, serveAsCurrent: false } as never, 5);
  assert.match(text, /Watching 1 of 5/);
  assert.match(text, /0xb785…1765 — account 5293/);
  assert.match(text, /block 109,000,000, 120 blocks behind the chain \(indexer lagging\)/);
  assert.match(text, /Not live, and read-only from this chat/);
  assert.match(renderWatching([], undefined, 5), /watches nothing yet/);
  assert.match(describeWatchFreshness(undefined), /could not read how far behind/);
});

test('a fresh subscription is spared first-sight alerts its screen just showed; real changes and older subscriptions are not', () => {
  const store = new InMemoryWatchStore();
  const T = 10_000_000;
  store.add({ chatId: 1, accountId: 3388, label: '#3388', addedAtMs: T - 10_000 });
  store.add({ chatId: 2, accountId: 3388, label: '#3388', addedAtMs: T - 60 * 60_000 });
  const firstSight = { assessment: { watch: { accountId: 3388 } }, previousState: undefined } as unknown as RiskChange;
  const realChange = { assessment: { watch: { accountId: 3388 } }, previousState: 'WATCH' } as unknown as RiskChange;
  assert.deepEqual(watchRecipients(store, firstSight, T).map((r) => r.chatId), [2]);
  assert.deepEqual(watchRecipients(store, realChange, T).map((r) => r.chatId), [1, 2]);
  assert.deepEqual(watchRecipients(store, firstSight, T + FRESH_SUBSCRIPTION_MS).map((r) => r.chatId), [1, 2]);
  assert.ok(watchRecipients(store, realChange, T).every((r) => r.rights === 'watch'));
});
