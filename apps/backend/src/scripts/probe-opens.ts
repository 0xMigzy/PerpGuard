/**
 * HOW RELIABLY DOES A MARKET OPEN LAND ON TESTNET? Measured before Copy
 * Trading is built on it (owner, 7 Oct 2026: "if opens still aren't landing
 * reliably after you've read the docs and written the path, stop and tell me").
 *
 *   pnpm probe:opens --symbol MON --rounds 8
 *
 * Each round opens ONE size step long at the market (p 0, IOC), on a market
 * where the account holds nothing, waits for the position list, and closes
 * whatever opened. Every open is judged by the POSITION LIST and by `lfr`,
 * never by the receipt: landed (a position appeared), dropped (`lfr`
 * unchanged: the forwarder never delivered it), refused (`lfr` moved, no
 * position) or unknown. Nothing is ever re-sent within a round.
 *
 * SAFETY. Testnet only. Refuses a market where the account already has a
 * position. The backend must be STOPPED (one key, colliding request ids).
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  PerplPositionSource,
  PerplVenue,
  buildClosePositionFrame,
  buildMarketOrderFrame,
  computeLastExecBlock,
  loadNetworkConfig,
  loadPerplCredentials,
  type PerplPosition,
  type VenueMarket,
} from '@perpguard/shared';

const { values } = parseArgs({ options: { symbol: { type: 'string', default: 'MON' }, rounds: { type: 'string', default: '8' }, leverage: { type: 'string', default: '2' }, out: { type: 'string', default: 'fixtures/open-probe-testnet.json' } } });
const network = loadNetworkConfig('testnet', process.env);
if (network.chainId !== 10143) throw new Error('testnet only');
const venue = new PerplVenue(network, { credentials: loadPerplCredentials(process.env) });
const markets = await venue.getMarkets();
const market = markets.find((m) => m.symbol === values.symbol.toUpperCase());
if (market === undefined) throw new Error(`${values.symbol} is not listed on testnet`);
const t0 = Date.now();
const log = (line: string): void => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

await venue.subscribePrices([market.symbol], () => {});
const socket = await venue.connectTrading();
const collateral = await venue.getCollateralToken();
const positions = new PerplPositionSource({ socket, network: network.name, markets: new Map<number, VenueMarket>(markets.map((m) => [m.marketId, m])), collateralDecimals: collateral.decimals });
positions.start();
const accountId = socket.accountId;
if (accountId === undefined) throw new Error('no account on this key');
for (let i = 0; i < 60 && (socket.headBlock === undefined || positions.status().state !== 'live'); i += 1) await wait(250);
const head = (): number => {
  if (socket.headBlock === undefined) throw new Error('no head block');
  return socket.headBlock;
};
const mine = (): PerplPosition | undefined => positions.snapshot().find((p) => p.marketId === market.marketId) as PerplPosition | undefined;
if (mine() !== undefined) throw new Error(`account ${accountId} already holds ${market.symbol}; pick a market it does not hold`);
log(`account ${accountId}, ${market.symbol} (market ${market.marketId}), lfr ${socket.lastForwardedRequestId}`);

type Verdict = 'landed' | 'dropped' | 'refused' | 'unknown';
const results: Array<Record<string, unknown>> = [];
for (let round = 1; round <= Number(values.rounds); round += 1) {
  const lfrBefore = socket.lastForwardedRequestId;
  const frame = buildMarketOrderFrame({ sn: socket.nextSequenceNumber(), rq: socket.reserveRequestId(), marketId: market.marketId, accountId, side: 'long', sizeScaled: 1, leverageHundredths: Math.round(Number(values.leverage) * 100), lastExecBlock: computeLastExecBlock(head(), market.orderTtlBlocks, 2) });
  const sentAt = Date.now();
  let receipt = 'no mt:24';
  try {
    const r = await socket.submit({ frame, intent: 'place', idempotencyKey: `probe-open-${round}-${sentAt}`, matches: (o) => o['rq'] === frame.rq, resultTimeoutMs: 20_000 });
    receipt = `${r.outcome}: ${r.reason}`;
  } catch (error) {
    receipt = `no outcome: ${error instanceof Error ? error.message : String(error)}`;
  }
  // The position list decides, not the receipt.
  let opened: PerplPosition | undefined;
  for (let i = 0; i < 40 && opened === undefined; i += 1) {
    opened = mine();
    if (opened === undefined) await wait(250);
  }
  const lfrAfter = socket.lastForwardedRequestId;
  const verdict: Verdict = opened !== undefined ? 'landed' : lfrAfter === lfrBefore ? 'dropped' : lfrAfter > lfrBefore ? 'refused' : 'unknown';
  log(`round ${round}: ${verdict.toUpperCase()} in ${((Date.now() - sentAt) / 1000).toFixed(1)} s; receipt ${receipt}; lfr ${lfrBefore} -> ${lfrAfter}${opened ? `; pid ${opened.positionId} size ${opened.size}` : ''}`);
  const row: Record<string, unknown> = { round, verdict, receipt, lfrBefore, lfrAfter, ms: Date.now() - sentAt };
  if (opened !== undefined) {
    const close = buildClosePositionFrame({ sn: socket.nextSequenceNumber(), rq: socket.reserveRequestId(), marketId: market.marketId, accountId, positionSide: opened.side, positionId: opened.positionId, sizeScaled: Math.round(opened.size * 10 ** market.sizeDecimals), lastExecBlock: computeLastExecBlock(head(), market.orderTtlBlocks, 2) });
    try {
      await socket.submit({ frame: close, intent: 'place', idempotencyKey: `probe-close-${round}-${Date.now()}`, matches: (o) => o['rq'] === close.rq, resultTimeoutMs: 20_000 });
    } catch {}
    for (let i = 0; i < 40 && mine() !== undefined; i += 1) await wait(250);
    row['closed'] = mine() === undefined;
    log(`  closed: ${row['closed']}`);
    if (row['closed'] !== true) {
      log('  the close did not land; stopping here so nothing is left half-done');
      results.push(row);
      break;
    }
  }
  results.push(row);
  await wait(2_000);
}
const tally = results.reduce<Record<string, number>>((a, r) => ({ ...a, [String(r['verdict'])]: (a[String(r['verdict'])] ?? 0) + 1 }), {});
log(`TALLY ${JSON.stringify(tally)} over ${results.length} round(s)`);
writeFileSync(values.out, `${JSON.stringify({ network: network.name, market: market.symbol, marketId: market.marketId, results, tally }, null, 2)}\n`);
process.exit(0);
