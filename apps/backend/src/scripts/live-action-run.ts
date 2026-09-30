/**
 * The ACTIONS LAYER against a real testnet position.
 *
 *   pnpm actions:live                  # top up whatever BTC position is open
 *   pnpm actions:live --open           # open one first, top it up, close it
 *   pnpm actions:live --amount 30000   # micros to add, instead of the engine's figure
 *   pnpm actions:live --twice          # attempt a SECOND top-up while the first is in flight
 *
 * WHAT THIS EXISTS TO SHOW. `t: 6` IncreasePositionCollateral comes back
 * `st: 7 Failed, sr: 32 OrderDescIdTooLow` on `mt: 24` while the collateral is
 * credited in full. Every previous run established that by hand. This run puts
 * the actions layer in the path and shows it resolving that reported failure to
 * `applied` from the position's own margin, with the send count printed so
 * "without a resend" is a number on the screen rather than a claim.
 *
 * SAFETY. Testnet only, and it refuses to run against mainnet. It sends at most
 * ONE top-up per invocation (the `--twice` flag adds a second ATTEMPT, which the
 * layer refuses without sending). It never re-sends: there is no code path in the
 * actions layer that could. If it opened the position it closes it in a finally.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  PerplPositionSource,
  PerplVenue,
  buildClosePositionFrame,
  buildMarketOrderFrame,
  computeLastExecBlock,
  fromVenuePosition,
  loadAppConfig,
  loadNetworkConfig,
  loadPerplCredentials,
  marginToReachBuffer,
  maskApiKey,
  priceToPNS,
  type PerplPosition,
  type VenueMarket,
} from '@perpguard/shared';
import { MarketFeed } from '../ingest/marketFeed.ts';
import { RiskLoop } from '../risk/loop.ts';
import { ActionsExecutor } from '../actions/executor.ts';
import { InMemoryActionLog } from '../actions/log.pg.ts';
import { LoopPositionReader } from '../actions/positionReader.ts';
import type { ActionCommand } from '../actions/types.ts';

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', default: 'BTC' },
    units: { type: 'string', default: '1' },
    side: { type: 'string', default: 'long' },
    open: { type: 'boolean', default: false },
    close: { type: 'boolean', default: true },
    'no-close': { type: 'boolean', default: false },
    /** AUSD micros to add. Default: whatever the engine says clears DANGER. */
    amount: { type: 'string' },
    /** Fire a second attempt while the first is in flight, to show the refusal. */
    twice: { type: 'boolean', default: false },
    out: { type: 'string', default: 'fixtures/live-action-run-testnet.json' },
  },
});

const symbol = values.symbol.toUpperCase();
const side = values.side === 'short' ? 'short' : 'long';
const units = Number(values.units);
const shouldClose = values.close && !values['no-close'];

const network = loadNetworkConfig('testnet', process.env);
if (network.chainId !== 10143) {
  console.error(`refusing to run against chain ${network.chainId}; this script is testnet only`);
  process.exit(1);
}
const appConfig = loadAppConfig(process.env);
const credentials = loadPerplCredentials(process.env);

const t0 = Date.now();
const stamp = (): string => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (line: string): void => console.log(`[${stamp()}] ${line}`);
const rule = (title: string): void => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);

