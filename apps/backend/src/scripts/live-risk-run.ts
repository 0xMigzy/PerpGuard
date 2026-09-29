/**
 * The risk loop, end to end, against a real testnet position.
 *
 *   pnpm risk:live            # read-only: run the loop over whatever is open
 *   pnpm risk:live --open     # open one position, watch it, close it
 *   pnpm risk:live --open --no-close   # leave it open (for a demo recording)
 *
 * WHY MAXIMUM LEVERAGE AT MINIMUM SIZE. At 2x, one size unit of BTC sits at a
 * ~46% buffer and the loop reports SAFE for as long as you care to watch. That
 * proves the plumbing and nothing else. At the market's maximum leverage the
 * buffer lands near 2.7%, which is DANGER on our thresholds and within a few
 * hundredths of where the ground-truth fixture sits — so the run shows a REAL
 * state classification against a REAL account, and then a real transition when
 * margin is added. Still pennies of actual risk: one size unit is under a dollar
 * of notional.
 *
 * SAFETY. Testnet only, and it refuses to run against mainnet. One size unit.
 * It prints every frame it sends, checks `fw` before submitting anything, and
 * closes the position in a finally block so a crash mid-run does not leave one
 * open.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  MarketFeed,
} from '../ingest/marketFeed.ts';
import { RiskLoop } from '../risk/loop.ts';
import { DEFAULT_THRESHOLDS, type RiskAssessment } from '../risk/types.ts';
import {
  PerplPositionSource,
  PerplVenue,
  ausdFromRaw,
  buildAddMarginFrame,
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
  type MarketRiskConfig,
  type PerplPosition,
  type VenueMarket,
} from '@perpguard/shared';

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', default: 'BTC' },
    /** Size in whole size units of the market. 1 is the exchange minimum. */
    units: { type: 'string', default: '1' },
    side: { type: 'string', default: 'long' },
    open: { type: 'boolean', default: false },
    close: { type: 'boolean', default: true },
    'no-close': { type: 'boolean', default: false },
    /** Buffer to aim for with the margin top-up. Must land inside WATCH. */
    target: { type: 'string', default: '0.06' },
    out: { type: 'string', default: 'fixtures/live-risk-run-testnet.json' },
  },
});

const symbol = values.symbol.toUpperCase();
const side = values.side === 'short' ? 'short' : 'long';
const units = Number(values.units);
const targetBuffer = Number(values.target);
const shouldClose = values.close && !values['no-close'];

// Read-only analytics may run against mainnet; this one opens a real position.
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

