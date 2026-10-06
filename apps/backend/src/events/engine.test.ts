import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedLiquidation, TakerOrder } from '@perpguard/shared';
import { EventEngine } from './engine.ts';
import { InMemoryLedger } from './ledger.ts';
import { DEFAULT_PREFERENCES } from './preferences.ts';
import type { PerpEvent, PositionChangeEvent } from './types.ts';

const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC' };
const freshness = { indexerBlock: 1, blocksBehind: 1 };

function rig(options: { watching?: Record<number, number[]>; feedChats?: number[]; sendFails?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const sent: Array<{ chatId: number; html: string }> = [];
  const logs: string[] = [];
  const ledger = new InMemoryLedger(() => clock.t);
  const engine = new EventEngine({
    ledger,
    match: { watchersOf: (id) => options.watching?.[id] ?? [], feedChats: () => options.feedChats ?? [], preferencesFor: () => DEFAULT_PREFERENCES },
    sender: { send: async (chatId, m) => { sent.push({ chatId, html: m.html }); return options.sendFails ? { ok: false, reason: 'blocked' } : { ok: true }; } },
    render: { webUrl: 'https://perpguard.app', watchEveryMs: 30_000 },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: () => clock.t,
    holdChangesMs: 20_000,
    feedPerMinute: 3,
  });
  return { engine, sent, logs, clock, ledger };
}
const liquidation = (id: string, accountId: number, atMs: number, notionalAusd = 12_000): PerpEvent => ({
  kind: 'liquidation', id, freshness,
  liquidation: { accountId, market: BTC, side: 'long', sizeLots: 1, notionalAusd, execPrice: 1, markPrice: 1, entryPrice: 1, isFull: true, realizedPnlAusd: -1, fundingAusd: 0, txHash: '0x1', atMs } as FeedLiquidation,
});
const change = (kind: PositionChangeEvent['kind'], openedAtMs = 500): PositionChangeEvent => ({ kind, id: `4088:1:${openedAtMs}:${kind}`, accountId: 4088, market: BTC, side: 'long', sizeBefore: 1, sizeAfter: kind === 'position-closed' ? 0 : 2, entryPrice: 1, marginAusd: 1, leverage: 1, openedAtMs, seenAtMs: 1, freshness });

test('the same event published twice, or after a restart, reaches a chat ONCE', async () => {
  const r = rig({ feedChats: [5150] });
  await r.engine.publish([liquidation('0xa-1', 9, 1)]);
  await r.engine.publish([liquidation('0xa-1', 9, 1)]);
  assert.equal(r.sent.length, 1);
  // A "restart": a new engine on the same ledger.
  const again = new EventEngine({ ledger: r.ledger, match: { watchersOf: () => [], feedChats: () => [5150], preferencesFor: () => DEFAULT_PREFERENCES }, sender: { send: async () => { r.sent.push({ chatId: 0, html: 'dup' }); return { ok: true }; } }, render: { webUrl: undefined, watchEveryMs: 30_000 }, logger: { info() {}, warn() {} } });
  await again.publish([liquidation('0xa-1', 9, 1)]);
  assert.equal(r.sent.length, 1, 'the ledger, not memory, decides');
});

test('a failed send is logged and NOT retried: the claim stands, so nothing can be sent twice', async () => {
  const r = rig({ feedChats: [5150], sendFails: true });
  await r.engine.publish([liquidation('0xb-1', 9, 1)]);
  await r.engine.publish([liquidation('0xb-1', 9, 1)]);
  assert.equal(r.sent.length, 1);
  assert.match(r.logs.join('\n'), /not delivered to a chat: blocked/);
});

test('a watched position that was LIQUIDATED is announced as the liquidation, not also as a close', async () => {
  const r = rig({ watching: { 4088: [5150] } });
  await r.engine.publish([change('position-closed')]);
  assert.equal(r.sent.length, 0, 'held while the liquidation feed catches up');
  await r.engine.publish([liquidation('0xc-1', 4088, 900, 50)]);
  r.clock.t += 20_001;
  await r.engine.tick();
  assert.deepEqual(r.sent.map((s) => s.html.split('\n')[0]), ['💥 <b>#4088 was liquidated</b> · BTC long']);
  assert.match(r.logs.join('\n'), /dropped: the liquidation already says it/);
});

test('a plain close, with no liquidation, goes out once the hold is over; an open goes at once', async () => {
  const r = rig({ watching: { 4088: [5150] } });
  await r.engine.publish([change('position-opened'), change('position-closed')]);
  assert.deepEqual(r.sent.map((s) => s.html.split('\n')[0]), ['🆕 <b>#4088 opened BTC long</b>']);
  r.clock.t += 20_001;
  await r.engine.tick();
  assert.equal(r.sent.at(-1)!.html.split('\n')[0], '🏁 <b>#4088 closed BTC long</b>');
  assert.equal(r.engine.heldCount, 0);
});

test('an OLD liquidation on the same market does not swallow a later position\'s close', async () => {
  const r = rig({ watching: { 4088: [5150] } });
  await r.engine.publish([liquidation('0xd-1', 4088, 100, 50)]);
  await r.engine.publish([change('position-closed', 500)]);
  r.clock.t += 20_001;
  await r.engine.tick();
  assert.equal(r.sent.at(-1)!.html.split('\n')[0], '🏁 <b>#4088 closed BTC long</b>');
});

test('the feeds are bounded per chat: three a minute here, the rest counted and said once', async () => {
  const r = rig({ feedChats: [5150] });
  await r.engine.publish([1, 2, 3, 4, 5].map((n) => liquidation(`0xe-${n}`, 9, 1)));
  assert.equal(r.sent.length, 3);
  r.clock.t += 60_001;
  await r.engine.tick();
  assert.match(r.sent.at(-1)!.html, /…and <b>2 more<\/b> liquidation and large-trade alerts in that minute/);
  await r.engine.publish([liquidation('0xe-6', 9, 1)]);
  assert.equal(r.sent.at(-1)!.html.startsWith('💥'), true, 'a new minute, a new allowance');
});

test('a watcher\'s own wallet is never flood-limited', async () => {
  const r = rig({ watching: { 4088: [5150] } });
  await r.engine.publish([1, 2, 3, 4, 5].map((n) => ({ ...change('position-opened', n), id: `o${n}` })));
  assert.equal(r.sent.length, 5);
});

test('large trades go to the feed at the default $25K', async () => {
  const r = rig({ feedChats: [5150] });
  const order = (n: number) => ({ accountId: 9, market: BTC, sizeLots: 1, notionalAusd: n, averagePrice: 1, fills: 1, txHash: '0x9' }) as TakerOrder;
  await r.engine.publish([
    { kind: 'large-trade', id: 'small', order: order(24_000), direction: undefined, freshness },
    { kind: 'large-trade', id: 'big', order: order(26_000), direction: { action: 'open', side: 'long' }, freshness },
  ]);
  assert.deepEqual(r.sent.map((s) => s.html.split('\n')[0]), ['🐋 <b>LARGE TRADE</b> · <b>26,000 AUSD</b> BTC']);
});
