import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadNetworkConfig } from '../config.ts';
import {
  DEFAULT_BACKOFF,
  PerplMarketDataSocket,
  backoffDelayMs,
  toMarketDescriptor,
  type FeedStatus,
  type MarketDescriptor,
} from './perpl-market-data.ts';
import type { PriceUpdate, VenueMarket } from './types.ts';

const mainnet = loadNetworkConfig('mainnet', {});

/** Two markets with DIFFERENT price_decimals, so mis-scaling cannot hide. */
const markets: MarketDescriptor[] = [
  { marketId: 1, symbol: 'BTC', priceDecimals: 1 },
  { marketId: 2, symbol: 'ETH', priceDecimals: 2 },
];

/** A websocket the test drives by hand. */
class FakeSocket extends EventTarget {
  static last: FakeSocket | undefined;
  static created = 0;

  readonly url: string;
  readonly sent: Record<string, unknown>[] = [];
  readyState = 0;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.last = this;
    FakeSocket.created += 1;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  deliver(message: unknown): void {
    const event = new Event('message') as Event & { data: string };
    event.data = JSON.stringify(message);
    this.dispatchEvent(event);
  }

  /** The most recently constructed socket, or a clear failure. */
  static requireLast(): FakeSocket {
    if (FakeSocket.last === undefined) throw new Error('no FakeSocket was constructed');
    return FakeSocket.last;
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    const event = new Event('close') as Event & { code: number; reason: string };
    event.code = code;
    event.reason = reason;
    this.dispatchEvent(event);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds, so a reconnect timer can be awaited. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(1);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Harness {
  socket: PerplMarketDataSocket;
  fake: FakeSocket;
  prices: PriceUpdate[];
  statuses: FeedStatus[];
}

async function started(
  options: { stableAfterMs?: number; baseMs?: number } = {},
): Promise<Harness> {
  FakeSocket.last = undefined;
  FakeSocket.created = 0;

  const socket = new PerplMarketDataSocket({
    network: mainnet,
    markets,
    webSocketImpl: FakeSocket as unknown as typeof WebSocket,
    // Tiny, deterministic delays: the schedule itself is asserted separately
    // against the pure function.
    backoff: { baseMs: options.baseMs ?? 1, maxMs: 4, factor: 2, jitter: 0 },
    stableAfterMs: options.stableAfterMs ?? 10_000,
    pingIntervalMs: 60_000,
  });

  const prices: PriceUpdate[] = [];
  const statuses: FeedStatus[] = [];
  socket.onPrice((update) => prices.push(update));
  socket.onStatus((status) => statuses.push(status));

  const starting = socket.start();
  const fake = FakeSocket.requireLast();
  fake.open();
  await starting;
  return { socket, fake, prices, statuses };
}

/** An mt 9 frame, keyed by market id, with prices as scaled integers. */
function marketState(entries: Record<number, { mrk: number; block?: number; t?: number }>) {
  const d: Record<string, unknown> = {};
  for (const [id, { mrk, block = 100, t = 1_790_000_000_000 }] of Object.entries(entries)) {
    d[id] = {
      at: { b: block, t },
      orl: mrk - 1,
      mrk,
      lst: mrk,
      mid: mrk + 1,
      bid: mrk - 2,
      ask: mrk + 2,
      prv: mrk,
      dv: 0,
      dva: '0',
      oi: 0,
      tvl: '0',
    };
  }
  return { mt: 9, d };
}

function subscribeFrames(fake: FakeSocket): Record<string, unknown>[] {
  return fake.sent.filter((frame) => frame['mt'] === 5);
}

describe('backoffDelayMs', () => {
  const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };

  it('doubles from the base and stops at the ceiling', () => {
    const schedule = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n, noJitter));
    assert.deepEqual(schedule, [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('never exceeds the ceiling, even after a very long outage', () => {
    for (const attempt of [50, 500, 5000]) {
      assert.equal(backoffDelayMs(attempt, noJitter), noJitter.maxMs);
    }
  });

  it('applies jitter downward only, so the ceiling stays a ceiling', () => {
    // random() === 1 is the most jitter possible.
    assert.equal(backoffDelayMs(99, DEFAULT_BACKOFF, () => 1), 24_000);
    assert.equal(backoffDelayMs(99, DEFAULT_BACKOFF, () => 0), 30_000);

    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = backoffDelayMs(3, DEFAULT_BACKOFF, () => r);
      assert.ok(delay <= 2000 && delay >= 1600, `delay ${delay} outside the jittered band`);
    }
  });

  it('is monotonic and never negative', () => {
    let previous = -1;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const delay = backoffDelayMs(attempt, noJitter);
      assert.ok(delay >= 0);
      assert.ok(delay >= previous, 'backoff must not shrink between attempts');
      previous = delay;
    }
  });
});

describe('toMarketDescriptor', () => {
  it('keeps the per-network id and scaling, and nothing else', () => {
    const market = {
      venue: 'perpl',
      network: 'testnet',
      marketId: 16,
      instanceId: 1,
      symbol: 'BTC',
      displayName: 'BTC Perp',
      priceDecimals: 1,
      sizeDecimals: 5,
      maxLeverage: 50,
      maintenanceMarginRatio: 0.01,
      makerFeeMicros: 0,
      takerFeeMicros: 345,
      fundingIntervalSec: 3600,
      orderTtlBlocks: 20,
      isOpen: true,
    } satisfies VenueMarket;

    assert.deepEqual(toMarketDescriptor(market), {
      marketId: 16,
      symbol: 'BTC',
      priceDecimals: 1,
    });
  });
});

describe('PerplMarketDataSocket subscription', () => {
  it('subscribes to market-state and heartbeat for the network chain id', async () => {
    const { fake } = await started();
    const frames = subscribeFrames(fake);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], {
      mt: 5,
      subs: [
        { stream: 'market-state@143', subscribe: true },
        { stream: 'heartbeat@143', subscribe: true },
      ],
    });
  });

