import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadNetworkConfig } from '../config.ts';
import { NotImplementedError, VenueError, VenueRequestError } from '../errors.ts';
import { ContextSchema } from './perpl-context.ts';
import { ApiSecret } from './perpl-signing.ts';
import { PerplVenue, toOpenInterest, toVenueMarket } from './perpl.ts';
import type { VenueMarket } from './types.ts';

function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const mainnetContext = loadFixture('context-mainnet.json');
const testnetContext = loadFixture('context-testnet.json');
const position1 = loadFixture('position1.json') as {
  position: { market: string; leverage: number };
  expected: { maintenanceMarginRatio: number };
};

const mainnet = loadNetworkConfig('mainnet', {});
const testnet = loadNetworkConfig('testnet', {});

/** A fetch that serves a captured context body. */
function stubFetch(body: unknown, init: { status?: number } = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function marketsOf(context: unknown, network: VenueMarket['network']): VenueMarket[] {
  return ContextSchema.parse(context).markets.map((m) => toVenueMarket(m, network));
}

function bySymbol(markets: VenueMarket[], symbol: string): VenueMarket {
  const market = markets.find((m) => m.symbol === symbol);
  assert.ok(market !== undefined, `expected a ${symbol} market`);
  return market;
}

describe('ContextSchema', () => {
  it('parses both captured live responses', () => {
    assert.equal(ContextSchema.parse(mainnetContext).markets.length, 9);
    assert.equal(ContextSchema.parse(testnetContext).markets.length, 7);
  });

  it('rejects a market whose scaling is the wrong type', () => {
    const broken = structuredClone(mainnetContext) as {
      markets: Array<{ config: { price_decimals: unknown } }>;
    };
    broken.markets[0]!.config.price_decimals = '1';
    const result = ContextSchema.safeParse(broken);
    assert.equal(result.success, false);
  });

  it('tolerates unknown fields being added upstream', () => {
    const extended = structuredClone(mainnetContext) as Record<string, unknown>;
    extended['some_new_section'] = { anything: true };
    assert.equal(ContextSchema.safeParse(extended).success, true);
  });
});

describe('toVenueMarket', () => {
  it('reproduces the maintenance margin ratio the position fixture derived', () => {
    // fixtures/position1.json derived mmr = 0.04 from a real BTC position at
    // 15x, and asked whether the context endpoint exposes it. It does, as
    // config.maintenance_margin: 2500. If this assertion ever fails, the
    // encoding assumption in units.ts is wrong and the risk engine is too.
    const btc = bySymbol(marketsOf(mainnetContext, 'mainnet'), position1.position.market);
    assert.equal(btc.maintenanceMarginRatio, position1.expected.maintenanceMarginRatio);
    assert.equal(btc.maxLeverage, position1.position.leverage);
  });

  it('maps mainnet BTC fully', () => {
    const btc = bySymbol(marketsOf(mainnetContext, 'mainnet'), 'BTC');
    assert.deepEqual(btc, {
      venue: 'perpl',
      network: 'mainnet',
      marketId: 1,
      instanceId: 1,
      symbol: 'BTC',
      displayName: 'BTC',
      priceDecimals: 1,
      sizeDecimals: 5,
      maxLeverage: 15,
      maintenanceMarginRatio: 0.04,
      makerFeeMicros: 45,
      takerFeeMicros: 345,
      fundingIntervalSec: 2580,
      orderTtlBlocks: 20,
      isOpen: true,
    });
  });

  it('keys on size_units, not the network-specific display name', () => {
    const btcTestnet = bySymbol(marketsOf(testnetContext, 'testnet'), 'BTC');
    assert.equal(btcTestnet.symbol, 'BTC');
    assert.equal(btcTestnet.displayName, 'BTC Perp');
  });
});

describe('cross-network differences', () => {
  const main = marketsOf(mainnetContext, 'mainnet');
  const test = marketsOf(testnetContext, 'testnet');

  it('gives the same asset a different market id per network', () => {
    assert.equal(bySymbol(main, 'BTC').marketId, 1);
    assert.equal(bySymbol(test, 'BTC').marketId, 16);
    assert.notEqual(bySymbol(main, 'ETH').marketId, bySymbol(test, 'ETH').marketId);
  });

  it('gives the same asset different price scaling per network', () => {
    // The reason scaling is loaded, never hard-coded.
    assert.equal(bySymbol(main, 'SOL').priceDecimals, 3);
    assert.equal(bySymbol(test, 'SOL').priceDecimals, 2);
  });

  it('uses a different protocol instance per network', () => {
    assert.equal(bySymbol(main, 'BTC').instanceId, 1);
    assert.equal(bySymbol(test, 'BTC').instanceId, 12);
  });
});

describe('PerplVenue.getMarkets', () => {
  it('returns every market from the context', async () => {
    const venue = new PerplVenue(mainnet, { fetchImpl: stubFetch(mainnetContext) });
    const markets = await venue.getMarkets();
    assert.equal(markets.length, 9);
    assert.deepEqual(
      markets.map((m) => m.symbol).sort(),
      ['BTC', 'ETH', 'HYPE', 'LIT', 'MON', 'PUMP', 'SOL', 'VVV', 'ZEC'],
    );
  });

  it('requests the documented path', async () => {
    const seen: string[] = [];
    const venue = new PerplVenue(mainnet, {
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify(mainnetContext), {
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    await venue.getMarkets();
    assert.deepEqual(seen, ['https://app.perpl.xyz/api/v1/pub/context']);
  });

  it('refuses a context from the wrong chain', async () => {
    // Guards against an env override pointing a network at the other chain.
    const venue = new PerplVenue(mainnet, { fetchImpl: stubFetch(testnetContext) });
    await assert.rejects(venue.getMarkets(), (error: unknown) => {
      assert.ok(error instanceof VenueRequestError);
      assert.match(error.message, /expected chain 143 for mainnet, context reports 10143/);
      return true;
    });
  });

  it('surfaces a non-2xx with its status', async () => {
    const venue = new PerplVenue(mainnet, {
      fetchImpl: (async () => new Response('upstream down', { status: 503 })) as unknown as typeof fetch,
    });
    await assert.rejects(venue.getMarkets(), (error: unknown) => {
      assert.ok(error instanceof VenueRequestError);
      assert.equal(error.status, 503);
      return true;
    });
  });

  it('rejects a malformed context rather than yielding NaN scaling', async () => {
    const venue = new PerplVenue(mainnet, { fetchImpl: stubFetch({ chain: { chain_id: 143 } }) });
    await assert.rejects(venue.getMarkets(), VenueRequestError);
  });
});

describe('PerplVenue context caching', () => {
  it('reuses the context within its TTL and refetches after refresh', async () => {
    let calls = 0;
    let clock = 0;
    const venue = new PerplVenue(mainnet, {
      contextTtlMs: 1000,
      now: () => clock,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify(mainnetContext), {
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    await venue.getMarkets();
    await venue.getMarkets();
    assert.equal(calls, 1, 'second read should hit the cache');

    clock = 1500;
    await venue.getMarkets();
    assert.equal(calls, 2, 'read past the TTL should refetch');

    venue.refresh();
    await venue.getMarkets();
    assert.equal(calls, 3, 'refresh should force a refetch');
  });

  it('de-duplicates concurrent cold reads into one request', async () => {
    let calls = 0;
    const venue = new PerplVenue(mainnet, {
      fetchImpl: (async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify(mainnetContext), {
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    await Promise.all([venue.getMarkets(), venue.getMarkets(), venue.getMarkets()]);
    assert.equal(calls, 1);
  });
});

describe('PerplVenue.getCollateralToken', () => {
  it('resolves AUSD through the instance collateral_token_id', async () => {
    const venue = new PerplVenue(mainnet, { fetchImpl: stubFetch(mainnetContext) });
    assert.deepEqual(await venue.getCollateralToken(), {
      symbol: 'AUSD',
      decimals: 6,
      address: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
    });
  });
});

describe('PerplVenue.getActionAvailability', () => {
  it('allows actions on a market the acting network lists', async () => {
    const venue = new PerplVenue(testnet, { fetchImpl: stubFetch(testnetContext) });
    assert.deepEqual(await venue.getActionAvailability({ marketId: 16, symbol: 'BTC' }), {
      actionable: true,
      network: 'testnet',
      // The acting network's own id, not mainnet's 1.
      marketId: 16,
    });
  });

  it('refuses a mainnet-only asset, with a reason fit to show in the UI', async () => {
    // HYPE and VVV exist on mainnet only. They are still monitored; only the
    // action controls are disabled.
    const venue = new PerplVenue(testnet, { fetchImpl: stubFetch(testnetContext) });
    for (const [marketId, symbol] of [[40, 'HYPE'], [70, 'VVV']] as const) {
      const availability = await venue.getActionAvailability({ marketId, symbol });
      assert.equal(availability.actionable, false);
      assert.ok(!availability.actionable);
      assert.equal(availability.code, 'not-listed-on-acting-network');
      assert.match(availability.reason, new RegExp(symbol));
      assert.match(availability.reason, /testnet/);
      assert.match(availability.reason, /Monitoring and alerts continue/);
    }
  });

  it('refuses a closed market', async () => {
    const closed = structuredClone(testnetContext) as {
      markets: Array<{ size_units: string; config: { is_open: boolean } }>;
    };
    const lit = closed.markets.find((m) => m.size_units === 'LIT');
    assert.ok(lit !== undefined);
    lit.config.is_open = false;

    const venue = new PerplVenue(testnet, { fetchImpl: stubFetch(closed) });
    const availability = await venue.getActionAvailability({ marketId: 272, symbol: 'LIT' });
    assert.ok(!availability.actionable);
    assert.equal(availability.code, 'market-closed');
  });

  it('refuses everything on a read-only venue, without fetching', async () => {
    // The mainnet analytics venue must never be a route to an action.
    let calls = 0;
    const venue = new PerplVenue(mainnet, {
      readOnly: true,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify(mainnetContext), {
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    const availability = await venue.getActionAvailability({ marketId: 1, symbol: 'BTC' });
    assert.ok(!availability.actionable);
    assert.equal(availability.code, 'venue-read-only');
    assert.equal(availability.network, 'mainnet');
    assert.equal(calls, 0, 'a read-only refusal needs no network call');
  });

  it('MARKET IDENTITY IS THE ID: a retired market whose name lives on is refused, never answered as its successor', async () => {
    // Mainnet SOL v1 (30) was retired and replaced by SOL_v2 (31), whose ticker is SOL.
    // Asking by name found 31 and called market 30 actionable.
    const venue = new PerplVenue(mainnet, { fetchImpl: stubFetch(mainnetContext) });
    const retired = await venue.getActionAvailability({ marketId: 30, symbol: 'SOL' });
    assert.ok(!retired.actionable);
    assert.equal(retired.code, 'not-listed-on-acting-network');
    assert.match(retired.reason, /market 30/);
    const live = await venue.getActionAvailability({ marketId: 31, symbol: 'SOL' });
    assert.deepEqual(live, { actionable: true, network: 'mainnet', marketId: 31 });
  });

  it('a symbol that does not match the id changes nothing: the id decides', async () => {
    const venue = new PerplVenue(testnet, { fetchImpl: stubFetch(testnetContext) });
    assert.deepEqual(await venue.getActionAvailability({ marketId: 16, symbol: 'ETH' }), { actionable: true, network: 'testnet', marketId: 16 });
    assert.equal((await venue.getActionAvailability({ marketId: 32_000, symbol: 'BTC' })).actionable, false);
  });

  it('answers for every market id without throwing', async () => {
    // Whatever the answer, asking must never fail: an unavailable action is a
    // disabled button, not an error path.
    const acting = new PerplVenue(testnet, { fetchImpl: stubFetch(testnetContext) });
    const listed = await acting.getMarkets();
    for (const m of listed) assert.equal((await acting.getActionAvailability(m)).actionable, true);
  });
});

describe('venue action wiring', () => {
  const venue = new PerplVenue(testnet, { fetchImpl: stubFetch(testnetContext) });

  // `cancelAll` must reject, never resolve: a stub that resolved could be read as
  // a completed action, and no action is complete before mt: 24 anyway.
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['cancelAll', () => venue.cancelAll({ idempotencyKey: 'k' })],
  ];

  for (const [name, call] of cases) {
    it(`${name} rejects with NotImplementedError`, async () => {
      await assert.rejects(call(), NotImplementedError);
    });
  }

  // Everything below IS built, off measured round trips, so each fails on the
  // missing key rather than as unimplemented — a different and more honest
  // failure. addMargin: four `t: 6` round trips. Reduce and close: three `t: 3`
  // round trips on 2026-09-30, in fixtures/close-probe-testnet.json.
  const built: Array<[string, () => Promise<unknown>]> = [
    [
      'addMargin',
      () =>
        venue.addMargin({ idempotencyKey: 'k', marketId: 16, symbol: 'BTC', positionId: 1, amountCNS: 10_000_000n }),
    ],
    [
      'reducePosition',
      () =>
        venue.reducePosition({
          idempotencyKey: 'k',
          marketId: 16,
          symbol: 'BTC',
          positionId: 1,
          positionSide: 'long',
          sizeLNS: 1n,
        }),
    ],
    [
      'closePosition',
      () =>
        venue.closePosition({
          idempotencyKey: 'k',
          marketId: 16,
          symbol: 'BTC',
          positionId: 1,
          positionSide: 'long',
          sizeLNS: 1n,
        }),
    ],
  ];

  for (const [name, call] of built) {
    it(`${name} is built, so it fails on the missing key rather than as unimplemented`, async () => {
      await assert.rejects(
        call(),
        (error: unknown) =>
          error instanceof VenueError &&
          !(error instanceof NotImplementedError) &&
          /no API credentials/.test(error.message),
      );
    });
  }

  it('a close refuses a non-positive size before it opens a socket', async () => {
    // Checked before `connectTrading`, so a caller bug costs neither a connection
    // nor an `rq`. This venue has no credentials at all, and the size refusal is
    // what comes back rather than the missing-key one.
    for (const sizeLNS of [0n, -1n]) {
      await assert.rejects(
        venue.closePosition({
          idempotencyKey: 'k',
          marketId: 16,
          symbol: 'BTC',
          positionId: 1,
          positionSide: 'long',
          sizeLNS,
        }),
        /must name a positive size/,
      );
    }
  });
});

describe('PerplVenue.feedStatus', () => {
  it('reports disconnected before anything has subscribed', () => {
    const venue = new PerplVenue(mainnet, { fetchImpl: stubFetch(mainnetContext) });
    const health = venue.feedStatus();

    // The dangerous default would be "connected": a caller that forgot to
    // start the feed would be told its empty cache is trustworthy.
    assert.equal(health.state, 'disconnected');
    assert.equal(health.reconnectAttempt, 0);
    assert.match(health.reason ?? '', /nothing has subscribed yet/);
  });

  it('is available on a read-only analytics venue, which is where prices live', () => {
    const venue = new PerplVenue(mainnet, {
      readOnly: true,
      fetchImpl: stubFetch(mainnetContext),
    });
    assert.equal(venue.feedStatus().state, 'disconnected');
  });
});

// ── getPositions ─────────────────────────────────────────────────────────────

const OWNER = '0x829114e33aff5e7682346300ff1525cbd3a8de17';

/** A websocket the test drives, matching the one in perpl-trading-socket.test. */
class VenueFakeSocket extends EventTarget {
  static last: VenueFakeSocket | undefined;
  readonly sent: Record<string, unknown>[] = [];
  readyState = 0;

  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    VenueFakeSocket.last = this;
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
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    const event = new Event('close') as Event & { code: number; reason: string };
    event.code = code;
    event.reason = reason;
    this.dispatchEvent(event);
  }
}

/** The real testnet position, as captured. */
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

async function venueWithPositions(rows: unknown[] = [wirePosition]): Promise<PerplVenue> {
  const venue = new PerplVenue(testnet, {
    fetchImpl: stubFetch(testnetContext),
    credentials: {
      apiKey: 'opaque',
      secret: ApiSecret.fromHex(
        '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
      ),
    },
    webSocketImpl: VenueFakeSocket as unknown as typeof WebSocket,
  });
  const connecting = venue.connectTrading();
  const fake = VenueFakeSocket.last as VenueFakeSocket;
  fake.open();
  await Promise.resolve();
  fake.deliver({
    mt: 19,
    sn: 100,
    addr: OWNER,
    as: [{ in: 12, id: 710, fr: false, fw: true, lfr: 8, b: '10000000000', lb: '0' }],
  });
  await connecting;
  fake.deliver({ mt: 26, sn: 100, d: rows });
  return venue;
}

describe('PerplVenue.getPositions', () => {
  it('returns the signed-in wallet’s positions, decoded', async () => {
    const venue = await venueWithPositions();
    const positions = await venue.getPositions(OWNER);

    assert.equal(positions.length, 1);
    const [position] = positions;
    assert.equal(position?.symbol, 'BTC');
    assert.equal(position?.side, 'long');
    assert.equal(position?.size, 0.00001);
    assert.equal(position?.entryPrice, 83379.8);
    assert.equal(position?.margin, 0.417125);
    assert.equal(position?.network, 'testnet');
    venue.disconnect();
  });

  it('accepts the address in any case', async () => {
    const venue = await venueWithPositions();
    assert.equal((await venue.getPositions(OWNER.toUpperCase())).length, 1);
    venue.disconnect();
  });

  it('THROWS for any other address rather than answering with ours', async () => {
    // An API key is bound to one account. Returning our positions for someone
    // else's address would be the risk tool lying about whose money is at
    // stake — the worst possible shape of wrong.
    const venue = await venueWithPositions();
    await assert.rejects(
      venue.getPositions('0x0000000000000000000000000000000000000001'),
      /signs for 0x829114e3.*not 0x00000000/s,
    );
    venue.disconnect();
  });

  it('points at the analytics interface for arbitrary wallets', async () => {
    const venue = await venueWithPositions();
    await assert.rejects(
      venue.getPositions('0x0000000000000000000000000000000000000001'),
      /analytics interface over indexed chain data/,
    );
    venue.disconnect();
  });

  it('refuses when the position view cannot be trusted', async () => {
    // No snapshot yet: an empty set and an unknown set must not read alike.
    const venue = new PerplVenue(testnet, {
      fetchImpl: stubFetch(testnetContext),
      credentials: {
        apiKey: 'opaque',
        secret: ApiSecret.fromHex(
          '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        ),
      },
      webSocketImpl: VenueFakeSocket as unknown as typeof WebSocket,
    });
    const connecting = venue.connectTrading();
    const fake = VenueFakeSocket.last as VenueFakeSocket;
    fake.open();
    await Promise.resolve();
    fake.deliver({
      mt: 19,
      sn: 100,
      addr: OWNER,
      as: [{ in: 12, id: 710, fr: false, fw: true, lfr: 8, b: '10000000000', lb: '0' }],
    });
    await connecting;

    await assert.rejects(venue.getPositions(OWNER), /no position snapshot/);
    venue.disconnect();
  });

  it('reports a flat account as empty, not as an error', async () => {
    const venue = await venueWithPositions([]);
    assert.deepEqual(await venue.getPositions(OWNER), []);
    venue.disconnect();
  });

  it('skips a position on a market the context does not list', async () => {
    // Real case: a market listed on chain but absent from the context. One
    // unknown market must not take the rest of the book down with it.
    const venue = await venueWithPositions([wirePosition, { ...wirePosition, mkt: 999, pid: 7 }]);
    const positions = await venue.getPositions(OWNER);
    assert.equal(positions.length, 1);
    assert.equal(positions[0]?.marketId, 16);
    venue.disconnect();
  });
});

describe('PerplVenue.getOpenInterest', () => {
  it('reads the LEVEL off the context state, scaled by each market\'s own decimals', async () => {
    const venue = new PerplVenue(mainnet, { fetchImpl: stubFetch(mainnetContext) });
    const readings = await venue.getOpenInterest();
    const btc = readings.find((r) => r.symbol === 'BTC')!;
    // Fixture: oi 837897 at size_decimals 5, mrk 839877 at price_decimals 1.
    assert.equal(btc.marketId, 1);
    assert.equal(btc.openInterestSize, 8.37897);
    assert.equal(btc.markPrice, 83987.7);
    assert.ok(Math.abs(btc.openInterestNotional - 8.37897 * 83987.7) < 1e-6);
    assert.equal(btc.atBlock, 108065166);
    assert.equal(btc.atMs, 1790391292000);

    // MON has size_decimals 0: integer sizes, and a price at 6dp.
    const mon = readings.find((r) => r.symbol === 'MON')!;
    assert.equal(mon.openInterestSize, 6598227);
    assert.equal(mon.markPrice, 0.026278);
    assert.equal(readings.length, 9, 'every market the context lists, and none it does not');
  });

  it('is pure arithmetic on one row, so the same market on the other network scales by ITS decimals', () => {
    const testnetBtc = ContextSchema.parse(testnetContext).markets.find((m) => m.size_units === 'BTC')!;
    const reading = toOpenInterest(testnetBtc, 'testnet');
    assert.equal(reading.network, 'testnet');
    assert.equal(reading.marketId, 16);
    assert.equal(reading.openInterestSize, 22.47059);
  });
});

describe('PerplVenue.connectTrading after a drop', () => {
  it('returns the same socket while it is open, and a NEW one once it has closed', async () => {
    const venue = await venueWithPositions();
    const first = await venue.connectTrading();
    assert.equal(await venue.connectTrading(), first, 'an open socket is reused');
    const firstFake = VenueFakeSocket.last as VenueFakeSocket;

    firstFake.serverClose(1006, 'connection lost');
    assert.equal(first.closed, true);
    // The dead socket is still what the venue holds for synchronous reads:
    // the last known balance is better than "unknown" during the gap.
    assert.equal(venue.freeBalanceFloorCNS(), 10_000_000_000n);

    const reconnecting = venue.connectTrading();
    const secondFake = VenueFakeSocket.last as VenueFakeSocket;
    assert.notEqual(secondFake, firstFake, 'a fresh websocket is opened');
    secondFake.open();
    await Promise.resolve();
    secondFake.deliver({
      mt: 19,
      sn: 200,
      addr: OWNER,
      as: [{ in: 12, id: 710, fr: false, fw: true, lfr: 11, b: '9000000000', lb: '0' }],
    });
    const second = await reconnecting;
    assert.notEqual(second, first);
    assert.equal(second.closed, false);
    assert.equal(second.lastForwardedRequestId, 11, 'rq is re-derived from the NEW snapshot');
    assert.equal(second.reserveRequestId(), 12);
    assert.equal(venue.freeBalanceFloorCNS(), 9_000_000_000n, 'reads move to the new socket');
    assert.equal(secondFake.sent[0]?.['mt'], 29, 'the new socket signs in first');
    assert.equal(await venue.connectTrading(), second);
  });

  it('shares one connect between callers racing a dead socket', async () => {
    const venue = await venueWithPositions();
    (VenueFakeSocket.last as VenueFakeSocket).serverClose(1006);
    const a = venue.connectTrading();
    const openedFake = VenueFakeSocket.last as VenueFakeSocket;
    const b = venue.connectTrading();
    assert.equal(VenueFakeSocket.last, openedFake, 'the second caller did not open a second websocket');
    openedFake.open();
    await Promise.resolve();
    openedFake.deliver({
      mt: 19,
      sn: 300,
      addr: OWNER,
      as: [{ in: 12, id: 710, fr: false, fw: true, lfr: 11, b: '1', lb: '0' }],
    });
    const [sa, sb] = await Promise.all([a, b]);
    assert.equal(sa, sb);
  });

  it('lets a failed reconnect be tried again rather than caching the failure', async () => {
    const venue = await venueWithPositions();
    (VenueFakeSocket.last as VenueFakeSocket).serverClose(1006);
    const attempt = venue.connectTrading();
    (VenueFakeSocket.last as VenueFakeSocket).serverClose(3401);
    await assert.rejects(attempt, /3401|sign-in rejected/);
    const again = venue.connectTrading();
    const fake = VenueFakeSocket.last as VenueFakeSocket;
    fake.open();
    await Promise.resolve();
    fake.deliver({
      mt: 19,
      sn: 400,
      addr: OWNER,
      as: [{ in: 12, id: 710, fr: false, fw: true, lfr: 11, b: '1', lb: '0' }],
    });
    const socket = await again;
    assert.equal(socket.closed, false);
  });
});
