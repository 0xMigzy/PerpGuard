/**
 * The analytics HTTP surface, against Fastify's own `inject` — so these exercise
 * the real routing, the real serialisation and the real status codes without
 * opening a port.
 *
 * The tests that matter most are the ones about SAYING SO: that a halted indexer's
 * figures arrive flagged rather than bare, that an unknown timeframe is refused
 * rather than defaulted, and that an address nobody can resolve comes back 200 with
 * an explanation instead of 404.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AccountLookup,
  Analytics,
  DailyPoint,
  FundingStats,
  MarketFundingSeries,
  MarketListing,
  HistoryCurve,
  IndexedOpenPosition,
  IndexerHealth,
  LiquidationRecord,
  LiquidationSummary,
  MarketBreakdown,
  MarketDailySeries,
  MarketOpenInterest,
  ProtocolMetrics,
  RiskSnapshot,
  RoundTrip,
  Timeframe,
  TraderDayPoint,
  TraderList,
  TraderSummary,
  TvlReading,
  WalletLookup,
  WalletMatch,
  WalletProfile,
} from '@perpguard/shared';
import Fastify from 'fastify';
import { defaultWarmEntries, registerAnalyticsRoutes, type AnalyticsRouteOptions } from './analyticsRoutes.ts';

const SYNCED: IndexerHealth = {
  state: 'synced',
  blocksBehind: 12,
  headIsIndependent: true,
  serveAsCurrent: true,
  observedAtMs: 1_800_000_000_000,
};

const HALTED: IndexerHealth = {
  state: 'halted',
  blocksBehind: 41_233,
  headIsIndependent: true,
  serveAsCurrent: false,
  reason: 'no progress for 11 minutes; the indexer has stopped',
  stalledForMs: 660_000,
  observedAtMs: 1_800_000_000_000,
};

/** A reader that records what it was asked and answers with canned values. */
class FakeAnalytics implements Analytics {
  healthValue: IndexerHealth = SYNCED;
  tvlValue: TvlReading = {
    known: true,
    totalValueLockedAusd: 4_251_883.12,
    totalValueLockedCNS: 4_251_883_120_000n,
    asOfMs: 1_800_000_000_000,
    source: 'chain',
  };
  walletValue: WalletLookup = {
    kind: 'not-linked',
    address: '0xdead',
    reason: 'no account in the index is linked to that address.',
  };
  profileValue: WalletProfile | undefined;
  searchValue: readonly WalletMatch[] = [];
  readonly asked: string[] = [];

  async health(): Promise<IndexerHealth> {
    this.asked.push('health');
    return this.healthValue;
  }

  async protocolMetrics(timeframe: Timeframe): Promise<ProtocolMetrics> {
    this.asked.push(`metrics:${timeframe}`);
    return {
      timeframe,
      sinceMs: 1_700_000_000_000,
      untilMs: 1_800_000_000_000,
      volumeAusd: 16_189_480.85,
      tradeCount: 84_989,
      makerFeesAusd: 299.15,
      fees: {
        totalAusd: 1_115.51,
        fromMs: Date.parse('2026-09-30T00:00:00Z'),
        toMs: 1_800_000_000_000,
        days: 1,
        label: 'the UTC day from 2026-09-30 (today so far)',
      },
      activeTraders: 281,
      liquidations: { count: 11, notionalAusd: 59_088.01, marginLostAusd: 9_028.19, badDebtAusd: 0 },
      rescues: {
        count: 680,
        judgeableCount: 647,
        unknownCount: 33,
        rescuableCount: 485,
        rate: 485 / 647,
        medianCoverRatio: 186.8,
        coverRatioCount: 485,
        medianSpareBalanceAusd: 2_318.4,
        rescuableRealisedLossAusd: 425_343.63,
        withAnySpareBalanceCount: 680,
      },
      collateralFlow: {
        depositedAusd: 10_787.29,
        withdrawnAusd: 128_679.15,
        netAusd: -117_891.86,
        depositCount: 12,
        withdrawalCount: 31,
      },
      indexedFromMs: Date.parse('2026-08-28T00:00:00Z'),
    };
  }

  async tvl(): Promise<TvlReading> {
    this.asked.push('tvl');
    return this.tvlValue;
  }

  async dailySeries(timeframe: Timeframe): Promise<readonly DailyPoint[]> {
    this.asked.push(`series:${timeframe}`);
    return [];
  }

  async backstopHistory() {
    this.asked.push('backstop');
    return { liquidations: 0, insuranceCredits: 0, insuranceCreditedAusd: 0, badDebtLiquidations: 0, badDebtAusd: 0, sinceMs: undefined };
  }