/** Everything worth keeping for docs/evidence.md. */
const transcript: Array<Record<string, unknown>> = [];
const record = (kind: string, detail: Record<string, unknown>): void => {
  transcript.push({ atMs: Date.now() - t0, kind, ...detail });
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

log(`Perpl testnet (chain ${network.chainId}), key ${maskApiKey(credentials.apiKey)}`);

const venue = new PerplVenue(network, { credentials });
const markets = await venue.getMarkets();
const market = markets.find((m) => m.symbol === symbol);
if (market === undefined) {
  console.error(`${symbol} is not listed on testnet. Available: ${markets.map((m) => m.symbol).join(', ')}`);
  process.exit(1);
}
const configs = await venue.getRiskConfigs();
const config = configs.get(market.marketId);
if (config === undefined) throw new Error(`no risk config for market ${market.marketId}`);

const leverage = market.maxLeverage;
const unitSize = units / 10 ** market.sizeDecimals;
log(
  `${market.displayName} (market ${market.marketId}) maxLeverage ${leverage}x, ` +
    `mmr ${market.maintenanceMarginRatio}, sizeDecimals ${market.sizeDecimals}, ttl ${market.orderTtlBlocks}`,
);
log(`size ${units} unit(s) = ${unitSize} ${symbol}; leverage ${leverage}x (the market maximum)`);
record('setup', {
  network: network.name,
  chainId: network.chainId,
  marketId: market.marketId,
  symbol: market.symbol,
  maxLeverage: leverage,
  maintenanceMarginRatio: market.maintenanceMarginRatio,
  units,
  unitSize,
  riskConfig: { ...config },
  thresholds: DEFAULT_THRESHOLDS,
  staleMs: appConfig.staleMs,
});

// ── the loop, wired to the live feed and the live account ────────────────────

// ONE NETWORK PER RISK LOOP. Both are named here so the constructor can refuse
// a mismatch rather than produce plausible nonsense off the wrong market.
const feed = new MarketFeed(network.name, appConfig.staleMs);
const unsubscribePrices = await venue.subscribePrices([symbol], (update) => {
  feed.record(update);
});

const socket = await venue.connectTrading();

/**
 * Raw `mt: 23`/`mt: 24` order frames, kept verbatim.
 *
 * A collateral increase reported `st: 7 Failed, sr: 32 OrderDescIdTooLow` on the
 * first live run while the margin it asked for was NEVERTHELESS APPLIED. That is
 * not a difference you can reason your way to, so the frames are captured.
 */
const orderFrames: Array<Record<string, unknown>> = [];
socket.onMessage((message) => {
  const mt = message['mt'];
  if (mt !== 23 && mt !== 24) return;
  orderFrames.push({ atMs: Date.now() - t0, ...message } as Record<string, unknown>);
  log(`RAW mt:${mt} ${JSON.stringify(message)}`);
});
log(
  `signed in: account ${socket.accountId}, fw ${socket.forwardingAllowed}, ` +
    `frozen ${socket.accountFrozen}`,
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

const describe = (a: RiskAssessment): string => {
  const buffer = a.liqBufferPct === undefined ? 'n/a' : `${(a.liqBufferPct * 100).toFixed(2)}%`;
  const liq = a.liquidationPricePNS === undefined ? 'n/a' : String(a.liquidationPricePNS);
  return (
    `${a.symbol} ${a.state} buffer=${buffer} liq=${liq} mark=${a.markPricePNS} ` +
    `feed=${a.feed} positions=${a.positions} priceAge=${a.priceAgeMs ?? 'n/a'}ms`
  );
};

loop.onChange((change) => {
  const a = change.assessment;
  log(`STATE ${change.previousState ?? '(none)'} -> ${a.state}  ${describe(a)}`);
  log(`      reason: ${a.reason}`);
  record('state-change', {
    previousState: change.previousState,
    state: a.state,
    liqBufferPct: a.liqBufferPct,
    liquidationPricePNS: a.liquidationPricePNS?.toString(),
    markPricePNS: a.markPricePNS.toString(),
    marginToSafeCNS: a.marginToSafeCNS.toString(),
    marginToSurviveCNS: a.marginToSurviveCNS.toString(),
    feed: a.feed,
    positions: a.positions,
    priceAgeMs: a.priceAgeMs,
    heldOnStalePrice: a.heldOnStalePrice,
    reason: a.reason,
  });
});
loop.start();

/** Re-evaluate on a timer as well as on updates, so quiet ticks still report. */
const ticker = setInterval(() => {
  loop.evaluate();
}, 1000);
ticker.unref();

const status = (): void => {
  const ps = loop.positionsStatus();
  const snap = loop.snapshot();
  log(
    `feed=${venue.feedStatus().state} positions=${ps.state}` +
      `${ps.reason === undefined ? '' : ` (${ps.reason})`} tracked=${snap.length}` +
      `${snap.length === 0 ? '' : ` | ${snap.map(describe).join(' | ')}`}`,
  );
};

async function headBlock(): Promise<number> {
  for (let i = 0; i < 40 && socket.headBlock === undefined; i += 1) await wait(250);
  const head = socket.headBlock;
  if (head === undefined) throw new Error('no heartbeat, so no head block for lb');
  return computeLastExecBlock(head, market!.orderTtlBlocks, 2);
}

/** The position this run opened, read off the live source by market id. */
const ourPosition = (): PerplPosition | undefined =>
  positionSource.snapshot().find((p) => p.marketId === market.marketId);

let opened = false;

try {
  // ── phase 1: baseline, before anything is opened ──────────────────────────
  log('--- phase 1: baseline, no position opened yet ---');
  await wait(4000);
  status();
  record('phase-1-baseline', {
    feed: venue.feedStatus().state,
    positions: loop.positionsStatus().state,
    tracked: loop.snapshot().length,
  });

  if (values.open) {
    // PRE-FLIGHT. `fw` false means the gateway admits the order and it then
    // fails on mt:24 with sr 34. Say so before submitting, not after.
    if (socket.forwardingAllowed !== true) {
      throw new Error(
        `account ${accountId} does not allow API-key-forwarded orders (fw=${socket.forwardingAllowed}). ` +
          `The owner wallet must send allowOrderForwarding(true); an API key cannot.`,
      );
    }

    // ── phase 2: open at min size, max leverage ─────────────────────────────
    log(`--- phase 2: opening ${unitSize} ${symbol} ${side} at ${leverage}x (market maximum) ---`);
    const openFrame = buildMarketOrderFrame({
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      marketId: market.marketId,
      accountId,
      side,
      sizeScaled: units,
      leverageHundredths: Math.round(leverage * 100),
      lastExecBlock: await headBlock(),
    });
    log(`sending OPEN: ${JSON.stringify(openFrame)}`);
    record('open-sent', { frame: { ...openFrame } });
    const openResult = await socket.submit({
      frame: openFrame,
      intent: 'place',
      idempotencyKey: `live-risk-open-${Date.now()}`,
      matches: (order) => order['rq'] === openFrame.rq,
    });
    log(`OPEN outcome: ${openResult.outcome} — ${openResult.reason}`);
    record('open-outcome', { outcome: openResult.outcome, reason: openResult.reason });
    if (openResult.outcome !== 'confirmed') {
      throw new Error(`open was not confirmed (${openResult.outcome}); not proceeding`);
    }
    opened = true;

    await wait(3000);
    loop.evaluate();
    status();
    const afterOpen = ourPosition();
    if (afterOpen === undefined) throw new Error('opened, but no position arrived on the socket');
    log(
      `position pid=${afterOpen.positionId} size=${afterOpen.size} entry=${afterOpen.entryPrice} ` +
        `margin=${afterOpen.margin} AUSD lev=${afterOpen.leverage}x`,
    );
    record('position-open', {
      positionId: afterOpen.positionId,
      size: afterOpen.size,
      entryPrice: afterOpen.entryPrice,
      marginAusd: afterOpen.margin,
      leverage: afterOpen.leverage,
    });

    // ── phase 3: hold through the dwell time ────────────────────────────────
    // DANGER -> WATCH is a SOFTENING, so it is gated on dwell as well as on the
    // buffer. Holding here is the point, not a delay: it is the asymmetry
    // working.
    const dwellMs = DEFAULT_THRESHOLDS.minDwellMs;
    log(`--- phase 3: holding ${dwellMs / 1000}s, the dwell a softening has to earn ---`);
    for (let i = 0; i < dwellMs / 10_000 + 1; i += 1) {
      await wait(10_000);
      status();
    }

    // ── phase 4: add margin, and cross a boundary for real ──────────────────
    const live = ourPosition();
    if (live === undefined) throw new Error('position vanished before the top-up');
    const price = feed.get(market.marketId);
    if (price === undefined) throw new Error('no mark price for the top-up calculation');
    const markPNS = priceToPNS(price.markPrice, config);
    const risk = fromVenuePosition(live, config);
    const topUpCNS = marginToReachBuffer(risk, markPNS, targetBuffer, config);
    log(
      `--- phase 4: adding ${ausdFromRaw(topUpCNS, config.collateralDecimals)} AUSD ` +
        `(${topUpCNS} micros) to reach a ${(targetBuffer * 100).toFixed(2)}% buffer ---`,
    );
    if (topUpCNS <= 0n) {
      log('no top-up needed to reach the target buffer; skipping phase 4');
    } else {
      const marginFrame = buildAddMarginFrame({
        sn: socket.nextSequenceNumber(),
        rq: socket.reserveRequestId(),
        marketId: market.marketId,
        accountId,
        positionId: live.positionId,
        amountCNS: topUpCNS,
        lastExecBlock: await headBlock(),
      });
        log(
        `lfr (last forwarded request id) before the top-up: ${socket.lastForwardedRequestId}; ` +
          `this frame's rq: ${marginFrame.rq}`,
      );
    log(`sending ADD MARGIN: ${JSON.stringify(marginFrame)}`);
      record('add-margin-sent', { frame: { ...marginFrame }, targetBuffer });
      const marginResult = await socket.submit({
        frame: marginFrame,
        intent: 'place',
        idempotencyKey: `live-risk-margin-${Date.now()}`,
        matches: (order) => order['rq'] === marginFrame.rq,
      });
      log(`ADD MARGIN outcome: ${marginResult.outcome} — ${marginResult.reason}`);
      log(`lfr after the top-up: ${socket.lastForwardedRequestId}`);
      record('add-margin-outcome', {
        outcome: marginResult.outcome,
        reason: marginResult.reason,
        lfrAfter: socket.lastForwardedRequestId,
      });

      await wait(6000);

      // A COLLATERAL INCREASE REPORTS FAILURE AND APPLIES ANYWAY. Measured
      // three times across two runs: `st: 7 Failed, sr: 32 OrderDescIdTooLow`
      // every time, with the margin nonetheless rising by exactly the amount
      // sent. So the outcome is reconciled against the POSITION'S MARGIN, which
      // is the only thing that actually says whether the collateral landed.
      //
      // NEVER RE-SEND ON A REPORTED FAILURE. The first investigation of this did
      // re-send with a fresh request id and ADDED THE MARGIN TWICE. On mainnet
      // that is a trader's collateral committed twice over because the venue
      // told us it had failed.
      loop.evaluate();
      status();
      const afterTopUp = ourPosition();
      if (afterTopUp !== undefined) {
        const appliedCNS = BigInt(Math.round((afterTopUp.margin - live.margin) * 10 ** config.collateralDecimals));
        const landed = appliedCNS === topUpCNS;
        record('position-after-top-up', {
          positionId: afterTopUp.positionId,
          marginAusd: afterTopUp.margin,
          size: afterTopUp.size,
          reportedOutcome: marginResult.outcome,
          appliedCNS: appliedCNS.toString(),
          requestedCNS: topUpCNS.toString(),
          landed,
        });
        log(
          `margin is now ${afterTopUp.margin} AUSD (was ${live.margin}): ` +
            `${appliedCNS} micros applied, ${topUpCNS} requested — ` +
            `${landed ? 'LANDED' : 'DID NOT LAND'}, while the order reported ` +
            `"${marginResult.outcome}"`,
        );
      }
    }
  }

  log('--- final state ---');
  status();
} finally {
  if (opened && shouldClose) {
    const live = ourPosition();
    if (live === undefined) {
      log('WARN nothing to close: no position on the socket. CHECK THE ACCOUNT BY HAND.');
    } else {
      log(`--- closing pid=${live.positionId} ---`);
      try {
        const closeFrame = buildClosePositionFrame({
          sn: socket.nextSequenceNumber(),
          rq: socket.reserveRequestId(),
          marketId: market.marketId,
          accountId,
          positionSide: live.side,
          positionId: live.positionId,
          sizeScaled: units,
          lastExecBlock: await headBlock(),
        });
        log(`sending CLOSE: ${JSON.stringify(closeFrame)}`);
        const closeResult = await socket.submit({
          frame: closeFrame,
          intent: 'place',
          idempotencyKey: `live-risk-close-${Date.now()}`,
          matches: (order) => order['rq'] === closeFrame.rq,
        });
        log(`CLOSE outcome: ${closeResult.outcome} — ${closeResult.reason}`);
        record('close-outcome', { outcome: closeResult.outcome, reason: closeResult.reason });
        await wait(3000);
        loop.evaluate();
        status();
      } catch (error) {
        log(`CLOSE FAILED: ${error instanceof Error ? error.message : String(error)}`);
        log('CHECK THE ACCOUNT BY HAND at https://testnet.perpl.xyz');
      }
    }
  } else if (opened) {
    log('leaving the position OPEN, as asked');
  }

  clearInterval(ticker);
  loop.stop();
  positionSource.stop();
  unsubscribePrices();
  socket.close();
  venue.disconnect();

  writeFileSync(
    values.out,
    `${JSON.stringify({ _source: 'pnpm risk:live', _captured: new Date().toISOString(), transcript, orderFrames }, null, 2)}\n`,
  );
  log(`transcript written to ${values.out}`);
}
