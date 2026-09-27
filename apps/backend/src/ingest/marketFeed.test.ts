import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PriceUpdate } from '@perpguard/shared';
import { MarketFeed } from './marketFeed.ts';

function priceUpdate(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return {
    venue: 'perpl',
    network: 'mainnet',
    symbol: 'BTC',
    marketId: 1,
    markPrice: 84_008.1,
    oraclePrice: 84_016.3,
    midPrice: 84_028.3,
    bid: 84_008.3,
    ask: 84_048.3,
    atBlock: 65_740_977,
    atMs: 1_790_391_300_000,
    receivedAtMs: 1_000,
    ...overrides,
  };
}

/** A clock the test moves by hand. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('MarketFeed', () => {
  it('rejects a nonsensical staleMs rather than silently never expiring', () => {
    assert.throws(() => new MarketFeed(0), RangeError);
    assert.throws(() => new MarketFeed(-1), RangeError);
    assert.throws(() => new MarketFeed(Number.NaN), RangeError);
  });

  it('stores and returns the latest price by id and by symbol', () => {
    const feed = new MarketFeed(10_000);
    feed.record(priceUpdate({ markPrice: 100 }));

    assert.equal(feed.get(1)?.markPrice, 100);
    assert.equal(feed.getBySymbol('BTC')?.markPrice, 100);
    assert.equal(feed.get(999), undefined);
    assert.equal(feed.getBySymbol('NOPE'), undefined);
    assert.equal(feed.size, 1);
  });

  it('keeps markets apart', () => {
    const feed = new MarketFeed(10_000);
    feed.record(priceUpdate({ marketId: 1, symbol: 'BTC', markPrice: 100 }));
    feed.record(priceUpdate({ marketId: 2, symbol: 'ETH', markPrice: 20 }));

    assert.equal(feed.getBySymbol('BTC')?.markPrice, 100);
    assert.equal(feed.getBySymbol('ETH')?.markPrice, 20);
    assert.equal(feed.snapshot().length, 2);
  });

  it('newest wins, and a late out-of-order frame does not rewind the cache', () => {
    const feed = new MarketFeed(10_000);
    feed.record(priceUpdate({ markPrice: 100, receivedAtMs: 1_000 }));
    feed.record(priceUpdate({ markPrice: 110, receivedAtMs: 2_000 }));
    assert.equal(feed.get(1)?.markPrice, 110);

    feed.record(priceUpdate({ markPrice: 90, receivedAtMs: 1_500 }));
    assert.equal(feed.get(1)?.markPrice, 110, 'a stale frame must not overwrite a newer one');
  });
});

describe('MarketFeed staleness', () => {
  it('treats a market it has never heard from as stale', () => {
    const feed = new MarketFeed(10_000);
    assert.equal(feed.isStale(1), true, 'no data is not fresh data');
    assert.equal(feed.isStaleBySymbol('BTC'), true);
    assert.equal(feed.ageMs(1), undefined);
    assert.deepEqual(feed.staleness(1), { stale: true, ageMs: undefined, reason: 'no-data' });
  });

  it('is fresh up to and including STALE_MS, stale after it', () => {
    const time = clock();
    const feed = new MarketFeed(10_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: time.now() }));

    assert.equal(feed.isStale(1), false);

    time.advance(9_999);
    assert.equal(feed.isStale(1), false, 'just inside the window');

    time.advance(1);
    assert.equal(feed.isStale(1), false, 'exactly at STALE_MS is still usable');

    time.advance(1);
    assert.equal(feed.isStale(1), true, 'one ms past STALE_MS is not');
    assert.equal(feed.staleness(1).reason, 'expired');
  });

  it('measures age from when we received it, not the venue clock', () => {
    const time = clock(5_000);
    const feed = new MarketFeed(10_000, time.now);
    // A venue timestamp far in the future must not make a dead feed look live.
    feed.record(priceUpdate({ receivedAtMs: 1_000, atMs: 9_999_999_999_999 }));

    assert.equal(feed.ageMs(1), 4_000);
    time.advance(7_000);
    assert.equal(feed.isStale(1), true);
  });

  it('never reports a negative age when a clock steps backwards', () => {
    const time = clock(1_000);
    const feed = new MarketFeed(10_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: 2_000 }));
    assert.equal(feed.ageMs(1), 0);
  });

  it('a fresh tick makes a stale market usable again', () => {
    const time = clock();
    const feed = new MarketFeed(10_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: time.now() }));

    time.advance(30_000);
    assert.equal(feed.isStale(1), true);

    feed.record(priceUpdate({ receivedAtMs: time.now() }));
    assert.equal(feed.isStale(1), false, 'the feed recovering clears staleness');
  });

  it('lists exactly the markets that have gone stale', () => {
    const time = clock();
    const feed = new MarketFeed(10_000, time.now);
    feed.record(priceUpdate({ marketId: 1, symbol: 'BTC', receivedAtMs: time.now() }));
    time.advance(20_000);
    feed.record(priceUpdate({ marketId: 2, symbol: 'ETH', receivedAtMs: time.now() }));

    assert.deepEqual(feed.staleMarketIds(), [1]);
    assert.equal(feed.isStaleBySymbol('BTC'), true);
    assert.equal(feed.isStaleBySymbol('ETH'), false);
  });
});
