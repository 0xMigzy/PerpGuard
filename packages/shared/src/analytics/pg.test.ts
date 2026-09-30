/**
 * The reader, against a recording fake client.
 *
 * The first three tests are the volume-window bug, pinned at the level where it
 * lived: WHICH TABLE a rolling window is read from. It was not a wrong constant or
 * an off-by-one — it was summing UTC-midnight day buckets for a rolling window,
 * which on mainnet at 05:04 UTC returned 3.75M AUSD against a true 16.14M. A test
 * on the number alone would pass against a fixture and regress in production, so
 * these assert the SQL's source and its bind parameter instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAnalytics, type SqlClient } from './pg.ts';
import { symbolResolver } from './map.ts';

const NOW = Date.parse('2026-09-30T05:04:14Z');

const RESOLVE = symbolResolver([
  { marketId: 1, symbol: 'BTC' },
  { marketId: 31, symbol: 'SOL' },
]);

/** Records every query, and answers from a table of canned rows. */
class FakeSql implements SqlClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  /** Matched against the SQL text; first hit wins. */
  readonly answers: Array<[RegExp, Array<Record<string, unknown>>]> = [];

  on(pattern: RegExp, rows: Array<Record<string, unknown>>): this {
    this.answers.push([pattern, rows]);
    return this;
  }

  async query(text: string, values: readonly unknown[] = []) {
    this.calls.push({ sql: text, values });
    for (const [pattern, rows] of this.answers) {
      if (pattern.test(text)) return { rows };
    }
    return { rows: [] };
  }

  /** Every query that touched a table. */
  touching(table: string): Array<{ sql: string; values: readonly unknown[] }> {
    return this.calls.filter((call) => call.sql.includes(`"${table}"`));
  }
}

const exchangeRow = {
  collateralDecimals: 6,
  volumeCNS: '2229336389548745',
  feesCNS: '128060257433',
  tradeCount: '5570901',
  liquidationCount: 680,
  rescuableLiquidationCount: 485,
  liquidationsWithSpareBalanceCount: 680,
  liquidationsWithUnknownPositionCount: 33,
  spareBalanceAtLiquidationCNS: '1126526379973',
  halted: false,
};

function reader(sql: FakeSql): PostgresAnalytics {
  sql.on(/from "Exchange"/, [exchangeRow]);
  return new PostgresAnalytics({
    client: sql,
    chainId: 143,
    resolveSymbol: RESOLVE,
    now: () => NOW,
  });
}

// ── the window bug ──────────────────────────────────────────────────────────

test('a rolling window is summed from Trade rows, NEVER from MarketDay buckets', () => {
  // THE fix. MarketDay.day is UTC midnight, so a rolling window against it sums
  // partial buckets: measured 0.23x on mainnet.
  const sql = new FakeSql();
  return reader(sql)
    .protocolMetrics('24h')
    .then(() => {
      assert.ok(sql.touching('Trade').length > 0, 'volume comes from raw fills');
      assert.equal(
        sql.touching('MarketDay').length,
        0,
        'a rolling window must not read day buckets at all',
      );
    });
});

test('the window bind is a rolling timestamp, not a day boundary', async () => {
  const sql = new FakeSql();
  await reader(sql).protocolMetrics('24h');

  const trade = sql.touching('Trade')[0]!;
  assert.equal(trade.values[0], '2026-09-29T05:04:14.000Z');
  // The buggy query effectively used this. If it ever reappears, this fails.
  assert.notEqual(trade.values[0], '2026-09-30T00:00:00.000Z');
  assert.match(trade.sql, /timestamp >= \$1/);
});

test('the day SERIES does read buckets, because there the bucket is the unit', async () => {
  const sql = new FakeSql();
  await reader(sql).dailySeries('7d');

  assert.ok(sql.touching('MarketDay').length > 0);
  // And it aligns DOWN to midnight, because a chart wants the partial leading day
  // labelled as its own day rather than folded into a total.
  assert.equal(sql.touching('MarketDay')[0]!.values[0], '2026-09-23T00:00:00.000Z');
});

