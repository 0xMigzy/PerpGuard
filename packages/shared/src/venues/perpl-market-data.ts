/**
 * The public Perpl market-data websocket.
 * https://docs.perpl.xyz/resources/for-developers/api/websocket.md
 *
 * Unauthenticated, so there is no sign-in and nothing here can move funds.
 * Its one job is to keep a price stream alive: subscribe, decode `mt: 9`
 * MarketStateUpdate frames into PriceUpdate, and — unlike the trading socket —
 * reconnect on its own when the connection drops.
 *
 * Reconnection lives here rather than in PerplSocketConnection on purpose. A
 * price feed that silently re-establishes itself is exactly what you want; a
 * trading socket that does the same would re-sign and reset its `rq`
 * high-water mark underneath an in-flight order. Same transport, opposite
 * policy.
 *
 * Two details from the docs shape the design:
 *   - `market-state@<chainId>` carries EVERY market on the chain in one frame,
 *     keyed by market id. So this socket tracks all of them and lets callers
 *     filter; opening one connection per symbol would burn the documented
 *     5-connections-per-IP budget for nothing.
 *   - the heartbeat's `sn` is strictly +1. A gap means frames were dropped and
 *     our prices may be silently wrong, so we resubscribe to get a fresh
 *     snapshot rather than carrying on with a stale view.
 */
import type { NetworkConfig } from '../config.ts';
import { scaledToNumber } from '../units.ts';
import { MarketStateSchema } from './perpl-context.ts';
import { MT } from './perpl-orders.ts';
import {
  PerplSocketConnection,
  isRecord,
  numberAt,
  silentLogger,
  type InboundMessage,
  type Logger,
} from './perpl-socket.ts';
import type { PriceUpdate, VenueMarket } from './types.ts';

const VENUE_ID = 'perpl' as const;

const DEFAULT_PING_INTERVAL_MS = 30_000;
/**
 * How long a connection must survive before it counts as healthy and the
 * backoff resets.
 *
 * Without this, a server that accepts and immediately drops us — which is what
 * the documented rate limit looks like — would reset the delay to its base on
 * every attempt and we would hammer it forever.
 */
const DEFAULT_STABLE_AFTER_MS = 10_000;

/** Exponential backoff, bounded. Defaults chosen for the documented limits. */
export interface BackoffPolicy {
  /** Delay before the first retry. */
  readonly baseMs: number;
  /** Ceiling. Reconnection never waits longer than this. */
  readonly maxMs: number;
  readonly factor: number;
  /**
   * Fraction of each delay that is randomised away, 0..1. Applied downward
   * only, so the ceiling stays a real ceiling.
   */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

/**
 * Delay before retry number `attempt` (1-based). Pure, so the schedule can be
 * asserted in tests instead of waited out.
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const step = Math.max(1, Math.floor(attempt));
  const raw = policy.baseMs * policy.factor ** (step - 1);
  // ** grows fast enough to reach Infinity for a long outage; min() first.
  const capped = Math.min(raw, policy.maxMs);
  const reduction = capped * policy.jitter * random();
  return Math.max(0, Math.round(capped - reduction));
}

/** What the socket needs about a market to decode and label its prices. */
export interface MarketDescriptor {
  readonly marketId: number;
  readonly symbol: string;
  readonly priceDecimals: number;
}

export function toMarketDescriptor(market: VenueMarket): MarketDescriptor {
  return {
    marketId: market.marketId,
    symbol: market.symbol,
    priceDecimals: market.priceDecimals,
  };
}

/** Connection-level events, for logging and for showing feed health in the UI. */
export type FeedStatus =
  | { readonly kind: 'connected'; readonly attempt: number }
  | { readonly kind: 'subscribed'; readonly reason: 'connect' | 'sequence-gap' }
  | { readonly kind: 'disconnected'; readonly error: Error; readonly retryInMs: number; readonly attempt: number }
  | { readonly kind: 'closed' };

export interface MarketDataSocketOptions {
  readonly network: NetworkConfig;
  /**
   * Every market to decode, from GET /v1/pub/context. Market ids and price
   * scaling differ per network and are never hard-coded.
   */
  readonly markets: readonly MarketDescriptor[];
  readonly logger?: Logger;
  readonly verbose?: boolean;
  readonly pingIntervalMs?: number;
  readonly backoff?: Partial<BackoffPolicy>;
  readonly stableAfterMs?: number;
  readonly now?: () => number;
  /** Injectable so the backoff schedule is testable. */
  readonly random?: () => number;
  /** Injectable for tests. Defaults to the global WebSocket Node ships. */
  readonly webSocketImpl?: typeof WebSocket;
}

export class PerplMarketDataSocket {
  readonly #options: MarketDataSocketOptions;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #backoff: BackoffPolicy;
  readonly #stableAfterMs: number;
  readonly #markets = new Map<number, MarketDescriptor>();

