/**
 * PerpGuard's backend process: the thing that actually runs.
 *
 *   pnpm start          # run it
 *   pnpm dev            # run it, restarting on edits
 *
 * THIS FILE IS COMPOSITION AND NOTHING ELSE. Every decision it appears to make
 * was already made somewhere testable: the risk maths in `@perpguard/shared`,
 * the state machine in `risk/state.ts`, whether to alert in `alerts/rules.ts`,
 * what `/health` says in `server/health.ts`, when to start in
 * `server/lifecycle.ts`. What is left here is wiring, and wiring is the one
 * thing that cannot be unit tested into correctness — so it is kept boring and
 * linear, and read top to bottom.
 *
 * FOUR RULES SHAPE THE ORDER BELOW.
 *
 *   ONE NETWORK FOR THE WHOLE PROCESS. Resolved once, passed to the feed, the
 *   position source and the risk loop, all three of which refuse a mismatch at
 *   construction. Both networks list BTC, so a testnet position priced off a
 *   mainnet mark yields a liquidation price, a buffer and an alert that are
 *   entirely wrong and completely plausible. There is no second network in this
 *   process to mix in.
 *
 *   NOTHING ALERTS BEFORE THE GATE OPENS. See `waitUntilReady`.
 *
 *   A FAILURE TO SIGN IN IS NOT A REASON TO EXIT. The price feed and the health
 *   endpoint are exactly what somebody needs when the account socket is down.
 *
 *   NOTHING SECRET IS EVER LOGGED. The bot token, the API key and the ed25519
 *   secret all come from the environment and none reaches a log line: the key is
 *   rendered only through `maskApiKey`, the secret lives inside `ApiSecret`, and
 *   the bot token is redacted out of every string the transport hands back.
 */
import { Pool } from 'pg';
import {
  assessOpenPositions,
  ConfigError,
  PerplPositionSource,
  PerplVenue,
  PostgresAnalytics,
  TvlProbe,
  fetchChainHead,
  symbolResolver,
  loadAppConfig,
  loadNetworkConfig,
  loadPerplCredentials,
  type MarketRiskConfig,
  type NetworkConfig,
  type VenueMarket,
} from '@perpguard/shared';
import {
  InMemoryLinkStore,
  PendingActionStore,
  PendingAmountStore,
  TelegramAlertTransport,
  VenueActionExecutor,
  createBot,
  freeBalanceFrom,
  loadBotConfig,
  type RiskView,
} from '@perpguard/bot';
import {
  ActionsExecutor,
  InMemoryActionLog,
  LoopPositionReader,
  PostgresActionLog,
  type ActionLog,
} from './actions/index.ts';
import { MarketFeed } from './ingest/marketFeed.ts';
import { RiskLoop } from './risk/loop.ts';
import type { RiskAssessment } from './risk/types.ts';
import { AlertEngine } from './alerts/engine.ts';
import { InMemoryAlertLog, PostgresAlertLog } from './alerts/log.pg.ts';
import type { AlertLog } from './alerts/types.ts';
import { AlertActivity } from './server/alertActivity.ts';
import { DeferredPositionSource } from './server/deferredPositionSource.ts';
import { buildHealth, type HealthReport } from './server/health.ts';
import { createHealthApp } from './server/http.ts';
import { IndexerLagMonitor } from './server/indexerHealth.ts';
import { ShutdownSequence, waitUntilReady } from './server/lifecycle.ts';
import { ActionProgressTracker } from './server/protect/progress.ts';
import { LinkCodeStore, SessionStore, WebPendingActionStore } from './server/protect/session.ts';
import { TradingSession } from './server/tradingSession.ts';

const startedAtMs = Date.now();
const log = (line: string): void => console.log(`[perpguard] ${line}`);
const warn = (line: string): void => console.warn(`[perpguard] ${line}`);

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