test('all-time passes no window at all, so nothing is filtered out', async () => {
  const sql = new FakeSql();
  await reader(sql).protocolMetrics('all');
  assert.equal(sql.touching('Trade')[0]!.values[0], null);
});

test('active traders are counted DISTINCT across both sides of a match', async () => {
  // A trader on three markets is one active trader. Summing per-market counts
  // would call them three — the same family of mistake as partial buckets.
  const sql = new FakeSql();
  await reader(sql).protocolMetrics('24h');
  const distinct = sql.calls.find((call) => /count\(\*\)::text as traders/.test(call.sql));
  assert.ok(distinct !== undefined, 'a distinct-trader query was issued');
  assert.match(distinct.sql, /union\s+select taker_id/, 'deduplicated across maker and taker');
  assert.doesNotMatch(distinct.sql, /union all/, 'union all would double-count');
});

// ── fees, split honestly ────────────────────────────────────────────────────

test('total fees are served for all-time and withheld for a rolling window', async () => {
  // A taker fill is an aggregate over a whole order, so taker fees have no
  // timestamp finer than the day bucket. Maker fees are a third of the total on
  // mainnet, so serving them as "fees" would repeat the volume bug.
  const sql = new FakeSql().on(/from "Trade"/, [
    { volume: '16139937620601', maker_fees: '42037159020', trades: '84837' },
  ]);
  const analytics = reader(sql);

  const all = await analytics.protocolMetrics('all');
  assert.equal(all.totalFeesAusd, 128_060.257433);

  const day = await analytics.protocolMetrics('24h');
  assert.equal(day.totalFeesAusd, undefined, 'withheld rather than understated');
  assert.equal(day.makerFeesAusd, 42_037.15902, 'and the exact half is still served');
});

// ── the rescue figures ──────────────────────────────────────────────────────

test('the rescue rate comes back over the judgeable denominator', async () => {
  const sql = new FakeSql().on(/from "Liquidation"/, [
    {
      total: '680',
      notional: '0',
      margin_lost: '0',
      bad_debt: '0',
      rescuable: '485',
      unknown: '33',
      any_spare: '680',
      spare_balance: '1126526379973',
    },
  ]);

  const metrics = await reader(sql).protocolMetrics('all');
  assert.equal(metrics.rescues.count, 680);
  assert.equal(metrics.rescues.judgeableCount, 647);
  assert.equal(metrics.rescues.unknownCount, 33);
  assert.equal(metrics.rescues.rescuableCount, 485);
  assert.equal(metrics.rescues.rate?.toFixed(4), '0.7496');
  assert.equal(metrics.rescues.spareBalanceAusd, 1_126_526.379973);
  // The dust diagnostic is carried but is not the rate.
  assert.equal(metrics.rescues.withAnySpareBalanceCount, 680);
});

test('the liquidation SQL tests wasRescuable IS NULL separately from false', async () => {
  // Null means "the position predates the start block", which is not the same as
  // "the balance would not have covered it".
  const sql = new FakeSql();
  await reader(sql).protocolMetrics('24h');
  const query = sql.touching('Liquidation')[0]!;
  assert.match(query.sql, /"wasRescuable" = true/);
  assert.match(query.sql, /"wasRescuable" is null/);
});

// ── collateral flow is not TVL ──────────────────────────────────────────────

test('collateral flow reports the net as a flow, negative included', async () => {
  // Mainnet's net IS negative: accounts held balances before the start block, so
  // withdrawals of pre-existing collateral outweigh deposits we can see. A field
  // called TVL could not carry that honestly.
  const sql = new FakeSql().on(/from "CollateralFlow"/, [
    { deposited: '1183018678531', withdrawn: '2435946982389', deposits: '1734', withdrawals: '2064' },
  ]);
  const flow = (await reader(sql).protocolMetrics('all')).collateralFlow;

  assert.equal(flow.depositedAusd, 1_183_018.678531);
  assert.equal(flow.withdrawnAusd, 2_435_946.982389);
  assert.ok(flow.netAusd < 0, 'negative, and the type says why that is not a bug');
  assert.equal(flow.depositCount, 1_734);
});

