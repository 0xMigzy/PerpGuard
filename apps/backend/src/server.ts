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
import { CopyReplayService } from './copy/service.ts';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  ApiSecret,
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
  lookupAccountByAddress,
  lookupAccountOwner,
  positionEventsInTxs,
  type TraderRow,
  type MarketRiskConfig,
  type NetworkConfig,
  type VenueMarket,
  fetchBinanceFunding,
  fetchHyperliquidFunding,
} from '@perpguard/shared';
import {
  BOT_MENU_COMMANDS,
  InMemoryAccountSettingsStore,
  type AccountSettings,
  type AccountSettingsStore,
  watchRecipients,
  DEFAULT_RATE_LIMIT,
  InMemoryLinkStore,
  InMemoryWatchStore,
  PendingActionStore,
  PendingAmountStore,
  RateLimiter,
  TelegramAlertTransport,
  classifyTelegramError,
  createBot,
  loadBotConfig,
  InMemoryIdentityStore,
  type IdentityStore,
  type LinkStore,
  type RiskView,
  type WatchResolver,
  type WatchStore,
  type WatchTarget,
  encodeNav,
  createManualAlertSender,
} from '@perpguard/bot';
import { DEFAULT_ALERT_CONFIG } from './alerts/types.ts';
import { withBadge } from './alerts/plain.ts';
import { InMemoryAutomationStore, PostgresAutomationStore, type AutomationStore } from './rescue/automation.ts';
import { InMemoryRescueStore, PostgresRescueStore, type RescueStore } from './rescue/store.ts';
import { RescueControlService } from './rescue/control.ts';
import { RescueEngine } from './rescue/engine.ts';
import { KillSwitch } from './rescue/killSwitch.ts';
import { ArmSigner } from './rescue/arming.ts';
import { replacedByManualAlert } from './manual/replaced.ts';
import { InMemoryManualAlertState, ManualAlerts, PostgresManualAlertState, type ManualAlertStateStore } from './manual/alerts.ts';
import { CloseEverything } from './emergency/closeAll.ts';
import { InMemoryCloseAllRunStore, PostgresCloseAllRunStore, type CloseAllRunStore } from './emergency/store.ts';
import type { OpenPosition } from './emergency/verify.ts';
import { toReconcilable } from './actions/positionReader.ts';
import { renderRescue } from './rescue/render.ts';
import { applyMarketRefresh } from './ingest/marketRefresh.ts';
import {
  ActionsExecutor,
  InMemoryActionLog,
  LoopPositionReader,
  PostgresActionLog,
  type ActionLog,
} from './actions/index.ts';
import { MarketFeed } from './ingest/marketFeed.ts';
import { RiskLoop } from './risk/loop.ts';
import { isBlind, type RiskAssessment } from './risk/types.ts';
import { AlertEngine } from './alerts/engine.ts';
import { InMemoryAlertLog, PostgresAlertLog, type AlertHistoryReader } from './alerts/log.pg.ts';
import type { AlertLog, AlertTransport } from './alerts/types.ts';
import { AlertActivity } from './server/alertActivity.ts';
import { DeferredPositionSource } from './server/deferredPositionSource.ts';
import { buildHealth, type HealthReport } from './server/health.ts';
import { createHealthApp } from './server/http.ts';
import { IndexerLagMonitor } from './server/indexerHealth.ts';
import { RiskSnapshotSource } from './server/riskSnapshot.ts';
import { analyticsLoaders, defaultWarmEntries } from './server/analyticsRoutes.ts';
import { buildVenueFundingPayload, describeFetchError, VenueFundingStore } from './funding/venueFundingStore.ts';
import { readScanFile, treasuryDaysOf } from './exchangeBalance/protocolDays.ts';
import { TreasuryScanner } from './exchangeBalance/treasuryScanner.ts';
import { OwnerDirectory } from './server/ownerDirectory.ts';
import { FillDirections } from './server/fillDirections.ts';
import { EventEngine, type ChatSender } from './events/engine.ts';
import { InMemoryLedger, PostgresLedger } from './events/ledger.ts';
import { InMemoryPreferenceStore, SMALLEST_LARGE_TRADE_AUSD, type PreferenceStore } from './events/preferences.ts';
import { PostgresPreferenceStore } from './events/preferences.pg.ts';
import { FeedPoller, PositionChanges } from './events/sources.ts';
import { InMemoryWarningState, PostgresWarningState, WatchWarnings, type WarningStateStore } from './events/watchWarnings.ts';
import { ProfileWarmer } from './server/hotProfiles.ts';
import { LazySeededMemoryStore, PostgresTreasuryStore } from './exchangeBalance/treasuryStore.ts';
import { SwrCache } from './server/responseCache.ts';
import { ShutdownSequence, waitUntilReady } from './server/lifecycle.ts';
import { ActionProgressTracker } from './server/protect/progress.ts';
import { WalletChallenger } from './server/link/walletChallenge.ts';
import { createPublicClient, http } from 'viem';
import { LinkCodeStore, SessionStore, WebPendingActionStore } from './server/protect/session.ts';
import { AccountRegistry, DEFAULT_MAX_SESSIONS } from './sessions/registry.ts';
import { KeyVault } from './server/link/crypto.ts';
import { LinkService } from './server/link/service.ts';
import { InMemoryWalletProofStore, PostgresWalletProofStore, type WalletProofStore } from './server/link/proofs.ts';
import { InMemoryKeyStore, PostgresKeyStore, PostgresLinkStore, type KeyStore } from './server/link/stores.ts';
import { WatchLoop } from './watch/loop.ts';
import { thresholdsFor } from './risk/warn.ts';
import { StartupDeliveryGate } from './alerts/startupGate.ts';
import { PostgresAccountSettingsStore } from './sessions/settings.pg.ts';
import { createWatchResolver } from './watch/resolve.ts';
import { PostgresWatchStore } from './watch/store.pg.ts';
import { PostgresIdentityStore } from './watch/identity.pg.ts';

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
/** How many linked accounts may have a live session at once. See AccountRegistry for the reasoning. */
const MAX_ACCOUNT_SESSIONS = intFromEnv('MAX_ACCOUNT_SESSIONS', DEFAULT_MAX_SESSIONS);
/** How often every watched account is re-read from the index and re-assessed. */
const WATCH_INTERVAL_MS = intFromEnv('WATCH_INTERVAL_MS', 30_000);
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

// THE SHARED VENUE HOLDS NO CREDENTIALS. It serves the market list, the risk
// configs and the market-data feed, which are facts about the venue; every
// account's socket lives in that account's own venue inside its session.
const venue = new PerplVenue(network, { logger: { log, warn } });

const markets: readonly VenueMarket[] = await venue.getMarkets();
// MUTABLE BEHIND A READONLY FACE: the market refresh below updates it in place,
// so every loop holding this map sees a changed maintenance margin at once.
const riskConfigs: ReadonlyMap<number, MarketRiskConfig> = new Map(await venue.getRiskConfigs());
/** The collateral token's decimals, from the context. Every rescue amount is in its units. */
const collateralDecimals = (await venue.getCollateralToken()).decimals;
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

// ── 4 & 5. positions and the risk loop: PER ACCOUNT, in the registry ────────
//
// What used to be one trading session, one position source and one risk loop
// is now a session per linked account, built in `sessions/session.ts` and
// owned by the registry below. The environment key's account is the first
// occupant, opened at boot; linking opens more.

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
let innerLog: AlertLog & AlertHistoryReader;
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