const READINESS_TIMEOUT_MS = intFromEnv('READINESS_TIMEOUT_MS', 20_000);
const SHUTDOWN_TIMEOUT_MS = intFromEnv('SHUTDOWN_TIMEOUT_MS', 10_000);
const EVALUATE_INTERVAL_MS = intFromEnv('EVALUATE_INTERVAL_MS', 1_000);
const INDEXER_POLL_MS = intFromEnv('INDEXER_POLL_MS', 60_000);
const HEALTH_PORT = intFromEnv('HEALTH_PORT', 8080);
const HEALTH_HOST = process.env['HEALTH_HOST']?.trim() ?? '0.0.0.0';

// ── 1. one network, resolved once ───────────────────────────────────────────

const appConfig = loadAppConfig(process.env);
/**
 * THE network for this process. Trading actions run on testnet, so the risk loop
 * that offers them assesses the same network — a loop watching mainnet while the
 * buttons act on testnet would offer a top-up for a position on the other chain.
 */
const network: NetworkConfig = appConfig.trading;
log(`network: ${network.name} (chain ${network.chainId}), stale after ${appConfig.staleMs}ms`);

// ── 2. credentials, all optional, none logged ───────────────────────────────

let credentials: ReturnType<typeof loadPerplCredentials> | undefined;
try {
  credentials = loadPerplCredentials(process.env);
  if (credentials.network !== network.name) {
    // A key for the other network would sign correctly and watch the wrong
    // account. Refuse rather than reconcile.
    throw new ConfigError(
      `PERPL_NETWORK is ${credentials.network} but this process runs on ${network.name}. ` +
        `One network per process: set TRADING_NETWORK and PERPL_NETWORK to the same value.`,
    );
  }
} catch (error) {
  if (error instanceof ConfigError && !/PERPL_NETWORK is/.test(error.message)) {
    // Missing credentials are a degraded state, not a startup failure. A
    // mismatched network is not: that one is a wiring error and must stop here.
    warn(`no Perpl API credentials: ${error.message}`);
    credentials = undefined;
  } else {
    throw error;
  }
}

let botConfig: ReturnType<typeof loadBotConfig> | undefined;
let botConfigReason: string | undefined;
try {
  botConfig = loadBotConfig(process.env);
} catch (error) {
  botConfigReason = error instanceof Error ? error.message : String(error);
  warn(`no Telegram bot: ${botConfigReason}`);
}
const userId = botConfig?.userId ?? process.env['PERPGUARD_USER_ID']?.trim() ?? 'default';

// ── 3. the venue, the market feed ───────────────────────────────────────────

const venue = new PerplVenue(network, {
  ...(credentials === undefined
    ? {}
    : { credentials: { apiKey: credentials.apiKey, secret: credentials.secret } }),
  logger: { log, warn },
});

const markets: readonly VenueMarket[] = await venue.getMarkets();
const riskConfigs: ReadonlyMap<number, MarketRiskConfig> = await venue.getRiskConfigs();
log(
  `${markets.length} market(s) on ${network.name}: ` +
    markets.map((m) => `${m.symbol}#${m.marketId}`).join(', '),
);

const feed = new MarketFeed(network.name, appConfig.staleMs);
// Every listed symbol. The market-state frame carries them all anyway, and a
// position can be opened on any of them between now and the next restart.
const unsubscribePrices = await venue.subscribePrices(
  markets.map((m) => m.symbol),
  (update) => feed.record(update),
);
log(`market data subscribed: ${venue.feedStatus().state}`);

// ── 4. positions, behind a source that exists before the socket does ────────

const trading = new TradingSession({
  venue,
  network,
  apiKey: credentials?.apiKey,
  logger: { info: log, warn },
});

const positionSource = new DeferredPositionSource({
  reason: () => {
    const status = trading.status();
    return (
      status.reason ??
      `the trading session is ${status.state}, so we have not been told what is open`
    );
  },
});

