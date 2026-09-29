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
import { Client } from 'pg';
import {
  ConfigError,
  PerplPositionSource,
  PerplVenue,
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
  StubActionExecutor,
  TelegramAlertTransport,
  createBot,
  loadBotConfig,
  type RiskView,
} from '@perpguard/bot';
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

const databaseUrl = process.env['DATABASE_URL']?.trim();
let alertDb: Client | undefined;
let innerLog: AlertLog;
if (databaseUrl === undefined || databaseUrl === '') {
  // Deliberate, and reported: a process that alerts without recording is a
  // process whose undelivered DANGER alerts exist nowhere.
  warn('DATABASE_URL is not set; alert history is in memory and is lost on restart');
  innerLog = new InMemoryAlertLog();
} else {
  alertDb = new Client({ connectionString: databaseUrl });
  await alertDb.connect();
  const pgLog = new PostgresAlertLog(alertDb);
  await pgLog.migrate();
  innerLog = pgLog;
  log('alert_log ready on Postgres');
}

const links = new InMemoryLinkStore({
  capacity: 1,
  ...(botConfig?.ownerTelegramUserId === undefined
    ? {}
    : { ownerTelegramUserId: botConfig.ownerTelegramUserId }),
});
const pendingActions = new PendingActionStore();
const executor = new StubActionExecutor({
  availability: (symbol) => venue.getActionAvailability(symbol),
});

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
        } satisfies RiskView,
        configs: riskConfigs,
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
let indexerDb: Client | undefined;
let indexerMonitor: IndexerLagMonitor | undefined;
if (indexerUrl !== undefined && indexerUrl !== '') {
  indexerDb = new Client({ connectionString: indexerUrl });
  await indexerDb.connect();
  const analytics = loadNetworkConfig(appConfig.analytics.name, process.env);
  indexerMonitor = new IndexerLagMonitor({
    sql: indexerDb,
    chainId: analytics.chainId,
    rpcUrl: analytics.rpcUrl,
  });
  log(`indexer lag watched on chain ${analytics.chainId}`);
} else {
  log('INDEXER_DATABASE_URL is not set; indexer lag is not being watched');
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

const app = createHealthApp({ health });

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