// WHO MAY ACT ON WHICH ACCOUNT. One link per Telegram user, as many users as
// there may be sessions plus the environment owner, persisted so a restart
// keeps every link — the sealed keys behind them are reopened below.
const linkCapacity = MAX_ACCOUNT_SESSIONS + 1;
let links: LinkStore = new InMemoryLinkStore({
  capacity: linkCapacity,
  ...(botConfig?.ownerTelegramUserId === undefined ? {} : { ownerTelegramUserId: botConfig.ownerTelegramUserId }),
});
let keyStore: KeyStore = new InMemoryKeyStore();
let walletProofs: WalletProofStore = new InMemoryWalletProofStore();
if (alertDb !== undefined) {
  try {
    links = await PostgresLinkStore.load({ pool: alertDb, capacity: linkCapacity, ownerTelegramUserId: botConfig?.ownerTelegramUserId, logger: { warn } });
    keyStore = await PostgresKeyStore.load({ pool: alertDb, logger: { warn } });
    walletProofs = await PostgresWalletProofStore.load({ pool: alertDb, logger: { warn } });
    log(`account links loaded from Postgres: ${links.list().length} link(s), ${keyStore.list().length} sealed key(s)`);
  } catch (error) {
    warn(`account links could not be loaded from Postgres (${error instanceof Error ? error.message : String(error)}); links are in memory until the next restart`);
  }
}
// THE KEY THAT SEALS PASTED API KEYS. Without it the key path refuses and says
// so; wallet proof still links to an account the process already runs.
// Rotating it invalidates every sealed key: the links survive, the sessions do
// not reopen, and each user re-links. See server/link/crypto.ts.
const keyEncryptionHex = process.env['PERPGUARD_KEY_ENCRYPTION_KEY']?.trim();
let vault: KeyVault | undefined;
if (keyEncryptionHex === undefined || keyEncryptionHex === '') {
  warn('PERPGUARD_KEY_ENCRYPTION_KEY is not set: pasted API keys cannot be stored, so linking by key is off (wallet proof still works for the environment account)');
} else {
  vault = new KeyVault(keyEncryptionHex);
  log(`key vault ready (environment key id ${vault.keyId})`);
}
const PUBLIC_WEB_URL = process.env['PUBLIC_WEB_URL']?.trim() || 'http://localhost:3000';
const pendingActions = new PendingActionStore();
const pendingAmounts = new PendingAmountStore();

// ── the public watch tier: who follows which mainnet account ───────────────
//
// PERSISTED when there is a database, because a public subscription that
// vanished on every restart would vanish often now that the process restarts
// itself. The resolver and the loop need the analytics index, which is wired
// further down; the bot is built first, so it gets a resolver that forwards to
// whatever is wired by the time somebody types /watch.
let watchStore: WatchStore = new InMemoryWatchStore();
if (alertDb !== undefined) {
  try {
    watchStore = await PostgresWatchStore.load({ pool: alertDb, logger: { warn } });
    log(`watch subscriptions loaded from Postgres: ${watchStore.accountIds().length} account(s) watched`);
  } catch (error) {
    warn(`watch subscriptions could not be loaded from Postgres (${error instanceof Error ? error.message : String(error)}); watching is in memory until the next restart`);
  }
}
// What each chat wants from the feeds and its warning levels. Loaded here,
// beside the subscriptions, because the watch engine below already reads it.
let preferences: PreferenceStore = new InMemoryPreferenceStore();
let warningState: WarningStateStore = new InMemoryWarningState();
if (alertDb !== undefined) {
  try {
    preferences = await PostgresPreferenceStore.load(alertDb);
    warningState = await PostgresWarningState.load(alertDb);
  } catch (error) {
    warn(`alert preferences could not be loaded from Postgres (${error instanceof Error ? error.message : String(error)}); defaults until the next restart`);
  }
}
// Everyone who has ever said /start, so a restart does not forget them.
let identities: IdentityStore = new InMemoryIdentityStore();
if (alertDb !== undefined) {
  try {
    identities = await PostgresIdentityStore.load({ pool: alertDb, logger: { warn } });
    log(`telegram identities loaded from Postgres: ${identities.list().length}`);
  } catch (error) {
    warn(`telegram identities could not be loaded from Postgres (${error instanceof Error ? error.message : String(error)}); in memory until the next restart`);
  }
}
let linkServiceImpl: LinkService | undefined;
let watchResolverImpl: WatchResolver | undefined;
const watchResolver: WatchResolver = {
  resolve: (target: WatchTarget) =>
    watchResolverImpl === undefined
      ? Promise.resolve({ error: 'this deployment has no mainnet index wired, so there is nothing to watch with' })
      : watchResolverImpl.resolve(target),
};
let watchLoop: WatchLoop | undefined;
/** The event engine's position source, bound once the engine exists (below the bot). */
let positionChanges: PositionChanges | undefined;
/** Each chat's warning levels on its watched wallets, bound with the engine. Declared here so the watch loop's hook can never read it before it exists. */
let watchWarnings: WatchWarnings | undefined;
/** What each fill did to its position, from its receipt: shared by the trades page and the large-trade feed. */
let fillDirections: FillDirections | undefined;

// ── the web session: the bot's link, one step later ────────────────────────
//
// The Protect page is signed into with a one-time code the bot hands the LINKED
// chat, so the web session is opened by the same person the bot already
// trusts. `PERPGUARD_WEB_DEV_LINK=1` additionally lets the operator mint one
// from the loopback interface for local work; it is off unless said so.
const webSessions = new SessionStore();
// ONE STORE PER PURPOSE. Each consumer refuses a store made for the other.
const protectCodes = new LinkCodeStore({ purpose: 'protect' });
const linkCodes = new LinkCodeStore({ purpose: 'link' });
const webPending = new WebPendingActionStore();
const actionProgress = new ActionProgressTracker();
// REFUSED IN PRODUCTION regardless of the flag: a loopback mint on a host that
// also runs a reverse proxy is an owner session for whoever reaches the proxy.
const devLinkMint = process.env['PERPGUARD_WEB_DEV_LINK']?.trim() === '1' && process.env['NODE_ENV'] !== 'production';
if (devLinkMint) warn('PERPGUARD_WEB_DEV_LINK=1: web sign-in codes can be minted from localhost. Dev only.');
if (process.env['PERPGUARD_WEB_DEV_LINK']?.trim() === '1' && !devLinkMint) warn('PERPGUARD_WEB_DEV_LINK is set but ignored: NODE_ENV is production.');

// Wallet ownership on /link: a Sign-In with Ethereum challenge for this site
// and the TRADING network, verified here against that network (EOAs and
// smart-contract wallets alike). Proves ownership only; the API key executes.
const walletChallenger = new WalletChallenger({
  publicWebUrl: PUBLIC_WEB_URL,
  chainId: network.chainId,
  verifyMessage: (args) => createPublicClient({ transport: http(network.rpcUrl) }).verifyMessage(args),
});
// Demo mode: anyone may open a READ-ONLY session on the monitored account.
// For the judge-facing deployment of PerpGuard's own test account, and for
// nothing else — a real trader's deployment leaves it off.
const demoEnabled = process.env['PERPGUARD_DEMO_ACCOUNT']?.trim() === '1';
if (demoEnabled) warn('PERPGUARD_DEMO_ACCOUNT=1: anyone can open a read-only session on the monitored account.');

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

const activity = new AlertActivity({
  inner: innerLog,
  durable: alertDb !== undefined,
  ...(durableReason === undefined ? {} : { durableReason }),
  transportConfigured: botConfig !== undefined,
  ...(botConfig === undefined
    ? {
        transportReason:
          botConfigReason ??
          'no Telegram transport is wired, so any warning this process produces goes nowhere',
      }
    : {}),
});

// ── the account registry: one session per linked account ───────────────────
//
// The Telegram transport is built after the bot, and the bot after the
// registry (it routes to sessions), so the registry is handed a transport
// that forwards to whichever one exists by the time an alert is sent.
let transport: TelegramAlertTransport | undefined;
const telegramTransport: AlertTransport = {
  send: (recipient, message) =>
    transport === undefined
      ? Promise.resolve({ ok: false, reason: 'no Telegram transport is configured, so this alert has nowhere to go', retryable: false })
      : transport.send(recipient, message),
};

// ── the startup gate: a restart never says "I cannot see this position" ────
// Every alert from every engine — owner sessions and the watch tier — is held
// until each loop has completed a pass with nothing blind, then the startup
// blindness is dropped and every real severity delivered. Past the deadline
// it is an outage, not a restart, and everything held goes out as decided.
const STARTUP_GATE_DEADLINE_MS = Number(process.env['STARTUP_ALERT_HOLD_MS'] ?? 180_000);
const startupClean = (scope: string): boolean => {
  // Polled from boot, while later declarations may not exist yet: anything
  // not yet there is simply not clean yet.
  try {
    return startupCleanNow(scope);
  } catch {
    return false;
  }
};
/** One linked account's session has come up clean: signed in, positions live, assessed, nothing blind. */
const sessionClean = (session: { status(): { positions: { state: string }; assessing: boolean }; loop: { snapshot(): readonly { state: string }[] } }): boolean => {
  const status = session.status();
  if (status.positions.state !== 'live' || !status.assessing) return false;
  return !session.loop.snapshot().some((a) => a.state === 'FEED_DOWN' || a.state === 'POSITIONS_UNTRUSTED');
};
const watchClean = (): boolean => {
  if (!process.env['INDEXER_DATABASE_URL']?.trim()) return true;
  if (watchLoop?.lastRunAtMs === undefined || watchLoop.lastHealth?.serveAsCurrent !== true) return false;
  return !watchLoop.snapshot().some((a) => a.state === 'FEED_DOWN' || a.state === 'POSITIONS_UNTRUSTED');
};
/**
 * PER SCOPE (7 Oct 2026): an account's alerts wait for THAT account's session,
 * the watch tier's for the watch loop, never for everyone. Until then one
 * person's broken key held every user's alerts for the whole deadline.
 */
