/**
 * Two index schemas, side by side, through the backend's own analytics code.
 *
 *   node --env-file=.env apps/backend/src/scripts/compare-indexes.ts public perpguard_full out.json
 *
 * Runs every timeframe's metrics, markets, funding, traders, liquidation
 * summary and the Risk ladder against each schema at the same moment, so a
 * difference is a difference in the data rather than time passing between
 * two reads. Read-only.
 */
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { PerplVenue, PostgresAnalytics, TIMEFRAMES, assessOpenPositions, buildRiskSnapshot, fetchChainHead, loadAppConfig, loadNetworkConfig, symbolResolver } from '@perpguard/shared';

const [a, b, out] = process.argv.slice(2) as [string, string, string];
const env = process.env as Record<string, string | undefined>;
const net = loadNetworkConfig(loadAppConfig(env).analytics.name, env);
const venue = new PerplVenue(net, {});
const markets = await venue.getMarkets();
const configs = await venue.getRiskConfigs();
const oi = await venue.getOpenInterest();
const marks = new Map(oi.map((m) => [m.marketId, { markPrice: m.markPrice, atMs: m.atMs }]));

async function read(schema: string) {
  const pool = new Pool({ connectionString: env['INDEXER_DATABASE_URL'], max: 4, options: `-c search_path=${schema}` });
  const analytics = new PostgresAnalytics({
    client: pool,
    chainId: net.chainId,
    resolveSymbol: symbolResolver(markets.map((m) => ({ marketId: m.marketId, symbol: m.symbol }))),
    chainHead: () => fetchChainHead(net.rpcUrl),
  });
  const result: Record<string, unknown> = { schema, health: await analytics.health() };
  for (const tf of TIMEFRAMES) {
    const [metrics, marketRows, funding, traders, liquidationSummary] = await Promise.all([
      analytics.protocolMetrics(tf),
      analytics.marketBreakdown(tf),
      analytics.funding(tf),
      analytics.traders(tf, { limit: 25 } as never),
      analytics.liquidationSummary(tf),
    ]);
    result[tf] = { metrics, markets: marketRows, funding, traders, liquidationSummary };
  }
  const positions = await analytics.openPositions();
  const snapshot = buildRiskSnapshot({ positions, configs, marks, insurance: new Map(), indexerBlock: 0, nowMs: Date.now() } as never);
  const assessed = assessOpenPositions(positions.map((p) => p.position), configs, marks);
  result['risk'] = { openPositions: positions.length, priced: assessed.filter((x) => x.liqBufferPct !== undefined).length, unpriced: assessed.filter((x) => x.liqBufferPct === undefined).map((x) => x.reason).reduce<Record<string, number>>((m, r) => ({ ...m, [r ?? '?']: (m[r ?? '?'] ?? 0) + 1 }), {}), counted: snapshot.counted, totals: snapshot.totals, ladderAt: Object.fromEntries(snapshot.ladder.filter((p) => [-0.1, -0.05, 0.05, 0.1].some((m) => Math.abs(p.move - m) < 1e-9)).map((p) => [p.move, p])) };
  await pool.end();
  return result;
}

const [ra, rb] = await Promise.all([read(a), read(b)]);
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), [a]: ra, [b]: rb }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`written ${out}`);
venue.disconnect();
