/**
 * The authenticated Perpl trading websocket.
 * https://docs.perpl.xyz/resources/for-developers/api/websocket.md
 *
 * Responsibilities, deliberately narrow: connect, sign in as the first frame,
 * keep the connection alive, track the few pieces of session state a
 * submission needs (account id, last forwarded request id, head block), and
 * carry one request from submission through to its real outcome.
 *
 * What it explicitly does NOT do is decide what any of that means — frames are
 * built and statuses decoded in perpl-orders.ts, which is pure and tested.
 *
 * The two-stage result is the whole point. `mt: 3` with `code: 0` means
 * accepted for forwarding: not posted, not filled. Only `mt: 24` carries the
 * outcome, so submit() resolves on `mt: 24` and reports `mt: 3` through a
 * callback that cannot be mistaken for completion.
 */
import type { NetworkConfig } from '../config.ts';
import { ActionTimeoutError, VenueAuthError, VenueRequestError } from '../errors.ts';
import { buildApiKeySignInFrame, type ApiSecret } from './perpl-signing.ts';
import {
  COMMAND_STATUS_SID,
  MT,
  classifyOrderUpdate,
  describeOrderStatus,
  isDefinitiveStatus,
  type OrderIntent,
  type OrderOutcome,
  type OrderRequestFrame,
  type OrderUpdateEntry,
} from './perpl-orders.ts';

export type { OrderUpdateEntry };

const VENUE_ID = 'perpl';

/** Close code the server uses when the signed sign-in frame is rejected. */
const CLOSE_AUTH_FAILURE = 3401;
/** Close code when the server could not process a frame at all. */
const CLOSE_FAILED_TO_PROCESS = 1011;

const DEFAULT_SIGN_IN_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_RESULT_TIMEOUT_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** Enough to hold the post-sign-in snapshots plus a burst of updates. */
const HISTORY_LIMIT = 200;

export interface Logger {
  log: (message: string) => void;
  warn: (message: string) => void;
}

const silentLogger: Logger = { log: () => {}, warn: () => {} };

/** Any inbound frame, already parsed. */
export type InboundMessage = Record<string, unknown>;

/** The `mt: 3` command status. */
export interface CommandStatus {
  readonly cid: number | undefined;
  readonly code: number;
  readonly error: string;
}

export interface SubmitOptions {
  readonly frame: OrderRequestFrame;
  readonly intent: OrderIntent;
  /** Carried into ActionTimeoutError so a timeout can be reconciled later. */
  readonly idempotencyKey: string;
  /**
   * Decides whether an `mt: 24` entry belongs to this request. Supplied by the
   * caller because the correlation rule differs between placing and cancelling.
   */
  readonly matches: (order: OrderUpdateEntry) => boolean;
  readonly onForwarded?: (status: CommandStatus) => void;
  readonly ackTimeoutMs?: number;
  readonly resultTimeoutMs?: number;
}

export interface SubmitResult {
  readonly ack: CommandStatus;
  readonly outcome: OrderOutcome;
  readonly reason: string;
  /** The raw `mt: 24` entry, absent when the gateway rejected the frame. */
  readonly order: OrderUpdateEntry | undefined;
  readonly orderId: number | undefined;
}

interface Pending {
  readonly frame: OrderRequestFrame;
  readonly intent: OrderIntent;
  readonly matches: (order: OrderUpdateEntry) => boolean;
  resolveAck?: (status: CommandStatus) => void;
  resolveOrder?: (order: OrderUpdateEntry) => void;
  reject?: (error: Error) => void;
  settled: boolean;
}