const startupCleanNow = (scope: string): boolean => {
  if (venue.feedStatus().state !== 'connected') return false;
  if (scope === 'watch') return watchClean();
  const account = /^account:(\d+)$/.exec(scope);
  if (account !== null) {
    const session = registry.get(Number(account[1]));
    return session !== undefined && sessionClean(session);
  }
  return registry.list().every(sessionClean) && watchClean();
};
const forwardingTransport = new StartupDeliveryGate({
  inner: telegramTransport,
  isClean: startupClean,
  deadlineMs: STARTUP_GATE_DEADLINE_MS,
  logger: { info: log, warn },
});
forwardingTransport.start();

/**
 * THE MANUAL ALERT SPEAKS FOR A CROSSING (Part 2): a linked account's own
 * WATCH and DANGER alerts, and a "recovered" from them, are not sent; past its
 * closing price, blindness and seeing again still are.
 */
const linkedAccountTransport: AlertTransport = {
  send: async (recipient, message) => {
    if (replacedByManualAlert(message)) return { ok: false, suppressed: true, reason: 'a crossing is said by the manual alert, once', retryable: false };
    return forwardingTransport.send(recipient, message);
  },
};

// ── each linked account's own settings ("Warn me at") ─────────────────────
// Loaded before the registry opens anything, so a session opens with its
// account's own thresholds; a change applies to the live loop at once.
const applySettings = (accountId: number, value: AccountSettings): void => {
  registry.get(accountId)?.loop.setThresholds(thresholdsFor(value.warnLevel));
  log(`[account ${accountId}] warn level set to ${value.warnLevel}`);
};
let accountSettings: AccountSettingsStore = new InMemoryAccountSettingsStore({ onChange: (id, v) => applySettings(id, v) });
if (alertDb !== undefined) {
  try {
    accountSettings = await PostgresAccountSettingsStore.load({ pool: alertDb, onChange: (id, v) => applySettings(id, v) });
    log('account settings loaded from Postgres');
  } catch (error) {
    warn(`account settings could not be loaded from Postgres (${error instanceof Error ? error.message : String(error)}); they are in memory until the next restart`);
  }
}

// ── 🛟 automation: state per account, Rescue rules and attempts ──────────────
// Postgres when there is one. Without it Rescue still runs, but its claims and
// counts live in memory, so it SAYS so: a restart would forget what was used.
let automation: AutomationStore = new InMemoryAutomationStore();
let rescueStore: RescueStore = new InMemoryRescueStore();
if (alertDb !== undefined) {
  try {
    automation = await PostgresAutomationStore.load(alertDb);
    rescueStore = await PostgresRescueStore.load(alertDb);
    log(`rescue: ${rescueStore.enabledRules().length} enabled rule(s) loaded from Postgres`);
  } catch (error) {
    warn(`rescue: automation state could not be loaded from Postgres (${error instanceof Error ? error.message : String(error)}); rules and attempts are in memory until the next restart`);
  }
} else {
  warn('rescue: no Postgres, so rules, attempts and the kill switch are in memory and a restart forgets them');
}

// MAINNET TRADING IS OFF unless switched on by name (owner, 6 Oct 2026: build
// network-aware, ship testnet-only). Monitoring and alerts run either way;
// with it off, no account session opens, so nothing can execute.
const MAINNET_TRADING = process.env['PERPGUARD_MAINNET_TRADING']?.trim() === '1';
const tradingOff =
  network.name === 'mainnet' && !MAINNET_TRADING
    ? 'Trading on mainnet is switched off for this deployment (PERPGUARD_MAINNET_TRADING is not set), so no account can execute here.'
    : undefined;
if (tradingOff !== undefined) warn(tradingOff);
const registry = new AccountRegistry({
  maxSessions: MAX_ACCOUNT_SESSIONS,
  ...(tradingOff === undefined ? {} : { tradingOff }),
  deps: {
    network,
    markets,
    riskConfigs,
    feed,
    feedStatus: () => venue.feedStatus(),
    actionLog,
    alertLog: activity,
    // A linked account's crossings are said by the MANUAL ALERT (Part 2), once,
    // with the amounts to add; this engine keeps "past its closing price" and
    // "I cannot see your positions" (and seeing them again).
    transport: linkedAccountTransport,
    // Whoever is linked to the account RIGHT NOW, with actions. Asked per
    // alert, so a link made after boot is honoured and an unlink is immediate.
    recipients: (accountId) => links.byAccountId(accountId).map((link) => ({ userId: link.userId, rights: 'act' as const })),
    venueFactory: (sessionCredentials) => new PerplVenue(network, { credentials: sessionCredentials, logger: { log, warn } }),
    evaluateIntervalMs: EVALUATE_INTERVAL_MS,
    thresholdsFor: (accountId) => thresholdsFor(accountSettings.get(accountId).warnLevel),
    logger: { info: log, warn },
    // The web page shows the steps as they happen; the bot's actions are
    // ignored by the tracker because it never started them.
    onProgress: (progress) => actionProgress.record(progress),
  },
});

// The environment key's account: the registry's first occupant. PERPL_ACCOUNT_ID
// names it, and the session tears itself down if the key signs in as anything
// else — a key for a different account than claimed is an isolation failure.
const envAccountId = credentials?.accountId;
if (credentials !== undefined && envAccountId === undefined) {
  warn('PERPL_API_KEY is set but PERPL_ACCOUNT_ID is not: the environment session needs to know which account it is for, so it is not opened. The process stays up and reports DEGRADED.');
}
if (credentials !== undefined && envAccountId !== undefined) {
  const opened = registry.open(envAccountId, { apiKey: credentials.apiKey, secret: credentials.secret });
  if (!opened.ok) warn(`environment session for account ${envAccountId} not opened: ${opened.reason}`);
}
const envSession = envAccountId === undefined ? undefined : registry.get(envAccountId);

// ── Top Traders and one trader's figures, for the bot's Watch screens ─────────
//
// From the analytics reader (bound further down; a tap can only arrive once
// the bot is polling, after everything is up). Kept a minute, so a busy chat
// cannot turn a leaderboard into a scan per tap. Top PnL is 30 days; Top ROI is
// ALL TIME (lifetime net PnL over lifetime deposits), named from the index's
// real start, which is the Exchange's deployment: "since Perpl launched".
/** The analytics reader, bound when the index is configured (section 7). Declared here so nothing can read it before it exists. */
let analyticsReader: PostgresAnalytics | undefined;
/** The analytics network's config (mainnet), bound in section 7; also names a wallet's account on it when linking. */
let analyticsNetworkConfig: NetworkConfig | undefined;
const TRADER_FIGURES_TTL_MS = 60_000;
const traderMemo = new Map<string, { readonly atMs: number; readonly value: Promise<unknown> }>();
function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = traderMemo.get(key);
  if (hit !== undefined && Date.now() - hit.atMs < TRADER_FIGURES_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  traderMemo.set(key, { atMs: Date.now(), value });
  value.catch(() => traderMemo.delete(key));
  if (traderMemo.size > 2_000) traderMemo.clear();
  return value;
}
/** Bound in section 7, with the analytics reader. */
let copyReplay: CopyReplayService | undefined;
const traderFigures = {
  copy: (accountId: number, followerEquityCNS: bigint, days: 7 | 30 = 30) => {
    if (copyReplay === undefined) return Promise.reject(new Error('no analytics'));
    return copyReplay.replay(accountId, followerEquityCNS, days);
  },
  activity: (accountId: number) => {
    if (copyReplay === undefined) return Promise.reject(new Error('no analytics'));
    return copyReplay.activity(accountId);
  },
  top: (kind: 'pnl' | 'roi') =>
    memo(`top:${kind}`, async () => {
      if (analyticsReader === undefined) throw new Error('no analytics');
      const list = kind === 'pnl' ? await analyticsReader.traders('30d', { ranking: 'pnl', limit: 10 }) : await analyticsReader.traders('all', { ranking: 'roi', limit: 10 });
      return { rows: list.rows, label: kind === 'pnl' ? `Net PnL over ${list.window.label}` : 'Since Perpl launched on 11 Feb 2026: the index starts at the Exchange\'s deployment' };
    }),
  stats: (accountId: number) =>
    memo(`stats:${accountId}`, async () => {
      if (analyticsReader === undefined) throw new Error('no analytics');
      const [month, lifetime] = await Promise.all([
        analyticsReader.traders('30d', { query: String(accountId), limit: 1 }),
        analyticsReader.traders('all', { query: String(accountId), limit: 1 }),
      ]);
      const mine = (rows: readonly TraderRow[]) => rows.find((r) => r.accountId === accountId);
      return { accountId, month: mine(month.rows), lifetime: mine(lifetime.rows) };
    }),
};

