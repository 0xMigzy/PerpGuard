import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExternalFundingQuote, ExternalFundingSnapshot, FundingVenueId } from '@perpguard/shared';
import { buildVenueFundingPayload, describeFetchError, VenueFundingStore } from './venueFundingStore.ts';

const quote = (venue: FundingVenueId, ticker: string, markPrice: number): ExternalFundingQuote => ({
  venue,
  instrument: venue === 'binance' ? `${ticker}USDT` : ticker,
  ticker,
  ratePct: 0.00125,
  intervalSec: 3600,
  intervalSource: 'stated',
  interestPctPer8h: 0.01,
  markPrice,
});

function harness() {
  let now = 1_000_000;
  const calls: Record<FundingVenueId, number> = { hyperliquid: 0, binance: 0 };
  const behaviour: Record<FundingVenueId, 'ok' | 'fail' | 'hang'> = { hyperliquid: 'ok', binance: 'ok' };
  const fetcher = (venue: FundingVenueId) => async (): Promise<ExternalFundingSnapshot> => {
    calls[venue] += 1;
    if (behaviour[venue] === 'fail') throw new Error('binance /fapi/v1/premiumIndex: HTTP 451');
    if (behaviour[venue] === 'hang') return new Promise(() => {});
    return { venue, quotes: [quote(venue, 'BTC', 85_800)] };
  };
  const store = new VenueFundingStore({
    fetchers: { hyperliquid: fetcher('hyperliquid'), binance: fetcher('binance') },
    ttlMs: 60_000,
    unavailableAfterMs: 180_000,
    firstWaitMs: 20,
    now: () => now,
  });
  return { store, calls, behaviour, advance: (ms: number) => (now += ms), at: () => now };
}

test('polled only while read, at most once per venue per TTL, however many readers', async () => {
  const h = harness();
  await Promise.all([h.store.read(['BTC']), h.store.read(['BTC']), h.store.read(['BTC'])]);
  assert.deepEqual(h.calls, { hyperliquid: 1, binance: 1 });
  h.advance(30_000);
  await h.store.read(['BTC']);
  assert.deepEqual(h.calls, { hyperliquid: 1, binance: 1 }, 'within the TTL');
  h.advance(31_000);
  await h.store.read(['BTC']);
  assert.deepEqual(h.calls, { hyperliquid: 2, binance: 2 });
});

test('a failed venue keeps its last good figures, with their age, until the window closes; then it is unavailable', async () => {
  const h = harness();
  await h.store.read(['BTC']);
  const goodAt = h.at();
  h.behaviour.binance = 'fail';
  h.advance(61_000);
  await h.store.read(['BTC']);
  await new Promise((r) => setImmediate(r));
  let r = await h.store.read(['BTC']);
  assert.equal(r.binance.status.state, 'ok');
  assert.equal(r.binance.status.lastGoodAtMs, goodAt);
  assert.equal(r.binance.status.error, 'HTTP 451');
  assert.equal(r.binance.quotes.length, 1);
  assert.equal(r.hyperliquid.status.error, undefined, 'one venue failing never touches the other');
  h.advance(120_000);
  r = await h.store.read(['BTC']);
  assert.equal(r.binance.status.state, 'unavailable');
  assert.equal(r.binance.status.lastGoodAtMs, goodAt, 'the age of the last good figure is still served');
  assert.deepEqual(r.binance.quotes, [], 'none of its old figures are shown as current');
});

test('nobody reading for a while is not an outage: the next read refreshes and serves current figures', async () => {
  const h = harness();
  await h.store.read(['BTC']);
  h.advance(10 * 60_000);
  const r = await h.store.read(['BTC']);
  assert.equal(r.binance.status.state, 'ok');
  assert.equal(r.binance.status.lastGoodAtMs, h.at(), 'fetched just now, not ten minutes ago');
  assert.equal(r.hyperliquid.status.state, 'ok');
});

test('a venue that never answers does not hold the page: the first read waits briefly, then says unavailable', async () => {
  const h = harness();
  h.behaviour.hyperliquid = 'hang';
  const r = await h.store.read(['BTC']);
  assert.equal(r.hyperliquid.status.state, 'unavailable');
  assert.equal(r.hyperliquid.status.lastGoodAtMs, undefined);
  assert.equal(r.binance.status.state, 'ok');
});

test('payload: an unavailable venue blanks its column; a listed one is matched and price-checked', () => {
  const ok = { status: { state: 'ok' as const, lastGoodAtMs: 1 }, quotes: [quote('hyperliquid', 'BTC', 85_811), quote('hyperliquid', 'LIT', 0.9)] };
  const down = { status: { state: 'unavailable' as const, lastGoodAtMs: undefined, error: 'timed out' }, quotes: [] };
  const p = buildVenueFundingPayload(
    [
      { marketId: 1, symbol: 'BTC', markPrice: 85_798.6 },
      { marketId: 60, symbol: 'LIT', markPrice: 4.04 },
      { marketId: 10, symbol: 'MON', markPrice: 0.0312 },
    ],
    { hyperliquid: ok, binance: down },
  );
  const by = Object.fromEntries(p.markets.map((m) => [m.symbol, m.venues]));
  assert.equal(by.BTC!.hyperliquid.kind, 'quote');
  assert.equal(by.LIT!.hyperliquid.kind, 'different-asset');
  assert.equal(by.MON!.hyperliquid.kind, 'not-listed');
  assert.equal(by.BTC!.binance.kind, 'unavailable');
  assert.equal(p.venues.binance.error, 'timed out');
});

test('errors are rendered as short reasons, never raw', () => {
  const timeout = new Error('x');
  timeout.name = 'TimeoutError';
  assert.equal(describeFetchError(timeout), 'timed out');
  assert.equal(describeFetchError(new TypeError('fetch failed')), 'could not connect');
  assert.equal(describeFetchError(new Error('binance: HTTP 418 teapot')), 'HTTP 418');
  assert.equal(describeFetchError('weird'), 'unreadable reply');
});