export interface TradingSocketOptions {
  readonly network: NetworkConfig;
  readonly apiKey: string;
  readonly secret: ApiSecret;
  readonly logger?: Logger;
  /** Dump every inbound frame. Never includes anything derived from the key. */
  readonly verbose?: boolean;
  readonly signInTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly now?: () => number;
  /** Injectable for tests. Defaults to the global WebSocket Node ships. */
  readonly webSocketImpl?: typeof WebSocket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberAt(node: Record<string, unknown>, key: string): number | undefined {
  const value = node[key];
  return typeof value === 'number' ? value : undefined;
}

export class PerplTradingSocket {
  readonly #options: TradingSocketOptions;
  readonly #logger: Logger;
  readonly #now: () => number;

  #ws: WebSocket | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #closeReason: Error | undefined;

  #nextSn = 1;
  #localRequestId = 0;

  #accountId: number | undefined;
  #accountFrozen = false;
  #forwardingAllowed: boolean | undefined;
  #lastForwardedRequestId = 0;
  #headBlock: number | undefined;
  #lastSn: number | undefined;
  #sequenceGap = false;

  /** Order ids already open at sign-in, so a new one can be told apart. */
  readonly #knownOrderIds = new Set<number>();
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(message: InboundMessage) => void>();
  readonly #closeWaiters = new Set<(error: Error) => void>();
  /**
   * A bounded record of what has already arrived.
   *
   * The snapshots that matter most — wallet, orders, positions — are pushed
   * immediately after sign-in, which is before connect() has even returned, so
   * anything that subscribes afterwards would otherwise never see them.
   */
  readonly #history: InboundMessage[] = [];

  constructor(options: TradingSocketOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
  }

  get accountId(): number | undefined {
    return this.#accountId;
  }

  get lastForwardedRequestId(): number {
    return this.#lastForwardedRequestId;
  }

  /**
   * Whether the account permits orders forwarded by an API key (`fw`).
   *
   * Undefined until a WalletSnapshot arrives. When false, a submission is
   * admitted by the gateway and then fails on `mt: 24` with
   * sr 34 OrderForwardingNotAllowed — worth saying before submitting, not
   * after.
   */
  get forwardingAllowed(): boolean | undefined {
    return this.#forwardingAllowed;
  }

  /** Whether the account is frozen (`fr`). Frozen accounts reject orders. */
  get accountFrozen(): boolean {
    return this.#accountFrozen;
  }

  get headBlock(): number | undefined {
    return this.#headBlock;
  }

  get sequenceGapDetected(): boolean {
    return this.#sequenceGap;
  }

  get knownOrderIds(): ReadonlySet<number> {
    return this.#knownOrderIds;
  }

  /** Frames already received, oldest first, capped at HISTORY_LIMIT. */
  get recentMessages(): readonly InboundMessage[] {
    return this.#history;
  }

  /** Observe every inbound frame. Returns an unsubscribe function. */
  onMessage(listener: (message: InboundMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Open the socket, send the signed `mt: 29` frame first, and wait for the
   * WalletSnapshot that follows a successful sign-in.
   *
   * Resolves without an account id if the snapshot never comes but the socket
   * stays open — that is what an API key with no on-chain account looks like,
   * and the caller can report it rather than being told the connection failed.
   */
  async connect(): Promise<void> {
    const url = this.#options.network.tradingWsUrl;
    const WebSocketImpl = this.#options.webSocketImpl ?? globalThis.WebSocket;
    if (WebSocketImpl === undefined) {
      throw new VenueRequestError(VENUE_ID, url, 'no WebSocket implementation available');
    }

    const ws = new WebSocketImpl(url);
    this.#ws = ws;

    // Registered before the open handshake is awaited: a frame that arrives in
    // the same turn as `open` must not fall between the two.
    ws.addEventListener('message', (event: MessageEvent) => this.#onFrame(event.data));
    ws.addEventListener('close', (event: CloseEvent) => {
      this.#onClosed(this.#closeError(event.code, event.reason));
    });
    ws.addEventListener('error', () => {
      this.#onClosed(new VenueRequestError(VENUE_ID, url, 'websocket error'));
    });

    await new Promise<void>((resolve, reject) => {
      const settle = (action: () => void): void => {
        ws.removeEventListener('open', onOpen);
        this.#closeWaiters.delete(onClosedDuringHandshake);
        action();
      };
      const onOpen = (): void => settle(resolve);
      const onClosedDuringHandshake = (error: Error): void => settle(() => reject(error));

      ws.addEventListener('open', onOpen);
      this.#closeWaiters.add(onClosedDuringHandshake);
    });

    // Must be the first frame on the socket.
    this.#send(buildApiKeySignInFrame({
      chainId: this.#options.network.chainId,
      apiKey: this.#options.apiKey,
      secret: this.#options.secret,
    }));

    this.#pingTimer = setInterval(() => {
      if (this.#ws?.readyState === 1) this.#send({ mt: MT.Ping, t: this.#now() });
    }, this.#options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    this.#pingTimer.unref?.();

    await this.#awaitWalletSnapshot(this.#options.signInTimeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS);
  }

