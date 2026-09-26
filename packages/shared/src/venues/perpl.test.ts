import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadNetworkConfig } from '../config.ts';
import { NotImplementedError, VenueRequestError } from '../errors.ts';
import { ContextSchema } from './perpl-context.ts';
import { PerplVenue, toVenueMarket } from './perpl.ts';
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
      makerFeeBps: 45,
      takerFeeBps: 345,
      fundingIntervalSec: 2580,
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

describe('unimplemented venue actions', () => {
  const venue = new PerplVenue(testnet, { fetchImpl: stubFetch(testnetContext) });

  // These must reject, never resolve: a stub that resolved could be read as a
  // completed action, and no action is complete before mt: 24 anyway.
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['getPositions', () => venue.getPositions('0x0000000000000000000000000000000000000001')],
    ['subscribePrices', () => venue.subscribePrices(['BTC'], () => {})],
    ['addMargin', () => venue.addMargin({ idempotencyKey: 'k', symbol: 'BTC', amount: 10 })],
    ['reducePosition', () => venue.reducePosition({ idempotencyKey: 'k', symbol: 'BTC', size: 1 })],
    ['closePosition', () => venue.closePosition({ idempotencyKey: 'k', symbol: 'BTC' })],
    ['cancelAll', () => venue.cancelAll({ idempotencyKey: 'k' })],
  ];

  for (const [name, call] of cases) {
    it(`${name} rejects with NotImplementedError`, async () => {
      await assert.rejects(call(), NotImplementedError);
    });
  }
});
