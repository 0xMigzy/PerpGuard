/**
 * The position source, and in particular the question it exists to answer:
 * can the set be believed right now?
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadNetworkConfig } from '../config.ts';
import { PerplPositionSource } from './perpl-position-source.ts';
import { positionsAreUsable } from './types.ts';
import { ApiSecret } from './perpl-signing.ts';
import { PerplTradingSocket } from './perpl-trading-socket.ts';
import type { VenueMarket } from './types.ts';

const testnet = loadNetworkConfig('testnet', {});
const secret = ApiSecret.fromHex(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
);

class FakeSocket extends EventTarget {
  static last: FakeSocket | undefined;
  readonly url: string;
  readyState = 0;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.last = this;
  }
  send(): void {}
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
  serverClose(code = 1006, reason = 'connection lost'): void {
    this.readyState = 3;
    const event = new Event('close') as Event & { code: number; reason: string };
    event.code = code;
    event.reason = reason;
    this.dispatchEvent(event);
  }
}

const btc: VenueMarket = {
  venue: 'perpl',
  network: 'testnet',
  marketId: 16,
  instanceId: 12,
  symbol: 'BTC',
  displayName: 'BTC Perp',
  priceDecimals: 1,
  sizeDecimals: 5,
  maxLeverage: 15,
  maintenanceMarginRatio: 0.04,
  makerFeeMicros: 45,
  takerFeeMicros: 345,
  fundingIntervalSec: 3600,
  orderTtlBlocks: 20,
  isOpen: true,
};

const wirePosition = {
  mkt: 16,
  acc: 710,
  pid: 4354895577089,
  st: 1,
  sr: 21,
  sd: 1,
  c: '417125',
  ep: 833798,
  s: 1,
  lv: 200,
  fnd: '0',
  dpnl: '0',
  fee: '288',
};

let clock = 1_000_000;

async function harness(options: { skipped?: (id: number) => void } = {}) {
  clock = 1_000_000;
  const socket = new PerplTradingSocket({
    network: testnet,
    apiKey: 'opaque',
    secret,
    webSocketImpl: FakeSocket as unknown as typeof WebSocket,
    signInTimeoutMs: 50,
    pingIntervalMs: 10_000,
  });
  const connecting = socket.connect();
  const fake = FakeSocket.last as FakeSocket;
  fake.open();
  await Promise.resolve();
  fake.deliver({
    mt: 19,
    sn: 100,
    addr: '0x829114e33aff5e7682346300ff1525cbd3a8de17',
    as: [{ in: 12, id: 710, fr: false, fw: true, lfr: 8, b: '10000000000', lb: '0' }],
  });
  await connecting;

  const source = new PerplPositionSource({
    socket,
    network: 'testnet',
    markets: new Map([[16, btc]]),
    collateralDecimals: 6,
    now: () => clock,
    ...(options.skipped === undefined ? {} : { onSkippedMarket: options.skipped }),
  });
  source.start();
  return { socket, fake, source };
}

describe('status', () => {
  it('is awaiting-snapshot before we are told what is open', async () => {
    const { source } = await harness();
    const status = source.status();
    // NOT "stale": this is expected at startup and recoverable, and calling it
    // stale would read as a fault. It is still not usable.
    assert.equal(status.state, 'awaiting-snapshot');
    assert.equal(positionsAreUsable(status), false);
    assert.equal(status.lastUpdateMs, undefined);
  });

  it('is live once the snapshot lands, even an empty one', async () => {
    const { fake, source } = await harness();
    fake.deliver({ mt: 26, sn: 100, d: [] });
    const status = source.status();
    assert.equal(status.state, 'live');
    assert.equal(positionsAreUsable(status), true);
    assert.equal(status.reason, undefined);
    assert.deepEqual(source.snapshot(), []);
  });

  it('goes stale when the socket closes, and KEEPS the last known set', async () => {
    const { fake, source } = await harness();
    fake.deliver({ mt: 26, sn: 100, d: [wirePosition] });
    assert.equal(source.snapshot().length, 1);

    fake.serverClose();

    const status = source.status();
    assert.equal(status.state, 'stale');
    assert.equal(positionsAreUsable(status), false);
    assert.match(status.reason ?? '', /frozen/);
    // A monitor that has lost its feed keeps showing what it last knew and
    // says so, rather than going blank.
    assert.equal(source.snapshot().length, 1);
  });

  it('goes stale on a sequence gap, when nothing about the set looks wrong', async () => {
    const { fake, source } = await harness();
    fake.deliver({ mt: 26, sn: 100, d: [wirePosition] });
    fake.deliver({ mt: 100, sn: 101, h: 66_450_000 });
    assert.equal(source.status().state, 'live');

    fake.deliver({ mt: 100, sn: 110, h: 66_450_010 });

    const status = source.status();
    assert.equal(status.state, 'stale');
    assert.match(status.reason ?? '', /sequence gap/);
    // This is the case that makes status() necessary: a missed mt 27 could
    // mean this position is already closed, and the set cannot show that.
    assert.equal(source.snapshot().length, 1);
  });

  it('reports how old the set is', async () => {
    const { fake, source } = await harness();
    fake.deliver({ mt: 26, sn: 100, d: [wirePosition] });
    clock += 5_000;
    assert.equal(source.status().ageMs, 5_000);
  });
});

describe('decoding and notification', () => {
  it('notifies subscribers with decoded positions', async () => {
    const { fake, source } = await harness();
    const seen: number[] = [];
    source.onSnapshot((positions) => seen.push(positions.length));

    fake.deliver({ mt: 26, sn: 100, d: [wirePosition] });
    assert.deepEqual(seen, [1]);

    const [position] = source.snapshot();
    assert.equal(position?.symbol, 'BTC');
    assert.equal(position?.side, 'long');
    assert.equal(position?.size, 0.00001);
    assert.equal(position?.margin, 0.417125);
    assert.equal(position?.positionId, 4354895577089);
  });

  it('drops a position when it closes', async () => {
    const { fake, source } = await harness();
    fake.deliver({ mt: 26, sn: 100, d: [wirePosition] });
    fake.deliver({ mt: 27, sn: 100, d: [{ ...wirePosition, st: 2, s: 0, c: '0' }] });
    assert.deepEqual(source.snapshot(), []);
  });

  it('warns once per unlistable market, not once per frame', async () => {
    const skipped: number[] = [];
    const { fake, source } = await harness({ skipped: (id) => skipped.push(id) });
    const unknown = { ...wirePosition, mkt: 999, pid: 7 };

    fake.deliver({ mt: 26, sn: 100, d: [wirePosition, unknown] });
    fake.deliver({ mt: 27, sn: 100, d: [wirePosition] });
    fake.deliver({ mt: 26, sn: 100, d: [wirePosition, unknown] });

    assert.deepEqual(skipped, [999], 'a repeating condition must not repeat the warning');
    assert.equal(source.snapshot().length, 1);
  });

  it('picks up a snapshot that arrived before start()', async () => {
    const { fake, socket } = await harness();
    fake.deliver({ mt: 26, sn: 100, d: [wirePosition] });

    const late = new PerplPositionSource({
      socket,
      network: 'testnet',
      markets: new Map([[16, btc]]),
      collateralDecimals: 6,
      now: () => clock,
    });
    late.start();
    assert.equal(late.snapshot().length, 1);
    assert.equal(late.status().state, 'live');
  });

  it('stops listening after stop()', async () => {
    const { fake, source } = await harness();
    source.stop();
    fake.deliver({ mt: 26, sn: 100, d: [wirePosition] });
    assert.deepEqual(source.snapshot(), []);
  });
});
