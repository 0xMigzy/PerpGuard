/**
 * Measure the close and reduce round trips, so they can be built on evidence.
 *
 *   pnpm close:probe                  # close whatever BTC position is open
 *   pnpm close:probe --units 3        # open 3 units first, reduce by 1, then close 2
 *   pnpm close:probe --reduce 1       # reduce the open position by 1 unit only
 *
 * WHY THIS EXISTS. `buildClosePositionFrame` was written from the docs and has
 * never been sent. The position shape, the `sr 32` behaviour and the `oid`-vs-`id`
 * correlation were all found by sending something and reading what came back, and
 * every one of them contradicted what the docs implied. So the frame gets measured
 * before `PerplVenue.closePosition` is built on it.
 *
 * WHAT IT RECORDS, and why each one:
 *   - `lfr` before and after. A forwarded request that produces no `mt: 24` and
 *     does not advance `lfr` never reached the contract, so its `rq` is unconsumed
 *     and nothing happened. That is how a DROPPED close is told apart from one
 *     that landed without reporting — measured on 2026-09-30, three open attempts.
 *   - every `mt: 21/24/25/27` frame, verbatim.
 *   - the position's size and margin before and after, which is the only thing
 *     that actually says whether the close worked.
 *
 * SAFETY. Testnet only. One order per phase, never re-sent. If it opens a
 * position it closes it.
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
  maskApiKey,
  type PerplPosition,
  type VenueMarket,
} from '@perpguard/shared';

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', default: 'BTC' },
    /** Open this many size units first. 0 uses whatever is already open. */
    units: { type: 'string', default: '0' },
    /** Reduce by this many size units before closing. 0 skips the reduce phase. */
    reduce: { type: 'string', default: '0' },
    /** Leave the remainder open instead of closing it. */
    'no-close': { type: 'boolean', default: false },
    out: { type: 'string', default: 'fixtures/close-probe-testnet.json' },
  },
});

const symbol = values.symbol.toUpperCase();
const unitsToOpen = Number(values.units);
const unitsToReduce = Number(values.reduce);

const network = loadNetworkConfig('testnet', process.env);
if (network.chainId !== 10143) {
  console.error(`refusing to run against chain ${network.chainId}; testnet only`);
  process.exit(1);
}
const credentials = loadPerplCredentials(process.env);

const t0 = Date.now();
const at = (): string => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (line: string): void => console.log(`[${at()}] ${line}`);
const rule = (title: string): void =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);

const frames: Array<Record<string, unknown>> = [];
const phases: Array<Record<string, unknown>> = [];
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

rule('setup');
log(`Perpl testnet (chain ${network.chainId}), key ${maskApiKey(credentials.apiKey)}`);

const venue = new PerplVenue(network, { credentials });
const markets = await venue.getMarkets();
const market = markets.find((m) => m.symbol === symbol);
if (market === undefined) {
  console.error(`${symbol} is not listed on testnet`);
  process.exit(1);
}

const off = await venue.subscribePrices([symbol], () => {});
const socket = await venue.connectTrading();
socket.onMessage((message) => {
  const mt = message['mt'];
  if (mt !== 21 && mt !== 24 && mt !== 25 && mt !== 27) return;
  frames.push({ atMs: Date.now() - t0, ...message } as Record<string, unknown>);
  log(`RAW mt:${mt} ${JSON.stringify(message).slice(0, 300)}`);
});

const collateral = await venue.getCollateralToken();
const positionSource = new PerplPositionSource({
  socket,
  network: network.name,
  markets: new Map<number, VenueMarket>(markets.map((m) => [m.marketId, m])),
  collateralDecimals: collateral.decimals,
});
positionSource.start();

const accountId = socket.accountId;
if (accountId === undefined) {
  console.error('no account id on this key');
  process.exit(1);
}
log(`account ${accountId}, lfr ${socket.lastForwardedRequestId}, fw ${socket.forwardingAllowed}`);

for (let i = 0; i < 40 && socket.headBlock === undefined; i += 1) await wait(250);
const headBlock = (): number => {
  const head = socket.headBlock;
  if (head === undefined) throw new Error('no head block; the heartbeat has not arrived');
  return head;
};

const openPosition = (): PerplPosition | undefined =>
  positionSource.snapshot().find((p) => p.marketId === market.marketId) as PerplPosition | undefined;

const unitsOf = (position: PerplPosition): number =>
  Math.round(position.size * 10 ** market.sizeDecimals);

/**
 * Send one frame and report what became of it, WITHOUT ever re-sending.
 *
 * The verdict is the point: `lfr` moving is the evidence that the contract
 * processed the request at all, independently of whether an `mt: 24` arrived.
 */
