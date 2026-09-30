/**
 * The authenticated session, connected in the background and retried forever —
 * BEFORE the first sign-in and AFTER every drop.
 *
 * THE SOCKET IS SINGLE-USE; THE SESSION IS NOT. A trading socket that closes
 * (1006 from the venue, a stall the watchdog caught, anything) is replaced by
 * a fresh one through `venue.connectTrading()`, which reads the account's
 * `lfr` off the new WalletSnapshot. Between the drop and the new sign-in the
 * session reports `retrying` with the close reason, so /health and the pages
 * say the positions are frozen rather than looking healthy. Nothing in flight
 * is retried across the gap: the close failed it, and the caller reconciles.
 *
 * IT NEVER EXITS THE PROCESS AND NEVER THROWS AT THE CALLER. A trading socket
 * that cannot sign in is a reason to report DEGRADED, not a reason to take down
 * the price feed and the health endpoint with it — the moment we can no longer
 * see an account is exactly the moment somebody needs to be able to ask why.
 *
 * THE REASON IS LOGGED ONCE, NOT PER RETRY. A socket retrying every few seconds
 * against a revoked key would otherwise fill a log with the same line until the
 * one different line that mattered was impossible to find. A changed reason logs
 * again; an unchanged one does not.
 *
 * NOTHING DERIVED FROM THE KEY IS EVER LOGGED. The API key is rendered only
 * through `maskApiKey`, the ed25519 secret is wrapped in `ApiSecret` and never
 * stringified, and the reason strings below come from close codes and error
 * messages, never from the credentials.
 */
import {
  maskApiKey,
  type NetworkConfig,
  type PerplTradingSocket,
  type PerplVenue,
} from '@perpguard/shared';
import type { TradingSessionStatus } from './health.ts';

export interface TradingSessionOptions {
  readonly venue: PerplVenue;
  readonly network: NetworkConfig;
  /** Present only so it can be masked into the first log line. */
  readonly apiKey: string | undefined;
  readonly logger?: { info(message: string): void; warn(message: string): void };
  /** Backoff between attempts, in ms. The last value repeats forever. */
  readonly backoffMs?: readonly number[];
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class TradingSession {
  readonly #venue: PerplVenue;
  readonly #network: NetworkConfig;
  readonly #apiKey: string | undefined;
  readonly #logger: { info(message: string): void; warn(message: string): void };
  readonly #backoffMs: readonly number[];
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  #socket: PerplTradingSocket | undefined;
  /** Every connect ever tried, for /health. */
  #attempt = 0;
  /** Failures since the last sign-in, which is what the backoff steps on. */
  #failuresInARow = 0;
  #signIns = 0;
  #state: TradingSessionStatus['state'];
  #reason: string | undefined;
  /** The last reason actually written to the log, so repeats stay silent. */
  #loggedReason: string | undefined;
  #stopped = false;
  #onSignedIn: ((socket: PerplTradingSocket) => void | Promise<void>) | undefined;

  constructor(options: TradingSessionOptions) {
    this.#venue = options.venue;
    this.#network = options.network;
    this.#apiKey = options.apiKey;
    this.#logger = options.logger ?? {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
    };
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.#state = this.#apiKey === undefined ? 'not-configured' : 'connecting';
    if (this.#apiKey === undefined) {
      this.#reason =
        'no Perpl API credentials were supplied (PERPL_API_KEY / PERPL_API_KEY_SECRET), ' +
        'so there is no account to watch';
    }
  }

  get socket(): PerplTradingSocket | undefined {
    return this.#socket;
  }

  /**
   * Called on EVERY successful sign-in: the first, and each reconnect after a
   * drop, with the new socket.
   *
   * The position source is built from the socket, so it cannot exist until
   * the socket does and must be rebuilt when the socket is replaced — a
   * source still pointed at the dead socket would hold a frozen set forever.
   * Registered rather than awaited so a sign-in that never happens does not
   * block startup.
   */
  onSignedIn(listener: (socket: PerplTradingSocket) => void | Promise<void>): void {
    this.#onSignedIn = listener;
  }

