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
  TvlReading,
  WalletLookup,
  WalletProfile,
} from '@perpguard/shared';
import Fastify from 'fastify';
import { registerAnalyticsRoutes, type AnalyticsRouteOptions } from './analyticsRoutes.ts';

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
        spareBalanceAusd: 1_126_526.38,
        medianSpareBalanceAusd: 2_318.4,
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

  async traders(timeframe: Timeframe, options: { sort?: string; direction?: string; limit?: number; offset?: number } = {}): Promise<TraderList> {
    this.asked.push(`traders:${timeframe}:${options.sort ?? '-'}:${options.direction ?? '-'}:${options.limit ?? '-'}:${options.offset ?? '-'}`);
    return {
      rows: [],
      total: 0,
      window: { timeframe, honoursTimeframe: timeframe === 'all', label: timeframe === 'all' ? 'all time' : 'the 31 UTC days from 2026-08-31 (today so far)', fromMs: undefined, toMs: 0 },
      sort: 'netPnl',
      direction: 'desc',
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      minRoundTripsForRatios: 10,
    };
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

test('health is re-read on every request, so a halt after boot is not cached', async () => {
  const { instance, analytics } = app();
  await instance.inject({ method: 'GET', url: '/api/analytics/metrics' });
  analytics.healthValue = HALTED;
  const second = await instance.inject({ method: 'GET', url: '/api/analytics/metrics' });
  assert.equal(body(second.payload)['stale'], true);
  assert.equal(analytics.asked.filter((a) => a === 'health').length, 2);
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
    rescues: { count: 0, judgeableCount: 0, unknownCount: 0, rescuableCount: 0, rate: undefined, spareBalanceAusd: 0, medianSpareBalanceAusd: undefined, withAnySpareBalanceCount: 0 },
    realisedPnlAusd: 0, fundingAusd: 0, feesPaidAusd: 0, netPnlAusd: 0, volumeAusd: 0, tradeCount: 0,
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
  rescues: { count: 0, judgeableCount: 0, unknownCount: 0, rescuableCount: 0, rate: undefined, spareBalanceAusd: 0, medianSpareBalanceAusd: undefined, withAnySpareBalanceCount: 0 },
  realisedPnlAusd: 0, fundingAusd: 0, feesPaidAusd: 0, netPnlAusd: 0, volumeAusd: 0, tradeCount: 0,
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
    asOf: { indexerBlock: 109_000_000, marksAtMs: 1, insuranceAtMs: 1, generatedAtMs: 2 },
    moves: [], counted: { positions: 0, priced: 0, unpriced: 0, unpricedReasons: {}, markets: 0 },
    totals: { notionalAusd: 0, longNotionalAusd: 0, shortNotionalAusd: 0, marginAusd: 0, unrealisedPnlAusd: 0 },
    insurance: { totalAusd: undefined, marketsWithReading: 0, marketsWithout: 0 },
    ladder: [], atRisk: {}, weakestCover: undefined, markets: [], positions: [], statements: ['static'],
  } satisfies RiskSnapshot;
  const { instance } = app(new FakeAnalytics(), { riskSnapshot: async () => snapshot });
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/risk' });
  assert.equal(response.statusCode, 200);
  const payload = body(response.payload);
  assert.ok('health' in payload, 'the envelope, like every route');
  assert.equal((payload['data'] as RiskSnapshot).asOf.indexerBlock, 109_000_000);
});