trading.onSignedIn(async (socket) => {
  const collateral = await venue.getCollateralToken();
  const source = new PerplPositionSource({
    socket,
    network: network.name,
    markets: new Map(markets.map((m) => [m.marketId, m])),
    collateralDecimals: collateral.decimals,
    onSkippedMarket: (marketId) =>
      warn(`skipping a position on market ${marketId}: the context does not list it`),
  });
  source.start();
  positionSource.attach(source);
  log(`position source attached (collateral ${collateral.symbol}, ${collateral.decimals} dp)`);
});

// ── 5. the risk loop ────────────────────────────────────────────────────────

const loop = new RiskLoop({
  network: network.name,
  feed,
  positions: positionSource,
  feedStatus: () => venue.feedStatus(),
  configs: riskConfigs,
});

// ── 6. alerts: log, transport, engine ───────────────────────────────────────

/**
 * The alert log, on Postgres when there is one.
 *
 * A POOL, NOT A CLIENT. This process runs for days and a single `pg.Client`
 * that loses its connection never gets another: every subsequent write fails
 * and the alert history silently stops. A pool replaces a dead connection on
 * the next query, which is the difference between a blip and an outage.
 *
 * A FAILING DATABASE DOES NOT STOP THE PROCESS, the same rule the trading
 * socket follows and for the same reason: the alert path degrading is not a
 * reason to take the price feed and the health endpoint down with it. It falls
 * back to the in-memory log, and `/health` says so AND says why — "no
 * DATABASE_URL" and "Postgres refused the connection" are different problems
 * with different fixes.
 */
const databaseUrl = process.env['DATABASE_URL']?.trim();
let alertDb: Pool | undefined;
let innerLog: AlertLog;
let durableReason: string | undefined;

if (databaseUrl === undefined || databaseUrl === '') {
  durableReason = 'DATABASE_URL is not set';
  warn(`${durableReason}; alert history is in memory and is lost on restart`);
  innerLog = new InMemoryAlertLog();
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  // An unhandled 'error' on an idle client TAKES THE PROCESS DOWN. Postgres
  // restarting mid-session is ordinary; a risk monitor exiting because of it
  // is not.
  pool.on('error', (error) => {
    warn(`idle Postgres connection dropped: ${error.message}. The pool will reconnect.`);
  });
  try {
    const pgLog = new PostgresAlertLog(pool);
    await pgLog.migrate();
    alertDb = pool;
    innerLog = pgLog;
    log('alert_log ready on Postgres');
  } catch (error) {
    // The URL never reaches a log line: it carries a password.
    durableReason = `Postgres was configured but could not be reached: ${
      error instanceof Error ? error.message : String(error)
    }`;
    warn(`${durableReason}. Falling back to an in-memory alert log and reporting DEGRADED.`);
    await pool.end().catch(() => {});
    innerLog = new InMemoryAlertLog();
  }
}

const links = new InMemoryLinkStore({
  capacity: 1,
  ...(botConfig?.ownerTelegramUserId === undefined
    ? {}
    : { ownerTelegramUserId: botConfig.ownerTelegramUserId }),
});
const pendingActions = new PendingActionStore();
const pendingAmounts = new PendingAmountStore();

// ── the web session: the bot's link, one step later ────────────────────────
//
// The Protect page is signed into with a one-time code the bot hands the LINKED
// chat, so the web session is opened by the same person the bot already
// trusts. `PERPGUARD_WEB_DEV_LINK=1` additionally lets the operator mint one
// from the loopback interface for local work; it is off unless said so.
const webSessions = new SessionStore();
const webLinkCodes = new LinkCodeStore();
const webPending = new WebPendingActionStore();
const actionProgress = new ActionProgressTracker();
const devLinkMint = process.env['PERPGUARD_WEB_DEV_LINK']?.trim() === '1';
if (devLinkMint) warn('PERPGUARD_WEB_DEV_LINK=1: web sign-in codes can be minted from localhost. Dev only.');

