/**
 * The transport half of a Perpl websocket, shared by both sockets we open.
 * https://docs.perpl.xyz/resources/for-developers/api/websocket.md
 *
 * Perpl speaks the same framing on the authenticated trading socket and the
 * public market-data one: JSON frames tagged with `mt`, an `mt: 1` ping to
 * keep the connection alive, and close codes that mean specific things. Only
 * that framing lives here. What the frames MEAN is the caller's business —
 * PerplTradingSocket tracks orders, PerplMarketDataSocket tracks prices, and
 * neither concern belongs in the pipe they share.
 *
 * Reconnect is deliberately NOT here, even though only one of the two callers
 * would misuse it. Re-opening the trading socket silently would re-sign, reset
 * `sn` and re-derive the `rq` high-water mark underneath an in-flight
 * submission, turning an unknown outcome into a blind retry — exactly what the
 * cancel rule in CLAUDE.md forbids. Reconnection is a policy the market-data
 * socket opts into, not a property of the transport.
 */
import { VenueAuthError, VenueRequestError } from '../errors.ts';
import { MT } from './perpl-orders.ts';

/** Close code the server uses when the signed sign-in frame is rejected. */
export const CLOSE_AUTH_FAILURE = 3401;
/** Close code when the server could not process a frame at all. */
export const CLOSE_FAILED_TO_PROCESS = 1011;

/** Enough to hold the post-sign-in snapshots plus a burst of updates. */
const DEFAULT_HISTORY_LIMIT = 200;

export interface Logger {
  log: (message: string) => void;
  warn: (message: string) => void;
}

export const silentLogger: Logger = { log: () => {}, warn: () => {} };

