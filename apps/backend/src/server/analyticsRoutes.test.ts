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
  Analytics,
  DailyPoint,
  FundingStats,
  IndexerHealth,
  MarketBreakdown,
  MarketDailySeries,
  MarketOpenInterest,
  ProtocolMetrics,
  RoundTrip,
  Timeframe,
  TvlReading,
  WalletLookup,
  WalletProfile,
} from '@perpguard/shared';
import Fastify from 'fastify';
import { registerAnalyticsRoutes } from './analyticsRoutes.ts';

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

  async wallet(address: string): Promise<WalletLookup> {
    this.asked.push(`wallet:${address}`);
    return this.walletValue;
  }

  async walletByAccountId(accountId: number): Promise<WalletProfile | undefined> {
    this.asked.push(`account:${accountId}`);
    return this.profileValue;
  }

  async roundTrips(
    accountId: number,
    options: { limit?: number; offset?: number } = {},
  ): Promise<readonly RoundTrip[]> {
    this.asked.push(`trips:${accountId}:${options.limit ?? '-'}:${options.offset ?? '-'}`);
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
  options: { openInterest?: () => Promise<readonly MarketOpenInterest[]> } = {
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
  for (const route of ['metrics', 'series', 'series/markets', 'markets', 'funding']) {
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

test('without a venue, open interest is a 503 and never the indexer delta in disguise', async () => {
  const { instance } = app(new FakeAnalytics(), {});
  const response = await instance.inject({ method: 'GET', url: '/api/analytics/open-interest' });
  assert.equal(response.statusCode, 503);
  assert.match(body(response.payload)['error'] as string, /only knows the change/);
});