  it('connects to the market-data url, not the trading one', async () => {
    const { fake } = await started();
    assert.equal(fake.url, mainnet.marketDataWsUrl);
  });
});

describe('PerplMarketDataSocket price decoding', () => {
  it('descales each market by its own price_decimals', async () => {
    const { fake, prices } = await started();
    fake.deliver(marketState({ 1: { mrk: 840081 }, 2: { mrk: 840081 } }));

    const btc = prices.find((p) => p.symbol === 'BTC');
    const eth = prices.find((p) => p.symbol === 'ETH');
    assert.ok(btc && eth);
    // Same integer on the wire, different decimals, different price.
    assert.equal(btc.markPrice, 84008.1);
    assert.equal(eth.markPrice, 8400.81);
  });

  it('maps every price field and both timestamps', async () => {
    const { fake, prices } = await started();
    fake.deliver(marketState({ 1: { mrk: 1000, block: 65_740_977, t: 1_790_391_300_000 } }));

    const update = prices[0];
    assert.ok(update);
    assert.equal(update.venue, 'perpl');
    assert.equal(update.network, 'mainnet');
    assert.equal(update.marketId, 1);
    assert.equal(update.markPrice, 100);
    assert.equal(update.oraclePrice, 99.9);
    assert.equal(update.midPrice, 100.1);
    assert.equal(update.bid, 99.8);
    assert.equal(update.ask, 100.2);
    assert.equal(update.atBlock, 65_740_977);
    assert.equal(update.atMs, 1_790_391_300_000, 'at.t is already milliseconds');
    assert.ok(update.receivedAtMs > 0);
  });

  it('keeps a lastUpdate per market, newest wins', async () => {
    const { socket, fake } = await started();
    fake.deliver(marketState({ 1: { mrk: 1000 }, 2: { mrk: 2000 } }));
    fake.deliver(marketState({ 1: { mrk: 1100 } }));

    assert.equal(socket.lastUpdate(1)?.markPrice, 110);
    assert.equal(socket.lastUpdate(2)?.markPrice, 20, 'ETH must not be disturbed by a BTC tick');
    assert.ok((socket.lastUpdateAtMs(1) ?? 0) > 0);
    assert.equal(socket.lastUpdate(999), undefined);
    assert.equal(socket.snapshot().length, 2);
  });

  it('ignores markets the context did not list', async () => {
    const { fake, prices } = await started();
    // The stream carries every market on the chain, including ones we have no
    // scaling for. Guessing decimals would invent a wrong price.
    fake.deliver(marketState({ 1: { mrk: 1000 }, 77: { mrk: 5000 } }));
    assert.deepEqual(
      prices.map((p) => p.marketId),
      [1],
    );
  });

  it('skips an unreadable entry without dropping the good ones', async () => {
    const { fake, prices } = await started();
    fake.deliver({ mt: 9, d: { 1: { at: { b: 1, t: 2 }, mrk: 'not-a-number' }, 2: null } });
    assert.equal(prices.length, 0);

    fake.deliver(marketState({ 1: { mrk: 1000 } }));
    assert.equal(prices.length, 1, 'the feed keeps working after a bad frame');
  });
});

