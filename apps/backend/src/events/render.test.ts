import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedLiquidation, TakerOrder } from '@perpguard/shared';
import { renderEvent } from './render.ts';
import type { LargeTradeEvent, LiquidationEvent, PositionChangeEvent } from './types.ts';

const ctx = { webUrl: 'https://perpguard.app', watchEveryMs: 30_000, explorerTxUrl: 'https://monadvision.com/tx/' };
/** A real-shaped hash: 0x and 64 hex. Anything else is never linked. */
const TX = `0x${'ab'.repeat(32)}`;
/** 12 Oct 2026, 04:36 UTC. */
const AT = Date.UTC(2026, 9, 12, 4, 36, 20);
const freshness = { indexerBlock: 111_124_139, blocksBehind: 140 };
const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC' };
const liq: LiquidationEvent = {
  kind: 'liquidation',
  id: '0xabc-3',
  freshness,
  liquidation: { accountId: 4088, market: BTC, side: 'long', sizeLots: 0.25, notionalAusd: 21_402.6, execPrice: 85_610.7, markPrice: 85_600, entryPrice: 87_100, isFull: true, realizedPnlAusd: -372.4, fundingAusd: -1.6, txHash: TX, atMs: AT } as FeedLiquidation,
};

test('a feed liquidation: size first and bold, the account, the prices, a loss floored; then the TIME and the LINKS, and no button', () => {
  const r = renderEvent(liq, 'feed', { ...ctx, address: '0xa217000000000000000000000000000000006205' });
  assert.match(r.html, /^💥 <b>LIQUIDATION<\/b> · <b>21,403 AUSD<\/b> BTC long\nAccount <b>#4088<\/b> · 0\.25 BTC\nClosed at 85,610\.7, entered at 87,100\nRealised loss <b>374 AUSD<\/b>/);
  // The last two lines: when it happened, then the wallet's page on this site and the transaction on the mainnet explorer.
  assert.ok(r.html.endsWith(`\n\n<i>Oct 12 · 04:36 UTC</i>\n<a href="https://perpguard.app/traders/4088">0xa217…6205</a> · <a href="https://monadvision.com/tx/${TX}">tx ↗</a>`), r.html);
  assert.deepEqual(r.links, [], 'the two link buttons are gone: one way to each place');
  assert.doesNotMatch(r.html, /As of block|behind the chain|Monadscan/);
  assert.doesNotMatch(r.html, /safe|would have kept|saved/i);
});

test('NO LINK RATHER THAN A BROKEN ONE: an unknown owner is the account number, still linked; no hash, no "tx ↗"; no site, no wallet link', () => {
  const unknownOwner = renderEvent(liq, 'feed', ctx).html;
  assert.ok(unknownOwner.endsWith(`<a href="https://perpguard.app/traders/4088">#4088</a> · <a href="https://monadvision.com/tx/${TX}">tx ↗</a>`));
  const badHash = renderEvent({ ...liq, liquidation: { ...liq.liquidation, txHash: '0xabc' } }, 'feed', ctx).html;
  assert.ok(badHash.endsWith('<a href="https://perpguard.app/traders/4088">#4088</a>'), 'a hash that is not 64 hex is not linked');
  const noSite = renderEvent(liq, 'feed', { ...ctx, webUrl: undefined }).html;
  assert.ok(noSite.endsWith(`#4088 · <a href="https://monadvision.com/tx/${TX}">tx ↗</a>`));
  // To a watcher: the time, "Watching only", and the links LAST.
  const watching = renderEvent(liq, 'watching', ctx).html.split('\n');
  assert.deepEqual(watching.slice(-3).map((l) => l.replace(/<[^>]+>/g, '')), ['Oct 12 · 04:36 UTC', 'Watching only — nothing here to press.', '#4088 · tx ↗']);
});

test('to a watcher it is about the account they watch, at any size; a partial one says so', () => {
  const r = renderEvent({ ...liq, liquidation: { ...liq.liquidation, isFull: false } }, 'watching', ctx);
  assert.match(r.html, /^💥 <b>#4088 was liquidated<\/b> · BTC long\nSize <b>21,403 AUSD<\/b> \(0\.25 BTC\), part of the position/);
});

test('a large trade names its direction from the receipt, or says plainly it is not known', () => {
  const order = { accountId: 5293, market: BTC, sizeLots: 0.4, notionalAusd: 34_250, averagePrice: 85_625.25, fills: 3, txHash: TX, atMs: AT } as TakerOrder;
  const known: LargeTradeEvent = { kind: 'large-trade', id: 't', order, direction: { action: 'open', side: 'short' }, freshness };
  assert.match(renderEvent(known, 'feed', ctx).html, /^🐋 <b>LARGE TRADE<\/b> · <b>34,250 AUSD<\/b> BTC\nAccount <b>#5293<\/b> · Opened a short\n0\.4 BTC at 85,625\.3 average · 3 fills/);
  const unknown = renderEvent({ ...known, direction: undefined }, 'feed', ctx).html;
  assert.match(unknown, /direction not known/);
  assert.match(unknown, /does not record which way a taker traded, and the transaction did not settle it/);
});

test("a watched wallet's change ends in a plain time and the wallet's page; an open and a close carry their transaction, an add or a reduce does not", () => {
  const base = { id: 'p', accountId: 4088, market: BTC, side: 'short' as const, entryPrice: 85_000, marginAusd: 512.9, leverage: 5, openedAtMs: AT, seenAtMs: AT + 90_000, freshness };
  const added = renderEvent({ ...base, kind: 'position-increased', sizeBefore: 0.1, sizeAfter: 0.3 } as PositionChangeEvent, 'watching', ctx);
  assert.match(added.html, /^➕ <b>#4088 added to BTC short<\/b>\n0\.1 BTC → 0\.3 BTC\nEntry 85,000 · margin <b>512 AUSD<\/b> · 5x/);
  // Seen 90 s after the opening time: an add has no chain time of its own, so it is when it was seen. No "tx ↗": the index keeps none.
  assert.ok(added.html.endsWith('<i>Oct 12 · 04:37 UTC</i>\nWatching only — nothing here to press.\n<a href="https://perpguard.app/traders/4088">#4088</a>'), added.html);
  assert.doesNotMatch(added.html, /As of block|Checked every|tx ↗/);
  assert.deepEqual(added.links, []);
  const opened = renderEvent({ ...base, kind: 'position-opened', sizeBefore: 0, sizeAfter: 0.3, txHash: TX } as PositionChangeEvent, 'watching', ctx).html;
  assert.ok(opened.endsWith(`<i>Oct 12 · 04:36 UTC</i>\nWatching only — nothing here to press.\n<a href="https://perpguard.app/traders/4088">#4088</a> · <a href="https://monadvision.com/tx/${TX}">tx ↗</a>`), 'opened: the index\'s opening time and transaction');
  const closed = renderEvent({ ...base, kind: 'position-closed', sizeBefore: 0.3, sizeAfter: 0, txHash: TX, closedAtMs: AT + 3_600_000 } as PositionChangeEvent, 'watching', ctx).html;
  assert.match(closed, /<i>Oct 12 · 05:36 UTC<\/i>/, "closed: the index's closing time");
  assert.match(closed, /tx ↗<\/a>$/);
});
