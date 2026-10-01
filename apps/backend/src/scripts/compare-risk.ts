/**
 * The Risk ladder from two index schemas, read at the same moment against the
 * same marks, and the full schema's ladder rebuilt from ONLY the positions the
 * other schema also holds — so what is left of the difference is attributable
 * to the positions one index has and the other does not. Read-only.
 */
import { Pool } from 'pg';
import { PerplVenue, PostgresAnalytics, buildRiskSnapshot, fetchChainHead, loadAppConfig, loadNetworkConfig, symbolResolver, type IndexedOpenPosition } from '@perpguard/shared';

const env = process.env as Record<string, string | undefined>;
const net = loadNetworkConfig(loadAppConfig(env).analytics.name, env);
const venue = new PerplVenue(net, {});
const markets = await venue.getMarkets();
const configs = await venue.getRiskConfigs();
const marks = new Map((await venue.getOpenInterest()).map((m) => [m.marketId, { markPrice: m.markPrice, atMs: m.atMs }]));
const reader = (schema: string) => new PostgresAnalytics({ client: new Pool({ connectionString: env['INDEXER_DATABASE_URL'], max: 2, options: `-c search_path=${schema}` }), chainId: net.chainId, resolveSymbol: symbolResolver(markets.map((m) => ({ marketId: m.marketId, symbol: m.symbol }))), chainHead: () => fetchChainHead(net.rpcUrl) });
const [pub, full] = await Promise.all([reader('public').openPositions(), reader('perpguard_full').openPositions()]);
const key = (p: IndexedOpenPosition) => `${p.accountId}:${p.position.market.marketId}:${p.position.side}`;
const shape = (p: IndexedOpenPosition) => `${p.position.sizeLots}:${p.position.marginAusd}`;
const pubPriced = pub.filter((p) => p.position.entryPrice !== undefined);
const pubKeys = new Map(pubPriced.map((p) => [key(p), shape(p)]));
const fullSameAsPub = full.filter((p) => pubKeys.get(key(p)) === shape(p));
const ladder = (positions: readonly IndexedOpenPosition[]) => {
  const s = buildRiskSnapshot({ positions, configs, marks, insurance: new Map(), indexerBlock: 0, nowMs: Date.now() } as never);
  return s.ladder.filter((p) => [-0.1, -0.05, 0.05, 0.1].some((m) => Math.abs(p.move - m) < 1e-9)).map((p) => `${(p.move * 100).toFixed(0)}%: ${p.positions} pos, ${Math.round(p.notionalAusd)} notional`);
};
console.log('public priced     ', pubPriced.length, ladder(pubPriced).join(' | '));
console.log('full, same set    ', fullSameAsPub.length, ladder(fullSameAsPub).join(' | '));
console.log('full, everything  ', full.length, ladder(full).join(' | '));
console.log('public positions not matched in full (drift):', pubPriced.filter((p) => !full.some((f) => key(f) === key(p) && shape(f) === shape(p))).length);
venue.disconnect();
process.exit(0);