  #awaitWalletSnapshot(timeoutMs: number): Promise<void> {
    if (this.#accountId !== undefined) return Promise.resolve();
    if (this.#closeReason !== undefined) return Promise.reject(this.#closeReason);

    return new Promise<void>((resolve, reject) => {
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        unsubscribeMessage();
        this.#closeWaiters.delete(onClose);
        settle();
      };

      const timer = setTimeout(() => {
        finish(() => {
          // An open socket with no snapshot is what an API key with no
          // on-chain account looks like. Report it, do not fail on it: the
          // caller may only be discovering the account id.
          this.#logger.warn(
            `no WalletSnapshot (mt ${MT.WalletSnapshot}) within ${timeoutMs}ms — the key may ` +
              `have no on-chain account yet. Continuing; nothing will be submitted without one.`,
          );
          resolve();
        });
      }, timeoutMs);

      // A close during sign-in — 3401 above all — must surface as auth failure.
      const onClose = (error: Error): void => finish(() => reject(error));
      this.#closeWaiters.add(onClose);

      const unsubscribeMessage = this.onMessage((message) => {
        if (message['mt'] === MT.WalletSnapshot) finish(resolve);
      });
    });
  }

  /** A unique, non-zero `sn` — without one the `mt: 3` carries no `cid`. */
  nextSequenceNumber(): number {
    return this.#nextSn++;
  }

