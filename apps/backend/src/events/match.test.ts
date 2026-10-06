import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedLiquidation, TakerOrder } from '@perpguard/shared';
import { recipientsFor, type MatchInputs } from './match.ts';
import { DEFAULT_PREFERENCES, type AlertPreferences } from './preferences.ts';
import type { PerpEvent } from './types.ts';

const fresh = { indexerBlock: 1, blocksBehind: 1 };
const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC' };
const liquidation = (accountId: number, notionalAusd: number): PerpEvent => ({ kind: 'liquidation', id: 'l', liquidation: { accountId, notionalAusd } as FeedLiquidation, freshness: fresh });
const trade = (accountId: number, notionalAusd: number): PerpEvent => ({ kind: 'large-trade', id: 't', order: { accountId, notionalAusd } as TakerOrder, direction: undefined, freshness: fresh });
const opened = (accountId: number): PerpEvent => ({ kind: 'position-opened', id: 'o', accountId, market: BTC, side: 'long', sizeBefore: 0, sizeAfter: 1, entryPrice: 1, marginAusd: 1, leverage: 1, openedAtMs: 1, seenAtMs: 1, freshness: fresh });

function inputs(prefs: Record<number, Partial<AlertPreferences>>, watching: Record<number, number[]>): MatchInputs {
  return {
    watchersOf: (id) => watching[id] ?? [],
    feedChats: () => [1, 2, 3],
    preferencesFor: (chat) => ({ ...DEFAULT_PREFERENCES, ...prefs[chat] }),
  };
}
const chats = (event: PerpEvent, i: MatchInputs) => recipientsFor(event, i).map((r) => `${r.chatId}:${r.why}`);

test('a watched wallet\'s change goes to its watchers only, at any size', () => {
  assert.deepEqual(chats(opened(4088), inputs({}, { 4088: [2] })), ['2:watching']);
  assert.deepEqual(chats(liquidation(4088, 50), inputs({}, { 4088: [2] })), ['2:watching'], 'a $50 liquidation still reaches whoever watches it');
});

test('wallet alerts off silences the watcher, not the feed', () => {
  const i = inputs({ 2: { walletAlerts: false } }, { 4088: [2] });
  assert.deepEqual(chats(opened(4088), i), []);
  assert.deepEqual(chats(liquidation(4088, 12_000), i), ['1:feed', '2:feed', '3:feed']);
});

test('the feeds go to every chat whose threshold the event meets; off is off', () => {
  const i = inputs({ 1: { liquidationMinAusd: 25_000 }, 2: { liquidationMinAusd: undefined }, 3: { liquidationMinAusd: 1_000 } }, {});
  assert.deepEqual(chats(liquidation(9, 10_000), i), ['3:feed']);
  assert.deepEqual(chats(liquidation(9, 25_000), i), ['1:feed', '3:feed'], 'at the threshold counts');
});

test('large trades use their own threshold (default $25K), and a watcher hears once', () => {
  assert.deepEqual(chats(trade(9, 24_999), inputs({}, {})), []);
  assert.deepEqual(chats(trade(9, 25_000), inputs({}, {})), ['1:feed', '2:feed', '3:feed']);
  assert.deepEqual(chats(liquidation(4088, 30_000), inputs({}, { 4088: [2] })), ['2:watching', '1:feed', '3:feed'], 'chat 2 once, as a watcher');
});
