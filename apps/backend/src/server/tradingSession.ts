/**
 * The authenticated session, connected in the background and retried forever.
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
  #attempt = 0;
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
   * Called once, on the first successful sign-in.
   *
   * The position source and the risk loop are built from the socket, so they
   * cannot exist until it does. Registered rather than awaited so a sign-in that
   * never happens does not block startup.
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
      try {
        const socket = await this.#venue.connectTrading();
        this.#socket = socket;
        this.#state = 'signed-in';
        this.#reason = undefined;
        this.#loggedReason = undefined;
        this.#logger.info(
          `signed in: account ${socket.accountId ?? 'unknown'}, ` +
            `forwarding ${socket.forwardingAllowed ?? 'unknown'}, ` +
            `frozen ${socket.accountFrozen}`,
        );
        await this.#onSignedIn?.(socket);
        return;
      } catch (error) {
        // Never `error` itself, and never anything derived from the key: an
        // error object can carry a request that quotes a header.
        this.#state = 'retrying';
        this.#reason = `sign-in failed: ${describe(error)}`;
        this.#logOnce(this.#reason);
        if (this.#stopped) return;
        await this.#sleep(this.#backoffFor(this.#attempt));
      }
    }
  }

  #backoffFor(attempt: number): number {
    if (this.#backoffMs.length === 0) return 0;
    return this.#backoffMs[Math.min(attempt - 1, this.#backoffMs.length - 1)]!;
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

  get startedAtMs(): number {
    return this.#now();
  }
}