async function sendOnce(
  label: string,
  frame: ReturnType<typeof buildClosePositionFrame>,
  watchMs: number,
): Promise<Record<string, unknown>> {
  const before = openPosition();
  const lfrBefore = socket.lastForwardedRequestId;
  const balanceBefore = socket.freeBalanceFloorCNS;

  log(`SEND ${label}: ${JSON.stringify(frame)}`);
  log(`  lfr before ${lfrBefore}, balance floor ${balanceBefore}, size ${before?.size ?? 0}`);

  let outcome = 'no mt:24 arrived';
  let threw: string | undefined;
  try {
    const result = await socket.submit({
      frame,
      intent: 'place',
      idempotencyKey: `probe-${label}-${Date.now()}`,
      matches: (order) => order['rq'] === frame.rq,
      resultTimeoutMs: watchMs,
    });
    outcome = `${result.outcome} — ${result.reason}`;
    log(`  mt:24 OUTCOME ${outcome}`);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
    log(`  NO OUTCOME: ${threw}`);
  }

  // Let the position update land even when the order outcome did not.
  await wait(3_000);
  const after = openPosition();
  const lfrAfter = socket.lastForwardedRequestId;

  // THE DISCRIMINATOR. `lfr` advances even on a request the contract rejects, so
  // unchanged means the frame never landed and its `rq` is still unconsumed.
  const reachedContract = lfrAfter > lfrBefore;
  const verdict = reachedContract
    ? after === undefined
      ? 'REACHED THE CONTRACT — position gone'
      : `REACHED THE CONTRACT — size ${before?.size ?? 0} -> ${after.size}`
    : 'DROPPED BY THE FORWARDER — lfr unchanged, rq unconsumed, nothing happened';

  log(`  lfr ${lfrBefore} -> ${lfrAfter}  ${reachedContract ? '(advanced)' : '(UNCHANGED)'}`);
  log(`  balance floor ${balanceBefore} -> ${socket.freeBalanceFloorCNS}`);
  log(`  VERDICT ${verdict}`);

  const record = {
    label,
    frame: { ...frame },
    lfrBefore,
    lfrAfter,
    reachedContract,
    reportedOutcome: outcome,
    threw,
    balanceBeforeCNS: balanceBefore?.toString(),
    balanceAfterCNS: socket.freeBalanceFloorCNS?.toString(),
    sizeBefore: before?.size,
    sizeAfter: after?.size,
    marginBefore: before?.margin,
    marginAfter: after?.margin,
    positionIdBefore: before?.positionId,
    positionIdAfter: after?.positionId,
    verdict,
  };
  phases.push(record);
  return record;
}

let openedByUs = false;

try {
  // ── phase 0: open, if asked ───────────────────────────────────────────────
  if (unitsToOpen > 0 && openPosition() === undefined) {
    rule(`opening ${unitsToOpen} unit(s)`);
    const frame = buildMarketOrderFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      side: 'long',
      sizeScaled: unitsToOpen,
      leverageHundredths: Math.round(market.maxLeverage * 100),
      lastExecBlock: computeLastExecBlock(headBlock(), market.orderTtlBlocks, 2),
    });
    await sendOnce('open', frame, 25_000);
    openedByUs = openPosition() !== undefined;
    if (!openedByUs) {
      console.error('the open did not land and was not re-sent. Re-run to try again.');
      process.exit(1);
    }
  }

  const position = openPosition();
  if (position === undefined) {
    console.error(`no open ${symbol} position. Pass --units N to open one.`);
    process.exit(1);
  }

  rule('the position');
  log(
    `pid ${position.positionId} ${position.side} size ${position.size} ` +
      `(${unitsOf(position)} units) margin ${position.margin} AUSD`,
  );

  // ── phase 1: a PARTIAL reduce ─────────────────────────────────────────────
  if (unitsToReduce > 0) {
    const available = unitsOf(position);
    if (unitsToReduce >= available) {
      console.error(
        `--reduce ${unitsToReduce} is not a partial reduce of a ${available}-unit position; ` +
          `that is a close. Open more units or reduce by fewer.`,
      );
      process.exit(1);
    }
    rule(`reducing by ${unitsToReduce} of ${available} unit(s) — a PARTIAL`);
    const frame = buildClosePositionFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      positionSide: position.side,
      positionId: position.positionId,
      sizeScaled: unitsToReduce,
      lastExecBlock: computeLastExecBlock(headBlock(), market.orderTtlBlocks, 2),
    });
    await sendOnce('reduce', frame, 25_000);
  }

  // ── phase 2: the close ────────────────────────────────────────────────────
  const remaining = openPosition();
  if (remaining !== undefined && !values['no-close']) {
    rule(`closing all ${unitsOf(remaining)} remaining unit(s)`);
    const frame = buildClosePositionFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      positionSide: remaining.side,
      positionId: remaining.positionId,
      sizeScaled: unitsOf(remaining),
      lastExecBlock: computeLastExecBlock(headBlock(), market.orderTtlBlocks, 2),
    });
    await sendOnce('close', frame, 25_000);
  }

  rule('summary');
  for (const phase of phases) {
    console.log(
      `  ${String(phase['label']).padEnd(7)} rq ${phase['lfrAfter']} ` +
        `lfr ${phase['lfrBefore']}->${phase['lfrAfter']}  ` +
        `size ${phase['sizeBefore'] ?? 0}->${phase['sizeAfter'] ?? 0}  ${phase['verdict']}`,
    );
    console.log(`          reported: ${phase['reportedOutcome']}`);
  }
  const final = openPosition();
  console.log(
    final === undefined
      ? '  position is CLOSED (gone from the set)'
      : `  position still open: size ${final.size}, margin ${final.margin} AUSD`,
  );
} finally {
  writeFileSync(
    values.out,
    `${JSON.stringify(
      { network: network.name, chainId: network.chainId, marketId: market.marketId, phases, frames },
      null,
      2,
    )}\n`,
  );
  log(`written to ${values.out}`);
  positionSource.stop();
  off();
  venue.disconnect();
  void openedByUs;
}
