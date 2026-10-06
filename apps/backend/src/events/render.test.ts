import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedLiquidation, TakerOrder } from '@perpguard/shared';
import { renderEvent } from './render.ts';
import type { LargeTradeEvent, LiquidationEvent, PositionChangeEvent } from './types.ts';

const ctx = { webUrl: 'https://perpguard.app', watchEveryMs: 30_000 };
const freshness = { indexerBlock: 111_124_139, blocksBehind: 140 };
const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC' };
const liq: LiquidationEvent = {
  kind: 'liquidation',
  id: '0xabc-3',
  freshness,
  liquidation: { accountId: 4088, market: BTC, side: 'long', sizeLots: 0.25, notionalAusd: 21_402.6, execPrice: 85_610.7, markPrice: 85_600, entryPrice: 87_100, isFull: true, realizedPnlAusd: -372.4, fundingAusd: -1.6, txHash: '0xabc' } as FeedLiquidation,
};

test('a feed liquidation: size first and bold, the account, the prices, a loss floored, the freshness, two LINK buttons', () => {
  const r = renderEvent(liq, 'feed', ctx);
  assert.match(r.html, /^💥 <b>LIQUIDATION<\/b> · <b>21,403 AUSD<\/b> BTC long\nAccount <b>#4088<\/b> · 0\.25 BTC\nClosed at 85,610\.7, entered at 87,100\nRealised loss <b>374 AUSD<\/b>/);
  assert.match(r.html, /<i>As of block 111,124,139, 140 blocks behind the chain\.<\/i>$/);
  assert.deepEqual(r.links, [
    { text: '👤 View trader', url: 'https://perpguard.app/traders/4088' },
    { text: '🔎 Monadscan', url: 'https://monadscan.com/tx/0xabc' },
  ]);
  assert.doesNotMatch(r.html, /safe|would have kept|saved/i);
});

test('to a watcher it is about the account they watch, at any size; a partial one says so', () => {
  const r = renderEvent({ ...liq, liquidation: { ...liq.liquidation, isFull: false } }, 'watching', ctx);
  assert.match(r.html, /^💥 <b>#4088 was liquidated<\/b> · BTC long\nSize <b>21,403 AUSD<\/b> \(0\.25 BTC\), part of the position/);
});

test('a large trade names its direction from the receipt, or says plainly it is not known', () => {
  const order = { accountId: 5293, market: BTC, sizeLots: 0.4, notionalAusd: 34_250, averagePrice: 85_625.25, fills: 3, txHash: '0xdef' } as TakerOrder;
  const known: LargeTradeEvent = { kind: 'large-trade', id: 't', order, direction: { action: 'open', side: 'short' }, freshness };
  assert.match(renderEvent(known, 'feed', ctx).html, /^🐋 <b>LARGE TRADE<\/b> · <b>34,250 AUSD<\/b> BTC\nAccount <b>#5293<\/b> · Opened a short\n0\.4 BTC at 85,625\.3 average · 3 fills/);
  const unknown = renderEvent({ ...known, direction: undefined }, 'feed', ctx).html;
  assert.match(unknown, /direction not known/);
  assert.match(unknown, /does not record which way a taker traded, and the transaction did not settle it/);
});

test('a watched wallet\'s change says both delays: the index\'s and our 30-second check', () => {
  const e: PositionChangeEvent = { kind: 'position-increased', id: 'p', accountId: 4088, market: BTC, side: 'short', sizeBefore: 0.1, sizeAfter: 0.3, entryPrice: 85_000, marginAusd: 512.9, leverage: 5, openedAtMs: 1, seenAtMs: 2, freshness };
  const r = renderEvent(e, 'watching', ctx);
  assert.match(r.html, /^➕ <b>#4088 added to BTC short<\/b>\n0\.1 BTC → 0\.3 BTC\nEntry 85,000 · margin <b>512 AUSD<\/b> · 5x/);
  assert.match(r.html, /As of block 111,124,139, 140 blocks behind the chain\. Checked every 30 seconds on top of that\./);
  assert.deepEqual(r.links.map((l) => l.text), ['👤 View trader']);
});
