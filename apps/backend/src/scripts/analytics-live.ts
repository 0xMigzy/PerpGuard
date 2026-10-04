/**
 * The analytics interface against live mainnet, printing every figure.
 *
 *   pnpm analytics:live
 *   pnpm analytics:live --wallet 0x…      # profile one address
 *   pnpm analytics:live --account 2118    # profile one account id
 *
 * READ-ONLY, and mainnet on purpose: the point is to see real numbers before any
 * UI exists, so a figure that is wrong is wrong here rather than in a demo.
 *
 * It prints the 24h volume alongside the figure the OLD bucketed query would have
 * produced, because that bug is the reason this layer exists and the gap is worth
 * seeing rather than trusting.
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import {
  PerplVenue,
  PostgresAnalytics,
  TvlProbe,
  TIMEFRAMES,
  describeMarket,
  loadNetworkConfig,
  symbolResolver,
  type Analytics,
  type Timeframe,
} from '@perpguard/shared';

const { values } = parseArgs({
  options: {
    wallet: { type: 'string' },
    account: { type: 'string' },
    trips: { type: 'string', default: '5' },
  },
});

const rule = (title: string): void =>
  console.log(`\n${'─'.repeat(78)}\n  ${title}\n${'─'.repeat(78)}`);

const n = (value: number, digits = 2): string =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const ausd = (value: number): string => `${n(value)} AUSD`;
const pct = (value: number | undefined, digits = 2): string =>
  value === undefined ? 'n/a' : `${n(value * 100, digits)}%`;
const when = (ms: number | undefined): string =>
  ms === undefined ? 'n/a' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
/**
 * A duration in the largest unit that keeps it legible.
 *
 * Seconds matter here: the busiest mainnet accounts hold positions for under a
 * minute, and rendering that as "0.0 min" throws away the only interesting part
 * of the figure.
 */
const hold = (ms: number | undefined): string => {
  if (ms === undefined) return 'n/a';
  if (ms < 60_000) return `${n(ms / 1000, 1)} s`;
  const hours = ms / 3_600_000;
  if (hours < 1) return `${n(ms / 60_000, 1)} min`;
  if (hours < 48) return `${n(hours, 1)} h`;
  return `${n(hours / 24, 1)} d`;
};

const network = loadNetworkConfig('mainnet', process.env);

// A POOL, not a Client. `protocolMetrics` fires its queries with Promise.all, and
// a single Client serialises concurrent queries and warns about it. The pool is
// also what the server would use.
const db = new Pool({
  host: process.env['ENVIO_PG_HOST'] ?? '127.0.0.1',
  port: Number(process.env['ENVIO_PG_PORT'] ?? 5432),
  user: process.env['ENVIO_PG_USER'] ?? 'envio',
  password: process.env['ENVIO_PG_PASSWORD'] ?? '',
  database: process.env['ENVIO_PG_DATABASE'] ?? 'perpguard_indexer',
  max: 6,
});

/**
 * REAL chain head, from the RPC — not from the indexer.
 *
 * `chain_metadata.block_height` is the indexer's own reading, so a dead indexer
 * reports itself zero blocks behind. Without an independent number, `health()`
 * correctly refuses to certify synced.
 */
async function chainHead(): Promise<number | undefined> {
  const url = process.env['ENVIO_PERPL_RPC_URL'] ?? 'https://rpc.monad.xyz';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json()) as { result?: string };
    return json.result === undefined ? undefined : Number.parseInt(json.result, 16);
  } catch {
    return undefined;
  }
}

// CANONICAL TICKERS COME FROM THE VENUE CONTEXT, keyed by market id. The indexer
// stores what the chain said — market 31 is SOL_v2 there — and market 80 (TAO) is
// in the index but absent from the context, so it resolves to no symbol at all.
const venue = new PerplVenue(network, {});
const markets = await venue.getMarkets();
const resolve = symbolResolver(markets.map((m) => ({ marketId: m.marketId, symbol: m.symbol })));