// ── symbols and unknowns ────────────────────────────────────────────────────

test('the breakdown resolves symbols by market id and surfaces an unlisted market', async () => {
  const sql = new FakeSql().on(/from "Market" m/, [
    {
      id: '31',
      name: 'SOL_v2',
      priceDecimals: 3,
      lotDecimals: 3,
      markPricePNS: '121912',
      lastFundingRatePct100k: '-2500',
      oi_delta: '5000',
      open_positions: '43',
      volume: '1000000',
      maker_fees: '100',
      trades: '7',
      liquidations: '2',
      rescuable: '1',
      longs: '30',
      shorts: '13',
    },
    {
      id: '80',
      name: 'TAO',
      priceDecimals: 3,
      lotDecimals: 3,
      markPricePNS: null,
      lastFundingRatePct100k: null,
      oi_delta: '0',
      open_positions: '0',
      volume: '0',
      maker_fees: '0',
      trades: '0',
      liquidations: '0',
      rescuable: '0',
      longs: '0',
      shorts: '0',
    },
  ]);

  const breakdown = await reader(sql).marketBreakdown('24h');

  assert.equal(breakdown[0]!.market.symbol, 'SOL', 'not SOL_v2');
  assert.equal(breakdown[0]!.market.indexerName, 'SOL_v2');
  assert.equal(breakdown[0]!.markPrice, 121.912);
  assert.equal(breakdown[0]!.lastFundingRatePct, -0.025);
  assert.equal(breakdown[0]!.longShareOfPositions?.toFixed(4), '0.6977');

  // The market the venue does not list: unknown, not guessed from the chain name.
  assert.equal(breakdown[1]!.market.symbol, undefined);
  assert.equal(breakdown[1]!.market.indexerName, 'TAO');
  assert.equal(breakdown[1]!.longShareOfPositions, undefined, 'no positions, no skew');
});

// ── health ──────────────────────────────────────────────────────────────────

test('health refuses to certify synced without an independent chain head', async () => {
  // chain_metadata.block_height is the indexer's own reading, written by the same
  // process: when it dies both columns freeze and the table reports zero behind.
  const sql = new FakeSql().on(/chain_metadata/, [
    {
      latest_processed_block: 109_233_602,
      block_height: 109_233_602,
      num_events_processed: 21_477_308,
      start_block: 100_000_000,
    },
  ]);

  const health = await reader(sql).health();
  assert.equal(health.headIsIndependent, false);
  assert.equal(health.serveAsCurrent, false, 'zero blocks behind ITSELF proves nothing');
  assert.notEqual(health.state, 'synced');
});

test('health certifies synced when an independent head agrees', async () => {
  const sql = new FakeSql().on(/chain_metadata/, [
    {
      latest_processed_block: 109_233_602,
      block_height: 109_233_602,
      num_events_processed: 21_477_308,
      start_block: 100_000_000,
    },
  ]);
  const analytics = new PostgresAnalytics({
    client: sql,
    chainId: 143,
    resolveSymbol: RESOLVE,
    chainHead: async () => 109_233_700,
    now: () => NOW,
  });

  const health = await analytics.health();
  assert.equal(health.headIsIndependent, true);
  assert.equal(health.state, 'synced');
  assert.equal(health.serveAsCurrent, true);
});

test('an indexer that has never run is unknown, never healthy', async () => {
  const health = await reader(new FakeSql()).health();
  assert.equal(health.serveAsCurrent, false);
});

// ── the wallet lookup that most addresses fail ──────────────────────────────