  async history(): Promise<HistoryCurve> {
    this.asked.push('history');
    return { startsAtMs: Date.UTC(2026, 1, 11, 23, 2, 27), startBlock: 54_773_010, months: [{ monthMs: Date.UTC(2026, 1, 1), trades: 12_576, volumeAusd: 1, newAccounts: 148, partial: false }] };
  }

  async dailySeriesByMarket(timeframe: Timeframe): Promise<readonly MarketDailySeries[]> {
    this.asked.push(`series-markets:${timeframe}`);
    return [];
  }

  async marketBreakdown(timeframe: Timeframe): Promise<readonly MarketBreakdown[]> {
    this.asked.push(`markets:${timeframe}`);
    return [];
  }

  async funding(timeframe: Timeframe): Promise<FundingStats> {
    this.asked.push(`funding:${timeframe}`);
    return { eventCount: 0, meanRatePct: undefined, markets: [] };
  }

  async fundingSeries(timeframe: Timeframe): Promise<readonly MarketFundingSeries[]> {
    this.asked.push(`funding-series:${timeframe}`);
    return [];
  }

  async marketListings(): Promise<readonly MarketListing[]> {
    this.asked.push('market-listings');
    return [];
  }

  async liquidations(
    timeframe: Timeframe,
    options: { limit?: number; offset?: number } = {},
  ): Promise<readonly LiquidationRecord[]> {
    this.asked.push(`liquidations:${timeframe}:${options.limit ?? '-'}:${options.offset ?? '-'}`);
    return [];
  }

  async wallet(address: string): Promise<WalletLookup> {
    this.asked.push(`wallet:${address}`);
    return this.walletValue;
  }

  async walletSearch(prefix: string, limit: number): Promise<readonly WalletMatch[]> {
    this.asked.push(`search:${prefix}:${limit}`);
    return this.searchValue;
  }

  async walletByAccountId(accountId: number): Promise<WalletProfile | undefined> {
    this.asked.push(`account:${accountId}`);
    return this.profileValue === undefined || this.profileValue.accountId === accountId ? this.profileValue : undefined;
  }

  async roundTrips(
    accountId: number,
    options: { limit?: number; offset?: number } = {},
  ): Promise<readonly RoundTrip[]> {
    this.asked.push(`trips:${accountId}:${options.limit ?? '-'}:${options.offset ?? '-'}`);
    return [];
  }

  async traders(timeframe: Timeframe, options: { sort?: string; direction?: string; limit?: number; offset?: number; ranking?: string; query?: string } = {}): Promise<TraderList> {
    this.asked.push(`traders:${timeframe}:${options.sort ?? '-'}:${options.direction ?? '-'}:${options.limit ?? '-'}:${options.offset ?? '-'}${options.ranking === undefined ? '' : `:${options.ranking}`}${options.query === undefined ? '' : `:q=${options.query}`}`);
    return {
      rows: [],
      total: 0,
      window: { timeframe, honoursTimeframe: timeframe === 'all', label: timeframe === 'all' ? 'all time' : 'the 31 UTC days from 2026-08-31 (today so far)', days: timeframe === 'all' ? undefined : 31, fromMs: undefined, toMs: 0 },
      sort: 'netPnl',
      direction: 'desc',
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      minRoundTripsForRatios: 10,
      ranking: undefined,
      belowFloor: undefined,
      query: undefined,
    };
  }

  async traderSummary(timeframe: Timeframe): Promise<TraderSummary> {
    this.asked.push(`trader-summary:${timeframe}`);
    return { window: { timeframe, honoursTimeframe: false, label: 'x', days: 31, fromMs: undefined, toMs: 0 }, traders: 1108, volumeAusd: 1, closedTraders: 1048, profitableTraders: 363, medianNetPnlAusd: -1.82, minTradersForDistribution: 10, liquidations: 589, rescuableLiquidations: 442 };
  }

  async traderDays(accountId: number, timeframe: Timeframe): Promise<readonly TraderDayPoint[]> {
    this.asked.push(`days:${accountId}:${timeframe}`);
    return [];
  }

  async liquidationSummary(timeframe: Timeframe): Promise<LiquidationSummary> {
    this.asked.push(`summary:${timeframe}`);
    return { timeframe, bySize: [], bySpareBalance: [], medianShortfallAusd: undefined, medianShortfallAllAusd: undefined };
  }

  async openPositions(): Promise<readonly IndexedOpenPosition[]> {
    this.asked.push('open-positions');
    return [];
  }
}