  status(): TradingSessionStatus {
    const socket = this.#socket;
    return {
      state: this.#state,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
      attempt: this.#attempt,
      ...(socket?.accountId === undefined ? {} : { accountId: socket.accountId }),
      ...(socket?.forwardingAllowed === undefined
        ? {}
        : { forwardingAllowed: socket.forwardingAllowed }),
    };
  }

  /** Start connecting. Returns immediately; the retry loop runs in the background. */
  start(): void {
    if (this.#state === 'not-configured') {
      // NOT the retry message. Nothing is being retried — there is nothing to
      // retry with — and saying otherwise would have someone waiting for a
      // connection that will never be attempted.
      this.#logger.warn(
        `${this.#reason ?? 'no credentials'}. The process stays up and reports DEGRADED; ` +
          `the price feed and /health are unaffected.`,
      );
      return;
    }
    this.#logger.info(
      `signing in to Perpl ${this.#network.name} (chain ${this.#network.chainId}) with key ` +
        `${maskApiKey(this.#apiKey ?? '')}`,
    );
    void this.#loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#socket?.close();
    this.#socket = undefined;
  }

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      this.#attempt += 1;
      let socket: PerplTradingSocket;
      try {
        socket = await this.#venue.connectTrading();
      } catch (error) {
        // Never `error` itself, and never anything derived from the key: an
        // error object can carry a request that quotes a header.
        this.#failuresInARow += 1;
        this.#state = 'retrying';
        this.#reason = `sign-in failed: ${describe(error)}`;
        this.#logOnce(this.#reason);
        if (this.#stopped) return;
        await this.#sleep(this.#backoffFor(this.#failuresInARow));
        continue;
      }

      this.#socket = socket;
      this.#state = 'signed-in';
      this.#reason = undefined;
      this.#loggedReason = undefined;
      this.#failuresInARow = 0;
      this.#signIns += 1;
      this.#logger.info(
        `${this.#signIns === 1 ? 'signed in' : `signed in again (sign-in ${this.#signIns})`}: ` +
          `account ${socket.accountId ?? 'unknown'}, ` +
          `forwarding ${socket.forwardingAllowed ?? 'unknown'}, ` +
          `frozen ${socket.accountFrozen}`,
      );
      await this.#onSignedIn?.(socket);

      // Stay signed in until the socket goes. A stop() closes it too, which is
      // how this wait ends on shutdown.
      const closeReason = await new Promise<string>((resolve) => {
        socket.onClose((error) => resolve(describe(error)));
      });
      if (this.#stopped) return;
      this.#failuresInARow += 1;
      this.#state = 'retrying';
      this.#reason = `the trading socket closed (${closeReason}); signing in again`;
      this.#logOnce(this.#reason);
      await this.#sleep(this.#backoffFor(this.#failuresInARow));
    }
  }

  #backoffFor(failures: number): number {
    if (this.#backoffMs.length === 0) return 0;
    return this.#backoffMs[Math.min(Math.max(failures, 1) - 1, this.#backoffMs.length - 1)]!;
  }

  /** Log a reason only when it differs from the last one written. */
  #logOnce(reason: string): void {
    if (this.#loggedReason === reason) return;
    this.#loggedReason = reason;
    this.#logger.warn(
      `${reason}. The process stays up, reports DEGRADED and keeps retrying; ` +
        `the price feed and /health are unaffected. (retrying quietly from here)`,
    );
  }

  /** Exposed for tests: when the retry loop has settled. */
  get attempts(): number {
    return this.#attempt;
  }

  /** How many times a socket has signed in, reconnects included. */
  get signIns(): number {
    return this.#signIns;
  }

  get startedAtMs(): number {
    return this.#now();
  }
}