  /**
   * The next `rq`, from the greater of our local counter and the account's
   * last forwarded id. Reserving it here keeps two submissions on one socket
   * from colliding.
   */
  reserveRequestId(): number {
    const next = Math.max(this.#localRequestId, this.#lastForwardedRequestId) + 1;
    this.#localRequestId = next;
    return next;
  }

  /**
   * Submit one order frame and follow it to its real outcome.
   *
   * Resolves only on `mt: 24`, or on an `mt: 3` that rejects the frame outright
   * (after which the docs guarantee no `mt: 24` will ever follow). Throws
   * ActionTimeoutError if either wait expires — an unknown outcome is never
   * reported as either success or failure.
   */
  async submit(options: SubmitOptions): Promise<SubmitResult> {
    const { frame } = options;
    if (this.#closed || this.#ws?.readyState !== 1) {
      throw this.#closeReason ??
        new VenueRequestError(VENUE_ID, this.#options.network.tradingWsUrl, 'socket is not open');
    }

    const pending: Pending = {
      frame,
      intent: options.intent,
      matches: options.matches,
      settled: false,
    };
    const ackPromise = new Promise<CommandStatus>((resolve, reject) => {
      pending.resolveAck = resolve;
      pending.reject = reject;
    });
    const orderPromise = new Promise<OrderUpdateEntry>((resolve, reject) => {
      pending.resolveOrder = resolve;
      const previousReject = pending.reject;
      pending.reject = (error: Error): void => {
        previousReject?.(error);
        reject(error);
      };
    });
    // Nothing awaits these until below; without this the rejection that
    // settles both promises would surface as an unhandled rejection.
    void ackPromise.catch(() => {});
    void orderPromise.catch(() => {});

    this.#pending.set(frame.sn, pending);
    this.#send(frame);

    const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    const ack = await this.#withTimeout(ackPromise, ackTimeoutMs, () => {
      this.#pending.delete(frame.sn);
      return new ActionTimeoutError(
        VENUE_ID,
        `no mt ${MT.StatusResponse} acknowledgement for sn ${frame.sn} within ${ackTimeoutMs}ms. ` +
          `The frame may never have been admitted; do not assume it was.`,
        {
          idempotencyKey: options.idempotencyKey,
          stage: 'ack',
          waitedMs: ackTimeoutMs,
          requestId: frame.rq,
        },
      );
    });

    if (ack.code !== 0) {
      // Documented: a non-zero code means the gateway rejected the frame before
      // the chain saw it, and no mt 24 will follow. Stop waiting.
      this.#pending.delete(frame.sn);
      return {
        ack,
        outcome: 'rejected',
        reason: `gateway rejected the frame: code ${ack.code}${ack.error === '' ? '' : ` — ${ack.error}`}`,
        order: undefined,
        orderId: undefined,
      };
    }

    options.onForwarded?.(ack);

    const resultTimeoutMs = options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS;
    const order = await this.#withTimeout(orderPromise, resultTimeoutMs, () => {
      this.#pending.delete(frame.sn);
      return new ActionTimeoutError(
        VENUE_ID,
        `accepted for forwarding, but no mt ${MT.OrdersUpdate} outcome within ${resultTimeoutMs}ms. ` +
          `The order may still be live — reconcile against rq ${frame.rq} before retrying.`,
        {
          idempotencyKey: options.idempotencyKey,
          stage: 'result',
          waitedMs: resultTimeoutMs,
          requestId: frame.rq,
        },
      );
    });

    this.#pending.delete(frame.sn);
    const st = numberAt(order, 'st');
    const sr = numberAt(order, 'sr');
    const { outcome, reason } = classifyOrderUpdate(st, sr, options.intent);
    return { ack, outcome, reason, order, orderId: numberAt(order, 'id') };
  }

  close(): void {
    this.#onClosed(
      new VenueRequestError(VENUE_ID, this.#options.network.tradingWsUrl, 'socket closed locally'),
    );
    try {
      this.#ws?.close();
    } catch {
      // Already closing; nothing to do.
    }
  }

  #send(frame: unknown): void {
    this.#ws?.send(JSON.stringify(frame));
  }

  #withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(onTimeout()), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error as Error);
        },
      );
    });
  }

  #closeError(code: number, reason: string): Error {
    const detail = reason === '' ? '' : ` (${reason})`;
    if (code === CLOSE_AUTH_FAILURE) {
      return new VenueAuthError(
        VENUE_ID,
        `sign-in rejected, close ${code}${detail}. Check the key, its scope, and that the ` +
          `clock is within 30s of the server.`,
        { closeCode: code },
      );
    }
    if (code === CLOSE_FAILED_TO_PROCESS) {
      return new VenueRequestError(
        VENUE_ID,
        this.#options.network.tradingWsUrl,
        `server closed with ${code}${detail} — an unknown market, an account this key does not ` +
          `own, or an unparseable frame. No status will arrive for anything in flight.`,
      );
    }
    return new VenueRequestError(
      VENUE_ID,
      this.#options.network.tradingWsUrl,
      `socket closed with ${code}${detail}`,
    );
  }

  #onClosed(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = error;
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer);
    // An unexpected close fails every request still in flight rather than
    // leaving it to time out against a socket that will never answer.
    for (const [sn, pending] of this.#pending) {
      pending.reject?.(error);
      this.#pending.delete(sn);
    }
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
    if (this.#history.length > HISTORY_LIMIT) this.#history.shift();

    this.#track(message);
    for (const listener of this.#listeners) listener(message);
  }

  #track(message: InboundMessage): void {
    const mt = message['mt'];

    if (mt === MT.WalletSnapshot) {
      const accounts = message['as'];
      if (Array.isArray(accounts) && isRecord(accounts[0])) {
        const account = accounts[0];
        this.#accountId ??= numberAt(account, 'id');
        this.#lastForwardedRequestId = numberAt(account, 'lfr') ?? this.#lastForwardedRequestId;
        if (typeof account['fw'] === 'boolean') this.#forwardingAllowed = account['fw'];
        if (typeof account['fr'] === 'boolean') this.#accountFrozen = account['fr'];
      }
      this.#lastSn = numberAt(message, 'sn') ?? this.#lastSn;
      return;
    }

    if (mt === MT.AccountUpdate) {
      this.#lastForwardedRequestId = numberAt(message, 'lfr') ?? this.#lastForwardedRequestId;
      return;
    }

    if (mt === MT.Heartbeat) {
      const sn = numberAt(message, 'sn');
      if (sn !== undefined && this.#lastSn !== undefined && sn !== this.#lastSn + 1) {
        this.#sequenceGap = true;
        this.#logger.warn(
          `heartbeat sequence gap: expected ${this.#lastSn + 1}, got ${sn}. Messages may have ` +
            `been lost; this session's view of orders is no longer trustworthy.`,
        );
      }
      if (sn !== undefined) this.#lastSn = sn;
      this.#headBlock = numberAt(message, 'h') ?? this.#headBlock;
      return;
    }

    if (mt === MT.OrdersSnapshot) {
      for (const order of this.#orderEntries(message)) {
        const id = numberAt(order, 'id');
        if (id !== undefined) this.#knownOrderIds.add(id);
      }
      return;
    }

    if (mt === MT.StatusResponse) {
      this.#onCommandStatus(message);
      return;
    }

    if (mt === MT.OrdersUpdate) {
      this.#onOrdersUpdate(message);
    }
  }

  #orderEntries(message: InboundMessage): OrderUpdateEntry[] {
    const d = message['d'];
    return Array.isArray(d) ? d.filter(isRecord) : [];
  }

  #onCommandStatus(message: InboundMessage): void {
    const sid = numberAt(message, 'sid');
    if (sid !== undefined && sid !== COMMAND_STATUS_SID) return;

    const statusNode = message['status'];
    const status: CommandStatus = {
      cid: numberAt(message, 'cid'),
      code: isRecord(statusNode) ? numberAt(statusNode, 'code') ?? -1 : -1,
      error: isRecord(statusNode) && typeof statusNode['error'] === 'string' ? statusNode['error'] : '',
    };

    if (status.cid === undefined) {
      // `cid` is omitted only when the frame's `sn` was 0, which we never send.
      this.#logger.warn(`mt ${MT.StatusResponse} with no cid — cannot match it to a request`);
      return;
    }
    const pending = this.#pending.get(status.cid);
    if (pending === undefined) return;
    pending.resolveAck?.(status);
  }

  #onOrdersUpdate(message: InboundMessage): void {
    for (const order of this.#orderEntries(message)) {
      const st = numberAt(order, 'st');
      const id = numberAt(order, 'id');

      for (const pending of this.#pending.values()) {
        if (pending.settled || !pending.matches(order)) continue;
        // The docs' dedup rule: the first definitive status wins and later
        // updates for the same request are ignored.
        if (st === undefined || !isDefinitiveStatus(st)) {
          this.#logger.log(
            `  … rq ${pending.frame.rq}: ${describeOrderStatus(st, numberAt(order, 'sr'))}`,
          );
          continue;
        }
        pending.settled = true;
        pending.resolveOrder?.(order);
        break;
      }

      if (id !== undefined) this.#knownOrderIds.add(id);
    }
  }
}