// ── the actions layer ───────────────────────────────────────────────────────
//
// THE ONLY PART OF PERPGUARD THAT MOVES MONEY. Everything about how it behaves is
// in `src/actions`; what is wired here is which venue it acts on, which positions
// it reconciles against, and where the rows go.
//
// `action_log` shares the alert log's pool when there is one. A run without
// Postgres gets the in-memory log rather than no log: the two-phase open/settle
// shape is what makes an unaccounted-for action findable, and that is worth having
// even when it does not survive a restart.
let actionLog: ActionLog = new InMemoryActionLog();
if (alertDb !== undefined) {
  try {
    const pgActions = new PostgresActionLog(alertDb);
    await pgActions.migrate();
    actionLog = pgActions;
    log('action_log ready on Postgres');
  } catch (error) {
    warn(
      `action_log could not be prepared on Postgres (${
        error instanceof Error ? error.message : String(error)
      }); actions will be recorded in memory only.`,
    );
  }
}

const actionsExecutor = new ActionsExecutor({
  venue,
  positions: new LoopPositionReader({
    source: positionSource,
    configs: riskConfigs,
    onAmbiguous: (marketId, count) =>
      warn(
        `${count} positions on market ${marketId}: refusing to reconcile an action against ` +
          `either, because nothing says which one it went to`,
      ),
    onUnscalable: (marketId) =>
      warn(`no market config for ${marketId}: cannot read its margin as exact integers`),
  }),
  // The gate the feed already encodes: refused when the FEED is not connected,
  // never because a price is merely old.
  prices: { canAct: (marketId) => feed.canAct(marketId, venue.feedStatus()) },
  log: actionLog,
  logger: { info: log, warn },
  // The web page shows the steps as they happen; the bot's actions are ignored
  // by the tracker because it never started them.
  onProgress: (progress) => actionProgress.record(progress),
});

const executor = new VenueActionExecutor({
  runner: actionsExecutor,
  availability: (symbol) => venue.getActionAvailability(symbol),
});

// A FLOOR on spendable AUSD, read off the account snapshot, and undefined before
// sign-in — which the bot renders as "I could not check your free balance" rather
// than as a balance of nothing. It is never used to refuse an amount: see
// `freeBalanceFloorCNS` on the trading socket for why `b - lb` is a floor.
const balance = freeBalanceFrom(() => venue.freeBalanceFloorCNS());

const bot =
  botConfig === undefined
    ? undefined
    : createBot({
        config: botConfig,
        links,
        store: pendingActions,
        executor,
        view: {
          network: loop.network,
          snapshot: () => loop.snapshot(),
          feedStatus: () => venue.feedStatus(),
          positionsStatus: () => loop.positionsStatus(),
          projectAddMargin: (marketId, amountCNS) => loop.projectAddMargin(marketId, amountCNS),
        } satisfies RiskView,
        configs: riskConfigs,
        amounts: pendingAmounts,
        balance,
        mintLinkCode: (id) => webLinkCodes.mint(id),
      });

const transport =
  bot === undefined || botConfig === undefined
    ? undefined
    : new TelegramAlertTransport({
        api: bot.api,
        token: botConfig.token,
        links,
        store: pendingActions,
        executor,
        logger: { warn },
      });

const activity = new AlertActivity({
  inner: innerLog,
  durable: alertDb !== undefined,
  ...(durableReason === undefined ? {} : { durableReason }),
  transportConfigured: transport !== undefined,
  ...(transport === undefined
    ? {
        transportReason:
          botConfigReason ??
          'no Telegram transport is wired, so any warning this process produces goes nowhere',
      }
    : {}),
});