// Declared before the bot (whose deps close over it), set once the engine exists.
let killSwitch: KillSwitch | undefined;
let closeEverything: CloseEverything | undefined;

/**
 * One account's open positions for 🚪 Close everything: from the FULLY LOADED
 * list only (undefined otherwise: nothing is closed blind), sizes as exact
 * lots, P&L from that account's own risk loop when it can price it.
 */
const requireCloseEverything = (): CloseEverything => {
  if (closeEverything === undefined) throw new Error('close-everything is not wired yet');
  return closeEverything;
};
/** The backend's report, in the bot's terms. */
const toEmergencyReport = (r: Awaited<ReturnType<CloseEverything['closeAll']>>) =>
  r.kind === 'ran' ? { kind: 'ran' as const, results: r.verified.results, complete: r.verified.complete, replayed: r.replayed } : r;

const openPositionsOf = (accountId: number): OpenPosition[] | undefined => {
  const session = registry.get(accountId);
  if (session === undefined || session.view.positionsStatus().state !== 'live') return undefined;
  const assessed = session.view.snapshot();
  const out: OpenPosition[] = [];
  for (const p of session.positionSource.snapshot()) {
    const config = riskConfigs.get(p.marketId);
    if (config === undefined || p.positionId === undefined) return undefined;
    const exact = toReconcilable(p, config);
    const a = assessed.find((x) => x.marketId === p.marketId && x.positionId === p.positionId);
    const priced = a !== undefined && a.state !== 'FEED_DOWN' && a.state !== 'POSITIONS_UNTRUSTED';
    out.push({ marketId: p.marketId, symbol: p.symbol, positionId: p.positionId, side: p.side, sizeLNS: exact.sizeLNS, lotDecimals: config.lotDecimals, unrealisedPnlCNS: priced ? a.metrics.unrealisedPnlCNS : undefined });
  }
  return out;
};

// AUTO TOP-UP IS ARMED ONLY BY A TAP, signed with a key derived from the
// server's key (`rescue/arming.ts`). Without that key nothing can be armed.
let armSigner: ArmSigner | undefined;
if (keyEncryptionHex !== undefined && keyEncryptionHex !== '') {
  try {
    armSigner = new ArmSigner(keyEncryptionHex);
  } catch (error) {
    warn(`auto top-up: no arming key (${error instanceof Error ? error.message : String(error)}); nothing can be armed`);
  }
} else {
  warn('auto top-up: PERPGUARD_KEY_ENCRYPTION_KEY is not set, so nothing can be armed (manual alerts are unaffected)');
}
/** This Telegram user, in this chat, is linked to this account: the arming check, asked at the tap and at every judgement. */
const isLinkedHere = (telegramUserId: number, chatId: number, accountId: number): boolean => {
  const link = links.byTelegramUserId(telegramUserId);
  return link !== undefined && link.accountId === accountId && link.chatId === chatId;
};

const rescueControl = new RescueControlService({
  store: rescueStore,
  automation,
  collateralDecimals,
  signer: armSigner,
  isLinked: isLinkedHere,
  alertPctOf: (accountId) => accountSettings.get(accountId).alertPct,
  snapshot: (accountId) => registry.get(accountId)?.view.snapshot(),
  // The engine is built below; a turn-off only ever asks after both exist.
  busy: (ruleId: number): boolean => rescueEngine.busy(ruleId),
  log,
});

const bot =
  botConfig === undefined
    ? undefined
    : createBot({
        config: botConfig,
        log,
        links,
        store: pendingActions,
        sessions: registry,
        ...(envAccountId === undefined ? {} : { ownerAccountId: envAccountId }),
        configs: riskConfigs,
        tradingNetwork: network.name,
        amounts: pendingAmounts,
        identities,
        link: {
          mint: (id, name) => {
            if (linkServiceImpl === undefined) throw new Error('linking is not wired yet');
            return linkServiceImpl.mint(id, name);
          },
          unlink: (id) => (linkServiceImpl === undefined ? Promise.resolve({ ok: false, text: 'Linking is not available right now.' }) : linkServiceImpl.unlink(id)),
          needsRelink: (id) => linkServiceImpl?.needsRelink(id),
          status: (id) => linkServiceImpl?.status(id),
          walletProof: (id) => linkServiceImpl?.walletProof(id),
        },
        watch: {
          store: watchStore,
          resolver: watchResolver,
          limiter: new RateLimiter({ ...DEFAULT_RATE_LIMIT }),
          indexerHealth: () => watchLoop?.lastHealth,
          assessments: (accountId) => watchLoop?.snapshot(accountId) ?? [],
          facts: (accountId) => watchLoop?.accountFacts(accountId),
          configs: () => watchLoop?.marketConfigs,
          refresh: async () => watchLoop?.evaluate(),
          preferences: { get: (chatId) => preferences.get(chatId), set: (chatId, p) => preferences.set(chatId, p) },
          traders: traderFigures,
        },
        settings: accountSettings,
        rescue: rescueControl,
        emergency: {
          preview: (accountId) => openPositionsOf(accountId),
          closeAll: async (accountId, requestId, by) => toEmergencyReport(await requireCloseEverything().closeAll(accountId, requestId, by)),
          closeOne: async (accountId, marketId, requestId, by) => toEmergencyReport(await requireCloseEverything().closeOne(accountId, marketId, requestId, by)),
        },
        killSwitch: {
          stopped: (accountId) => automation.automationStopped(accountId),
          changedAtMs: (accountId) => killSwitch?.changedAtMs(accountId),
          stop: async (accountId, by) => {
            if (killSwitch === undefined) throw new Error('the kill switch is not wired yet');
            return killSwitch.stop(accountId, by);
          },
          resume: async (accountId, by) => {
            if (killSwitch === undefined) throw new Error('the kill switch is not wired yet');
            return killSwitch.resume(accountId, by);
          },
        },
        // Telegram refuses a URL button it cannot open, so a local-only
        // address is not offered as one.
        ...(/^https?:\/\/(localhost|127\.)/.test(PUBLIC_WEB_URL) ? {} : { webUrl: PUBLIC_WEB_URL }),
      });

transport =
  bot === undefined || botConfig === undefined
    ? undefined
    : new TelegramAlertTransport({
        api: bot.api,
        token: botConfig.token,
        links,
        store: pendingActions,
        // Availability is asked per account's venue by the bot; the transport
        // only needs it to decide whether buttons are live, and the shared
        // venue answers that from the same context.
        executor: { availability: (market) => venue.getActionAvailability(market), execute: async () => ({ kind: 'refused', detail: 'the transport never executes' }) },
        logger: { warn },
      });

