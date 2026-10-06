/**
 * One account's live session: its socket, its positions, its risk loop, its
 * alerts, its executor. Nothing in it can see another account's.
 *
 * This is the unit the registry creates when a user links and tears down when
 * they unlink. It is exactly the set of singletons the backend used to hold
 * for the one environment account, moved behind one object with one account
 * id, so that "a session must never read, assess or act on any account but its
 * own" is a property of construction rather than of care:
 *
 *   - the VENUE is this session's, built from this session's credentials, so
 *     its trading socket signs in as this account and nothing else;
 *   - the POSITION SOURCE reads that socket, so it holds this account's rows;
 *   - the RISK LOOP assesses that source and stamps every assessment with
 *     this account id, so alert history and alert keys are scoped to it;
 *   - the EXECUTOR reconciles against that source, acts through that venue,
 *     holds its own in-flight registry, and REFUSES a command naming any
 *     other account before a lease is taken;
 *   - the ALERT ENGINE delivers to whoever is linked to THIS account.
 *
 * Shared across sessions, and safe to share: the market feed and market
 * configs, which are facts about the venue rather than about an account; the
 * action and alert logs, which record the account on every row; and the
 * Telegram transport, which addresses recipients the engine names.
 *
 * THE SOCKET MUST SIGN IN AS THE ACCOUNT IT WAS OPENED FOR. The registry keys
 * sessions by the account the user linked; the venue tells us which account
 * the key actually signs for. If they differ, the session reports a mismatch
 * and asks to be torn down: a key for a different account than claimed is an
 * isolation failure, not a detail.
 */
import {
  PerplPositionSource,
  type FeedHealth,
  type MarketRiskConfig,
  type NetworkConfig,
  type PerplVenue,
  type Unsubscribe,
  type VenueMarket,
} from '@perpguard/shared';
import { freeBalanceFrom, type AccountView, type FreeBalanceView, type RiskView } from '@perpguard/bot';
import { VenueActionExecutor } from '@perpguard/bot';
import { ActionsExecutor, LoopPositionReader, type ActionLog } from '../actions/index.ts';
import type { ActionProgress } from '../actions/executor.ts';
import { AlertEngine } from '../alerts/engine.ts';
import type { AlertLog, AlertRecipient, AlertTransport } from '../alerts/types.ts';
import type { MarketFeed } from '../ingest/marketFeed.ts';
import { RiskLoop } from '../risk/loop.ts';
import type { MarketConfigs, RiskAssessment, RiskThresholds } from '../risk/types.ts';
import { DeferredPositionSource } from '../server/deferredPositionSource.ts';
import type { PositionSourceStatus } from '@perpguard/shared';
import type { TradingSessionStatus } from '../server/health.ts';
import { TradingSession } from '../server/tradingSession.ts';

export interface SessionCredentials {
  readonly apiKey: string;
  readonly secret: import('@perpguard/shared').ApiSecret;
}

/** Everything a session needs that is NOT its own: shared, account-agnostic. */
export interface SessionDeps {
  readonly network: NetworkConfig;
  readonly markets: readonly VenueMarket[];
  readonly riskConfigs: MarketConfigs;
  readonly feed: MarketFeed;
  readonly feedStatus: () => FeedHealth;
  readonly actionLog: ActionLog;
  readonly alertLog: AlertLog;
  readonly transport: AlertTransport;
  /** Who is linked to an account right now, asked per alert. */
  readonly recipients: (accountId: number) => readonly AlertRecipient[];
  /** Builds the venue for one account's credentials. The venue owns the socket. */
  readonly venueFactory: (credentials: SessionCredentials) => PerplVenue;
  readonly evaluateIntervalMs: number;
  readonly thresholds?: Partial<RiskThresholds>;
  /** This account's own thresholds (its "Warn me at"), applied when the session opens. */
  readonly thresholdsFor?: (accountId: number) => Partial<RiskThresholds> | undefined;
  readonly logger: { info(message: string): void; warn(message: string): void };
  readonly onProgress?: (progress: ActionProgress) => void;
  readonly now?: () => number;
  /** Trading-session backoff and sleep, injectable so tests do not wait. */
  readonly backoffMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  /** Executor timings, injectable for tests. */
  readonly settleTimeoutMs?: number;
  readonly venueTimeoutMs?: number;
}

