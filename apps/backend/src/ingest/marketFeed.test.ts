import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FeedHealth, PriceUpdate } from '@perpguard/shared';
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

const CONNECTED: FeedHealth = { state: 'connected', reconnectAttempt: 0 };
const RECONNECTING: FeedHealth = {
  state: 'reconnecting',
  reason: 'the market-data connection dropped; retrying (attempt 2)',
  reconnectAttempt: 2,
  downForMs: 3_000,
};
const DISCONNECTED: FeedHealth = {
  state: 'disconnected',
  reason: 'no market data for 90s after 9 reconnect attempt(s); still retrying',
  reconnectAttempt: 9,
  downForMs: 90_000,
};

/** A clock the test moves by hand. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('MarketFeed', () => {
  it('rejects a nonsensical staleMs rather than silently never expiring', () => {
    assert.throws(() => new MarketFeed('mainnet', 0), RangeError);
    assert.throws(() => new MarketFeed('mainnet', -1), RangeError);
    assert.throws(() => new MarketFeed('mainnet', Number.NaN), RangeError);
  });

  it('stores and returns the latest price by id and by symbol', () => {
    const feed = new MarketFeed('mainnet', 10_000);
    feed.record(priceUpdate({ markPrice: 100 }));

    assert.equal(feed.get(1)?.markPrice, 100);
    assert.equal(feed.getBySymbol('BTC')?.markPrice, 100);
    assert.equal(feed.get(999), undefined);
    assert.equal(feed.getBySymbol('NOPE'), undefined);
    assert.equal(feed.size, 1);
  });

  it('keeps markets apart', () => {
    const feed = new MarketFeed('mainnet', 10_000);
    feed.record(priceUpdate({ marketId: 1, symbol: 'BTC', markPrice: 100 }));
    feed.record(priceUpdate({ marketId: 2, symbol: 'ETH', markPrice: 20 }));

    assert.equal(feed.getBySymbol('BTC')?.markPrice, 100);
    assert.equal(feed.getBySymbol('ETH')?.markPrice, 20);
    assert.equal(feed.snapshot().length, 2);
  });

  it('newest wins, and a late out-of-order frame does not rewind the cache', () => {
    const feed = new MarketFeed('mainnet', 10_000);
    feed.record(priceUpdate({ markPrice: 100, receivedAtMs: 1_000 }));
    feed.record(priceUpdate({ markPrice: 110, receivedAtMs: 2_000 }));
    assert.equal(feed.get(1)?.markPrice, 110);

    feed.record(priceUpdate({ markPrice: 90, receivedAtMs: 1_500 }));
    assert.equal(feed.get(1)?.markPrice, 110, 'a stale frame must not overwrite a newer one');
  });
});

describe('MarketFeed price age', () => {
  it('treats a market it has never heard from as having no usable age', () => {
    const feed = new MarketFeed('mainnet', 10_000);
    assert.equal(feed.ageMs(1), undefined);
    assert.equal(feed.isPriceOld(1), true, 'nothing here could be fresh');
    assert.equal(feed.isPriceOldBySymbol('BTC'), true);
  });

  it('is fresh up to and including STALE_MS, old after it', () => {
    const time = clock();
    const feed = new MarketFeed('mainnet', 10_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: time.now() }));

    assert.equal(feed.isPriceOld(1), false);

    time.advance(10_000);
    assert.equal(feed.isPriceOld(1), false, 'exactly at STALE_MS is still fresh');

    time.advance(1);
    assert.equal(feed.isPriceOld(1), true, 'one ms past STALE_MS is not');
  });

  it('measures age from when we received it, not the venue clock', () => {
    const time = clock(5_000);
    const feed = new MarketFeed('mainnet', 10_000, time.now);
    // A venue timestamp far in the future must not make a dead feed look live.
    feed.record(priceUpdate({ receivedAtMs: 1_000, atMs: 9_999_999_999_999 }));

    assert.equal(feed.ageMs(1), 4_000);
    time.advance(7_000);
    assert.equal(feed.isPriceOld(1), true);
  });

  it('never reports a negative age when a clock steps backwards', () => {
    const time = clock(1_000);
    const feed = new MarketFeed('mainnet', 10_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: 2_000 }));
    assert.equal(feed.ageMs(1), 0);
  });

  it('lists exactly the markets whose price is old', () => {
    const time = clock();
    const feed = new MarketFeed('mainnet', 10_000, time.now);
    feed.record(priceUpdate({ marketId: 1, symbol: 'BTC', receivedAtMs: time.now() }));
    time.advance(20_000);
    feed.record(priceUpdate({ marketId: 2, symbol: 'ETH', receivedAtMs: time.now() }));

    assert.deepEqual(feed.oldPriceMarketIds(), [1]);
  });
});

describe('MarketFeed.canAct: a quiet market is not a broken feed', () => {
  it('acts on a quiet market whose price is old but whose feed is healthy', () => {
    const time = clock();
    const feed = new MarketFeed('mainnet', 10_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: time.now() }));

    // On Perpl a mark price only changes when it moves. Five minutes of quiet
    // is a market nobody traded, not a feed that broke.
    time.advance(300_000);

    const gate = feed.canAct(1, CONNECTED);
    assert.equal(gate.ok, true, 'a quiet market stays actionable');
    assert.equal(gate.priceIsOld, true, 'and is still reported as old, for the UI');
    assert.equal(gate.ageMs, 300_000);
    assert.equal(gate.code, undefined);
  });

  it('refuses to act on a fresh-looking price when the feed is disconnected', () => {
    const time = clock();
    const feed = new MarketFeed('mainnet', 10_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: time.now() }));

    // Age says fresh. It is frozen: the connection died a moment ago and the
    // market may have moved since. Age cannot tell; only the feed can.
    const gate = feed.canAct(1, DISCONNECTED);
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'feed-disconnected');
    assert.equal(gate.priceIsOld, false, 'the price really is young — and still unusable');
    assert.match(gate.reason ?? '', /no market data for 90s/);
  });

  it('refuses while reconnecting too, because prices are frozen either way', () => {
    const time = clock();
    const feed = new MarketFeed('mainnet', 10_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: time.now() }));

    const gate = feed.canAct(1, RECONNECTING);
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'feed-disconnected');
    assert.equal(gate.feed, 'reconnecting', 'the UI can still say which it is');
  });

  it('refuses when the feed is healthy but this market never arrived', () => {
    const feed = new MarketFeed('mainnet', 10_000);
    const gate = feed.canAct(42, CONNECTED);
    assert.equal(gate.ok, false);
    assert.equal(gate.code, 'no-price');
    assert.equal(gate.ageMs, undefined);
  });

  it('answers by symbol as well', () => {
    const time = clock();
    const feed = new MarketFeed('mainnet', 10_000, time.now);
    feed.record(priceUpdate({ marketId: 1, symbol: 'BTC', receivedAtMs: time.now() }));
    time.advance(60_000);

    assert.equal(feed.canActBySymbol('BTC', CONNECTED).ok, true, 'quiet BTC is fine');
    assert.equal(feed.canActBySymbol('BTC', DISCONNECTED).ok, false);
    assert.equal(feed.canActBySymbol('NOPE', CONNECTED).code, 'no-price');
    assert.equal(feed.canActBySymbol('NOPE', DISCONNECTED).code, 'feed-disconnected');
  });

  it('never blocks on age alone, at any age, while connected', () => {
    const time = clock();
    const feed = new MarketFeed('mainnet', 1_000, time.now);
    feed.record(priceUpdate({ receivedAtMs: time.now() }));

    for (const advance of [0, 1_000, 10_000, 3_600_000]) {
      time.advance(advance);
      assert.equal(
        feed.canAct(1, CONNECTED).ok,
        true,
        `age ${advance}ms must not gate an action on a connected feed`,
      );
    }
  });
});