  readonly #priceListeners = new Set<(update: PriceUpdate) => void>();
  readonly #statusListeners = new Set<(status: FeedStatus) => void>();
  /** The most recent update per market id — the per-market lastUpdate stamp. */
  readonly #latest = new Map<number, PriceUpdate>();

  #conn: PerplSocketConnection | undefined;
  #started = false;
  #stopped = false;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;
  #headBlock: number | undefined;
  #lastSn: number | undefined;

  constructor(options: MarketDataSocketOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.#stableAfterMs = options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
    for (const market of options.markets) this.#markets.set(market.marketId, market);
  }

  get connected(): boolean {
    return this.#conn?.isOpen === true;
  }

  /** Latest head block from the heartbeat, if one has arrived. */
  get headBlock(): number | undefined {
    return this.#headBlock;
  }

  /** How many consecutive reconnect attempts have failed. 0 when healthy. */
  get reconnectAttempt(): number {
    return this.#attempt;
  }

  /** The most recent price for a market, or undefined if none has arrived. */
  lastUpdate(marketId: number): PriceUpdate | undefined {
    return this.#latest.get(marketId);
  }

  /** When we received the most recent price for a market. */
  lastUpdateAtMs(marketId: number): number | undefined {
    return this.#latest.get(marketId)?.receivedAtMs;
  }