export interface SessionStatus {
  readonly accountId: number;
  readonly trading: TradingSessionStatus;
  readonly positions: PositionSourceStatus;
  /** Whether the loop has run at least once with a live position set. */
  readonly assessing: boolean;
  readonly tracked: number;
  /** Set when the key signed in as a different account than this session is for. */
  readonly mismatch?: string;
}

export class AccountSession {
  readonly accountId: number;
  readonly #deps: SessionDeps;
  readonly venue: PerplVenue;
  readonly trading: TradingSession;
  readonly positionSource: DeferredPositionSource;
  readonly loop: RiskLoop;
  readonly engine: AlertEngine;
  readonly executor: ActionsExecutor;
  readonly balance: FreeBalanceView;
  readonly view: RiskView;
  readonly #log = (line: string): void => this.#deps.logger.info(`[account ${this.accountId}] ${line}`);
  readonly #warn = (line: string): void => this.#deps.logger.warn(`[account ${this.accountId}] ${line}`);
  #attached: PerplPositionSource | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #assessing = false;
  #mismatch: string | undefined;
  #onMismatch: ((reason: string) => void) | undefined;
  #stopped = false;
  #unsubscribeLoop: Unsubscribe | undefined;

  constructor(accountId: number, credentials: SessionCredentials, deps: SessionDeps) {
    this.accountId = accountId;
    this.#deps = deps;
    const { network, markets, riskConfigs, feed, feedStatus } = deps;

    this.venue = deps.venueFactory(credentials);

    this.trading = new TradingSession({
      venue: this.venue,
      network,
      apiKey: credentials.apiKey,
      logger: { info: this.#log, warn: this.#warn },
      ...(deps.backoffMs === undefined ? {} : { backoffMs: deps.backoffMs }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });

    this.positionSource = new DeferredPositionSource({
      reason: () => {
        if (this.#mismatch !== undefined) return this.#mismatch;
        const status = this.trading.status();
        return status.reason ?? `the trading session is ${status.state}, so we have not been told what is open`;
      },
    });

    // Rebuilt on EVERY sign-in: a reconnect brings a new socket, and a source
    // still reading the dead one would hold a frozen set forever.
    this.trading.onSignedIn(async (socket) => {
      if (socket.accountId !== undefined && socket.accountId !== accountId) {
        // The key signs for somebody else. Say so, stop, and ask to be removed:
        // nothing from this socket may be attributed to the account we were
        // opened for.
        this.#mismatch =
          `the API key signed in as account ${socket.accountId}, not account ${accountId}. ` +
          `This session is being torn down; nothing from that socket is attributed to account ${accountId}.`;
        this.#warn(this.#mismatch);
        this.#onMismatch?.(this.#mismatch);
        return;
      }
      const collateral = await this.venue.getCollateralToken();
      const source = new PerplPositionSource({
        socket,
        network: network.name,
        markets: new Map(markets.map((m) => [m.marketId, m])),
        collateralDecimals: collateral.decimals,
        onSkippedMarket: (marketId) => this.#warn(`skipping a position on market ${marketId}: the context does not list it`),
      });
      this.#attached?.stop();
      this.#attached = source;
      source.start();
      this.positionSource.attach(source);
      this.#log(`position source attached (collateral ${collateral.symbol}, ${collateral.decimals} dp)`);
    });

    this.loop = new RiskLoop({
      network: network.name,
      feed,
      positions: this.positionSource,
      feedStatus,
      configs: riskConfigs,
      accountId,
      ...(deps.thresholds === undefined ? {} : { thresholds: deps.thresholds }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    // The account's own "Warn me at", remembered across restarts.
    const own = deps.thresholdsFor?.(accountId);
    if (own !== undefined) this.loop.setThresholds(own);

    this.engine = new AlertEngine({
      source: this.loop,
      configs: riskConfigs,
      transport: deps.transport,
      log: deps.alertLog,
      recipients: () => deps.recipients(accountId),
      logger: { error: this.#warn, warn: this.#warn, info: this.#log },
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });

    this.executor = new ActionsExecutor({
      venue: this.venue,
      accountId,
      positions: new LoopPositionReader({
        source: this.positionSource,
        configs: riskConfigs,
        onAmbiguous: (marketId, count) => this.#warn(`${count} positions on market ${marketId}: refusing to reconcile an action against either`),
        onUnscalable: (marketId) => this.#warn(`no market config for ${marketId}: cannot read its margin as exact integers`),
      }),
      // The SHARED feed's gate: refused when the feed is not connected, never
      // because a price is merely old. One feed, one truth, every account.
      prices: { canAct: (marketId) => feed.canAct(marketId, feedStatus()) },
      log: deps.actionLog,
      logger: { info: this.#log, warn: this.#warn },
      ...(deps.onProgress === undefined ? {} : { onProgress: deps.onProgress }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.settleTimeoutMs === undefined ? {} : { settleTimeoutMs: deps.settleTimeoutMs }),
      ...(deps.venueTimeoutMs === undefined ? {} : { venueTimeoutMs: deps.venueTimeoutMs }),
    });

    this.balance = freeBalanceFrom(() => this.venue.freeBalanceFloorCNS());

    this.view = {
      network: this.loop.network,
      snapshot: () => this.loop.snapshot(),
      feedStatus,
      positionsStatus: () => this.loop.positionsStatus(),
      projectAddMargin: (marketId, amountCNS) => this.loop.projectAddMargin(marketId, amountCNS),
    };
  }

  /** What the bot routes to for this account. */
  get accountView(): AccountView {
    return {
      accountId: this.accountId,
      view: this.view,
      executor: new VenueActionExecutor({
        runner: this.executor,
        availability: (market) => this.venue.getActionAvailability(market),
      }),
      balance: this.balance,
      status: () => {
        const s = this.status();
        return { trading: s.trading, ...(s.mismatch === undefined ? {} : { mismatch: s.mismatch }) };
      },
    };
  }

  /** Called when the key turns out to sign for another account. The registry closes the session. */
  onMismatch(listener: (reason: string) => void): void {
    this.#onMismatch = listener;
  }

  start(): void {
    if (this.#stopped) throw new Error(`session for account ${this.accountId} was stopped and cannot be restarted`);
    this.trading.start();
    this.loop.start();
    this.engine.start();
    this.#unsubscribeLoop = this.positionSource.onSnapshot(() => {
      if (this.positionSource.status().state === 'live') this.#assessing = true;
    });
    // The loop re-evaluates on position updates only; a price that moves a
    // position into DANGER arrives on the shared feed.
    this.#timer = setInterval(() => this.loop.evaluate(), this.#deps.evaluateIntervalMs);
    this.#timer.unref?.();
  }

  /** Stop producing, drain what was queued, close the socket. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribeLoop?.();
    this.loop.stop();
    this.engine.stop();
    await this.engine.drain();
    this.#attached?.stop();
    this.positionSource.stop();
    await this.trading.stop();
    this.venue.disconnect();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  status(): SessionStatus {
    const tracked: readonly RiskAssessment[] = this.loop.snapshot();
    return {
      accountId: this.accountId,
      trading: this.trading.status(),
      positions: this.positionSource.status(),
      assessing: this.#assessing,
      tracked: tracked.length,
      ...(this.#mismatch === undefined ? {} : { mismatch: this.#mismatch }),
    };
  }
}

export type { MarketRiskConfig };