const engine = new AlertEngine({
  source: loop,
  configs: riskConfigs,
  // A transport that refuses honestly beats one that silently succeeds: the
  // engine records the row and logs at error level, so an alert with nowhere to
  // go is visible rather than lost.
  transport: transport ?? {
    async send() {
      return {
        ok: false,
        reason: 'no Telegram transport is configured, so this alert has nowhere to go',
        retryable: false,
      };
    },
  },
  log: activity,
  userId,
  logger: { error: warn, warn, info: log },
});

// ── 7. the optional indexer lag probe ───────────────────────────────────────

const indexerUrl = process.env['INDEXER_DATABASE_URL']?.trim();
let indexerDb: Pool | undefined;
let indexerMonitor: IndexerLagMonitor | undefined;
let analyticsReader: PostgresAnalytics | undefined;
let analyticsVenue: PerplVenue | undefined;
if (indexerUrl !== undefined && indexerUrl !== '') {
  // A pool, and NOT connected eagerly, for the same two reasons as the alert
  // log: a dead single client never recovers, and an indexer database that is
  // down is a degraded reading rather than a reason not to start. The probe
  // already turns any failure into a verdict.
  indexerDb = new Pool({ connectionString: indexerUrl, max: 2 });
  indexerDb.on('error', (error) => {
    warn(`idle indexer Postgres connection dropped: ${error.message}. The pool will reconnect.`);
  });
  const analyticsNetwork = loadNetworkConfig(appConfig.analytics.name, process.env);
  indexerMonitor = new IndexerLagMonitor({
    sql: indexerDb,
    chainId: analyticsNetwork.chainId,
    rpcUrl: analyticsNetwork.rpcUrl,
  });
  log(`indexer lag watched on chain ${analyticsNetwork.chainId}`);

  // ── the analytics reader, on the same pool ────────────────────────────────
  //
  // CANONICAL TICKERS COME FROM THE VENUE CONTEXT, keyed by market id. The indexer
  // stores what the chain said — mainnet market 31 is `SOL_v2` there — and market
  // 80 (TAO) is indexed but absent from the context, so it resolves to no symbol
  // rather than borrowing the chain's name.
  //
  // `markets` was already fetched for the risk configs, and it is the ANALYTICS
  // network's market list when analytics and trading are the same network. When
  // they differ the analytics venue is asked separately, because resolving mainnet
  // market ids against testnet tickers would mislabel every row.
  analyticsVenue =
    analyticsNetwork.name === network.name ? venue : new PerplVenue(analyticsNetwork, {});
  const analyticsMarkets =
    analyticsNetwork.name === network.name ? markets : await analyticsVenue.getMarkets();

  // TVL IS A CHAIN READ, NOT AN INDEXER READ. Accounts held collateral before the
  // start block, so the indexed deposit/withdrawal net is a FLOW and on mainnet it
  // is negative. `balanceOf` the Exchange proxy is the current truth whenever we
  // started watching. MONAD_RPC_URL overrides, since that is the name people reach
  // for; it falls back to the network's own RPC.
  const tvlRpcUrl = process.env['MONAD_RPC_URL']?.trim() || analyticsNetwork.rpcUrl;
  const tvlProbe = new TvlProbe({
    rpcUrl: tvlRpcUrl,
    tokenAddress: analyticsNetwork.collateralAddress,
    // The PROXY. Collateral sits there; the implementation holds none.
    exchangeAddress: analyticsNetwork.exchangeAddress,
    collateralDecimals: analyticsNetwork.collateralDecimals,
  });

  analyticsReader = new PostgresAnalytics({
    client: indexerDb,
    chainId: analyticsNetwork.chainId,
    resolveSymbol: symbolResolver(
      analyticsMarkets.map((m) => ({ marketId: m.marketId, symbol: m.symbol })),
    ),
    // An INDEPENDENT chain head, so a halted indexer cannot report itself synced.
    // The same helper the lag monitor uses, so the two cannot disagree about the
    // head and then disagree about whether the indexer is healthy.
    chainHead: () => fetchChainHead(analyticsNetwork.rpcUrl),
    tvlProbe,
  });
  log(`analytics API ready on chain ${analyticsNetwork.chainId} (TVL via ${new URL(tvlRpcUrl).host})`);
} else {
  log('INDEXER_DATABASE_URL is not set; indexer lag and the analytics API are both off');
}