// ── 🛟 the rescue engine: once a second, every enabled rule ─────────────────
// Sends through the account's OWN executor (lock, feed gate, forwarding
// pre-flight, action_log row, reconciliation on the position's margin). Its
// messages go to the chats linked to that account, with buttons only into
// that chat's own screens.
const rescueEngine = new RescueEngine({
  store: rescueStore,
  automation,
  armProblem: (rule) => rescueControl.armProblem(rule),
  account: (accountId) => {
    const session = registry.get(accountId);
    if (session === undefined) return undefined;
    return {
      snapshot: () => session.view.snapshot(),
      feedConnected: () => session.view.feedStatus().state === 'connected',
      // GONE ONLY ON PROOF: the ids of a FULLY LOADED list, or nothing at all.
      openPositionIds: () =>
        session.view.positionsStatus().state === 'live'
          ? new Set(session.positionSource.snapshot().flatMap((p) => (p.positionId === undefined ? [] : [p.positionId])))
          : undefined,
      availability: (market) => session.venue.getActionAvailability(market),
      freeFloorCNS: () => {
        const b = session.balance.freeBalance();
        return b.known ? b.floorCNS : undefined;
      },
      execute: (command) => session.executor.execute(command),
    };
  },
  notify: async (accountId, notice) => {
    const raw = renderRescue(notice, collateralDecimals);
    // THE NETWORK ON EVERY ACTION SCREEN: Rescue's messages are about money that moved, or will.
    const rendered = { ...raw, html: withBadge(raw.html, network.name) };
    const keyboard = rendered.buttons.map((b) => ({
      text: b.text,
      // Fresh: a rescue report is the record of what happened to someone's money, never edited away.
      callback_data: encodeNav(b.route === 'rescue' ? { to: 'rescue' } : b.route === 'position' ? { to: 'position', marketId: notice.rule.marketId } : { to: 'rescue-stop', marketId: notice.rule.marketId }, { fresh: true }),
    }));
    for (const link of links.byAccountId(accountId)) {
      if (bot === undefined) break;
      try {
        await bot.api.sendMessage(link.chatId, rendered.html, { parse_mode: 'HTML', ...(keyboard.length === 0 ? {} : { reply_markup: { inline_keyboard: [keyboard] } }) });
      } catch (error) {
        warn(`rescue: the ${notice.kind} message to chat ${link.chatId} did not go: ${classifyTelegramError(error, botConfig?.token ?? '').reason ?? 'Telegram refused it'}`);
      }
    }
    log(`rescue: told account ${accountId}'s ${links.byAccountId(accountId).length} chat(s): ${notice.kind} (rule ${notice.rule.id})`);
  },
  logger: { info: log, warn },
});
rescueEngine.start();

// ── 🔔 manual alerts: every linked account, at its alert distance ───────────
// One message per position per crossing (re-armed after a quarter-level
// recovery), remembered across restarts, held while blind. Amounts to add,
// each through the two-step confirm; or, with Auto armed, "adding now".
let manualState: ManualAlertStateStore = new InMemoryManualAlertState();
if (alertDb !== undefined) {
  try {
    manualState = await PostgresManualAlertState.load(alertDb);
  } catch (error) {
    warn(`manual alerts: crossings cannot be remembered in Postgres (${error instanceof Error ? error.message : String(error)}); a restart may repeat one`);
  }
}
const sendManualAlert =
  bot === undefined
    ? undefined
    : createManualAlertSender({ api: bot.api, store: pendingActions, links, sessions: registry, configs: riskConfigs, alerts: DEFAULT_ALERT_CONFIG, network: network.name });
const manualAlerts = new ManualAlerts({
  accounts: () =>
    registry.list().map((session) => ({
      accountId: session.accountId,
      positionsLive: () => session.view.positionsStatus().state === 'live',
      assessments: () => session.view.snapshot(),
    })),
  alertPctOf: (accountId) => accountSettings.get(accountId).alertPct,
  state: manualState,
  deliver: async (accountId, assessment, alertPct) => {
    if (sendManualAlert === undefined) return;
    await sendManualAlert({ accountId, assessment, alertPct, auto: rescueEngine.autoNow(accountId, assessment) });
  },
  logger: { info: log, warn },
});
manualAlerts.start();
log('manual alerts up: every linked account at its own alert distance, once per crossing');
// 🔴 THE KILL SWITCH: the persisted flag first, then every Rescue rule off and
// the mode to NONE. Database only: it works with no session at all.
killSwitch = new KillSwitch({ automation, rescueStore, rescueEngine, log });

// 🚪 CLOSE EVERYTHING: stops first, one run per account, each request once,
// closes one at a time through the account's own executor, and reads the
// outcome from the position list afterwards (`emergency/`).
let closeAllRuns: CloseAllRunStore = new InMemoryCloseAllRunStore();
if (alertDb !== undefined) {
  try {
    closeAllRuns = await PostgresCloseAllRunStore.load(alertDb);
  } catch (error) {
    warn(`close-everything: runs cannot be recorded in Postgres (${error instanceof Error ? error.message : String(error)}); the log lines are the record until the next restart`);
  }
}
closeEverything = new CloseEverything({
  killSwitch,
  account: (accountId) => {
    const session = registry.get(accountId);
    if (session === undefined) return undefined;
    return {
      openPositions: () => openPositionsOf(accountId),
      execute: (command) => session.executor.execute(command),
      exitPrice: (p) => session.venue.closedPositionExitPrice(p.marketId, p.positionId),
    };
  },
  store: closeAllRuns,
  log,
});

// ── the market list, re-read every 10 minutes ───────────────────────────────
// A maintenance margin Perpl changes while we run is applied in place and
// LOGGED, never discovered by a missed rescue (owner, 7 Oct 2026).
const MARKET_REFRESH_MS = 10 * 60_000;
const marketRefreshTimer = setInterval(() => {
  void venue
    .getRiskConfigs()
    .then((fresh) => {
      const changes = applyMarketRefresh(riskConfigs as Map<number, MarketRiskConfig>, fresh);
      for (const c of changes) (c.severity === 'warn' ? warn : log)(`markets: ${c.line}`);
    })
    .catch((error: unknown) => warn(`markets: the 10-minute re-read of the market list did not answer (${error instanceof Error ? error.message : String(error)}); keeping the last one`));
}, MARKET_REFRESH_MS);
marketRefreshTimer.unref();
log(`markets: re-read every ${MARKET_REFRESH_MS / 60_000} minutes; maintenance-margin changes are logged as warnings`);
log(`rescue engine up: ${rescueStore.enabledRules().length} enabled rule(s), judged every second`);

// ── linking: proof on the page, sessions in the registry ───────────────────
const linkService = new LinkService({
  codes: linkCodes,
  identities,
  links,
  keys: keyStore,
  vault,
  registry,
  // ONE sign-in to learn whose key it is, then closed; the registry opens the
  // socket that stays.
  probe: async (sealed) => {
    const probeVenue = new PerplVenue(network, { credentials: { apiKey: sealed.apiKey, secret: ApiSecret.fromHex(sealed.secretHex) } });
    try {
      const socket = await probeVenue.connectTrading();
      return { accountId: socket.accountId, forwardingAllowed: socket.forwardingAllowed };
    } finally {
      probeVenue.disconnect();
    }
  },
  lookupAccount: (address) => lookupAccountByAddress(address, { rpcUrl: network.rpcUrl, exchangeAddress: network.exchangeAddress }),
  proofs: walletProofs,
  // The analytics network (mainnet), asked only to NAME where a wallet's account is when the
  // trading network has none. Nothing is ever linked there: acting on it is switched off.
  lookupElsewhere: async (address) => {
    const other = analyticsNetworkConfig;
    if (other === undefined || other.chainId === network.chainId) return undefined;
    const found = await lookupAccountByAddress(address, { rpcUrl: other.rpcUrl, exchangeAddress: other.exchangeAddress });
    return found.found ? { network: other.name, accountId: found.accountId } : undefined;
  },
  secretFromHex: (hex) => ApiSecret.fromHex(hex),
  envAccountId,
  webUrl: PUBLIC_WEB_URL,
  network: network.name,
  ...(bot === undefined ? {} : { notify: async (chatId, text) => { await bot.api.sendMessage(chatId, text); } }),
  logger: { info: log, warn },
});
linkServiceImpl = linkService;
await linkService.reopenAll();

// ── 6b. the watch tier's alerts: the same engine, a recipient list per change ──
//
// Built after the loop exists (section 7 below assigns it), so it is a function
// of state rather than a second block of wiring: see `startWatchAlerts`.
let watchEngine: AlertEngine | undefined;
async function startWatchAlerts(): Promise<void> {
  if (watchLoop === undefined || analyticsVenue === undefined) return;
  const configs = await analyticsVenue.getRiskConfigs();
  watchEngine = new AlertEngine({
    source: watchLoop,
    configs,
    transport: forwardingTransport,
    log: activity,
    // Every chat following this account, each as a WATCH recipient: words, no
    // keyboard. The decision was already made per position above this line; a
    // subscription made in the last two minutes is spared first sights, which
    // its wallet screen has just shown.
    // ONLY "I cannot see it" and "I can see it again" now: crossing a distance
    // is each chat's own warning levels (events/watchWarnings.ts), and
    // sending both would warn twice about the same fall.
    recipients: (change) =>
      isBlind(change.assessment.state) || (change.previousState !== undefined && isBlind(change.previousState))
        ? watchRecipients(watchStore, change, Date.now()).filter((r) => r.chatId === undefined || preferences.get(r.chatId).walletAlerts)
        : [],
    logger: { error: warn, warn, info: log },
  });
  watchEngine.start();
  watchLoop.start(WATCH_INTERVAL_MS);
  log(`watch tier up: ${watchStore.accountIds().length} account(s) watched, re-assessed every ${WATCH_INTERVAL_MS}ms`);
}

