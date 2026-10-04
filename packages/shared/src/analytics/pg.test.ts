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
import { PostgresAnalytics, parseTraderQuery, type SqlClient } from './pg.ts';
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

test('rolling VOLUME is summed from Trade rows, never from MarketDay buckets', () => {
  // THE fix. MarketDay.day is UTC midnight, so a rolling window against it sums
  // partial buckets: measured 0.238x on mainnet.
  //
  // Note what is NOT asserted: that MarketDay goes untouched. Fees legitimately
  // read buckets, because taker fees have no finer timestamp — and they bind a DAY
  // boundary and carry their own label saying so. The rule is about which source
  // answers which question, not about avoiding a table.
  const sql = new FakeSql();
  return reader(sql)
    .protocolMetrics('24h')
    .then(() => {
      const volume = sql.touching('Trade');
      assert.ok(volume.length > 0, 'volume comes from raw fills');

      // Bucket reads are the fees query (once per window) and the one-row
      // "where does the index start" probe. Nothing that sums a volume.
      const buckets = sql.touching('MarketDay').filter((c) => !/min\(day\) as from_day/.test(c.sql));
      assert.equal(buckets.length, 2, 'bucket reads are the fees query, once per window');
      for (const bucket of buckets) {
        assert.match(bucket.sql, /sum\("feesCNS"\)/, 'and it is the fees query');
        assert.doesNotMatch(
          bucket.sql,
          /"volumeCNS"/,
          'volume must never be read from a bucket for a rolling window',
        );
      }
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

test('fees come from day buckets and carry the range they ACTUALLY cover', async () => {
  // A taker fill is an aggregate over a whole order, so taker fees have no
  // timestamp finer than the day bucket — and they are the larger share on
  // mainnet. Serving maker fees under the name "fees" would repeat the volume bug,
  // so fees come from buckets and say so.
  const sql = new FakeSql()
    .on(/from "Trade"/, [{ volume: '16139937620601', maker_fees: '42037159020', trades: '84837' }])
    .on(/count\(distinct day\)/, [
      { fees: '20000000000', days: '7', from_day: new Date('2026-09-24T00:00:00Z') },
    ]);

  const metrics = await reader(sql).protocolMetrics('7d');

  assert.equal(metrics.fees.totalAusd, 20_000);
  assert.equal(metrics.fees.days, 7);
  assert.equal(new Date(metrics.fees.fromMs).toISOString(), '2026-09-24T00:00:00.000Z');
  assert.equal(metrics.fees.toMs, NOW, 'through to now, including today’s partial bucket');
  // THE LABEL IS THE POINT: a caller must not render this under "24h" or "7d".
  assert.equal(metrics.fees.label, 'the 7 UTC days from 2026-09-24 (today so far)');
  // And the maker half stays exact for the rolling window.
  assert.equal(metrics.makerFeesAusd, 42_037.15902);
});

test('the fees bind is a DAY boundary while everything else is the rolling instant', async () => {
  const sql = new FakeSql();
  await reader(sql).protocolMetrics('24h');

  const fees = sql.calls.find((call) => /count\(distinct day\)/.test(call.sql))!;
  assert.equal(fees.values[0], '2026-09-29T00:00:00.000Z', 'aligned down to midnight');
  // Volume is NOT aligned: that is the rolling window the bug got wrong.
  assert.equal(sql.touching('Trade')[0]!.values[0], '2026-09-29T05:04:14.000Z');
});

test('a single indexed day is labelled as one day, not as seven', async () => {
  const sql = new FakeSql().on(/count\(distinct day\)/, [
    { fees: '500000000', days: '1', from_day: new Date('2026-09-30T00:00:00Z') },
  ]);
  const metrics = await reader(sql).protocolMetrics('7d');
  // The label follows the DATA, not the request: if only one day is indexed, the
  // figure is one day's and must not claim to be a week's.
  assert.equal(metrics.fees.label, 'the UTC day from 2026-09-30 (today so far)');
  assert.equal(metrics.fees.days, 1);
});

test('no indexed days says so rather than reporting zero fees for a week', async () => {
  const sql = new FakeSql().on(/count\(distinct day\)/, [
    { fees: '0', days: '0', from_day: null },
  ]);
  const metrics = await reader(sql).protocolMetrics('7d');
  assert.equal(metrics.fees.label, 'no complete UTC day of fees is indexed yet');
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
      median_cover: '186.8',
      cover_count: '485',
    },
  ]);

  const metrics = await reader(sql).protocolMetrics('all');
  assert.equal(metrics.rescues.count, 680);
  assert.equal(metrics.rescues.judgeableCount, 647);
  assert.equal(metrics.rescues.unknownCount, 33);
  assert.equal(metrics.rescues.rescuableCount, 485);
  assert.equal(metrics.rescues.rate?.toFixed(4), '0.7496');
  assert.equal(metrics.rescues.medianCoverRatio, 186.8);
  assert.equal(metrics.rescues.coverRatioCount, 485);
  assert.ok(!('spareBalanceAusd' in metrics.rescues), 'the summed free balance is gone: it counted one account once per liquidation');
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
  assert.equal(breakdown[1]!.longShareOfMargin, undefined, 'no margin, no skew: never a 50% default');
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

test('a prefix search lowercases the bind, compares lower(owner), and serves the address as stored', async () => {
  const sql = new FakeSql().on(/lower\(owner\) like/, [
    { id: '2118', owner: '0xB7854953A71e45D1033B3d619E76d56391291765' },
    { id: '2500', owner: '0xB78A0000000000000000000000000000000000AA' },
  ]);

  const matches = await reader(sql).walletSearch('0xB78', 20);

  assert.deepEqual(matches, [
    { address: '0xB7854953A71e45D1033B3d619E76d56391291765', accountId: 2118 },
    { address: '0xB78A0000000000000000000000000000000000AA', accountId: 2500 },
  ]);
  const call = sql.calls.find((c) => /lower\(owner\) like/.test(c.sql))!;
  assert.deepEqual(call.values, ['0xb78', 20]);
  assert.match(call.sql, /owner is not null/);
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

// ── the previous period ─────────────────────────────────────────────────────

test('a timeframe carries the window before it, bounded on BOTH ends', async () => {
  const sql = new FakeSql();
  const metrics = await reader(sql).protocolMetrics('7d');

  const trades = sql.touching('Trade').filter((c) => /sum\("notionalCNS"\)/.test(c.sql));
  assert.equal(trades.length, 2, 'one volume query per window');
  const [current, previous] = trades;
  assert.deepEqual(current!.values, ['2026-09-23T05:04:14.000Z', '2026-09-30T05:04:14.000Z']);
  assert.deepEqual(previous!.values, ['2026-09-16T05:04:14.000Z', '2026-09-23T05:04:14.000Z']);
  assert.match(current!.sql, /timestamp <\s+\$2/, 'the upper bound is exclusive');

  assert.equal(metrics.previous?.sinceMs, Date.parse('2026-09-16T05:04:14Z'));
  assert.equal(metrics.previous?.untilMs, Date.parse('2026-09-23T05:04:14Z'));
  assert.equal('previous' in (metrics.previous ?? {}), false, 'no previous of a previous');
});

test('a previous period the index only partly covers is marked incomplete', async () => {
  // The index starts 2026-08-28. The 30d window before the current 30d one
  // begins 2026-08-01, so its figures are three days dressed as a month.
  const sql = new FakeSql();
  sql.on(/min\(day\) as from_day/, [{ from_day: new Date('2026-08-28T00:00:00Z') }]);
  const month = await reader(sql).protocolMetrics('30d');
  assert.equal(month.indexedFromMs, Date.parse('2026-08-28T00:00:00Z'));
  assert.equal(month.previous?.complete, false);

  // Whereas the day before yesterday is fully covered.
  const day = await reader(sql).protocolMetrics('24h');
  assert.equal(day.previous?.complete, true);

  // And with no bucket at all, nothing is complete and the start is unknown.
  const empty = await reader(new FakeSql()).protocolMetrics('24h');
  assert.equal(empty.indexedFromMs, undefined);
  assert.equal(empty.previous?.complete, false);
});

test('all-time has no previous period, and says so with undefined rather than zero', async () => {
  const sql = new FakeSql();
  const metrics = await reader(sql).protocolMetrics('all');
  assert.equal(metrics.previous, undefined);
  assert.equal(sql.touching('Trade').filter((c) => /notionalCNS/.test(c.sql)).length, 1);
});

test('previous-period fees compare whole day buckets and never say "today so far"', async () => {
  const sql = new FakeSql();
  sql.on(/sum\("feesCNS"\)/, [{ fees: '1000000', days: '7', from_day: new Date('2026-09-16T00:00:00Z') }]);
  const metrics = await reader(sql).protocolMetrics('7d');

  const fees = sql.touching('MarketDay').filter((c) => /sum\("feesCNS"\)/.test(c.sql));
  assert.deepEqual(fees[0]!.values, ['2026-09-23T00:00:00.000Z', null], 'current: open-ended');
  assert.deepEqual(
    fees[1]!.values,
    ['2026-09-16T00:00:00.000Z', '2026-09-23T00:00:00.000Z'],
    'previous: the day buckets before the current range starts',
  );
  assert.match(metrics.fees.label, /today so far/);
  assert.doesNotMatch(metrics.previous!.fees.label, /today so far/);
});

// ── the median ──────────────────────────────────────────────────────────────

test('the median spare balance is over RESCUABLE cases, and undefined when there are none', async () => {
  const sql = new FakeSql();
  sql.on(/from "Liquidation"/, [
    { total: '3', rescuable: '2', unknown: '0', any_spare: '3', median_cover: '42.5', cover_count: '2', median_spare: '1234567.5' },
  ]);
  const metrics = await reader(sql).protocolMetrics('24h');
  assert.match(sql.touching('Liquidation')[0]!.sql, /percentile_cont\(0\.5\)[\s\S]*filter \(where "wasRescuable" = true\)/);
  assert.equal(metrics.rescues.medianSpareBalanceAusd, 1.2345675);

  const none = new FakeSql();
  none.on(/from "Liquidation"/, [{ total: '0', rescuable: '0', unknown: '0', any_spare: '0', median_cover: null, cover_count: '0', median_spare: null }]);
  const empty = (await reader(none).protocolMetrics('24h')).rescues;
  assert.equal(empty.medianSpareBalanceAusd, undefined);
  assert.equal(empty.medianCoverRatio, undefined, 'no rescuable case: no ratio, never zero');
});

// ── daily series ────────────────────────────────────────────────────────────

test('the day series carries the day\'s collateral flow alongside its buckets', async () => {
  const sql = new FakeSql();
  sql.on(/full outer join flows/, [
    {
      day: new Date('2026-09-29T00:00:00Z'), volume: '5000000', trades: '2', fees: '1000',
      liquidations: '1', rescuable: '1', oi_close: '10', max_market_traders: '3',
      deposited: '10000000', withdrawn: '2500000',
    },
  ]);
  const [day] = await reader(sql).dailySeries('7d');
  assert.equal(day!.depositedAusd, 10);
  assert.equal(day!.withdrawnAusd, 2.5);
  assert.equal(day!.netFlowAusd, 7.5);
  assert.equal(day!.volumeAusd, 5);
});

test('the per-market series groups one row per market per day and names the market by id', async () => {
  const sql = new FakeSql();
  const row = (id: string, name: string, day: string, close: string) => ({
    id, name, priceDecimals: '1', day: new Date(day),
    volume: '1000000', trades: '1', fees: '10', liquidations: '0', rescuable: '0', oi_close: '0',
    mark_open: close, mark_high: close, mark_low: close, mark_close: close,
  });
  sql.on(/from "MarketDay" d join "Market" m/, [
    row('1', 'BTC', '2026-09-28T00:00:00Z', '839877'),
    row('1', 'BTC', '2026-09-29T00:00:00Z', '0'),
    row('31', 'SOL_v2', '2026-09-29T00:00:00Z', '121602'),
  ]);
  const series = await reader(sql).dailySeriesByMarket('7d');
  assert.equal(sql.calls.find((c) => /"MarketDay" d/.test(c.sql))!.values[0], '2026-09-23T00:00:00.000Z');
  assert.equal(series.length, 2);
  assert.equal(series[0]!.market.symbol, 'BTC');
  assert.equal(series[0]!.points.length, 2);
  assert.equal(series[0]!.points[0]!.markClose, 83987.7);
  assert.equal(series[0]!.points[1]!.markClose, undefined, 'a bucket with no mark is undefined, never 0');
  // Market 31 is SOL_v2 in the indexer and SOL in the context: resolved by id.
  assert.equal(series[1]!.market.symbol, 'SOL');
  assert.equal(series[1]!.market.indexerName, 'SOL_v2');
});

// ── the liquidation list ────────────────────────────────────────────────────

test('liquidations are raw rows on the rolling window, newest first, capped like round trips', async () => {
  const sql = new FakeSql();
  const analytics = reader(sql);
  await analytics.liquidations('7d', { limit: 100_000, offset: -3 });
  const list = sql.calls.find((call) => /from "Liquidation" l join "Market"/.test(call.sql))!;
  assert.ok(list, 'reads Liquidation rows joined to their market');
  assert.match(list.sql, /order by l\.timestamp desc, l\."logIndex" desc/);
  assert.equal(list.values[0], new Date(NOW - 7 * 24 * 3_600_000).toISOString(), 'the rolling instant, not a day');
  assert.equal(list.values[1], 500, 'capped');
  assert.equal(list.values[2], 0, 'floored');
  await analytics.liquidations('all');
  const all = sql.calls.filter((call) => /from "Liquidation" l join/.test(call.sql)).at(-1)!;
  assert.equal(all.values[0], null, 'all-time passes no window');
  assert.equal(all.values[1], 50, 'the default page');
});

test('a liquidation row scales by ITS market, resolves the symbol by id, and keeps null as unknown', async () => {
  const sql = new FakeSql().on(/from "Liquidation" l join "Market"/, [
    {
      id: '0xabc-23', kind: 'LIQUIDATION', market: '31', name: 'SOL_v2', priceDecimals: 3, lotDecimals: 3,
      account: '4703', side: 'LONG', isFull: true, mark: '118468', exec: '118400', lots: '381',
      notional: '138300333', margin_lost: '61640072', bad_debt: '0', free_before: '2113227859',
      to_survive: '229108', wasRescuable: true, timestamp: '2026-09-29T23:43:35.000Z', txHash: '0xabc',
    },
    {
      id: '0xdef-1', kind: 'LIQUIDATION', market: '80', name: 'TAO', priceDecimals: 3, lotDecimals: 2,
      account: '12', side: 'SHORT', isFull: false, mark: '300684', exec: '300700', lots: '250',
      notional: '1000000', margin_lost: '50000', bad_debt: '0', free_before: '0',
      to_survive: null, wasRescuable: null, timestamp: '2026-09-29T20:00:00.000Z', txHash: '0xdef',
    },
  ]);
  const [sol, tao] = await reader(sql).liquidations('30d');
  assert.equal(sol!.market.symbol, 'SOL', 'by market id: the indexer calls it SOL_v2');
  assert.equal(sol!.side, 'long');
  assert.equal(sol!.kind, 'liquidation');
  assert.equal(sol!.markPrice, 118.468, 'priceDecimals 3');
  assert.equal(sol!.sizeLots, 0.381, 'lotDecimals 3');
  assert.equal(sol!.notionalAusd, 138.300333);
  assert.equal(sol!.freeBalanceBeforeAusd, 2113.227859);
  assert.equal(sol!.marginToSurviveAusd, 0.229108);
  assert.equal(sol!.verdict, 'rescuable');
  assert.equal(sol!.accountId, 4703);
  assert.equal(tao!.market.symbol, undefined, 'unlisted by the venue: no symbol, never the chain name');
  assert.equal(tao!.side, 'short');
  assert.equal(tao!.isFull, false);
  assert.equal(tao!.sizeLots, 2.5, 'lotDecimals 2');
  assert.equal(tao!.marginToSurviveAusd, undefined, 'null stays a hole');
  assert.equal(tao!.verdict, 'unknown', 'null is not false');
});

test('an unrecognised forced-exit kind throws rather than being filed under a guess', async () => {
  const sql = new FakeSql().on(/from "Liquidation" l join "Market"/, [
    { id: 'x', kind: 'SOMETHING_NEW', market: '1', name: 'BTC Perp', priceDecimals: 1, lotDecimals: 5, account: '1', side: 'LONG', isFull: true, mark: '1', exec: '1', lots: '1', notional: '1', margin_lost: '0', bad_debt: '0', free_before: '0', to_survive: null, wasRescuable: null, timestamp: '2026-09-29T20:00:00.000Z', txHash: '0x' },
  ]);
  await assert.rejects(reader(sql).liquidations('24h'), /unrecognised forced exit kind/);
});

// ── the Traders section ─────────────────────────────────────────────────────

test('all-time traders read the lifetime Trader rows; a window sums TraderDay buckets from a DAY boundary', async () => {
  // "This is plumbing, not new maths": the indexer already wrote both tables.
  // A window has no finer grain than a bucket, so it is served day-aligned and
  // the payload says so rather than borrowing the rolling label.
  const all = new FakeSql();
  const lifetime = await reader(all).traders('all');
  assert.equal(all.touching('TraderDay').length, 0);
  assert.equal(all.touching('Trader').length, 1);
  assert.equal(lifetime.window.honoursTimeframe, true);
  assert.equal(lifetime.window.label, 'all time');

  const week = new FakeSql();
  const windowed = await reader(week).traders('7d');
  const query = week.touching('TraderDay')[0]!;
  assert.match(query.sql, /sum\("netPnlCNS"\)/);
  assert.match(query.sql, /sum\(wins \+ losses\)\s+as round_trips/, 'a round trip is a win or a loss');
  assert.equal(query.values[2], '2026-09-23T00:00:00.000Z', 'aligned down to midnight');
  assert.equal(windowed.window.honoursTimeframe, false);
  assert.equal(windowed.window.label, 'the 8 UTC days from 2026-09-23 (today so far)');
  assert.equal(windowed.window.days, 8);
});

test('trader sort keys are whitelisted into the SQL and the direction is never interpolated raw', async () => {
  const sql = new FakeSql();
  await reader(sql).traders('all', { sort: 'winRate', direction: 'asc', limit: 25, offset: 50 });
  const query = sql.touching('Trader')[0]!;
  assert.match(query.sql, /order by win_rate asc nulls last/);
  assert.deepEqual(query.values, [25, 50, null, null, null]);
  // THE NUMERIC COLUMN, NOT THE TEXT ALIAS. `order by net_pnl` sorted "+99"
  // above "+911" on the live list, because the alias is the ::text output.
  // Qualified `w.net_pnl` is the CTE's numeric column, in both forms.
  const pnl = new FakeSql();
  await reader(pnl).traders('all', { sort: 'netPnl' });
  assert.match(pnl.touching('Trader')[0]!.sql, /order by w\.net_pnl desc nulls last/);
  assert.doesNotMatch(pnl.touching('Trader')[0]!.sql, /order by net_pnl/);
  const windowed = new FakeSql();
  await reader(windowed).traders('7d', { sort: 'netPnl' });
  assert.match(windowed.touching('TraderDay')[0]!.sql, /order by w\.net_pnl desc nulls last/);
  assert.doesNotMatch(windowed.touching('TraderDay')[0]!.sql, /order by net_pnl/);
  // An unknown key falls back to the default rather than reaching the text.
  const bad = new FakeSql();
  await reader(bad).traders('all', { sort: 'id; drop table' as never, direction: 'sideways' as never });
  assert.match(bad.touching('Trader')[0]!.sql, /order by w\.net_pnl desc nulls last/);
  assert.doesNotMatch(bad.touching('Trader')[0]!.sql, /drop table/);
});

test('a trader row withholds the win rate under the floor and keeps the counts', async () => {
  const sql = new FakeSql().on(/from "Trader"/, [
    { id: '710', owner: '0xABC', free_balance: '1000000', open_positions: 1, last_active: new Date('2026-09-30T00:00:00Z'), net_pnl: '5000000', volume: '9000000', trades: 4, round_trips: 3, wins: 2, losses: 1, win_rate: null, liquidations: 0, rescuable: 0, total: '1' },
    { id: '711', owner: '', free_balance: '0', open_positions: 0, last_active: new Date('2026-09-30T00:00:00Z'), net_pnl: '0', volume: '0', trades: 40, round_trips: 20, wins: 10, losses: 10, win_rate: 0.5, liquidations: 2, rescuable: 1, total: '1' },
  ]);
  const list = await reader(sql).traders('all');
  assert.equal(list.rows[0]!.winRate, undefined, 'three trades and two wins is not a rate');
  assert.equal(list.rows[0]!.wins, 2);
  assert.equal(list.rows[0]!.address, '0xabc', 'lowercased');
  assert.equal(list.rows[1]!.winRate, 0.5);
  assert.equal(list.minRoundTripsForRatios, 10);
});

test('a profile under the floor withholds both ratios and says which floor', async () => {
  const sql = new FakeSql().on(/from "Trader" where id/, [
    { id: '710', accountId: '710', owner: '', firstTradeAt: null, lastActiveAt: new Date('2026-09-30T00:00:00Z'), realizedPnlCNS: '0', fundingCNS: '0', feesPaidCNS: '0', netPnlCNS: '0', volumeCNS: '0', tradeCount: 3, roundTrips: 3, wins: 3, losses: 0, bestRoundTripCNS: '0', worstRoundTripCNS: '0', liquidationCount: 0, rescuableLiquidationCount: 0, liquidationsWithSpareBalanceCount: 0, spareBalanceAtLiquidationCNS: '0' },
  ]);
  const profile = (await reader(sql).walletByAccountId(710))!;
  assert.equal(profile.performance.winRate, undefined);
  assert.equal(profile.performance.profitFactor, undefined);
  assert.equal(profile.performance.minRoundTripsForRatios, 10);
  assert.equal(profile.performance.wins, 3, 'the history is still served in full');
});

test('trader days read TraderDay for the account, day-aligned, oldest first', async () => {
  const sql = new FakeSql().on(/from "TraderDay"/, [
    { day: new Date('2026-09-29T00:00:00Z'), volume: '1000000', trades: 2, realised: '500000', funding: '-1000', fees: '2000', net_pnl: '497000', wins: 1, losses: 1, liquidations: 0, rescuable: 0, margin_added: '0', margin_removed: '0', deposited: '0', withdrawn: '0', end_free: '3000000' },
  ]);
  const days = await reader(sql).traderDays(710, '7d');
  const query = sql.touching('TraderDay')[0]!;
  assert.deepEqual(query.values, ['710', '2026-09-23T00:00:00.000Z']);
  assert.match(query.sql, /order by day asc/);
  assert.equal(days[0]!.netPnlAusd, 0.497);
  assert.equal(days[0]!.endFreeBalanceAusd, 3);
});

// ── the Liquidations section ────────────────────────────────────────────────

test('the liquidation summary bands the rolling window and reports EVERY band, empty ones included', async () => {
  const sql = new FakeSql()
    .on(/width_bucket/, [
      { size_band: 1, spare_band: 4, total: '3', rescuable: '2', not_rescuable: '1', unknown: '0' },
      { size_band: 4, spare_band: 0, total: '1', rescuable: '0', not_rescuable: '0', unknown: '1' },
    ])
    .on(/median_rescuable/, [{ median_rescuable: '412500000', median_all: '900000000' }]);
  const summary = await reader(sql).liquidationSummary('30d');
  const bands = sql.calls.find((c) => /width_bucket/.test(c.sql))!;
  assert.equal(bands.values[0], '2026-08-31T05:04:14.000Z', 'the rolling instant, like every other window');
  assert.deepEqual(bands.values[2], ['100000000', '1000000000', '10000000000', '100000000000'], 'edges in micros from the Exchange decimals');
  assert.equal(summary.bySize.length, 5);
  assert.equal(summary.bySize[1]!.label, '100 – 1K');
  assert.equal(summary.bySize[1]!.count, 3);
  assert.equal(summary.bySize[1]!.rescuableCount, 2);
  assert.equal(summary.bySize[4]!.label, '≥ 100K');
  assert.equal(summary.bySize[4]!.unknownCount, 1);
  assert.equal(summary.bySize[2]!.count, 0, 'an empty band is present with zeros');
  assert.equal(summary.bySpareBalance[0]!.label, '< 1');
  assert.equal(summary.bySpareBalance[0]!.count, 1);
  assert.equal(summary.bySpareBalance[4]!.count, 3);
  assert.equal(summary.medianShortfallAusd, 412.5);
  assert.equal(summary.medianShortfallAllAusd, 900);
});

test('every open position is read with its owner, scaled by its market, unknown entries kept as holes', async () => {
  const sql = new FakeSql().on(/where p.status = 'OPEN'\s+order by/, [
    { account: '710', id: 1, name: 'BTC Perp', priceDecimals: 1, lotDecimals: 5, side: 'LONG', lotLNS: '50000', entryPricePNS: '840295', entryPriceKnown: true, depositCNS: '2810330000', leverageHdths: '1500', openedAt: new Date('2026-09-30T00:00:00Z'), marginAddedCNS: '0' },
    { account: '711', id: 31, name: 'SOL_v2', priceDecimals: 3, lotDecimals: 3, side: 'SHORT', lotLNS: '2000', entryPricePNS: '0', entryPriceKnown: false, depositCNS: '100000000', leverageHdths: '500', openedAt: new Date('2026-09-30T00:00:00Z'), marginAddedCNS: '0' },
  ]);
  const positions = await reader(sql).openPositions();
  assert.equal(positions.length, 2);
  assert.equal(positions[0]!.accountId, 710);
  assert.equal(positions[0]!.position.sizeLots, 0.5);
  assert.equal(positions[0]!.position.entryPrice, 84_029.5);
  assert.equal(positions[0]!.position.marginAusd, 2_810.33);
  assert.equal(positions[1]!.position.market.symbol, 'SOL', 'resolved by id, not by the chain name');
  assert.equal(positions[1]!.position.entryPrice, undefined);
  assert.equal(positions[1]!.position.side, 'short');
});

test('per-market fees are maker PLUS taker from day buckets, with the same label as the protocol figure', async () => {
  // One definition, both places (CLAUDE.md). The maker half stays exact under its own name.
  const sql = new FakeSql().on(/from "Market" m/, [
    { id: 1, name: 'BTC Perp', priceDecimals: 1, lotDecimals: 5, markPricePNS: '800000', lastFundingRatePct100k: '4', oi_delta: '0', open_positions: '2', volume: '1000000000', maker_fees: '300000', trades: '10', fees: '1000000', fee_days: '7', fee_from_day: new Date('2026-09-24T00:00:00Z'), liquidations: '0', rescuable: '0', longs: '1', shorts: '1', long_margin: '1000000000', short_margin: '3000000000' },
  ]);
  const [btc] = await reader(sql).marketBreakdown('7d');
  const query = sql.touching('Market')[0]!;
  assert.equal(query.values[0], '2026-09-23T05:04:14.000Z', 'rolling for volume');
  assert.equal(query.values[1], '2026-09-23T00:00:00.000Z', 'a day boundary for fees');
  assert.equal(btc!.fees.totalAusd, 1);
  assert.equal(btc!.fees.label, 'the 7 UTC days from 2026-09-24 (today so far)');
  assert.equal(btc!.makerFeesAusd, 0.3);
  // Skew by margin at risk: 1,000 AUSD posted long, 3,000 short.
  assert.equal(btc!.longMarginAusd, 1_000);
  assert.equal(btc!.shortMarginAusd, 3_000);
  assert.equal(btc!.longShareOfMargin, 0.25);
});

test('the current window\u2019s fees include today\u2019s bucket however much time passes mid-read (the 1 Oct race)', async () => {
  // untilMs is "now" at the start of the read; by the fee query the clock has
  // moved on. That used to drop today at random. Here the clock advances one
  // millisecond on every read, which is the losing case every time.
  const sql = new FakeSql();
  sql.on(/from "Exchange"/, [exchangeRow]);
  let clock = NOW;
  const analytics = new PostgresAnalytics({ client: sql, chainId: 143, resolveSymbol: RESOLVE, now: () => (clock += 1) });
  const metrics = await analytics.protocolMetrics('7d');
  const fees = sql.calls.filter((c) => /count\(distinct day\)/.test(c.sql));
  assert.equal(fees.length, 2, 'current and previous windows');
  assert.equal(fees[0]!.values[1], null, 'the current window is open-ended: today counts');
  assert.notEqual(fees[1]!.values[1], null, 'the previous window ends at a day boundary');
  assert.match(metrics.fees.label, /today so far|no complete UTC day/, 'labelled as the current window');
});

test('the funding series sums every rate as integers and says which resolution it drew', async () => {
  // Positive is longs paying (Perpl docs). 4 + 4 − 1 hundred-thousandths of a percent.
  const sql = new FakeSql().on(/from "FundingEvent" f join "Market" m/, [
    { id: '1', name: 'BTC Perp', at: new Date('2026-10-01T00:00:00Z'), rate: '4', rate_sum: '4', events: '1' },
    { id: '1', name: 'BTC Perp', at: new Date('2026-10-01T00:43:00Z'), rate: '4', rate_sum: '4', events: '1' },
    { id: '1', name: 'BTC Perp', at: new Date('2026-10-01T01:26:00Z'), rate: '-1', rate_sum: '-1', events: '1' },
    { id: '31', name: 'SOL_v2', at: new Date('2026-10-01T00:00:00Z'), rate: '-2', rate_sum: '-2', events: '1' },
  ]);
  const series = await reader(sql).fundingSeries('7d');
  assert.equal(series.length, 2);
  assert.equal(series[0]!.resolution, 'event');
  assert.equal(series[0]!.eventCount, 3);
  assert.equal(series[0]!.cumulativeRatePct, 0.00007);
  assert.deepEqual(series[0]!.points.map((p) => p.ratePct), [0.00004, 0.00004, -0.00001]);
  assert.equal(series[1]!.market.symbol, 'SOL', 'resolved by id, not by the chain name');
  assert.equal(sql.touching('FundingEvent')[0]!.values[1], false, 'every event up to 7 days');
});

test('over 30D and All the line is a daily mean, but the sum is still over every event', async () => {
  const sql = new FakeSql().on(/from "FundingEvent" f join "Market" m/, [
    { id: '1', name: 'BTC Perp', at: new Date('2026-09-30T00:00:00Z'), rate: '2.5', rate_sum: '85', events: '34' },
    { id: '1', name: 'BTC Perp', at: new Date('2026-10-01T00:00:00Z'), rate: '-1', rate_sum: '-33', events: '33' },
  ]);
  const [btc] = await reader(sql).fundingSeries('all');
  assert.equal(btc!.resolution, 'utc-day');
  assert.equal(btc!.eventCount, 67);
  assert.equal(btc!.cumulativeRatePct, 0.00052, '(85 − 33) / 100,000: the events, not the daily means');
  assert.equal(sql.touching('FundingEvent')[0]!.values[1], true);
  assert.deepEqual(btc!.points.map((p) => p.events), [34, 33], 'each point says how many settlements it averages');
  await reader(sql).fundingSeries('30d');
  const series = sql.touching('FundingEvent').filter((c) => /join "Market" m/.test(c.sql));
  assert.equal(series[1]!.values[1], true, '30D too: 1,000 steps would read as a block');
});

test('the funding cadence is the venue interval beside the measured one, never assumed hourly', async () => {
  const sql = new FakeSql()
    .on(/from "FundingEvent" f join "Market" m/, [{ id: '1', name: 'BTC Perp', at: new Date('2026-10-01T00:00:00Z'), rate: '4', rate_sum: '4', events: '1' }])
    .on(/mean_gap_sec/, [{ id: '1', events: '33', mean_gap_sec: '2587.4' }]);
  const analytics = new PostgresAnalytics({ client: sql, chainId: 143, resolveSymbol: RESOLVE, fundingIntervalSec: (id) => (id === 1 ? 2580 : undefined), now: () => NOW });
  const [btc] = await analytics.fundingSeries('24h');
  assert.deepEqual(btc!.cadence, { venueIntervalSec: 2580, measuredIntervalSec: 2587.4, eventsPerDay: 33 });
  const bare = await reader(new FakeSql().on(/from "FundingEvent" f join "Market" m/, [{ id: '1', name: 'BTC Perp', at: new Date('2026-10-01T00:00:00Z'), rate: '4', rate_sum: '4', events: '1' }])).fundingSeries('24h');
  assert.deepEqual(bare[0]!.cadence, { venueIntervalSec: undefined, measuredIntervalSec: undefined, eventsPerDay: 0 }, 'unknown stays unknown');
});

test('a listing reads the contract parameters in the context’s units, and keeps the chain symbol', async () => {
  const sql = new FakeSql().on(/where m.listed/, [
    { id: '120', name: 'ARB', symbol: 'ARB', paused: true, priceDecimals: 5, lotDecimals: 1, init_margin: '300', maint_margin: '1000', max_oi: '250000000', mark: '20233', mark_at: new Date('2026-10-03T12:00:00Z'), listed_at: new Date('2026-09-30T10:55:39Z'), trades: '0' },
    { id: '1', name: 'BTC Perp', symbol: 'BTC', paused: false, priceDecimals: 1, lotDecimals: 5, init_margin: '1500', maint_margin: '2500', max_oi: '30000000', mark: '848050', mark_at: null, listed_at: new Date('2026-02-11T23:02:32Z'), trades: '22394371' },
  ]);
  const [arb, btc] = await reader(sql).marketListings();
  assert.equal(arb!.market.symbol, undefined, 'the venue does not list it, so it has no ticker');
  assert.equal(arb!.chainSymbol, 'ARB');
  assert.equal(arb!.paused, true);
  assert.equal(arb!.maxLeverage, 3);
  assert.equal(arb!.maintenanceMarginRatio, 0.1);
  assert.equal(arb!.maxOpenInterestSize, 25_000_000);
  assert.equal(arb!.markPrice, 0.20233);
  assert.equal(arb!.tradesAllTime, 0);
  assert.equal(btc!.maxLeverage, 15, 'the ground-truth position is 15x at BTC’s maximum');
  assert.equal(btc!.maintenanceMarginRatio, 0.04);
  assert.equal(btc!.markAtMs, undefined);
});

test('THE COVER RATIO: free balance over shortfall, per rescuable event, never a sum of free balance', async () => {
  const sql = new FakeSql();
  sql.on(/from "Exchange"/, [exchangeRow]);
  sql.on(/from "Liquidation"/, [{ total: '3', rescuable: '2', unknown: '0', any_spare: '3', median_cover: '42.5', cover_count: '2', median_spare: '1' }]);
  const metrics = await reader(sql).protocolMetrics('30d');
  const text = sql.touching('Liquidation')[0]!.sql;
  assert.match(text, /percentile_cont\(0\.5\) within group \(order by "freeBalanceBeforeCNS"::numeric \/ "marginToSurviveCNS"\)/);
  assert.match(text, /"wasRescuable" = true and "marginToSurviveCNS" > 0/, 'rescuable only, and never a division by zero');
  assert.doesNotMatch(text, /sum\("freeBalanceBeforeCNS"\)/, 'no sum of a per-account level across liquidations');
  assert.equal(metrics.rescues.medianCoverRatio, 42.5);
  assert.equal(metrics.rescues.coverRatioCount, 2);
});

// ── the Traders page: rankings, the floor, search, the cards ───────────────

test('a trader is someone who TRADED in the window: every list filters trades > 0', async () => {
  for (const tf of ['all', '30d'] as const) {
    const sql = new FakeSql();
    await reader(sql).traders(tf);
    assert.match(sql.touching('Trader')[0]!.sql, /where w\.trades > 0/);
  }
});

test('THE RANKING FLOOR: PnL rankings need 10 round trips; volume and liquidations do not', async () => {
  const pnl = new FakeSql();
  await reader(pnl).traders('30d', { ranking: 'pnl' });
  const text = pnl.touching('Trader')[0]!.sql;
  assert.match(text, /and \(w\.round_trips >= 10\)/);
  assert.match(text, /order by w\.net_pnl desc/);
  const losses = new FakeSql();
  await reader(losses).traders('30d', { ranking: 'losses' });
  assert.match(losses.touching('Trader')[0]!.sql, /and \(w\.round_trips >= 10\)[\s\S]*order by w\.net_pnl asc/);
  const volume = new FakeSql();
  await reader(volume).traders('30d', { ranking: 'volume' });
  assert.match(volume.touching('Trader')[0]!.sql, /and \(true\)[\s\S]*order by w\.volume desc/);
  const liquidated = new FakeSql();
  await reader(liquidated).traders('30d', { ranking: 'liquidated' });
  assert.match(liquidated.touching('Trader')[0]!.sql, /and \(w\.liquidations > 0\)[\s\S]*order by w\.liquidations desc/);
});

test('"Liquidated with spare" ranks by the LARGEST free balance at a RESCUABLE liquidation, never a sum, never the dust flag', async () => {
  const sql = new FakeSql();
  await reader(sql).traders('all', { ranking: 'spare' });
  const text = sql.touching('Trader')[0]!.sql;
  assert.match(text, /max\("freeBalanceBeforeCNS"\) filter \(where "wasRescuable" = true\) as spare_held/);
  assert.doesNotMatch(text, /sum\("freeBalanceBeforeCNS"\)/);
  assert.doesNotMatch(text, /hadSpareBalance/);
  assert.match(text, /and \(l\.spare_held is not null\)[\s\S]*order by l\.spare_held desc/);
});

test('the floor reports how many it left out; a search drops it so any account can be found', async () => {
  const row = { id: '2260', owner: '0xabc', free_balance: '0', open_positions: 0, last_active: new Date('2026-10-01T00:00:00Z'), net_pnl: '30262000000', volume: '1', trades: 2, round_trips: 1, wins: 1, losses: 0, win_rate: null, liquidations: 0, rescuable: 0, spare_held: null, margin_lost: '0', below_floor: '48', total: '1' };
  const floored = new FakeSql().on(/join "Trader" t/, [row]);
  const list = await reader(floored).traders('30d', { ranking: 'pnl' });
  assert.equal(list.belowFloor, 48);
  assert.equal(list.ranking, 'pnl');
  const searched = new FakeSql().on(/join "Trader" t/, [row]);
  const found = await reader(searched).traders('30d', { ranking: 'pnl', query: '#2260' });
  assert.match(searched.touching('Trader')[0]!.sql, /and \(true\)/, 'the floor is dropped for a search');
  assert.deepEqual(searched.touching('Trader')[0]!.values.slice(3), [null, '2260']);
  assert.equal(found.belowFloor, undefined);
  assert.equal(found.query, '#2260');
  assert.equal((await reader(new FakeSql().on(/join "Trader" t/, [row])).traders('30d', { ranking: 'volume' })).belowFloor, undefined);
});

test('search: an address prefix is lowercased and compared lowercased; junk is no search at all', async () => {
  const sql = new FakeSql();
  await reader(sql).traders('all', { query: '0xB78549' });
  const q = sql.touching('Trader')[0]!;
  assert.match(q.sql, /lower\(t\.owner\) like \$4::text \|\| '%'/);
  assert.deepEqual(q.values.slice(3), ['0xb78549', null]);
  assert.equal(parseTraderQuery('drop table'), undefined);
  assert.equal(parseTraderQuery('0x'), undefined);
  assert.deepEqual(parseTraderQuery(' 710 '), { kind: 'account', accountId: 710 });
});

test('the cards: traders who traded, a median over those with a closed trade, withheld below 10, market volume once per match', async () => {
  const sql = new FakeSql().on(/percentile_cont/, [{ traders: '1108', closed: '1060', profitable: '571', median_pnl: '-1234567', liquidations: '601', rescuable: '448', market_volume: '1855650300000000' }]);
  sql.on(/from "Exchange"/, [exchangeRow]);
  const summary = await reader(sql).traderSummary('30d');
  const text = sql.touching('TraderDay')[0]!.sql;
  assert.match(text, /a as \(select \* from w where trades > 0\)/);
  assert.match(text, /from "MarketDay"/, 'volume counted once per match, from market buckets');
  assert.equal(summary.traders, 1108);
  assert.equal(summary.closedTraders, 1060);
  assert.equal(summary.profitableTraders, 571);
  assert.equal(summary.medianNetPnlAusd, -1.234567);
  assert.equal(summary.volumeAusd, 1_855_650_300);
  const few = new FakeSql().on(/percentile_cont/, [{ traders: '9', closed: '4', profitable: '3', median_pnl: '5000000', liquidations: '0', rescuable: '0', market_volume: '0' }]);
  few.on(/from "Exchange"/, [exchangeRow]);
  assert.equal((await reader(few).traderSummary('24h')).medianNetPnlAusd, undefined, 'a median of four accounts describes nobody');
});