// ── 8. the health report, buildable before anything is ready ────────────────

let assessing = false;

const health = (): HealthReport =>
  buildHealth({
    network: network.name,
    startedAtMs,
    nowMs: Date.now(),
    feed: venue.feedStatus(),
    positions: positionSource.status(),
    assessments: loop.snapshot(),
    trading: trading.status(),
    alerts: activity.status(),
    indexer: indexerMonitor?.health(),
    assessing,
  });

const app = createHealthApp({
  health,
  protect: {
    userId,
    view: {
      network: loop.network,
      snapshot: () => loop.snapshot(),
      feedStatus: () => venue.feedStatus(),
      positionsStatus: () => loop.positionsStatus(),
      projectAddMargin: (marketId, amountCNS) => loop.projectAddMargin(marketId, amountCNS),
      sightedBook: () => loop.sightedBook(),
      positions: () => positionSource.snapshot(),
      thresholds: () => loop.thresholds,
    },
    configs: riskConfigs,
    sessions: webSessions,
    linkCodes: webLinkCodes,
    pending: webPending,
    progress: actionProgress,
    freeBalance: () => balance.freeBalance(),
    availability: (symbol) => venue.getActionAvailability(symbol),
    inFlightOn: (marketId) => actionsExecutor.inFlightOn(marketId),
    runner: actionsExecutor,
    accountId: () => trading.status().accountId,
    forwardingAllowed: () => trading.status().forwardingAllowed,
    devLinkMint,
    logger: { info: log, warn },
  },
  // Mounted only when the indexer database is configured. A backend that refused
  // to serve alerts because Postgres was unreachable would have the priorities
  // exactly backwards; /health reports the degradation instead.
  ...(analyticsReader === undefined ? {} : { analytics: analyticsReader }),
  // The open-interest LEVEL is a venue read on the analytics network; the
  // indexer only has the delta. Kept off the reader so the two cannot be confused.
  ...(analyticsVenue === undefined
    ? {}
    : {
        openInterest: () => analyticsVenue!.getOpenInterest(),
        // ONE NETWORK: configs and marks both come from the analytics venue, and
        // the positions from the analytics network's indexer. Nothing here can
        // reach the trading venue.
        assessPositions: async (positions) => {
          const [configs, oi] = await Promise.all([analyticsVenue!.getRiskConfigs(), analyticsVenue!.getOpenInterest()]);
          const marks = new Map(oi.map((m) => [m.marketId, { markPrice: m.markPrice, atMs: m.atMs }]));
          const assessed = assessOpenPositions(positions, configs, marks);
          const used = assessed.map((a) => a.markAtMs).filter((ms): ms is number => ms !== undefined);
          return { positions: assessed, asOfMs: used.length === 0 ? undefined : Math.min(...used) };
        },
      }),
});

// ── 9. shutdown, registered BEFORE anything can need it ─────────────────────
//
// Ahead of the listen below on purpose. A port already in use is an ordinary
// deployment mistake, and with no sequence registered it would crash out with a
// raw libuv stack trace, leaving the market-data socket open behind it.

const shutdown = new ShutdownSequence({
  deadlineMs: SHUTDOWN_TIMEOUT_MS,
  onStep: (step) =>
    step.ok
      ? log(`shutdown: ${step.name} (${step.ms}ms)`)
      : warn(`shutdown: ${step.name} FAILED after ${step.ms}ms: ${step.error}`),
});

let evaluateTimer: ReturnType<typeof setInterval> | undefined;
let indexerTimer: ReturnType<typeof setInterval> | undefined;