const transcript: Array<Record<string, unknown>> = [];
const record = (kind: string, detail: Record<string, unknown>): void => {
  transcript.push({ atMs: Date.now() - t0, kind, ...detail });
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

rule('setup');
log(`Perpl testnet (chain ${network.chainId}), key ${maskApiKey(credentials.apiKey)}`);

const venue = new PerplVenue(network, { credentials, logger: { log, warn: log } });
const markets = await venue.getMarkets();
const market = markets.find((m) => m.symbol === symbol);
if (market === undefined) {
  console.error(`${symbol} is not listed on testnet: ${markets.map((m) => m.symbol).join(', ')}`);
  process.exit(1);
}
const configs = await venue.getRiskConfigs();
const config = configs.get(market.marketId);
if (config === undefined) throw new Error(`no risk config for market ${market.marketId}`);

const feed = new MarketFeed(network.name, appConfig.staleMs);
const unsubscribePrices = await venue.subscribePrices([symbol], (update) => feed.record(update));
const socket = await venue.connectTrading();

/** Every `mt: 23`/`mt: 24`, verbatim — the frames the sr 32 finding rests on. */
const orderFrames: Array<Record<string, unknown>> = [];
socket.onMessage((message) => {
  const mt = message['mt'];
  if (mt !== 23 && mt !== 24) return;
  orderFrames.push({ atMs: Date.now() - t0, ...message } as Record<string, unknown>);
  log(`RAW mt:${mt} ${JSON.stringify(message)}`);
});

log(
  `signed in: account ${socket.accountId}, fw ${socket.forwardingAllowed}, ` +
    `frozen ${socket.accountFrozen}, balance floor ${socket.freeBalanceFloorCNS} micros`,
);
const accountId = socket.accountId;
if (accountId === undefined) {
  console.error('no account id on this key; nothing to do');
  process.exit(1);
}

const collateral = await venue.getCollateralToken();
const positionSource = new PerplPositionSource({
  socket,
  network: network.name,
  markets: new Map<number, VenueMarket>(markets.map((m) => [m.marketId, m])),
  collateralDecimals: collateral.decimals,
  onSkippedMarket: (marketId) => log(`WARN skipping market ${marketId}: not in the context`),
});
positionSource.start();

const loop = new RiskLoop({
  network: network.name,
  feed,
  positions: positionSource,
  feedStatus: () => venue.feedStatus(),
  configs,
});
loop.onChange((change) => {
  const a = change.assessment;
  const buffer = a.liqBufferPct === undefined ? 'n/a' : `${(a.liqBufferPct * 100).toFixed(2)}%`;
  log(`STATE ${change.previousState ?? '(none)'} -> ${a.state}  buffer=${buffer} liq=${a.liquidationPricePNS}`);
});
loop.start();

// ── the actions layer, wired exactly as the server wires it ──────────────────

const actionLog = new InMemoryActionLog();
const executor = new ActionsExecutor({
  venue,
  positions: new LoopPositionReader({
    source: positionSource,
    configs,
    onAmbiguous: (marketId, count) => log(`WARN ${count} positions on market ${marketId}`),
    onUnscalable: (marketId) => log(`WARN no config for market ${marketId}`),
  }),
  prices: { canAct: (marketId) => feed.canAct(marketId, venue.feedStatus()) },
  log: actionLog,
  logger: { info: log, warn: (line) => log(`WARN ${line}`) },
  settleTimeoutMs: 12_000,
});

let openedByUs = false;

// Arrow consts rather than `function` declarations: a hoisted declaration is not
// covered by the narrowing above, so `market` would still read as possibly
// undefined inside it.
/**
 * Wait for a price, a position snapshot, and a head block.
 *
 * The head block comes from the heartbeat, which lands on every block (~300ms on
 * Monad) but has not necessarily arrived by the time sign-in resolves. `lb` is
 * computed from it, and `computeLastExecBlock` refuses a zero rather than sending
 * an order that can never execute.
 */
const awaitReady = async (): Promise<void> => {
  for (let i = 0; i < 60; i += 1) {
    if (
      feed.get(market.marketId) !== undefined &&
      positionSource.status().state === 'live' &&
      socket.headBlock !== undefined
    ) {
      return;
    }
    await wait(250);
  }
  throw new Error(
    `not ready after 15s: price=${feed.get(market.marketId) !== undefined} ` +
      `positions=${positionSource.status().state} headBlock=${socket.headBlock}`,
  );
};

/** The head block, once {@link awaitReady} has established there is one. */
const headBlock = (): number => {
  const head = socket.headBlock;
  if (head === undefined) throw new Error('no head block: the heartbeat has not arrived');
  return head;
};

const openPosition = (): PerplPosition | undefined =>
  positionSource.snapshot().find((p) => p.marketId === market.marketId) as
    | PerplPosition
    | undefined;

try {
  await awaitReady();

  if (values.open && openPosition() === undefined) {
    rule('opening a position');
    const frame = buildMarketOrderFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      side,
      sizeScaled: units,
      leverageHundredths: Math.round(market.maxLeverage * 100),
      lastExecBlock: computeLastExecBlock(headBlock(), market.orderTtlBlocks, 2),
    });
    log(`SEND ${JSON.stringify(frame)}`);
    await socket.submit({ frame, intent: 'place', idempotencyKey: 'open', matches: () => true });
    openedByUs = true;
    for (let i = 0; i < 40 && openPosition() === undefined; i += 1) await wait(250);
  }

  const position = openPosition();
  if (position === undefined) {
    console.error(
      `no open ${symbol} position on testnet account ${accountId}. Re-run with --open to open one.`,
    );
    process.exit(1);
  }

  rule('the position, before');
  loop.evaluate();
  const assessment = loop.snapshot().find((a) => a.marketId === market.marketId);
  const risk = fromVenuePosition(position, config);
  const markPricePNS = priceToPNS(feed.get(market.marketId)!.markPrice, config);
  log(`pid ${position.positionId} ${position.side} size ${position.size} margin ${position.margin} AUSD`);
  log(`margin as integers: ${risk.depositCNS} micros`);
  log(
    `state ${assessment?.state} buffer ${
      assessment?.liqBufferPct === undefined ? 'n/a' : `${(assessment.liqBufferPct * 100).toFixed(2)}%`
    } liq ${assessment?.liquidationPricePNS} mark ${markPricePNS}`,
  );

  const amountCNS =
    values.amount !== undefined
      ? BigInt(values.amount)
      : marginToReachBuffer(risk, markPricePNS, loop.thresholds.dangerExitPct, config);
  if (amountCNS <= 0n) {
    console.error('the engine says this position needs no top-up; pass --amount to force one');
    process.exit(1);
  }

  record('before', {
    positionId: position.positionId,
    marginCNS: risk.depositCNS.toString(),
    sizeLNS: risk.lotLNS.toString(),
    state: assessment?.state,
    liqBufferPct: assessment?.liqBufferPct,
    liquidationPricePNS: assessment?.liquidationPricePNS?.toString(),
    markPricePNS: markPricePNS.toString(),
    amountCNS: amountCNS.toString(),
  });

  rule('sending ONE top-up through the actions layer');
  log(`amount ${amountCNS} micros (${Number(amountCNS) / 10 ** config.collateralDecimals} AUSD)`);

  const command: ActionCommand = {
    kind: 'add-margin',
    idempotencyKey: `live:${Date.now()}:${market.marketId}`,
    userId: 'live-run',
    marketId: market.marketId,
    symbol: market.symbol,
    positionId: position.positionId,
    amountCNS,
  };

  // A SECOND ATTEMPT WHILE THE FIRST IS IN FLIGHT, when asked for. It must be
  // refused without sending — that is the one-in-flight rule against a real venue.
  const second = values.twice
    ? (async () => {
        await wait(150);
        return executor.execute({ ...command, idempotencyKey: `${command.idempotencyKey}:second` });
      })()
    : undefined;

  const outcome = await executor.execute(command);
  const secondOutcome = second === undefined ? undefined : await second;

  rule('the outcome');
  console.log(`OUTCOME     ${outcome.kind.toUpperCase()}`);
  if (outcome.kind !== 'refused') {
    console.log(`REPORTED    ${outcome.reported.status}: ${outcome.reported.reason ?? '(none)'}`);
    console.log(`            ^ what the VENUE said. Not the outcome.`);
  }
  if (outcome.kind === 'applied' || outcome.kind === 'not-applied') {
    const r = outcome.reconciliation;
    console.log(`RECONCILED  ${r.field} ${r.before} -> ${r.after} (delta ${r.delta}), requested ${r.requested}`);
    console.log(`            ${r.detail}`);
  }
  console.log(`DETAIL      ${outcome.detail}`);
  if (outcome.kind === 'unknown') console.log(`NEXT STEP   ${outcome.nextStep}`);

  rule('the proof that nothing was re-sent');
  // THE ENTRIES ARE NESTED IN `d`, not at the top level of the frame. Reading
  // `frame.t` counts zero of everything, which is the same class of mistake as
  // reading `id` instead of `oid`: a filter that matches nothing looks exactly
  // like a venue that sent nothing.
  const t6Outcomes = orderFrames
    .filter((f) => f['mt'] === 24)
    .flatMap((f) => (Array.isArray(f['d']) ? (f['d'] as Array<Record<string, unknown>>) : []))
    .filter((entry) => entry['t'] === 6);
  console.log(`mt:24 entries for t:6 (collateral increases): ${t6Outcomes.length}`);
  for (const entry of t6Outcomes) {
    console.log(
      `  rq ${entry['rq']} st ${entry['st']} sr ${entry['sr']} oid ${entry['oid']} ` +
        `mkt ${entry['mkt']} acc ${entry['acc']}`,
    );
  }
  console.log(
    `ONE top-up requested, ${t6Outcomes.length} outcome entr${t6Outcomes.length === 1 ? 'y' : 'ies'}, ` +
      `${new Set(t6Outcomes.map((e) => e['rq'])).size} distinct rq — no resend.`,
  );

  if (secondOutcome !== undefined) {
    rule('the second attempt, while the first was in flight');
    console.log(`OUTCOME     ${secondOutcome.kind.toUpperCase()}`);
    if (secondOutcome.kind === 'refused') console.log(`CODE        ${secondOutcome.code}`);
    console.log(`DETAIL      ${secondOutcome.detail}`);
  }

  rule('the action_log rows');
  for (const row of actionLog.rows) {
    console.log(
      `  ${row.row.idempotencyKey}  ${row.row.kind}  ${row.row.field} ` +
        `requested=${row.row.requested} before=${row.row.before}`,
    );
    console.log(
      row.settlement === undefined
        ? `    UNSETTLED — this is the row a human should go looking at`
        : `    settled: outcome=${row.settlement.outcome} reported=${row.settlement.reportedStatus} ` +
          `after=${row.settlement.after}`,
    );
  }
  console.log(`unsettled rows: ${actionLog.unsettled().length}`);

  rule('the position, after');
  loop.evaluate();
  const after = openPosition();
  const afterAssessment = loop.snapshot().find((a) => a.marketId === market.marketId);
  log(`margin ${after?.margin} AUSD`);
  log(
    `state ${afterAssessment?.state} buffer ${
      afterAssessment?.liqBufferPct === undefined
        ? 'n/a'
        : `${(afterAssessment.liqBufferPct * 100).toFixed(2)}%`
    } liq ${afterAssessment?.liquidationPricePNS}`,
  );

  record('after', {
    outcome: outcome.kind,
    reportedStatus: outcome.kind === 'refused' ? undefined : outcome.reported.status,
    reportedReason: outcome.kind === 'refused' ? undefined : outcome.reported.reason,
    reconciliation:
      outcome.kind === 'applied' || outcome.kind === 'not-applied'
        ? {
            verdict: outcome.reconciliation.verdict,
            before: outcome.reconciliation.before.toString(),
            after: outcome.reconciliation.after?.toString(),
            delta: outcome.reconciliation.delta?.toString(),
            requested: outcome.reconciliation.requested.toString(),
            detail: outcome.reconciliation.detail,
          }
        : undefined,
    detail: outcome.detail,
    secondAttempt:
      secondOutcome === undefined
        ? undefined
        : {
            kind: secondOutcome.kind,
            code: secondOutcome.kind === 'refused' ? secondOutcome.code : undefined,
            detail: secondOutcome.detail,
          },
    t6OutcomeFrames: t6Outcomes.length,
    marginAfterAusd: after?.margin,
    state: afterAssessment?.state,
    liqBufferPct: afterAssessment?.liqBufferPct,
  });

} finally {
  if (openedByUs && shouldClose) {
    rule('closing the position we opened');
    const position = openPosition();
    if (position !== undefined) {
      try {
        const frame = buildClosePositionFrame({
          sn: socket.nextSequenceNumber(),
          rq: socket.reserveRequestId(),
          marketId: market.marketId,
          accountId,
          positionSide: position.side,
          positionId: position.positionId,
          sizeScaled: Math.round(position.size * 10 ** market.sizeDecimals),
          lastExecBlock: computeLastExecBlock(headBlock(), market.orderTtlBlocks, 2),
        });
        log(`SEND ${JSON.stringify(frame)}`);
        await socket.submit({ frame, intent: 'place', idempotencyKey: 'close', matches: () => true });
      } catch (error) {
        log(`WARN close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  writeFileSync(
    values.out,
    `${JSON.stringify({ network: network.name, chainId: network.chainId, transcript, orderFrames }, null, 2)}\n`,
  );
  log(`transcript written to ${values.out}`);

  loop.stop();
  positionSource.stop();
  unsubscribePrices();
  venue.disconnect();
}