const OI: readonly MarketOpenInterest[] = [
  {
    venue: 'perpl', network: 'mainnet', marketId: 1, symbol: 'BTC',
    openInterestSize: 8.37897, markPrice: 83_987.7, openInterestNotional: 703_729.96,
    atBlock: 108_065_166, atMs: 1_790_391_292_000,
  },
  {
    venue: 'perpl', network: 'mainnet', marketId: 10, symbol: 'MON',
    openInterestSize: 6_598_227, markPrice: 0.026278, openInterestNotional: 173_388.21,
    atBlock: 108_065_100, atMs: 1_790_391_200_000,
  },
];

function app(
  analytics: FakeAnalytics = new FakeAnalytics(),
  options: Omit<AnalyticsRouteOptions, 'analytics' | 'prefix'> = {
    openInterest: async () => OI,
  },
) {
  const instance = Fastify({ logger: false });
  registerAnalyticsRoutes(instance, { analytics, ...options });
  return { instance, analytics };
}

const body = (payload: string): Record<string, unknown> =>
  JSON.parse(payload) as Record<string, unknown>;

// ── the health envelope, on every route ─────────────────────────────────────

test('every route carries the indexer health and a stale flag', async () => {
  // A client must be able to render "these numbers are frozen" without making a
  // second request, because a client that has to ask separately will forget to.
  const { instance } = app();
  for (const url of [
    '/api/analytics/health',
    '/api/analytics/metrics',
    '/api/analytics/tvl',
    '/api/analytics/series',
    '/api/analytics/series/markets',
    '/api/analytics/open-interest',
    '/api/analytics/markets',
    '/api/analytics/funding',
    '/api/analytics/funding/series',
    '/api/analytics/markets/listings',
    '/api/analytics/wallet/0x00000000000000000000000000000000000000ab',
  ]) {
    const response = await instance.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, url);
    const payload = body(response.payload);
    assert.ok('data' in payload, `${url} has data`);
    assert.ok('health' in payload, `${url} has health`);
    assert.equal(payload['stale'], false, url);
    assert.equal(typeof payload['generatedAtMs'], 'number', url);
  }
});

test('a halted indexer serves its figures FLAGGED, not withheld', async () => {
  // The product rule everywhere else: keep the last known state visible and say
  // plainly that it is frozen. A blank dashboard helps nobody.
  const { instance, analytics } = app();
  analytics.healthValue = HALTED;

  const response = await instance.inject({ method: 'GET', url: '/api/analytics/metrics' });

  assert.equal(response.statusCode, 200, 'the data is still served');
  const payload = body(response.payload);
  assert.equal(payload['stale'], true);
  assert.match(String(payload['staleReason']), /the indexer has stopped/);
  // And the figures are there, so a dashboard can show them with the warning.
  assert.equal((payload['data'] as ProtocolMetrics).volumeAusd, 16_189_480.85);
  assert.equal((payload['health'] as IndexerHealth).state, 'halted');
});

test('health is cached for two seconds and re-read after, so a halt after boot shows within seconds', async () => {
  let clock = 1_000_000;
  const { instance, analytics } = app(new FakeAnalytics(), { openInterest: async () => OI, now: () => clock });
  await instance.inject({ method: 'GET', url: '/api/analytics/metrics' });
  analytics.healthValue = HALTED;
  // Inside the two seconds: the cached verdict, and no second read. A page's
  // seven calls at once were seven chain RPCs for one block number.
  clock += 1_000;
  const within = await instance.inject({ method: 'GET', url: '/api/analytics/metrics' });
  assert.equal(body(within.payload)['stale'], false);
  assert.equal(analytics.asked.filter((a) => a === 'health').length, 1);
  // Past them: re-read behind the reader, and the NEXT answer says halted.
  clock += 1_500;
  await instance.inject({ method: 'GET', url: '/api/analytics/metrics' });
  await new Promise((r) => setTimeout(r, 0));
  const after = await instance.inject({ method: 'GET', url: '/api/analytics/metrics' });
  assert.equal(body(after.payload)['stale'], true);
  assert.equal(analytics.asked.filter((a) => a === 'health').length, 2);
});