shutdown
  // Stop producing work first. Everything below is then draining a queue that
  // cannot grow, rather than racing one that still can.
  .add('stop the risk loop', () => {
    loop.stop();
    if (evaluateTimer !== undefined) clearInterval(evaluateTimer);
    if (indexerTimer !== undefined) clearInterval(indexerTimer);
  })
  .add('stop the bot', async () => {
    await bot?.stop();
  })
  // Before the sockets close, and before the process exits. A half-sent DANGER
  // alert on restart is worse than a late one.
  .add('drain alert deliveries', async () => {
    engine.stop();
    await engine.drain();
  })
  .add('close the trading socket', () => trading.stop())
  .add('close the market data feed', () => {
    unsubscribePrices();
    venue.disconnect();
  })
  .add('close the http server', () => app.close())
  .add('close the databases', async () => {
    await alertDb?.end();
    await indexerDb?.end();
  });

let exiting = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (exiting) {
      warn(`${signal} again while shutting down; still draining`);
      return;
    }
    exiting = true;
    log(`${signal} received; shutting down`);
    void shutdown.run().then(
      (results) => {
        const failed = results.filter((r) => !r.ok).length;
        log(`shutdown complete, ${results.length - failed}/${results.length} steps clean`);
        process.exit(failed === 0 ? 0 : 1);
      },
      (error) => {
        warn(`shutdown itself failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      },
    );
  });
}

// ── 10. now serve health, failing cleanly if the port is taken ──────────────

try {
  await app.listen({ host: HEALTH_HOST, port: HEALTH_PORT });
  log(`health on http://${HEALTH_HOST}:${HEALTH_PORT}/health`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  warn(
    `could not serve health on ${HEALTH_HOST}:${HEALTH_PORT}: ${detail}. ` +
      `Set HEALTH_PORT to a free port. Closing what is already open.`,
  );
  await shutdown.run();
  process.exit(1);
}

// ── 11. connect the account, then open the gate ─────────────────────────────

trading.start();

if (indexerMonitor !== undefined) {
  await indexerMonitor.poll();
  indexerTimer = setInterval(() => void indexerMonitor.poll(), INDEXER_POLL_MS);
  indexerTimer.unref();
}

/**
 * The gate. BOTH halves, and the feed half is the one that bites: sign-in
 * completing while the market feed is still on its first connect would have the
 * loop assess every position as blind and the engine fire a FEED_DOWN for each,
 * seconds after boot, about a feed that was merely still starting.
 */
const readiness = await waitUntilReady({
  isReady: () =>
    positionSource.status().state === 'live' && venue.feedStatus().state === 'connected',
  timeoutMs: READINESS_TIMEOUT_MS,
});

if (readiness.ready) {
  log(`ready after ${readiness.waitedMs}ms; assessing`);
} else {
  // Not a failure. With no position set there is nothing to assess, so the loop
  // is silent either way, and the health endpoint is what says why.
  warn(
    `still not ready after ${readiness.waitedMs}ms (positions: ` +
      `${positionSource.status().state}, feed: ${venue.feedStatus().state}). ` +
      `Starting anyway and reporting DEGRADED; nothing will be assessed until ` +
      `both are up.`,
  );
}

loop.start();
engine.start();
assessing = true;

// The loop re-evaluates on position updates only, and a price that moves a
// position into DANGER arrives on the feed, not on the account socket.
evaluateTimer = setInterval(() => {
  if (shutdown.started) return;
  loop.evaluate();
}, EVALUATE_INTERVAL_MS);
evaluateTimer.unref();

if (bot !== undefined) {
  // Long polling. `start` does not resolve until the bot stops, so it is not
  // awaited; a failure to reach Telegram must not take the process down.
  void bot
    .start({ onStart: (info) => log(`telegram bot @${info.username} polling`) })
    .catch((error: unknown) => {
      warn(`telegram polling stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
}

log(`up in ${Date.now() - startedAtMs}ms; status ${health().status}`);