// ── 7. the optional indexer lag probe ───────────────────────────────────────

const indexerUrl = process.env['INDEXER_DATABASE_URL']?.trim();
let indexerDb: Pool | undefined;
let indexerMonitor: IndexerLagMonitor | undefined;
let analyticsVenue: PerplVenue | undefined;
if (indexerUrl !== undefined && indexerUrl !== '') {
  // A pool, and NOT connected eagerly, for the same two reasons as the alert
  // log: a dead single client never recovers, and an indexer database that is
  // down is a degraded reading rather than a reason not to start. The probe
  // already turns any failure into a verdict.
  // SIX, not two. A page fires seven calls at once and each of the heavy ones
  // fans out into five parallel scans; with two connections every cheap call
  // queued behind the scans and a 20ms health read measured four seconds.
  indexerDb = new Pool({ connectionString: indexerUrl, max: 6 });
  indexerDb.on('error', (error) => {
    warn(`idle indexer Postgres connection dropped: ${error.message}. The pool will reconnect.`);
  });
  const analyticsNetwork = loadNetworkConfig(appConfig.analytics.name, process.env);
  analyticsNetworkConfig = analyticsNetwork;
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
    // The venue's own settlement interval, so an annualised rate is never off a hard-coded hour.
    fundingIntervalSec: (marketId) => analyticsMarkets.find((m) => m.marketId === marketId)?.fundingIntervalSec,
    // An INDEPENDENT chain head, so a halted indexer cannot report itself synced.
    // The same helper the lag monitor uses, so the two cannot disagree about the
    // head and then disagree about whether the indexer is healthy.
    chainHead: () => cachedChainHead(analyticsNetwork.rpcUrl),
    tvlProbe,
  });
  log(`analytics API ready on chain ${analyticsNetwork.chainId} (TVL via ${new URL(tvlRpcUrl).host})`);

  // 🔁 COPY REPLAY (Half A): the analytics network's index and marks, onto the
  // TRADING network's own markets. Read-only; nothing here can send.
  {
    const marksVenue = analyticsVenue;
    copyReplay = new CopyReplayService({
      source: analyticsReader,
      actingNetwork: network.name,
      actingMarkets: () => markets,
      marks: () => marksVenue.getOpenInterest(),
    });
  }

  // ── the watch tier's data: the index for positions, the venue for marks ──
  //
  // ONE NETWORK, the analytics one: positions from its index, marks and margin
  // configs from its venue, ownership from its Exchange contract. The resolver
  // is the same index-then-chain lookup the web's search uses.
  const reader = analyticsReader;
  const watchVenue = analyticsVenue;
  watchResolverImpl = createWatchResolver({
    analytics: reader,
    lookupOnChain: (address) => lookupAccountByAddress(address, { rpcUrl: analyticsNetwork.rpcUrl, exchangeAddress: analyticsNetwork.exchangeAddress }),
  });
  watchLoop = new WatchLoop({
    subscriptions: watchStore,
    profile: (accountId) => reader.walletByAccountId(accountId),
    health: () => reader.health(),
    marks: () => watchVenue.getOpenInterest(),
    configs: () => watchVenue.getRiskConfigs(),
    staleMs: appConfig.staleMs,
    onPositions: (pass) => {
      const failed = (what: string) => (error: unknown) => warn(`events: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      void positionChanges?.observe(pass).catch(failed('position changes'));
      void watchWarnings?.observe(pass).catch(failed('warning levels'));
    },
    logger: { info: log, warn },
  });
  fillDirections = new FillDirections({
    read: (txs) => positionEventsInTxs(txs, { rpcUrl: analyticsNetwork.rpcUrl, exchangeAddress: analyticsNetwork.exchangeAddress }),
  });
} else {
  log('INDEXER_DATABASE_URL is not set; indexer lag and the analytics API are both off');
}

// ── the event engine: one feed poller and the watch loop, fanned out per chat ──
//
// Liquidations and large taker orders from the index for every chat that has
// started the bot (by its thresholds), and watched wallets' position changes
// for their watchers. At most once per (event, chat), across restarts, by the
// ledger. Links only: an event alert never carries an action.
let eventEngine: EventEngine | undefined;
let feedPoller: FeedPoller | undefined;
let ledgerPrune: ReturnType<typeof setInterval> | undefined;
if (bot !== undefined && botConfig !== undefined && analyticsReader !== undefined) {
  const feed = analyticsReader;
  let ledger: InMemoryLedger | PostgresLedger = new InMemoryLedger();
  if (alertDb !== undefined) {
    try {
      ledger = await PostgresLedger.load(alertDb);
    } catch (error) {
      warn(`events: the delivery ledger could not be loaded from Postgres (${error instanceof Error ? error.message : String(error)}); deliveries are remembered in memory until the next restart`);
    }
  }
  const telegram = bot.api;
  const token = botConfig.token;
  const sender: ChatSender = {
    send: async (chatId, message) => {
      try {
        await telegram.sendMessage(chatId, message.html, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(message.links.length === 0 ? {} : { reply_markup: { inline_keyboard: [message.links.map((l) => ({ text: l.text, url: l.url }))] } }),
        });
        return { ok: true };
      } catch (error) {
        const result = classifyTelegramError(error, token);
        return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? 'Telegram refused it' };
      }
    },
  };
  eventEngine = new EventEngine({
    ledger,
    match: {
      watchersOf: (accountId) => watchStore.watchersOf(accountId).map((s) => s.chatId),
      feedChats: () => [...new Set(identities.list().map((i) => i.chatId))],
      preferencesFor: (chatId) => preferences.get(chatId),
    },
    sender,
    render: { webUrl: /^https?:\/\/(localhost|127\.)/.test(PUBLIC_WEB_URL) ? undefined : PUBLIC_WEB_URL, watchEveryMs: 30_000 },
    logger: { info: log, warn },
  });
  eventEngine.start();
  positionChanges = new PositionChanges(eventEngine);
  watchWarnings = new WatchWarnings({
    watchersOf: (accountId) => watchStore.watchersOf(accountId),
    preferencesFor: (chatId) => preferences.get(chatId),
    state: warningState,
    sender,
    render: { webUrl: /^https?:\/\/(localhost|127\.)/.test(PUBLIC_WEB_URL) ? undefined : PUBLIC_WEB_URL, watchEveryMs: 30_000 },
    logger: { warn },
  });
  feedPoller = new FeedPoller({
    feed,
    cursor: ledger,
    publisher: eventEngine,
    freshness: async () => {
      const h = await feed.health();
      return { indexerBlock: h.latestProcessedBlock, blocksBehind: h.blocksBehind };
    },
    direction: (txHash, accountId, marketId) => fillDirections?.directionOf(txHash, accountId, marketId) ?? Promise.resolve(undefined),
    minLargeTradeAusd: SMALLEST_LARGE_TRADE_AUSD,
    logger: { info: log, warn },
  });
  feedPoller.start();
  const ledgerRef = ledger;
  ledgerPrune = setInterval(() => void ledgerRef.prune(Date.now() - 14 * 24 * 60 * 60_000).catch((error) => warn(`events: pruning the delivery ledger failed: ${error instanceof Error ? error.message : String(error)}`)), 6 * 60 * 60_000);
  ledgerPrune.unref();
  log(`event engine up: liquidations and large trades from the index every 15s, watched wallets' changes every watch pass (${alertDb === undefined ? 'in memory' : 'ledger in Postgres'})`);
}

/**
 * The chain head, at most once per two seconds.
 *
 * Every analytics envelope wants the head to judge the indexer against, and a
 * page asks for seven envelopes at once; seven RPC round trips for one block
 * number is what the floor on every response was made of.
 */
let chainHeadMemo: { readonly atMs: number; readonly value: Promise<number | undefined> } | undefined;
function cachedChainHead(rpcUrl: string): Promise<number | undefined> {
  const atMs = Date.now();
  if (chainHeadMemo !== undefined && atMs - chainHeadMemo.atMs < 2_000) return chainHeadMemo.value;
  chainHeadMemo = { atMs, value: fetchChainHead(rpcUrl) };
  return chainHeadMemo.value;
}

/**
 * The analytics answer cache, owned here so it can be warmed before the first
 * visitor and kept warm: the default views are recomputed every KEEP_WARM_MS
 * along with whatever else has been read lately, one at a time so the scans
 * never pile up on the two cores the indexer is also using.
 */
const analyticsCache = new SwrCache({
  onRefreshError: (key, error) => warn(`analytics cache: refresh of ${key} failed, serving the previous answer: ${error instanceof Error ? error.message : String(error)}`),
});
const KEEP_WARM_MS = intFromEnv('ANALYTICS_KEEP_WARM_MS', 60_000);

// ── 8. the health report, buildable before anything is ready ────────────────

let botUsername: string | undefined;

const health = (): HealthReport => {
  const primary = envSession?.status();
  return buildHealth({
    network: network.name,
    startedAtMs,
    nowMs: Date.now(),
    feed: venue.feedStatus(),
    positions: primary?.positions ?? {
      state: 'awaiting-snapshot',
      reason: envAccountId === undefined ? 'no environment account session is configured' : `the session for account ${envAccountId} is not running`,
      lastUpdateMs: undefined,
      ageMs: undefined,
    },
    assessments: envSession?.loop.snapshot() ?? [],
    trading: primary?.trading ?? { state: 'not-configured', reason: 'no Perpl API credentials with a PERPL_ACCOUNT_ID were supplied, so there is no environment account to watch', attempt: 0 },
    alerts: activity.status(),
    indexer: indexerMonitor?.health(),
    assessing: primary?.assessing ?? false,
    sessions: registry.statuses(),
  });
};

// THE PROTOCOL TREASURY'S MOVEMENTS, kept current: an incremental scan of the
// analytics network's Exchange every 15 minutes (and once now), stored in the
// backend's Postgres, seeded once from the committed one-off scan. Needs the
// index for the reconciliation, so it runs only beside the analytics API.
const treasuryScanner =
  analyticsReader === undefined || analyticsNetworkConfig === undefined
    ? undefined
    : (() => {
        const seedFile = process.env.PROTOCOL_FLOWS_FILE?.trim() || fileURLToPath(new URL('../../../fixtures/protocol-flows-mainnet.json', import.meta.url));
        const seed = () => readScanFile(seedFile);
        const reader = analyticsReader;
        return new TreasuryScanner({
          store: alertDb === undefined ? new LazySeededMemoryStore(seed) : new PostgresTreasuryStore(alertDb, seed),
          rpc: { rpcUrl: analyticsNetworkConfig.rpcUrl, exchangeAddress: analyticsNetworkConfig.exchangeAddress },
          collateralAtIndexHead: () => reader.collateralTotalsAtIndexHead(),
          log,
          warn,
        });
      })();
treasuryScanner?.start();

const app = createHealthApp({
  health,
  ...(copyReplay === undefined ? {} : { copyReplay: { service: copyReplay, collateralDecimals: analyticsNetworkConfig?.collateralDecimals ?? 6 } }),
  // The Protect API is bound to the ENVIRONMENT account's session. No page
  // calls it any more (the web is public and read-only), but the routes stay
  // for the bot-code flow; without an environment session there is nothing
  // for them to serve, so they are not mounted.
  ...(envSession === undefined || envAccountId === undefined ? {} : { protect: {
    userId,
    view: {
      network: envSession.loop.network,
      snapshot: () => envSession.loop.snapshot(),
      feedStatus: () => venue.feedStatus(),
      positionsStatus: () => envSession.loop.positionsStatus(),
      projectAddMargin: (marketId, amountCNS) => envSession.loop.projectAddMargin(marketId, amountCNS),
      sightedBook: () => envSession.loop.sightedBook(),
      positions: () => envSession.positionSource.snapshot(),
      thresholds: () => envSession.loop.thresholds,
    },
    configs: riskConfigs,
    sessions: webSessions,
    linkCodes: protectCodes,
    pending: webPending,
    progress: actionProgress,
    freeBalance: () => envSession.balance.freeBalance(),
    availability: (market) => envSession.venue.getActionAvailability(market),
    inFlightOn: (marketId) => envSession.executor.inFlightOn(marketId),
    runner: envSession.executor,
    accountId: () => envSession.trading.status().accountId,
    forwardingAllowed: () => envSession.trading.status().forwardingAllowed,
    // The Alerts page: history from the same log the engine writes, delivery
    // counts from the same decorator /health reads, cooldowns from the engine.
    // Chat ids stay in the link store; only "linked since" leaves it.
    alertsView: {
      recent: (id, limit) => innerLog.recent(id, limit),
      status: () => activity.status(),
      linkedAtMs: (id) => links.byUserId(id)?.linkedAtMs,
      botUsername: () => botUsername,
      historyFor: (marketId) => envSession.engine.historyFor(marketId, envAccountId),
    },
    devLinkMint,
    demoEnabled,
    logger: { info: log, warn },
  } }),
  // The linking page's API: the one session in the web app.
  link: {
    service: linkService,
    wallet: walletChallenger,
    logger: { info: log },
    network: network.name,
    ...(envAccountId === undefined ? {} : { envAccountId }),
    keyStorageConfigured: vault !== undefined,
    // 👁 WATCH IT INSTEAD: a mainnet account the page's signed wallet owns, watched read-only in the person's chat.
    watchInstead: async (identity, accountId) => {
      const added = watchStore.add({ chatId: identity.chatId, accountId, label: `#${accountId} (your wallet)`, addedAtMs: Date.now() });
      if (!added.ok) return { ok: false, text: added.text };
      const text =
        `👁 Watching your mainnet account #${accountId}, read-only.\n` +
        `You'll get alerts here as its positions near liquidation, open and close. ` +
        `There are no buttons: PerpGuard's actions run on testnet only for now.`;
      if (bot !== undefined) await bot.api.sendMessage(identity.chatId, text).catch(() => undefined);
      void watchLoop?.evaluate().catch(() => undefined);
      return { ok: true, text: added.already ? `Already watching #${accountId} in your Telegram chat.` : `Watching #${accountId} in your Telegram chat. Alerts are read-only.` };
    },
  },
  // Mounted only when the indexer database is configured. A backend that refused
  // to serve alerts because Postgres was unreachable would have the priorities
  // exactly backwards; /health reports the degradation instead.
  ...(analyticsReader === undefined ? {} : { analytics: analyticsReader, analyticsCache }),
  // The treasury's in/out per day, from the incremental scan's own state.
  ...(treasuryScanner === undefined ? {} : { protocolTreasuryDays: async () => treasuryDaysOf(treasuryScanner.movements(), treasuryScanner.status()) }),
  // WALLET -> ACCOUNT OFF THE CHAIN, on the analytics network: the same
  // `getAccountByAddr` read Protect sign-in uses, so an address the index never
  // saw an AccountCreated for still resolves.
  ...(analyticsNetworkConfig === undefined
    ? {}
    : {
        lookupAccountOnChain: (wallet: string) =>
          lookupAccountByAddress(wallet, { rpcUrl: analyticsNetworkConfig!.rpcUrl, exchangeAddress: analyticsNetworkConfig!.exchangeAddress }),
      }),
  // The open-interest LEVEL is a venue read on the analytics network; the
  // indexer only has the delta. Kept off the reader so the two cannot be confused.
  ...(analyticsVenue === undefined || analyticsReader === undefined || analyticsNetworkConfig === undefined
    ? {}
    : {
        openInterest: () => analyticsVenue!.getOpenInterest(),
        // ONE NETWORK: positions from the analytics indexer, marks and configs
        // from the analytics venue, insurance from the analytics chain.
        riskSnapshot: (() => {
          // Owners for the Risk tables: the index's, else the Exchange contract's, kept for the process's life.
          const owners = new OwnerDirectory({
            fromIndex: (ids) => analyticsReader.knownOwners(ids),
            fromChain: (id) => lookupAccountOwner(id, { rpcUrl: analyticsNetworkConfig!.rpcUrl, exchangeAddress: analyticsNetworkConfig!.exchangeAddress }),
          });
          const source = new RiskSnapshotSource({
            analytics: analyticsReader,
            network: analyticsNetworkConfig,
            riskConfigs: () => analyticsVenue!.getRiskConfigs(),
            openInterest: () => analyticsVenue!.getOpenInterest(),
            owners: (ids) => owners.ownersOf(ids),
          });
          return () => source.read();
        })(),
        // Other venues' funding against Perpl's live markets: Perpl's tickers
        // and marks from the analytics venue, the rest from the store, which
        // calls Hyperliquid and Binance from here and only while read.
        venueFunding: (() => {
          const store = new VenueFundingStore({
            fetchers: { hyperliquid: () => fetchHyperliquidFunding(), binance: (tickers) => fetchBinanceFunding(tickers) },
            onError: (venue, error) => warn(`venue funding: ${venue} read failed: ${describeFetchError(error)}`),
          });
          return async () => {
            const markets = await analyticsVenue!.getOpenInterest();
            return buildVenueFundingPayload(markets, await store.read(markets.map((m) => m.symbol)));
          };
        })(),
        // What each fill did to its position, from its transaction's receipt on the analytics network.
        fillDirections: fillDirections!,
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

/** Profiles kept warm (hotProfiles.ts): the busiest, the default leaderboard's top, every watched account. */
const BUSIEST_PROFILES_WARMED = 10;
const LEADERBOARD_PROFILES_WARMED = 50;
/** Under the cache's 30-minute idle eviction, so a warmed profile is never more than this old. */
const HOT_PROFILE_INTERVAL_MS = 20 * 60_000;

const shutdown = new ShutdownSequence({
  deadlineMs: SHUTDOWN_TIMEOUT_MS,
  onStep: (step) =>
    step.ok
      ? log(`shutdown: ${step.name} (${step.ms}ms)`)
      : warn(`shutdown: ${step.name} FAILED after ${step.ms}ms: ${step.error}`),
});

let indexerTimer: ReturnType<typeof setInterval> | undefined;
let warmTimer: ReturnType<typeof setInterval> | undefined;
let profileTimer: ReturnType<typeof setInterval> | undefined;

shutdown
  // Stop producing work first. Everything below is then draining a queue that
  // cannot grow, rather than racing one that still can.
  .add('stop the watch loop and timers', () => {
    rescueEngine.stop();
    manualAlerts.stop();
    clearInterval(marketRefreshTimer);
    treasuryScanner?.stop();
    watchLoop?.stop();
    feedPoller?.stop();
    eventEngine?.stop();
    if (ledgerPrune !== undefined) clearInterval(ledgerPrune);
    if (indexerTimer !== undefined) clearInterval(indexerTimer);
    if (warmTimer !== undefined) clearInterval(warmTimer);
    if (profileTimer !== undefined) clearInterval(profileTimer);
  })
  .add('stop the bot', async () => {
    await bot?.stop();
  })
  // Before the sockets close, and before the process exits. A half-sent DANGER
  // alert on restart is worse than a late one.
  .add('drain watch alert deliveries', async () => {
    watchEngine?.stop();
    await watchEngine?.drain();
  })
  // A rescue already sent is reconciled before its session's socket closes: never left unknown by a restart.
  .add('settle rescues in flight', async () => {
    await Promise.race([rescueEngine.settle(), new Promise<void>((r) => setTimeout(r, 30_000))]);
  })
  // Each session stops its loop, drains its alerts and closes its socket.
  .add('close account sessions', () => registry.closeAll())
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

// ── 11. the sessions are already connecting; open the gate ──────────────────

// ── the analytics cache: warm before the first visitor, keep warm after ─────
//
// SEQUENTIAL, and never overlapping: one warm cycle at a time, one entry at a
// time. The scans behind these answers are what saturated the box when a page
// asked for them all at once, and a warmer that did the same would be the same
// problem on a timer. The hot set is whatever was read in the last ten minutes,
// so a profile someone is watching stays warm and one nobody opened does not
// cost anything.
if (analyticsReader !== undefined) {
  const reader = analyticsReader;
  const defaults = defaultWarmEntries(reader);
  const loaderFor = new Map(defaults.map((entry) => [entry.key, entry.load]));
  let warming = false;
  const profileWarmer = new ProfileWarmer({
    sources: {
      busiest: () => reader.busiestAccounts(BUSIEST_PROFILES_WARMED),
      leaderboard: async () => (await reader.traders('30d', { ranking: 'pnl', limit: LEADERBOARD_PROFILES_WARMED })).rows.map((r) => r.accountId),
      watched: () => watchStore.accountIds(),
    },
    warm: async (id) => {
      const profile = analyticsLoaders(reader).profile(id);
      await analyticsCache.warm(profile.key, profile.load);
    },
    stopped: () => shutdown.started,
  });
  const warmCycle = async (): Promise<void> => {
    if (warming || shutdown.started) return;
    warming = true;
    const startedAt = Date.now();
    let warmed = 0;
    try {
      const hot = new Set([...defaults.map((e) => e.key), ...analyticsCache.recentlyRead(10 * 60_000)]);
      for (const key of hot) {
        if (shutdown.started) break;
        const load = loaderFor.get(key);
        // Only the defaults have a loader here; everything else is kept warm by
        // its readers through stale-while-revalidate on the route.
        if (load === undefined) continue;
        try {
          await analyticsCache.warm(key, load);
          warmed += 1;
        } catch (error) {
          warn(`analytics warm: ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      warming = false;
    }
    if (warmed > 0) log(`analytics cache: ${warmed} answer(s) warm in ${Date.now() - startedAt}ms`);
  };
  // The cross-account leverage baseline (a ~7 s scan of every position) is
  // warmed ONCE, after the first cycle and never beside it; its hour-long TTL on
  // the insights route keeps it fresh behind readers from then on.
  void warmCycle().then(async () => {
    const baseline = analyticsLoaders(reader).leverageBaseline();
    // A reader may already have started it behind an early insights request.
    if (analyticsCache.ageOf(baseline.key) === undefined) {
      try {
        await analyticsCache.warm(baseline.key, baseline.load);
      } catch (error) {
        warn(`analytics warm: ${baseline.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // The hot profiles (hotProfiles.ts), one at a time, then every 20 minutes
    // so none is ever more than that old for the first reader: account #10's
    // takes ~19 s cold, and Compare, the profile and its positions all wait on it.
    const started = Date.now();
    const warmed = await profileWarmer.run();
    log(`analytics warm: ${String(warmed)} hot profile(s) in ${Date.now() - started}ms`);
  });
  profileTimer = setInterval(() => void profileWarmer.run(), HOT_PROFILE_INTERVAL_MS);
  profileTimer.unref();
  warmTimer = setInterval(() => void warmCycle(), KEEP_WARM_MS);
  warmTimer.unref();
}

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
    (envSession === undefined || envSession.positionSource.status().state === 'live') && venue.feedStatus().state === 'connected',
  timeoutMs: READINESS_TIMEOUT_MS,
});

if (readiness.ready) {
  log(`ready after ${readiness.waitedMs}ms; assessing`);
} else {
  // Not a failure. With no position set there is nothing to assess, so the loop
  // is silent either way, and the health endpoint is what says why.
  warn(
    `still not ready after ${readiness.waitedMs}ms (positions: ` +
      `${envSession?.positionSource.status().state ?? 'no session'}, feed: ${venue.feedStatus().state}). ` +
      `Starting anyway and reporting DEGRADED; nothing will be assessed until ` +
      `both are up.`,
  );
}

void startWatchAlerts().catch((error: unknown) => warn(`watch tier did not start: ${error instanceof Error ? error.message : String(error)}`));


if (bot !== undefined) {
  // Long polling. `start` does not resolve until the bot stops, so it is not
  // awaited; a failure to reach Telegram must not take the process down.
  void bot
    .start({
      onStart: (info) => {
        botUsername = info.username;
        log(`telegram bot @${info.username} polling`);
        // THE MENU TEACHES THE FAST WAY. Only the commands that are quicker
        // typed than tapped are listed; everything else is a button.
        void bot.api
          .setMyCommands(BOT_MENU_COMMANDS)
          .then(() => log(`telegram command menu set: ${BOT_MENU_COMMANDS.map((c) => `/${c.command}`).join(' ')}`))
          .catch((error: unknown) => warn(`telegram command menu not set: ${error instanceof Error ? error.message : String(error)}`));
      },
    })
    .catch((error: unknown) => {
      warn(`telegram polling stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
}

log(`up in ${Date.now() - startedAtMs}ms; status ${health().status}`);