test('an address with no linked account is not-linked, NOT an empty profile', async () => {
  // 1366 of 1556 mainnet accounts have no owner recorded, because only
  // AccountCreated links the two and most accounts predate the start block.
  // Returning an empty profile would tell a trader they have no history.
  const lookup = await reader(new FakeSql()).wallet('0xAbC0000000000000000000000000000000000001');

  assert.equal(lookup.kind, 'not-linked');
  assert.ok(lookup.kind === 'not-linked');
  assert.equal(lookup.address, '0xabc0000000000000000000000000000000000001', 'lowercased');
  assert.match(lookup.reason, /does NOT mean the address has no history/);
  assert.match(lookup.reason, /look it up by account id/);
});

test('an address matches case-insensitively, because owners are stored checksummed', async () => {
  // The indexer stores the address as the event gave it, which on mainnet is
  // mixed-case EIP-55. Comparing a lowercased input against it exactly matches
  // nothing, and the failure is invisible — it looks like an unlinked address.
  const sql = new FakeSql().on(/lower\(owner\)/, [{ id: '2118' }]);
  sql.on(/from "Trader" where id/, [
    {
      id: '2118',
      accountId: '2118',
      owner: '0xB7854953A71e45D1033B3d619E76d56391291765',
      firstTradeAt: new Date('2026-09-01T00:00:00Z'),
      lastActiveAt: new Date('2026-09-30T00:00:00Z'),
      realizedPnlCNS: '0',
      fundingCNS: '0',
      feesPaidCNS: '0',
      netPnlCNS: '0',
      volumeCNS: '0',
      tradeCount: '0',
      roundTrips: '0',
      wins: '0',
      losses: '0',
      bestRoundTripCNS: '0',
      worstRoundTripCNS: '0',
      liquidationCount: '0',
      rescuableLiquidationCount: '0',
      liquidationsWithSpareBalanceCount: '0',
      spareBalanceAtLiquidationCNS: '0',
    },
  ]);

  const lookup = await reader(sql).wallet('0xB7854953A71e45D1033B3d619E76d56391291765');

  assert.equal(lookup.kind, 'found');
  // The bind is lowercased and the SQL lowercases the column, so either casing
  // of either side resolves.
  const byOwner = sql.calls.find((call) => /lower\(owner\)/.test(call.sql))!;
  assert.equal(byOwner.values[0], '0xb7854953a71e45d1033b3d619e76d56391291765');
});

test('round trips are capped in SQL, because one account has 207,681 of them', async () => {
  const sql = new FakeSql();
  const analytics = reader(sql);

  await analytics.roundTrips(10, { limit: 100_000 });
  const capped = sql.calls.find((call) => /from "Position" p/.test(call.sql))!;
  assert.equal(capped.values[1], 500, 'clamped to a limit a caller can survive');

  await analytics.roundTrips(10, { limit: 0, offset: -5 });
  const floored = sql.calls.filter((call) => /from "Position" p/.test(call.sql)).at(-1)!;
  assert.equal(floored.values[1], 1);
  assert.equal(floored.values[2], 0);
});

test('the collateral decimals come from the Exchange row, not from a constant', async () => {
  const sql = new FakeSql();
  sql.answers.length = 0;
  sql.on(/from "Exchange"/, [{ ...exchangeRow, collateralDecimals: 2 }]);
  sql.on(/from "Trade"/, [{ volume: '100', maker_fees: '0', trades: '1' }]);

  const analytics = new PostgresAnalytics({
    client: sql,
    chainId: 143,
    resolveSymbol: RESOLVE,
    now: () => NOW,
  });
  // 100 at 2 decimals is 1.00, not 0.0001.
  assert.equal((await analytics.protocolMetrics('24h')).volumeAusd, 1);
});

test('no Exchange row throws rather than assuming 6 decimals', async () => {
  const sql = new FakeSql();
  const analytics = new PostgresAnalytics({
    client: sql,
    chainId: 143,
    resolveSymbol: RESOLVE,
    now: () => NOW,
  });
  await assert.rejects(analytics.protocolMetrics('24h'), /Refusing to assume 6 decimals/);
});