describe('PerplMarketDataSocket heartbeat', () => {
  it('tracks the head block', async () => {
    const { socket, fake } = await started();
    fake.deliver({ mt: 100, sn: 1, h: 65_740_995 });
    assert.equal(socket.headBlock, 65_740_995);
  });

  it('resubscribes on a sequence gap, because prices may have been missed', async () => {
    const { fake } = await started();
    fake.deliver({ mt: 100, sn: 1, h: 10 });
    fake.deliver({ mt: 100, sn: 2, h: 11 });
    assert.equal(subscribeFrames(fake).length, 1, 'no gap, no resubscribe');

    fake.deliver({ mt: 100, sn: 9, h: 12 });
    assert.equal(subscribeFrames(fake).length, 2, 'a gap forces a fresh snapshot');
  });
});

describe('PerplMarketDataSocket reconnection', () => {
  it('reconnects and resubscribes after the connection drops', async () => {
    const { socket, fake, statuses } = await started();
    assert.equal(socket.connected, true);

    fake.serverClose(1006, 'network gone');
    assert.equal(socket.connected, false);

    await waitFor(() => FakeSocket.created === 2, 'a second connection');
    const reconnected = FakeSocket.requireLast();
    assert.notEqual(reconnected, fake);
    reconnected.open();

    // Wait on the resubscribe itself: readyState flips to open synchronously,
    // so `connected` is true a tick before the socket has resubscribed.
    await waitFor(
      () => subscribeFrames(reconnected).length === 1,
      'the new connection to resubscribe',
    );
    assert.equal(socket.connected, true);

    assert.ok(statuses.some((s) => s.kind === 'disconnected'));
    assert.equal(statuses.filter((s) => s.kind === 'connected').length, 2);

    // And it delivers prices again on the new connection.
    const prices: PriceUpdate[] = [];
    socket.onPrice((u) => prices.push(u));
    reconnected.deliver(marketState({ 1: { mrk: 1234 } }));
    assert.equal(prices[0]?.markPrice, 123.4);

    socket.close();
  });

  it('backs off further on each consecutive failure, and resets once healthy', async () => {
    const { socket, fake, statuses } = await started();

    // Three drops in a row where the replacement connection never opens.
    fake.serverClose();
    await waitFor(() => FakeSocket.created === 2, 'attempt 2');
    FakeSocket.requireLast().serverClose();
    await waitFor(() => FakeSocket.created === 3, 'attempt 3');
    FakeSocket.requireLast().serverClose();
    await waitFor(() => FakeSocket.created === 4, 'attempt 4');

    const attempts = statuses.filter((s) => s.kind === 'disconnected').map((s) => s.attempt);
    assert.deepEqual(attempts, [1, 2, 3], 'the attempt counter climbs while it keeps failing');
    assert.equal(socket.reconnectAttempt, 3);

    socket.close();
  });

  it('resets the backoff only after a connection proves stable', async () => {
    const { socket, fake } = await started({ stableAfterMs: 5 });
    fake.serverClose();
    await waitFor(() => FakeSocket.created === 2, 'a second connection');
    assert.equal(socket.reconnectAttempt, 1);

    FakeSocket.requireLast().open();
    await waitFor(() => socket.reconnectAttempt === 0, 'the backoff to reset');

    socket.close();
  });

  it('stops reconnecting once closed', async () => {
    const { socket, fake } = await started();
    socket.close();
    fake.serverClose();

    await sleep(20);
    assert.equal(FakeSocket.created, 1, 'a closed feed must not come back');
    assert.equal(socket.connected, false);
  });

  it('throws if the very first connect fails, and starts no retry loop', async () => {
    FakeSocket.created = 0;
    const socket = new PerplMarketDataSocket({
      network: mainnet,
      markets,
      webSocketImpl: FakeSocket as unknown as typeof WebSocket,
      backoff: { baseMs: 1, maxMs: 2, factor: 2, jitter: 0 },
    });

    const starting = socket.start();
    FakeSocket.requireLast().serverClose(1011, 'nope');
    await assert.rejects(starting, /socket closed with 1011/);
    // The transport must not volunteer a trading diagnosis on a public feed.
    await assert.doesNotReject(
      starting.catch((error: Error) => {
        assert.doesNotMatch(error.message, /account this key does not own/);
      }),
    );

    await sleep(20);
    assert.equal(FakeSocket.created, 1, 'a startup failure must not retry behind the caller');
  });
});