test('an indexed answer is served from the cache, with its age, and refreshed behind the reader past the TTL', async () => {
  let clock = 1_000_000;
  const { instance, analytics } = app(new FakeAnalytics(), { openInterest: async () => OI, now: () => clock, cacheTtlMs: 20_000 });
  const first = body((await instance.inject({ method: 'GET', url: '/api/analytics/metrics?timeframe=30d' })).payload);
  assert.equal(first['ageMs'], 0);
  assert.equal(first['revalidating'], false);
  clock += 5_000;
  const cached = body((await instance.inject({ method: 'GET', url: '/api/analytics/metrics?timeframe=30d' })).payload);
  assert.equal(cached['ageMs'], 5_000, 'the age is how old the figures are, not when they were served');
  assert.equal(cached['computedAtMs'], 1_000_000);
  assert.equal(analytics.asked.filter((a) => a === 'metrics:30d').length, 1, 'no second query inside the TTL');
  clock += 20_000;
  const stale = body((await instance.inject({ method: 'GET', url: '/api/analytics/metrics?timeframe=30d' })).payload);
  assert.equal(stale['ageMs'], 25_000, 'served immediately, old');
  assert.equal(stale['revalidating'], true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(analytics.asked.filter((a) => a === 'metrics:30d').length, 2, 'one refresh ran behind it');
  const fresh = body((await instance.inject({ method: 'GET', url: '/api/analytics/metrics?timeframe=30d' })).payload);
  assert.equal(fresh['ageMs'], 0);
  // A different window is a different answer, never served from the other's cache.
  await instance.inject({ method: 'GET', url: '/api/analytics/metrics?timeframe=7d' });
  assert.equal(analytics.asked.filter((a) => a === 'metrics:7d').length, 1);
});

test('a stale envelope has no staleReason when the indexer is fine', async () => {
  const { instance } = app();
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/metrics' });
  assert.equal('staleReason' in body(response.payload), false);
});

// ── timeframes are validated, never defaulted ───────────────────────────────

test('every valid timeframe is passed through unchanged', async () => {
  const { instance, analytics } = app();
  for (const timeframe of ['24h', '7d', '30d', 'all']) {
    const response = await instance.inject({
      method: 'GET',
      url: `/api/analytics/metrics?timeframe=${timeframe}`,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(analytics.asked.includes(`metrics:${timeframe}`));
  }
});

test('the funding series takes the window it is given; the listings take none', async () => {
  const { instance, analytics } = app();
  const series = await instance.inject({ method: 'GET', url: '/api/analytics/funding/series?timeframe=7d' });
  assert.equal(series.statusCode, 200);
  assert.ok(analytics.asked.includes('funding-series:7d'));
  const bad = await instance.inject({ method: 'GET', url: '/api/analytics/funding/series?timeframe=1h' });
  assert.equal(bad.statusCode, 400, 'never a silent default');
  const listings = await instance.inject({ method: 'GET', url: '/api/analytics/markets/listings' });
  assert.equal(listings.statusCode, 200);
  assert.ok(analytics.asked.includes('market-listings'));
});

test('an unknown timeframe is a 400, never silently 24h', async () => {
  // A typo served as 24h would put one window's numbers under another's label,
  // which is the volume bug wearing a different hat.
  const { instance, analytics } = app();
  const response = await instance.inject({
    method: 'GET',
    url: '/api/analytics/metrics?timeframe=1h',
  });

  assert.equal(response.statusCode, 400);
  assert.match(String(body(response.payload)['error']), /unknown timeframe "1h"/);
  assert.match(String(body(response.payload)['error']), /Refusing to default/);
  assert.equal(analytics.asked.some((a) => a.startsWith('metrics:')), false, 'nothing was queried');
});

test('an absent timeframe defaults to 24h, which is documented rather than guessed', async () => {
  const { instance, analytics } = app();
  await instance.inject({ method: 'GET', url: '/api/analytics/series' });
  assert.ok(analytics.asked.includes('series:24h'));
});

test('every timeframed route validates, not just metrics', async () => {
  const { instance } = app();
  for (const route of ['metrics', 'series', 'series/markets', 'markets', 'funding', 'liquidations']) {
    const response = await instance.inject({
      method: 'GET',
      url: `/api/analytics/${route}?timeframe=nonsense`,
    });
    assert.equal(response.statusCode, 400, route);
  }
});

// ── the wallet lookup, which must not 404 ───────────────────────────────────

test('an unresolvable address is 200 with an explanation, not 404', async () => {
  // 404 would read as "no such trader". Most mainnet accounts have no owner
  // recorded, so "I cannot see which account is yours" is the ordinary answer and
  // it comes with advice about asking by account id.
  const { instance } = app();
  const response = await instance.inject({
    method: 'GET',
    url: '/api/analytics/wallet/0x000000000000000000000000000000000000dead',
  });

  assert.equal(response.statusCode, 200);
  const data = body(response.payload)['data'] as { kind: string; reason: string };
  assert.equal(data.kind, 'not-linked');
  assert.match(data.reason, /no account in the index/);
});

test('a checksummed address is accepted, because addresses are case-insensitive', async () => {
  // CLAUDE.md: this is the shape that failed silently once already, and it is
  // exactly what a user pastes from a block explorer.
  const { instance, analytics } = app();
  const mixed = '0xB7854953A71e45D1033B3d619E76d56391291765';
  const response = await instance.inject({ method: 'GET', url: `/api/analytics/wallet/${mixed}` });

  assert.equal(response.statusCode, 200);
  assert.ok(analytics.asked.includes(`wallet:${mixed}`), 'passed through for the reader to fold');
});

test('a malformed address IS a 400, because that is a client mistake', async () => {
  const { instance, analytics } = app();
  for (const bad of ['0x123', 'vitalik.eth', 'null']) {
    const response = await instance.inject({ method: 'GET', url: `/api/analytics/wallet/${bad}` });
    assert.equal(response.statusCode, 400, bad);
  }
  assert.equal(analytics.asked.some((a) => a.startsWith('wallet:')), false);
});

// ── the prefix search ───────────────────────────────────────────────────────

test('a partial address lists its matches, and no match is an ordinary 200', async () => {
  const { instance, analytics } = app();
  analytics.searchValue = [{ address: '0xB7854953A71e45D1033B3d619E76d56391291765', accountId: 2118 }];
  const hit = await instance.inject({ method: 'GET', url: '/api/analytics/wallet-search?q=0xB785' });
  assert.equal(hit.statusCode, 200);
  const data = body(hit.payload)['data'] as { query: string; matches: WalletMatch[]; limit: number };
  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0]!.accountId, 2118);
  assert.ok(analytics.asked.includes('search:0xB785:20'), 'the prefix is passed through as typed; the reader lowercases');

  analytics.searchValue = [];
  const miss = await instance.inject({ method: 'GET', url: '/api/analytics/wallet-search?q=0xdead' });
  assert.equal(miss.statusCode, 200, 'nothing matched is an answer, not an error');
  assert.deepEqual((body(miss.payload)['data'] as { matches: unknown[] }).matches, []);
});

test('a prefix under 3 hex characters, a non-hex one, or a full address is a 400 on the search route', async () => {
  // Too short would list the whole owner table; a full address belongs to
  // /wallet/:address, where the Exchange contract is consulted as well.
  const { instance, analytics } = app();
  for (const bad of ['0x1', '0x12', '0xzz1', '12345', '0x' + 'a'.repeat(40), '0xab%']) {
    const response = await instance.inject({ method: 'GET', url: `/api/analytics/wallet-search?q=${encodeURIComponent(bad)}` });
    assert.equal(response.statusCode, 400, bad);
  }
  assert.equal(analytics.asked.some((a) => a.startsWith('search:')), false);
});

// ── accounts ────────────────────────────────────────────────────────────────

test('an account id that does not exist IS a 404', async () => {
  // Unlike an address: an account id either exists in the index or it does not,
  // and there is no third reading.
  const { instance } = app();
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/account/99999' });
  assert.equal(response.statusCode, 404);
  assert.match(String(body(response.payload)['error']), /no account 99999/);
});

test('a non-numeric account id is a 400', async () => {
  const { instance } = app();
  for (const bad of ['abc', '-1', '1.5']) {
    const response = await instance.inject({ method: 'GET', url: `/api/analytics/account/${bad}` });
    assert.equal(response.statusCode, 400, bad);
  }
});

test('round-trip paging passes through, and garbage is dropped rather than sent', async () => {
  const { instance, analytics } = app();
  await instance.inject({
    method: 'GET',
    url: '/api/analytics/account/10/round-trips?limit=25&offset=50',
  });
  assert.ok(analytics.asked.includes('trips:10:25:50'));

  // The reader clamps its own limits, so a non-numeric one is simply not passed.
  await instance.inject({
    method: 'GET',
    url: '/api/analytics/account/10/round-trips?limit=abc',
  });
  assert.ok(analytics.asked.includes('trips:10:-:-'));
});

test('liquidation paging passes through with the timeframe, and garbage is dropped', async () => {
  const { instance, analytics } = app();
  const response = await instance.inject({
    method: 'GET',
    url: '/api/analytics/liquidations?timeframe=30d&limit=25&offset=50',
  });
  assert.equal(response.statusCode, 200);
  assert.ok(analytics.asked.includes('liquidations:30d:25:50'));
  assert.equal(body(response.payload)['stale'], false);

  await instance.inject({ method: 'GET', url: '/api/analytics/liquidations?limit=abc' });
  assert.ok(analytics.asked.includes('liquidations:24h:-:-'), 'defaults to 24h, drops the garbage limit');
});

// ── TVL ─────────────────────────────────────────────────────────────────────

test('TVL is served with its own asOfMs, because a level ages', async () => {
  const { instance } = app();
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/tvl' });
  const data = body(response.payload)['data'] as Record<string, unknown>;
  assert.equal(data['known'], true);
  assert.equal(data['totalValueLockedAusd'], 4_251_883.12);
  assert.equal(data['source'], 'chain');
  assert.equal(typeof data['asOfMs'], 'number');
});

test('a TVL the chain would not answer for is known:false, never zero', async () => {
  const { instance, analytics } = app();
  analytics.tvlValue = { known: false, reason: 'the RPC timed out', asOfMs: 1 };
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/tvl' });

  assert.equal(response.statusCode, 200);
  const data = body(response.payload)['data'] as Record<string, unknown>;
  assert.equal(data['known'], false);
  assert.equal('totalValueLockedAusd' in data, false, 'no number to mistake for a balance');
  assert.match(String(data['reason']), /timed out/);
});

test('a bigint in the TVL reading does not break serialisation', async () => {
  // totalValueLockedCNS is a bigint, and JSON.stringify throws on those. If this
  // ever regresses the route 500s rather than returning a wrong number, but it
  // would still be a broken endpoint.
  const { instance } = app();
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/tvl' });
  assert.equal(response.statusCode, 200);
});

// ── discovery ───────────────────────────────────────────────────────────────

test('the prefix lists its routes and explains the stale flag', async () => {
  const { instance } = app();
  const response = await instance.inject({ method: 'GET', url: '/api/analytics' });
  const payload = body(response.payload);
  assert.equal(payload['service'], 'perpguard-analytics');
  assert.match(String(payload['note']), /must not be presented as current/);
  assert.ok((payload['routes'] as string[]).length >= 8);
});

// ── open interest: the level, from the venue ────────────────────────────────

test('open interest sums the venue readings and dates them by the OLDEST market', async () => {
  const { instance } = app();
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/open-interest' });
  assert.equal(response.statusCode, 200);
  const data = body(response.payload)['data'] as {
    markets: unknown[]; totalNotional: number; asOfMs: number;
  };
  assert.equal(data.markets.length, 2);
  assert.ok(Math.abs(data.totalNotional - (703_729.96 + 173_388.21)) < 1e-6);
  assert.equal(data.asOfMs, 1_790_391_200_000, 'the staler of the two, never the fresher');
});

test('assessed positions need a venue: 503 without one, the profile\'s rows through it with one', async () => {
  const bare = app(new FakeAnalytics(), {});
  const refused = await bare.instance.inject({ method: 'GET', url: '/api/analytics/account/10/positions' });
  assert.equal(refused.statusCode, 503);
  assert.match(body(refused.payload)['error'] as string, /cannot be priced/);

  const analytics = new FakeAnalytics();
  analytics.profileValue = {
    address: '', accountId: 10, firstTradeAtMs: undefined, lastActiveAtMs: 1, openPositions: [
      { market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' }, side: 'long', sizeLots: 0.5, entryPrice: 84_000, marginAusd: 2_800, leverage: 15, openedAtMs: 1, marginAddedAusd: 0 },
    ],
    performance: { roundTrips: 0, wins: 0, losses: 0, winRate: undefined, profitFactor: undefined, minRoundTripsForRatios: 10, maxDrawdownAusd: 0, longestWinStreak: 0, longestLossStreak: 0, averageHoldMs: undefined, bestRoundTripAusd: 0, worstRoundTripAusd: 0, bestMarket: undefined, worstMarket: undefined },
    rescues: { count: 0, judgeableCount: 0, unknownCount: 0, rescuableCount: 0, rate: undefined, medianCoverRatio: undefined, coverRatioCount: 0, medianSpareBalanceAusd: undefined, rescuableRealisedLossAusd: 0, withAnySpareBalanceCount: 0 },
    realisedPnlAusd: 0, fundingAusd: 0, feesPaidAusd: 0, netPnlAusd: 0, volumeAusd: 0, tradeCount: 0, freeBalanceAusd: 0, depositedAusd: 0, withdrawnAusd: 0,
  };
  const given: unknown[] = [];
  const wired = app(analytics, {
    openInterest: async () => OI,
    assessPositions: async (positions) => {
      given.push(...positions);
      return { positions: positions.map((position) => ({ position, markPrice: 83_000, liqBufferPct: 0.0266 })), asOfMs: 5 };
    },
  });
  const response = await wired.instance.inject({ method: 'GET', url: '/api/analytics/account/10/positions' });
  assert.equal(response.statusCode, 200);
  assert.equal(given.length, 1, 'the profile\'s open positions are what gets assessed');
  const data = body(response.payload)['data'] as { positions: unknown[]; asOfMs: number };
  assert.equal(data.positions.length, 1);
  assert.equal(data.asOfMs, 5);

  const missing = await wired.instance.inject({ method: 'GET', url: '/api/analytics/account/99/positions' });
  assert.equal(missing.statusCode, 404);
});

test('without a venue, open interest is a 503 and never the indexer delta in disguise', async () => {
  const { instance } = app(new FakeAnalytics(), {});
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/open-interest' });
  assert.equal(response.statusCode, 503);
  assert.match(body(response.payload)['error'] as string, /only knows the change/);
});

// ── the on-chain fallback for a wallet the index cannot link ────────────────

const PROFILE: WalletProfile = {
  address: '',
  accountId: 710,
  firstTradeAtMs: undefined,
  lastActiveAtMs: 1_790_000_000_000,
  openPositions: [],
  performance: {
    roundTrips: 3, wins: 2, losses: 1, winRate: undefined, profitFactor: undefined, minRoundTripsForRatios: 10,
    maxDrawdownAusd: 0, longestWinStreak: 2, longestLossStreak: 1, averageHoldMs: undefined,
    bestRoundTripAusd: 0, worstRoundTripAusd: 0, bestMarket: undefined, worstMarket: undefined,
  },
  rescues: { count: 0, judgeableCount: 0, unknownCount: 0, rescuableCount: 0, rate: undefined, medianCoverRatio: undefined, coverRatioCount: 0, medianSpareBalanceAusd: undefined, rescuableRealisedLossAusd: 0, withAnySpareBalanceCount: 0 },
  realisedPnlAusd: 0, fundingAusd: 0, feesPaidAusd: 0, netPnlAusd: 0, volumeAusd: 0, tradeCount: 0, freeBalanceAusd: 0, depositedAusd: 0, withdrawnAusd: 0,
};

const chain = (answer: AccountLookup) => async (_address: string): Promise<AccountLookup> => answer;

test('an address the index cannot link is asked of the Exchange, and resolves to its profile', async () => {
  // The fix: 88% of mainnet accounts have no owner recorded, but the contract
  // knows every one. Same lookup Protect sign-in already uses.
  const analytics = new FakeAnalytics();
  analytics.profileValue = PROFILE;
  const { instance } = app(analytics, { lookupAccountOnChain: chain({ found: true, accountId: 710, address: '0xdead' }) });
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/wallet/0x000000000000000000000000000000000000dead' });
  assert.equal(response.statusCode, 200);
  const data = body(response.payload)['data'] as { kind: string; resolvedBy: string; profile: WalletProfile };
  assert.equal(data.kind, 'found');
  assert.equal(data.resolvedBy, 'chain', 'the page can say how it got there');
  assert.equal(data.profile.accountId, 710);
  assert.equal(data.profile.address, '0xdead', 'the looked-up address fills the empty owner');
  assert.ok(analytics.asked.includes('account:710'));
});

test('a chain-resolved account the index has never seen is still not-linked, with the id and why', async () => {
  const analytics = new FakeAnalytics();
  analytics.profileValue = undefined;
  const { instance } = app(analytics, { lookupAccountOnChain: chain({ found: true, accountId: 9999, address: '0xdead' }) });
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/wallet/0x000000000000000000000000000000000000dead' });
  const data = body(response.payload)['data'] as { kind: string; accountId?: number; reason: string };
  assert.equal(data.kind, 'not-linked');
  assert.equal(data.accountId, 9999);
  assert.match(data.reason, /resolves .* to account 9999/);
  assert.match(data.reason, /no activity/);
});

test('a chain miss keeps the index answer and appends what the contract said', async () => {
  const { instance } = app(new FakeAnalytics(), { lookupAccountOnChain: chain({ found: false, address: '0xdead', reason: 'this wallet has no account on the Exchange' }) });
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/wallet/0x000000000000000000000000000000000000dead' });
  const data = body(response.payload)['data'] as { kind: string; reason: string };
  assert.equal(data.kind, 'not-linked');
  assert.match(data.reason, /no account in the index/);
  assert.match(data.reason, /Exchange contract was asked too: this wallet has no account/);
});

test('an index hit never asks the chain', async () => {
  const analytics = new FakeAnalytics();
  analytics.walletValue = { kind: 'found', profile: PROFILE, resolvedBy: 'index' };
  let asked = 0;
  const { instance } = app(analytics, { lookupAccountOnChain: async () => { asked += 1; return { found: false, address: 'x', reason: 'no' }; } });
  await instance.inject({ method: 'GET', url: '/api/analytics/wallet/0x000000000000000000000000000000000000dead' });
  assert.equal(asked, 0);
});

// ── the Traders section ─────────────────────────────────────────────────────

test('the traders list passes sort, direction and paging through, and validates them', async () => {
  const { instance, analytics } = app();
  const ok = await instance.inject({ method: 'GET', url: '/api/analytics/traders?timeframe=7d&sort=volume&direction=asc&limit=25&offset=50' });
  assert.equal(ok.statusCode, 200);
  assert.ok(analytics.asked.includes('traders:7d:volume:asc:25:50'));
  const data = body(ok.payload)['data'] as TraderList;
  assert.equal(data.window.honoursTimeframe, false, 'a window comes from day buckets and says so');
  assert.equal(data.minRoundTripsForRatios, 10);

  for (const bad of ['sort=pnl', 'direction=up', 'timeframe=1h']) {
    const response = await instance.inject({ method: 'GET', url: `/api/analytics/traders?${bad}` });
    assert.equal(response.statusCode, 400, bad);
  }
  assert.equal(analytics.asked.filter((a) => a.startsWith('traders:')).length, 1, 'a rejected query is never run');
});

test('an account’s days take the timeframe and validate the id', async () => {
  const { instance, analytics } = app();
  const ok = await instance.inject({ method: 'GET', url: '/api/analytics/account/710/days?timeframe=30d' });
  assert.equal(ok.statusCode, 200);
  assert.ok(analytics.asked.includes('days:710:30d'));
  assert.equal((await instance.inject({ method: 'GET', url: '/api/analytics/account/x/days' })).statusCode, 400);
  assert.equal((await instance.inject({ method: 'GET', url: '/api/analytics/account/710/days?timeframe=1h' })).statusCode, 400);
});

test('the liquidation summary is timeframed like the list', async () => {
  const { instance, analytics } = app();
  assert.equal((await instance.inject({ method: 'GET', url: '/api/analytics/liquidations/summary?timeframe=all' })).statusCode, 200);
  assert.ok(analytics.asked.includes('summary:all'));
  assert.equal((await instance.inject({ method: 'GET', url: '/api/analytics/liquidations/summary?timeframe=1h' })).statusCode, 400);
});

// ── the Risk section ────────────────────────────────────────────────────────

test('risk is a 503 without a venue, and the snapshot in the envelope with one', async () => {
  const none = app();
  const refused = await none.instance.inject({ method: 'GET', url: '/api/analytics/risk' });
  assert.equal(refused.statusCode, 503);
  assert.match(String(body(refused.payload)['error']), /no venue/);

  const snapshot = {
    asOf: { indexerBlock: 109_000_000, marksAtMs: 1, insuranceAtMs: 1, indexerBlockAtMs: 1, generatedAtMs: 2 },
    moves: [], counted: { positions: 0, priced: 0, unpriced: 0, unpricedReasons: {}, markets: 0 },
    totals: { notionalAusd: 0, openInterestAusd: 0, longMarginAusd: 0, shortMarginAusd: 0, marginAusd: 0, unrealisedPnlAusd: 0 },
    insurance: { totalAusd: undefined, marketsWithReading: 0, marketsWithout: 0 },
    backstop: undefined,
    ladder: [], atRisk: {}, weakestCover: undefined, markets: [], positions: [], statements: ['static'],
  } satisfies RiskSnapshot;
  const { instance } = app(new FakeAnalytics(), { riskSnapshot: async () => snapshot });
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/risk' });
  assert.equal(response.statusCode, 200);
  const payload = body(response.payload);
  assert.ok('health' in payload, 'the envelope, like every route');
  assert.equal((payload['data'] as RiskSnapshot).asOf.indexerBlock, 109_000_000);
});

test('the history curve is served through the cache with its start, and is warmed at boot', async () => {
  const { instance, analytics } = app();
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/history' });
  assert.equal(response.statusCode, 200);
  const data = body(response.payload)['data'] as HistoryCurve;
  assert.equal(data.startBlock, 54_773_010);
  assert.equal(data.months[0]!.trades, 12_576);
  assert.ok(analytics.asked.includes('history'));
  assert.ok(defaultWarmEntries(analytics).some((e) => e.key === 'history'));
  assert.ok(defaultWarmEntries(analytics).some((e) => e.key === 'metrics:all'), 'All is the slow one, so it is kept warm');
});

test('traders: ranking and search reach the reader; an unknown ranking is a 400; the summary route serves the cards', async () => {
  const { instance, analytics } = app();
  const ok = await instance.inject({ method: 'GET', url: '/api/analytics/traders?timeframe=30d&ranking=spare&q=%200xB785%20' });
  assert.equal(ok.statusCode, 200);
  assert.ok(analytics.asked.includes('traders:30d:-:-:-:-:spare:q=0xB785'), analytics.asked.join(' '));
  const bad = await instance.inject({ method: 'GET', url: '/api/analytics/traders?timeframe=30d&ranking=richest' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /unknown ranking "richest"/);
  const summary = await instance.inject({ method: 'GET', url: '/api/analytics/traders/summary?timeframe=30d' });
  assert.equal(summary.statusCode, 200);
  assert.equal(body(summary.payload)['data'] && (body(summary.payload)['data'] as TraderSummary).traders, 1108);
});