// TVL IS A CHAIN READ. The indexed deposit/withdrawal net is a FLOW whose sign is
// negative on mainnet, because accounts held collateral before the start block.
// `balanceOf` the Exchange PROXY is the current truth regardless of when we started.
const tvlRpcUrl = process.env['MONAD_RPC_URL']?.trim() || network.rpcUrl;
const analytics: Analytics = new PostgresAnalytics({
  client: db,
  chainId: network.chainId,
  resolveSymbol: resolve,
  chainHead,
  tvlProbe: new TvlProbe({
    rpcUrl: tvlRpcUrl,
    tokenAddress: network.collateralAddress,
    exchangeAddress: network.exchangeAddress,
    collateralDecimals: network.collateralDecimals,
  }),
});

try {
  // ── health, first, because it qualifies everything after it ───────────────
  rule('health');
  const health = await analytics.health();
  console.log(`  state              ${health.state.toUpperCase()}`);
  console.log(`  blocks behind      ${health.blocksBehind.toLocaleString('en-US')}`);
  console.log(`  head independent   ${health.headIsIndependent}`);
  console.log(`  serve as current   ${health.serveAsCurrent}`);
  if (health.reason !== undefined) console.log(`  reason             ${health.reason}`);
  if (!health.serveAsCurrent) {
    console.log(
      '\n  NOTE every figure below is real but MUST NOT be presented as current.\n' +
        '       A lagging indexer is out of date; a halted one is frozen.',
    );
  }

  // ── the bug, shown rather than claimed ────────────────────────────────────
  rule('the 24h volume window: fixed vs the bug it replaced');
  const fixed = await analytics.protocolMetrics('24h');
  const buggy = await db.query(
    `select coalesce(sum("volumeCNS"), 0)::text as v
       from "MarketDay" where day >= (now() - interval '24 hours')`,
  );
  const buggyAusd = Number(BigInt((buggy.rows[0] as { v: string }).v)) / 1e6;
  console.log(`  rolling 24h, from Trade rows   ${ausd(fixed.volumeAusd).padStart(24)}`);
  console.log(`  old query, from day buckets    ${ausd(buggyAusd).padStart(24)}`);
  console.log(
    `  the old query reported         ${n(buggyAusd / fixed.volumeAusd, 3)}x of the real figure`,
  );
  console.log(
    `  window                         ${when(fixed.sinceMs)} -> ${when(fixed.untilMs)} (rolling, to the ms)`,
  );

  // ── headline metrics, every timeframe ─────────────────────────────────────
  rule('protocol metrics');
  const W = 24;
  console.log(`  ${'metric'.padEnd(20)}${TIMEFRAMES.map((t) => t.padStart(W)).join('')}`);
  const metrics = new Map<Timeframe, Awaited<ReturnType<Analytics['protocolMetrics']>>>();
  for (const timeframe of TIMEFRAMES) metrics.set(timeframe, await analytics.protocolMetrics(timeframe));
  const metricsAll = metrics.get('all')!;

  const row = (label: string, pick: (m: ProtocolRow) => string): void => {
    const cells = TIMEFRAMES.map((t) => pick(metrics.get(t)!).padStart(W)).join('');
    console.log(`  ${label.padEnd(20)}${cells}`);
  };
  type ProtocolRow = Awaited<ReturnType<Analytics['protocolMetrics']>>;

  row('volume', (m) => ausd(m.volumeAusd));
  row('trades', (m) => m.tradeCount.toLocaleString('en-US'));
  row('active traders', (m) => m.activeTraders.toLocaleString('en-US'));
  row('maker fees', (m) => ausd(m.makerFeesAusd));
  row('total fees', (m) => ausd(m.fees.totalAusd));
  row('  …covering', (m) => `${m.fees.days} UTC day${m.fees.days === 1 ? '' : 's'}`);
  row('liquidations', (m) => m.liquidations.count.toLocaleString('en-US'));
  row('liquidated notional', (m) => ausd(m.liquidations.notionalAusd));
  row('margin lost', (m) => ausd(m.liquidations.marginLostAusd));
  row('bad debt', (m) => ausd(m.liquidations.badDebtAusd));
  row('deposits', (m) => ausd(m.collateralFlow.depositedAusd));
  row('withdrawals', (m) => ausd(m.collateralFlow.withdrawnAusd));
  row('net flow', (m) => ausd(m.collateralFlow.netAusd));

  console.log('');
  for (const timeframe of TIMEFRAMES) {
    console.log(`  fees for ${timeframe.padEnd(4)} cover ${metrics.get(timeframe)!.fees.label}`);
  }
  console.log(
    '\n  TOTAL FEES COME FROM WHOLE UTC DAYS, not from the rolling window, and each row above\n' +
      '  carries the range it actually covers. A taker fill is an aggregate over a whole order,\n' +
      '  so taker fees have no timestamp finer than the day bucket — and they are the larger\n' +
      '  share. Exact and honest beats precise-looking and wrong. Maker fees ARE exact for the\n' +
      '  rolling window, and are reported separately above.\n' +
      '  net flow is a FLOW, not a level. TVL is read from the chain — see below.',
  );

  // ── TVL, from the chain ───────────────────────────────────────────────────
  rule('total value locked — a CHAIN read, not indexed flow');
  const tvl = await analytics.tvl();
  if (tvl.known) {
    console.log(`  TVL                ${ausd(tvl.totalValueLockedAusd)}`);
    console.log(`  exact micros       ${tvl.totalValueLockedCNS}`);
    console.log(`  source             ${tvl.source} (balanceOf on the Exchange proxy)`);
    console.log(`  read at            ${when(tvl.asOfMs)}  via ${new URL(tvlRpcUrl).host}`);
    const net = metricsAll.collateralFlow.netAusd;
    console.log(
      `\n  and the indexed FLOW, which answers a different question:\n` +
        `  net over all time  ${ausd(net)} — negative, because accounts held collateral\n` +
        `                     before our start block. That is why TVL is not derived from it.`,
    );
  } else {
    // Never zero. An RPC that timed out and an empty treasury are different facts.
    console.log(`  TVL                UNKNOWN`);
    console.log(`  reason             ${tvl.reason}`);
  }

  // ── the rescue figures ────────────────────────────────────────────────────
  rule('rescuable liquidations — the number PerpGuard quotes');
  const r = metricsAll.rescues;
  console.log(`  liquidations                 ${r.count}`);
  console.log(`  of those, judgeable          ${r.judgeableCount}`);
  console.log(`  opened before our start      ${r.unknownCount}  (excluded, never counted as failures)`);
  console.log(`  RESCUABLE                    ${r.rescuableCount}`);
  console.log(`  RATE                         ${pct(r.rate)}  (${r.rescuableCount} of ${r.judgeableCount})`);
  console.log(`  cover ratio (median)         ${r.medianCoverRatio === undefined ? '-' : `${r.medianCoverRatio.toFixed(1)}x`} over ${r.coverRatioCount} rescuable: free balance / shortfall, per event`);
  console.log(
    `  had ANY spare balance        ${r.withAnySpareBalanceCount} of ${r.count} — DIAGNOSTIC ONLY,\n` +
      `                               it counts dust and is never the headline`,
  );
  for (const timeframe of ['24h', '7d', '30d'] as const) {
    const m = metrics.get(timeframe)!.rescues;
    console.log(
      `  ${timeframe.padEnd(4)} ${String(m.rescuableCount).padStart(4)} of ${String(m.judgeableCount).padStart(4)} judgeable` +
        `  rate ${pct(m.rate).padStart(8)}  cover ${m.medianCoverRatio === undefined ? '-' : `${m.medianCoverRatio.toFixed(1)}x`}`,
    );
  }

  // ── per market ────────────────────────────────────────────────────────────
  rule('per-market breakdown (24h volume, current positions)');
  console.log(
    `  ${'market'.padEnd(44)}${'24h volume'.padStart(18)}${'trades'.padStart(9)}` +
      `${'open'.padStart(7)}${'long/short'.padStart(12)}${'skew'.padStart(8)}` +
      `${'mark'.padStart(14)}${'funding'.padStart(12)}${'liq'.padStart(6)}${'resc'.padStart(6)}`,
  );
  for (const market of await analytics.marketBreakdown('24h')) {
    console.log(
      `  ${describeMarket(market.market).padEnd(44)}` +
        `${ausd(market.volumeAusd).padStart(18)}` +
        `${market.tradeCount.toLocaleString('en-US').padStart(9)}` +
        `${String(market.openPositions).padStart(7)}` +
        `${`${market.longPositions}/${market.shortPositions}`.padStart(12)}` +
        `${pct(market.longShareOfPositions, 1).padStart(8)}` +
        `${(market.markPrice === undefined ? 'n/a' : n(market.markPrice, 4)).padStart(14)}` +
        `${(market.lastFundingRatePct === undefined ? 'n/a' : `${n(market.lastFundingRatePct, 6)}%`).padStart(12)}` +
        `${String(market.liquidationCount).padStart(6)}` +
        `${String(market.rescuableLiquidationCount).padStart(6)}`,
    );
  }

  // ── funding ───────────────────────────────────────────────────────────────
  rule('funding (30d)');
  const funding = await analytics.funding('30d');
  // The contract publishes pct100k — hundred-thousandths of a percent — and the
  // real mainnet values are integers running -4..4, i.e. ±0.00004%. Four decimal
  // places print 0.0000% for every one of them, which is accurate and useless.
  const ratePct = (value: number | undefined): string =>
    value === undefined ? 'n/a' : `${n(value, 6)}%`;
  console.log(
    `  events ${funding.eventCount.toLocaleString('en-US')}, mean rate ${ratePct(funding.meanRatePct)}` +
      `\n  (on-chain rates are hundred-thousandths of a percent; mainnet's run -4..4)`,
  );
  for (const market of funding.markets) {
    console.log(
      `  ${describeMarket(market.market).padEnd(44)}` +
        `${String(market.eventCount).padStart(7)} events` +
        `  mean ${ratePct(market.meanRatePct).padStart(12)}` +
        `  last ${ratePct(market.lastRatePct).padStart(12)}` +
        `  at ${when(market.lastAtMs)}`,
    );
  }

  // ── the day series ────────────────────────────────────────────────────────
  rule('daily series (last 14 of 30d) — total fees here ARE exact');
  console.log(
    `  ${'day'.padEnd(12)}${'volume'.padStart(18)}${'trades'.padStart(9)}` +
      `${'fees'.padStart(14)}${'liq'.padStart(6)}${'resc'.padStart(6)}${'oi delta'.padStart(14)}`,
  );
  const series = await analytics.dailySeries('30d');
  for (const point of series.slice(-14)) {
    console.log(
      `  ${new Date(point.dayMs).toISOString().slice(0, 10).padEnd(12)}` +
        `${ausd(point.volumeAusd).padStart(18)}` +
        `${point.tradeCount.toLocaleString('en-US').padStart(9)}` +
        `${ausd(point.feesAusd).padStart(14)}` +
        `${String(point.liquidationCount).padStart(6)}` +
        `${String(point.rescuableLiquidationCount).padStart(6)}` +
        `${n(point.openInterestDeltaLots, 0).padStart(14)}`,
    );
  }
  console.log(`  ${series.length} day(s) in the 30d series`);

  // ── a wallet ──────────────────────────────────────────────────────────────
  rule('wallet');
  if (values.wallet !== undefined) {
    const lookup = await analytics.wallet(values.wallet);
    if (lookup.kind === 'not-linked') {
      console.log(`  ${values.wallet}\n  NOT LINKED: ${lookup.reason}`);
    } else {
      printProfile(lookup.profile);
    }
  } else {
    // Whichever address IS linked, so the address path is exercised rather than
    // skipped — 88% of mainnet accounts have no owner recorded.
    const linked = await db.query(
      `select owner from "Trader" where owner <> '' order by "volumeCNS" desc limit 1`,
    );
    const owner = (linked.rows[0] as { owner: string } | undefined)?.owner;
    if (owner !== undefined) {
      console.log(`  busiest address with a linked account: ${owner}`);
      const lookup = await analytics.wallet(owner);
      if (lookup.kind === 'found') printProfile(lookup.profile);
    }
    console.log('');
    // And one that is not linked, to show the distinct outcome.
    const missing = await analytics.wallet('0x000000000000000000000000000000000000dead');
    console.log(`  an unlinked address: ${missing.kind.toUpperCase()}`);
    if (missing.kind === 'not-linked') console.log(`    ${missing.reason}`);
  }

  if (values.account !== undefined) {
    rule(`account ${values.account}`);
    const profile = await analytics.walletByAccountId(Number(values.account));
    if (profile === undefined) console.log('  no such account in the index');
    else printProfile(profile);
  }

  function printProfile(profile: Awaited<ReturnType<Analytics['walletByAccountId']>> & object): void {
    const p = profile.performance;
    console.log(`  account            ${profile.accountId}`);
    console.log(`  address            ${profile.address === '' ? '(not recorded — created before our start block)' : profile.address}`);
    console.log(`  first trade        ${when(profile.firstTradeAtMs)}`);
    console.log(`  last active        ${when(profile.lastActiveAtMs)}`);
    console.log(`  volume             ${ausd(profile.volumeAusd)} over ${profile.tradeCount.toLocaleString('en-US')} trades`);
    console.log(`  realised PnL       ${ausd(profile.realisedPnlAusd)}`);
    console.log(`  funding            ${ausd(profile.fundingAusd)}`);
    console.log(`  fees paid          ${ausd(profile.feesPaidAusd)}`);
    // realised + funding - fees. Funding is signed, so it is added.
    console.log(`  NET PnL            ${ausd(profile.netPnlAusd)}`);
    console.log(`  round trips        ${p.roundTrips.toLocaleString('en-US')} (${p.wins.toLocaleString('en-US')}W / ${p.losses.toLocaleString('en-US')}L)`);
    console.log(`  win rate           ${pct(p.winRate)}`);
    console.log(`  profit factor      ${p.profitFactor === undefined ? 'n/a (no losses)' : n(p.profitFactor, 3)}`);
    console.log(`  max drawdown       ${ausd(p.maxDrawdownAusd)}`);
    console.log(`  longest streaks    ${p.longestWinStreak}W / ${p.longestLossStreak}L`);
    console.log(`  average hold       ${hold(p.averageHoldMs)}`);
    console.log(`  best round trip    ${ausd(p.bestRoundTripAusd)}`);
    console.log(`  worst round trip   ${ausd(p.worstRoundTripAusd)}`);
    console.log(`  best market        ${p.bestMarket === undefined ? 'n/a' : `${describeMarket(p.bestMarket.market)} ${ausd(p.bestMarket.netPnlAusd)} over ${p.bestMarket.roundTrips.toLocaleString('en-US')}`}`);
    console.log(`  worst market       ${p.worstMarket === undefined ? 'n/a' : `${describeMarket(p.worstMarket.market)} ${ausd(p.worstMarket.netPnlAusd)} over ${p.worstMarket.roundTrips.toLocaleString('en-US')}`}`);
    const rescues = profile.rescues;
    console.log(
      `  liquidations       ${rescues.count} (${rescues.rescuableCount} rescuable of ` +
        `${rescues.judgeableCount} judgeable, rate ${pct(rescues.rate)}, median cover ${rescues.medianCoverRatio === undefined ? '-' : `${rescues.medianCoverRatio.toFixed(1)}x`})`,
    );
    const shown = profile.openPositions.slice(0, 5);
    console.log(
      `  open positions     ${profile.openPositions.length}` +
        `${shown.length < profile.openPositions.length ? ` (showing ${shown.length})` : ''}`,
    );
    for (const position of shown) {
      console.log(
        `    ${describeMarket(position.market).padEnd(10)} ${position.side.padEnd(5)} ` +
          `size ${n(position.sizeLots, 5).padStart(12)}  entry ${position.entryPrice === undefined ? 'unknown'.padStart(12) : n(position.entryPrice, 2).padStart(12)}  ` +
          `margin ${ausd(position.marginAusd).padStart(16)}  ${n(position.leverage, 0)}x  opened ${when(position.openedAtMs)}`,
      );
    }
  }

  // ── round trips ───────────────────────────────────────────────────────────
  const busiest = await db.query(
    `select id from "Trader" order by "roundTrips" desc limit 1`,
  );
  const accountId = Number((busiest.rows[0] as { id: string }).id);
  rule(`most recent round trips for the busiest account (${accountId})`);
  const trips = await analytics.roundTrips(accountId, { limit: Number(values.trips) });
  for (const trip of trips) {
    console.log(
      `  ${describeMarket(trip.market).padEnd(10)} ${trip.side.padEnd(5)} ` +
        `size ${n(trip.sizeLots, 5).padStart(12)}  net ${ausd(trip.netPnlAusd).padStart(16)}  ` +
        `hold ${hold(trip.holdMs).padStart(9)}  ${trip.isWin ? 'WIN ' : 'LOSS'}` +
        `${trip.wasForcedExit ? '  FORCED EXIT' : ''}  closed ${when(trip.closedAtMs)}`,
    );
  }
} finally {
  await db.end();
  venue.disconnect();
}
