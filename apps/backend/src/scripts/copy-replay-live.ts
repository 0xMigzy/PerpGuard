/**
 * The copy replay against the live mainnet index, onto testnet's markets.
 *
 *   pnpm copy:replay                      # the top 10 by 30-day net P&L
 *   pnpm copy:replay --account 4886 --size 1000 --trades 20
 *
 * READ-ONLY. Prints each leader's replay and checks the equity it rebuilt
 * against the index's own figure today (free balance plus open margin).
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { PerplVenue, PostgresAnalytics, loadNetworkConfig, symbolResolver } from '@perpguard/shared';
import { CopyReplayService } from '../copy/service.ts';
import { ausdText } from '../copy/replay.ts';

const { values } = parseArgs({ options: { account: { type: 'string' }, size: { type: 'string', default: '1000' }, trades: { type: 'string', default: '0' } } });

const url = process.env['INDEXER_DATABASE_URL']?.trim();
if (!url) throw new Error('INDEXER_DATABASE_URL is not set');
const db = new Pool({ connectionString: url, max: 6 });
const mainnet = new PerplVenue(loadNetworkConfig('mainnet', process.env), { logger: { log: () => undefined, warn: () => undefined } });
const testnet = new PerplVenue(loadNetworkConfig('testnet', process.env), { logger: { log: () => undefined, warn: () => undefined } });
const [mainMarkets, testMarkets] = await Promise.all([mainnet.getMarkets(), testnet.getMarkets()]);
const analytics = new PostgresAnalytics({ client: db, chainId: 143, resolveSymbol: symbolResolver(mainMarkets.map((m) => ({ marketId: m.marketId, symbol: m.symbol }))) });
const service = new CopyReplayService({ source: analytics, actingNetwork: 'testnet', actingMarkets: () => testMarkets, marks: () => mainnet.getOpenInterest() });

console.log(`testnet lists: ${testMarkets.map((m) => `${m.symbol} (max ${m.maxLeverage}x, ${m.sizeDecimals} dp)`).join(', ')}`);
const size = BigInt(Math.round(Number(values.size) * 1e6));

const leaders = values.account !== undefined
  ? [Number(values.account)]
  : (await analytics.traders('30d', { ranking: 'pnl', limit: 10 })).rows.map((t) => t.accountId);

for (const id of leaders) {
  const t0 = Date.now();
  const { result } = await service.replay(id, size);
  const ms = Date.now() - t0;
  if (result.kind !== 'replayed') {
    console.log(`\n#${id}: ${JSON.stringify(result)} (${ms} ms)`);
    continue;
  }
  const t = result.totals;
  // Sanity: the index's own equity now, against the replay's start plus the window's flows and results.
  const now = await db.query(`select "freeBalanceCNS"::text f, (select coalesce(sum("depositCNS"),0) from "Position" where trader_id = $1 and status = 'OPEN')::text m from "Trader" where id = $1`, [String(id)]);
  const indexEquity = BigInt(now.rows[0].f) + BigInt(now.rows[0].m);
  // The replay's own equity rule, walked to today: start + the window's flows + every result realised in it.
  const src = (await analytics.copySource(id, { fromMs: result.fromMs, toMs: result.toMs, cap: 3_000 }))!;
  const rebuilt = src.equityAtStartCNS + src.flows.reduce((a, f) => a + f.deltaCNS, 0n) + src.closedFromBefore.reduce((a, c) => a + c.netPnlCNS, 0n) + src.positions.filter((p) => p.status !== 'open').reduce((a, p) => a + p.netPnlCNS, 0n) - src.feesByDay.reduce((a, f) => a + f.feesCNS, 0n);
  const openMargin = BigInt(now.rows[0].m);
  console.log(`  equity check: rebuilt (realised, after daily fees) ${ausdText(rebuilt, 'floor')} vs index free + open margin ${ausdText(indexEquity, 'floor')} (open margin ${ausdText(openMargin, 'floor')}; the gap is open positions' realised-so-far and anything the index cannot attribute)`);
  console.log(`\n#${id}  (${ms} ms)  leader equity at start ${ausdText(result.leaderStartCNS, 'floor')}, index equity now ${ausdText(indexEquity, 'floor')}`);
  console.log(`  books: ${result.books.reconciled ? 'RECONCILED' : 'NOT RECONCILED'}, rebuilt ${ausdText(result.books.rebuiltCNS, 'floor')} vs on record ${ausdText(result.books.indexCNS, 'floor')} (gap ${ausdText(result.books.gapCNS, 'floor')})`);
  console.log(`  copied ${t.copied}, skipped ${t.skipped} ${JSON.stringify(t.skippedBy)}  not listed: ${t.notListed.map((x) => `${x.symbol}×${x.count}`).join(', ') || 'none'}`);
  console.log(`  copy result ${ausdText(t.closedResultCNS, 'floor')} closed (+ ${ausdText(t.openEstimateCNS, 'floor')} open, estimate); ${t.wins} won, ${t.losses} lost, ${t.forcedExits} forced exits`);
  console.log(`  ${ausdText(result.followerStartCNS, 'floor')} -> ${ausdText(t.followerEndEquityCNS, 'floor')}; lowest free ${ausdText(t.lowestFreeCNS, 'floor')}; leader made ${ausdText(t.leaderResultOnCopiedCNS, 'floor')} on the same positions`);
  for (const tr of result.trades.slice(0, Number(values.trades))) {
    const c = tr.copy;
    console.log(`   ${new Date(tr.openedAtMs).toISOString().slice(0, 16)} ${tr.symbol} ${tr.side} ${tr.status}: ${c.kind === 'copied' ? `copied ×${c.scale.toFixed(5)} size ${c.sizeUnits}e-${c.sizeDecimals} margin ${ausdText(c.marginCNS, 'ceil')} result ${c.resultCNS === undefined ? 'n/a' : ausdText(c.resultCNS, 'floor')}${c.estimate ? ' (est.)' : ''}` : `SKIPPED ${c.text}`}`);
  }
}
await db.end();
process.exit(0);