  /** Every price seen so far, newest per market. */
  snapshot(): PriceUpdate[] {
    return [...this.#latest.values()];
  }

  onPrice(listener: (update: PriceUpdate) => void): () => void {
    this.#priceListeners.add(listener);
    return () => this.#priceListeners.delete(listener);
  }

  onStatus(listener: (status: FeedStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /**
   * Connect and subscribe, then stay connected.
   *
   * The FIRST attempt is awaited and throws on failure, so a bad URL or an
   * unreachable venue is a startup error rather than a feed that quietly never
   * produces anything. Every drop after that is handled internally, with
   * backoff, and never throws at the caller.
   */
  async start(): Promise<void> {
    if (this.#stopped) throw new Error('market-data socket has been closed');
    if (this.#started) return;
    await this.#connectOnce();
  }

  /** Stop for good. Cancels any pending reconnect; start() will not resume. */
  close(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearTimers();
    this.#conn?.close('market-data socket closed locally');
    this.#conn = undefined;
    this.#emitStatus({ kind: 'closed' });
  }

  async #connectOnce(): Promise<void> {
    const options = this.#options;
    const conn = new PerplSocketConnection({
      venueId: VENUE_ID,
      url: options.network.marketDataWsUrl,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.webSocketImpl === undefined ? {} : { webSocketImpl: options.webSocketImpl }),
    });
    this.#conn = conn;

    conn.onMessage((message) => this.#onFrame(message));
    conn.onClose((error) => this.#onDisconnected(error));

    await conn.open();
    conn.startPing(options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);

    // Only now: a failed first open must not leave a reconnect loop running
    // behind a start() that threw.
    this.#started = true;
    this.#emitStatus({ kind: 'connected', attempt: this.#attempt });
    this.#subscribe('connect');

    // The backoff resets only once this connection has proved it survives.
    this.#stableTimer = setTimeout(() => {
      this.#attempt = 0;
    }, this.#stableAfterMs);
    this.#stableTimer.unref?.();
  }

  /**
   * (Re)send the subscription set. Sent on every connect, and again after a
   * heartbeat sequence gap to pull a fresh snapshot.
   */
  #subscribe(reason: 'connect' | 'sequence-gap'): void {
    const chainId = this.#options.network.chainId;
    this.#conn?.send({
      mt: MT.SubscriptionRequest,
      subs: [
        { stream: `market-state@${chainId}`, subscribe: true },
        { stream: `heartbeat@${chainId}`, subscribe: true },
      ],
    });
    this.#emitStatus({ kind: 'subscribed', reason });
  }

  #onDisconnected(error: Error): void {
    // A close during the very first connect is reported by start() throwing.
    if (!this.#started || this.#stopped) return;
    if (this.#stableTimer !== undefined) clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
    if (this.#reconnectTimer !== undefined) return;

    this.#attempt += 1;
    const retryInMs = backoffDelayMs(this.#attempt, this.#backoff, this.#random);
    this.#emitStatus({ kind: 'disconnected', error, retryInMs, attempt: this.#attempt });
    this.#logger.warn(
      `market data disconnected (${error.message}); reconnecting in ${retryInMs}ms ` +
        `(attempt ${this.#attempt})`,
    );

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#reconnect();
    }, retryInMs);
    this.#reconnectTimer.unref?.();
  }

  async #reconnect(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.#connectOnce();
    } catch (error) {
      // The failed connection's own close already scheduled the next attempt.
      // Only step in if it did not — a constructor that throws outright, say —
      // so the feed can never end up waiting on a retry nobody scheduled.
      if (this.#conn?.closed !== true) {
        this.#onDisconnected(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #clearTimers(): void {
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    if (this.#stableTimer !== undefined) clearTimeout(this.#stableTimer);
    this.#reconnectTimer = undefined;
    this.#stableTimer = undefined;
  }

  #emitStatus(status: FeedStatus): void {
    for (const listener of this.#statusListeners) listener(status);
  }

  #onFrame(message: InboundMessage): void {
    const mt = message['mt'];
    if (mt === MT.MarketStateUpdate) {
      this.#onMarketState(message);
      return;
    }
    if (mt === MT.Heartbeat) {
      this.#onHeartbeat(message);
    }
  }

  /**
   * The heartbeat's `sn` is strictly +1. A gap means frames were dropped, so
   * the prices we hold may be silently wrong — resubscribe for a fresh
   * snapshot rather than trusting what we have.
   */
  #onHeartbeat(message: InboundMessage): void {
    this.#headBlock = numberAt(message, 'h') ?? this.#headBlock;

    const sn = numberAt(message, 'sn');
    if (sn === undefined) return;
    const previous = this.#lastSn;
    this.#lastSn = sn;
    if (previous === undefined || sn === previous + 1) return;

    this.#logger.warn(
      `market-data heartbeat gap: expected sn ${previous + 1}, got ${sn}. Resubscribing for a ` +
        `fresh snapshot; prices between those points were missed.`,
    );
    this.#subscribe('sequence-gap');
  }

  /**
   * `mt: 9` carries every market on the chain, keyed by market id, with all
   * prices as integers scaled by that market's own price_decimals.
   */
  #onMarketState(message: InboundMessage): void {
    const d = message['d'];
    if (!isRecord(d)) return;
    const receivedAtMs = this.#now();

    for (const [key, raw] of Object.entries(d)) {
      const marketId = Number(key);
      if (!Number.isInteger(marketId)) continue;

      const descriptor = this.#markets.get(marketId);
      // Every market on the chain arrives in this frame, including ones the
      // context did not list. Nothing to scale them by, so skip them.
      if (descriptor === undefined) continue;

      const parsed = MarketStateSchema.safeParse(raw);
      if (!parsed.success) {
        this.#logger.warn(
          `ignoring an unreadable market-state entry for ${descriptor.symbol} (market ${marketId})`,
        );
        continue;
      }

      const state = parsed.data;
      const decimals = descriptor.priceDecimals;
      const update: PriceUpdate = {
        venue: VENUE_ID,
        network: this.#options.network.name,
        symbol: descriptor.symbol,
        marketId,
        markPrice: scaledToNumber(state.mrk, decimals),
        oraclePrice: scaledToNumber(state.orl, decimals),
        midPrice: scaledToNumber(state.mid, decimals),
        bid: scaledToNumber(state.bid, decimals),
        ask: scaledToNumber(state.ask, decimals),
        atBlock: state.at.b,
        // `at.t` is already milliseconds on the wire.
        atMs: state.at.t,
        receivedAtMs,
      };

      this.#latest.set(marketId, update);
      for (const listener of this.#priceListeners) listener(update);
    }
  }
}