/** Any inbound frame, already parsed. */
export type InboundMessage = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function numberAt(node: Record<string, unknown>, key: string): number | undefined {
  const value = node[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * An `Amount` field — which the wire sends as a DECIMAL STRING of the token's
 * own micros — as an exact bigint.
 *
 * NEVER `Number()`. The docs say so and money maths in this repo is
 * integer-only; a balance large enough to matter is exactly the one a float
 * would round. Anything that is not an integer string is `undefined` rather
 * than a guess: a balance we cannot parse must read as "unknown", never as 0,
 * because 0 would be reported as a real figure.
 */
export function amountAt(node: Record<string, unknown>, key: string): bigint | undefined {
  const value = node[key];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? BigInt(trimmed) : undefined;
}

export interface SocketConnectionOptions {
  readonly venueId: string;
  readonly url: string;
  readonly logger?: Logger;
  /** Dump every inbound frame. Never includes anything derived from a key. */
  readonly verbose?: boolean;
  readonly historyLimit?: number;
  /**
   * Extra diagnosis appended to a 1011 close, which means only "the server
   * could not process a frame". What that implies is caller-specific — on the
   * trading socket it is usually an unknown market or an account the key does
   * not own — so the transport does not guess.
   */
  readonly failedToProcessHint?: string;
  /**
   * Give up on an unfinished handshake after this long. 0 (the default) waits
   * for the OS, which on a blackholed route means minutes of SYN retries.
   * Anything that reconnects should set it, so a dead attempt fails fast and
   * the retry policy — not the TCP stack — decides when to try again.
   */
  readonly connectTimeoutMs?: number;
  readonly now?: () => number;
  /** Injectable for tests. Defaults to the global WebSocket Node ships. */
  readonly webSocketImpl?: typeof WebSocket;
}

/**
 * One websocket connection: open it, send frames, receive parsed frames, keep
 * it alive, and turn a close into a typed error exactly once.
 *
 * Single-use. Once closed it stays closed; a caller that wants another
 * connection constructs another instance, which is what makes reconnection a
 * visible decision rather than a hidden one.
 */
export class PerplSocketConnection {
  readonly #options: SocketConnectionOptions;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #historyLimit: number;

  #ws: WebSocket | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #closeReason: Error | undefined;

  readonly #listeners = new Set<(message: InboundMessage) => void>();
  readonly #closeWaiters = new Set<(error: Error) => void>();
  /**
   * A bounded record of what has already arrived.
   *
   * The snapshots that matter most are pushed immediately after sign-in, which
   * is before connect() has even returned, so anything that subscribes
   * afterwards would otherwise never see them.
   */
  readonly #history: InboundMessage[] = [];

  constructor(options: SocketConnectionOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  get url(): string {
    return this.#options.url;
  }

  /** True only while the socket is open and usable for sending. */
  get isOpen(): boolean {
    return !this.#closed && this.#ws?.readyState === 1;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Why the connection ended, once it has. */
  get closeReason(): Error | undefined {
    return this.#closeReason;
  }

  /** Frames already received, oldest first, capped at the history limit. */
  get recentMessages(): readonly InboundMessage[] {
    return this.#history;
  }

  /** Observe every inbound frame. Returns an unsubscribe function. */
  onMessage(listener: (message: InboundMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Observe the close, whenever it comes. Fires exactly once, and immediately
   * if the connection has already closed — a late subscriber must not wait
   * forever for an event it just missed.
   */
  onClose(listener: (error: Error) => void): () => void {
    if (this.#closed) {
      listener(this.#closeReason ?? this.#closeError(0, 'already closed'));
      return () => {};
    }
    this.#closeWaiters.add(listener);
    return () => this.#closeWaiters.delete(listener);
  }

  /**
   * Open the socket and resolve once the handshake completes.
   *
   * Frame handlers are attached before the open is awaited: a frame that
   * arrives in the same turn as `open` must not fall between the two.
   */
  async open(): Promise<void> {
    const url = this.#options.url;
    const WebSocketImpl = this.#options.webSocketImpl ?? globalThis.WebSocket;
    if (WebSocketImpl === undefined) {
      throw new VenueRequestError(
        this.#options.venueId,
        url,
        'no WebSocket implementation available',
      );
    }

    const ws = new WebSocketImpl(url);
    this.#ws = ws;

    ws.addEventListener('message', (event: MessageEvent) => this.#onFrame(event.data));
    ws.addEventListener('close', (event: CloseEvent) => {
      this.#onClosed(this.#closeError(event.code, event.reason));
    });
    ws.addEventListener('error', () => {
      this.#onClosed(new VenueRequestError(this.#options.venueId, url, 'websocket error'));
    });

    const connectTimeoutMs = this.#options.connectTimeoutMs ?? 0;

    await new Promise<void>((resolve, reject) => {
      const settle = (action: () => void): void => {
        if (timer !== undefined) clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        this.#closeWaiters.delete(onClosedDuringHandshake);
        action();
      };
      const onOpen = (): void => settle(resolve);
      const onClosedDuringHandshake = (error: Error): void => settle(() => reject(error));

      // close() routes through #onClosed, so the timeout rejects this promise
      // AND tells everyone watching the connection — one path, not two.
      const timer =
        connectTimeoutMs > 0
          ? setTimeout(() => {
              this.close(`handshake did not complete within ${connectTimeoutMs}ms`);
            }, connectTimeoutMs)
          : undefined;
      // Deliberately not unref'd: a real socket keeps the loop alive through
      // its own handshake anyway, and the timer is always cleared on settle.

      ws.addEventListener('open', onOpen);
      this.#closeWaiters.add(onClosedDuringHandshake);
    });
  }

  /**
   * Start the keep-alive ping. Called after any frame that has to come first
   * on the socket — on the trading socket the signed sign-in frame does.
   */
  startPing(intervalMs: number): void {
    this.stopPing();
    this.#pingTimer = setInterval(() => {
      if (this.isOpen) this.send({ mt: MT.Ping, t: this.#now() });
    }, intervalMs);
    this.#pingTimer.unref?.();
  }

  stopPing(): void {
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
  }

  send(frame: unknown): void {
    this.#ws?.send(JSON.stringify(frame));
  }

  /** Close locally. Idempotent, and never throws. */
  close(message = 'socket closed locally'): void {
    this.#onClosed(new VenueRequestError(this.#options.venueId, this.#options.url, message));
    try {
      this.#ws?.close();
    } catch {
      // Already closing; nothing to do.
    }
  }

  #closeError(code: number, reason: string): Error {
    const detail = reason === '' ? '' : ` (${reason})`;
    if (code === CLOSE_AUTH_FAILURE) {
      return new VenueAuthError(
        this.#options.venueId,
        `sign-in rejected, close ${code}${detail}. Check the key, its scope, and that the ` +
          `clock is within 30s of the server.`,
        { closeCode: code },
      );
    }
    if (code === CLOSE_FAILED_TO_PROCESS) {
      const hint = this.#options.failedToProcessHint;
      return new VenueRequestError(
        this.#options.venueId,
        this.#options.url,
        `socket closed with ${code}${detail} — the server could not process a frame` +
          `${hint === undefined ? '.' : `. ${hint}`}`,
      );
    }
    return new VenueRequestError(
      this.#options.venueId,
      this.#options.url,
      `socket closed with ${code}${detail}`,
    );
  }

  #onClosed(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = error;
    this.stopPing();
    for (const waiter of [...this.#closeWaiters]) waiter(error);
    this.#closeWaiters.clear();
  }

  #onFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.#logger.warn(`ignoring a frame that is not JSON (${data.length} bytes)`);
      return;
    }
    if (!isRecord(message)) return;

    if (this.#options.verbose === true) this.#logger.log(`<- ${data}`);

    this.#history.push(message);
    if (this.#history.length > this.#historyLimit) this.#history.shift();

    for (const listener of this.#listeners) listener(message);
  }
}
