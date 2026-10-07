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
 * built and statuses decoded in perpl-orders.ts, which is pure and tested —
 * nor move bytes, which is PerplSocketConnection in perpl-socket.ts, shared
 * with the public market-data socket.
 *
 * The two-stage result is the whole point. `mt: 3` with `code: 0` means
 * accepted for forwarding: not posted, not filled. Only `mt: 24` carries the
 * outcome, so submit() resolves on `mt: 24` and reports `mt: 3` through a
 * callback that cannot be mistaken for completion.
 */
import type { NetworkConfig } from '../config.ts';
import { ActionTimeoutError, VenueRequestError } from '../errors.ts';
import { buildApiKeySignInFrame, type ApiSecret } from './perpl-signing.ts';
import {
  PerplSocketConnection,
  amountAt,
  isRecord,
  numberAt,
  silentLogger,
  type InboundMessage,
  type Logger,
} from './perpl-socket.ts';
import { isOpenPosition, positionIdOf, type PositionEntry } from './perpl-positions.ts';
import {
  COMMAND_STATUS_SID,
  MT,
  classifyOrderUpdate,
  describeOrderStatus,
  isDefinitiveStatus,
  type OrderIntent,
  type OrderOutcome,
  type OrderRequestFrame,
  orderIdOf,
  type OrderUpdateEntry,
  type LastOrderState,
} from './perpl-orders.ts';

export type { OrderUpdateEntry, LastOrderState, PositionEntry };

const VENUE_ID = 'perpl';

const DEFAULT_SIGN_IN_TIMEOUT_MS = 10_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_RESULT_TIMEOUT_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
/**
 * Heartbeats (`mt: 100`) land on EVERY block, ~300ms apart (measured: 327 of
 * 327 over 100s), so ten seconds without a single frame is not a quiet
 * market — it is a connection that is open but dead, which a half-open TCP
 * socket never reports on its own. The watchdog closes it with a reason so the
 * ordinary close path, and whoever reconnects on it, takes over.
 */
const DEFAULT_STALL_TIMEOUT_MS = 10_000;

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
  /**
   * Treat the connection as dead after this much total silence and close it.
   * 0 disables the watchdog. See DEFAULT_STALL_TIMEOUT_MS for why silence on
   * this socket is never normal.
   */
  readonly stallTimeoutMs?: number;
  readonly now?: () => number;
  /** Injectable for tests. Defaults to the global WebSocket Node ships. */
  readonly webSocketImpl?: typeof WebSocket;
}

/** How many closing rows a socket remembers: plenty for one close-everything run. */
const CLOSED_ROWS_KEPT = 100;

export class PerplTradingSocket {
  readonly #options: TradingSocketOptions;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #stallTimeoutMs: number;
  /** The transport. Everything else in this class is session state on top. */
  readonly #conn: PerplSocketConnection;

  #stallTimer: ReturnType<typeof setInterval> | undefined;
  #lastFrameAtMs = 0;

  #nextSn = 1;
  #localRequestId = 0;

  #accountId: number | undefined;
  #walletAddress: string | undefined;
  #accountFrozen = false;
  #forwardingAllowed: boolean | undefined;
  /** `b` on the account, in AUSD micros. Undefined until a snapshot arrives. */
  #balanceCNS: bigint | undefined;
  /** `lb` on the account, in AUSD micros. */
  #lockedBalanceCNS: bigint | undefined;
  #lastForwardedRequestId = 0;
  #headBlock: number | undefined;
  #lastSn: number | undefined;
  #sequenceGap = false;

  /** Order ids already open at sign-in, so a new one can be told apart. */
  readonly #knownOrderIds = new Set<number>();
  /**
   * The last status seen for every order id this session has heard about.
   *
   * Kept so a timed-out action can be reconciled against what actually became
   * of the order instead of being reported as unknown. A cancel of an order
   * that already expired may never produce an `mt: 24` of its own, but the
   * expiry itself does arrive, and it lands here.
   */
  readonly #orderStates = new Map<number, LastOrderState>();
  readonly #pending = new Map<number, Pending>();

  /**
   * Open positions, keyed by `pid`, exactly as the wire sent them.
   *
   * RAW ON PURPOSE. Decoding needs per-market scaling, which this class does
   * not have and should not fetch — its job is to move bytes and track session
   * state, the same reason order frames are built and decoded in
   * perpl-orders.ts. perpl-positions.ts turns these into positions.
   *
   * Keyed by `pid` rather than market id because `pid` is what identifies a
   * position: a market that goes flat and is reopened is a new position with a
   * new id, and keying by market would silently merge the two.
   */
  readonly #positions = new Map<number, PositionEntry>();
  /** Closing rows by pid, newest last, bounded. See `closedRow`. */
  readonly #closedRows = new Map<number, PositionEntry>();
  #positionsSnapshotReceived = false;
  readonly #positionListeners = new Set<(positions: readonly PositionEntry[]) => void>();

  constructor(options: TradingSocketOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.#conn = new PerplSocketConnection({
      venueId: VENUE_ID,
      url: options.network.tradingWsUrl,
      failedToProcessHint:
        'Likely an unknown market, an account this key does not own, or an unparseable frame. ' +
        'No status will arrive for anything in flight.',
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.webSocketImpl === undefined ? {} : { webSocketImpl: options.webSocketImpl }),
    });

    // Both registered first, so session state is updated before any external
    // observer sees a frame, and so a close fails everything in flight before
    // it reaches anyone waiting on the connection.
    this.#conn.onMessage((message) => {
      this.#lastFrameAtMs = this.#now();
      this.#track(message);
    });
    this.#conn.onClose((error) => {
      this.#stopStallWatchdog();
      this.#failPending(error);
      // The set has not changed, but its TRUSTWORTHINESS has: this socket does
      // not reconnect ITSELF, so from here the positions it holds are frozen
      // until whoever owns it opens a replacement. Subscribers are told so they
      // can re-read positionsTrustworthy rather than going on believing a
      // stale set.
      this.#emitPositions();
    });
  }

  /**
   * True once the connection has ended, for any reason. A closed socket never
   * reopens: the owner constructs a new one, which is what keeps a reconnect
   * from silently re-signing underneath an in-flight submission (every
   * in-flight request is failed on close, so nothing can be retried blind).
   */
  get closed(): boolean {
    return this.#conn.closed;
  }

  /**
   * Observe the close, whenever it comes; fires exactly once, and immediately
   * if the socket has already closed. This is the hook a reconnect policy
   * hangs off — the policy lives with the owner, never here.
   */
  onClose(listener: (error: Error) => void): () => void {
    return this.#conn.onClose(listener);
  }

  get accountId(): number | undefined {
    return this.#accountId;
  }

  /**
   * The wallet this API key signs for, lowercased, from `addr` on the
   * WalletSnapshot.
   *
   * Kept so a caller asking for "this address's positions" can be told no
   * when it is not this address. An API key is bound to one account, and
   * answering with account 710's positions whatever address was asked for
   * would be a risk tool lying about whose money is at stake.
   */
  get walletAddress(): string | undefined {
    return this.#walletAddress;
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

  /** `b` on the account snapshot, in AUSD micros. Undefined before a snapshot. */
  get balanceCNS(): bigint | undefined {
    return this.#balanceCNS;
  }

  /** `lb` on the account snapshot, in AUSD micros. Undefined before a snapshot. */
  get lockedBalanceCNS(): bigint | undefined {
    return this.#lockedBalanceCNS;
  }

  /**
   * A FLOOR on the AUSD that could be moved into a position right now.
   *
   * `b - lb`, and it is a floor rather than the figure, because WHAT `lb`
   * OVERLAPS WITH IS UNRESOLVED. The docs give `b` as "Balance (decimal
   * string)" and `lb` as "Locked balance (decimal string)" and say no more —
   * in particular they do not say whether `b` already excludes what `lb`
   * counts.
   *
   * Both readings are covered by subtracting:
   *   - If `lb` sits INSIDE `b`, then `b - lb` is exactly the spendable amount.
   *   - If `lb` sits OUTSIDE `b`, then `b` was already spendable and `b - lb`
   *     understates it by `lb`.
   * So this never OVERSTATES, which is the only direction that matters for a
   * caller about to tell a trader what they can afford. It can understate, so
   * callers must present it as "at least", never as "you have", and must not
   * refuse an action for exceeding it — see the note in `apps/bot/src/custom.ts`.
   *
   * The chain says an account balance excludes collateral posted to a position:
   * `IncreasePositionCollateral` carries both the position's new deposit and the
   * account's `balanceCNS`, and `apps/indexer` reads the latter as free balance —
   * which is what the `rescuableLiquidationCount` headline rests on. That is the
   * CONTRACT though, not the wire, so it does not settle `lb`, and a question is
   * out to Perpl to make this exact rather than conservative.
   *
   * Clamped at zero: a negative floor is not a balance, and would read as a
   * debt we have no evidence for.
   */
  get freeBalanceFloorCNS(): bigint | undefined {
    if (this.#balanceCNS === undefined) return undefined;
    const floor = this.#balanceCNS - (this.#lockedBalanceCNS ?? 0n);
    return floor > 0n ? floor : 0n;
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

  /**
   * Every open position, raw. Empty before the first snapshot arrives, which
   * is why `positionsSnapshotReceived` exists: "no positions" and "we have not
   * been told yet" are different answers and must not look alike.
   */
  get positions(): readonly PositionEntry[] {
    return [...this.#positions.values()];
  }

  /** The last row this socket saw for a position that is no longer open (closed, liquidated...), if any. */
  closedRow(positionId: number): PositionEntry | undefined {
    return this.#closedRows.get(positionId);
  }

  /** Whether the `mt: 26` snapshot has arrived. False means we do not know. */
  get positionsSnapshotReceived(): boolean {
    return this.#positionsSnapshotReceived;
  }

  /**
   * Whether the position view can be trusted right now.
   *
   * False when the snapshot has not arrived, when the socket has closed, or
   * when a heartbeat sequence gap says we may have missed an update. A gap
   * matters more for positions than for orders: a missed `mt: 27` leaves a
   * closed position showing as open, or hides one that was opened, and neither
   * is visible by looking at the position set itself.
   *
   * This socket DOES NOT RECONNECT ITSELF. Once it closes, the positions above
   * are frozen at whatever they were — the "monitor gone blind" case — until
   * the owner opens a replacement socket and a fresh snapshot arrives on it.
   * A caller must gate on this rather than on the set being non-empty.
   */
  get positionsTrustworthy(): boolean {
    return this.#positionsSnapshotReceived && this.#conn.isOpen && !this.#sequenceGap;
  }

  /** Why the position view cannot be trusted, or undefined when it can. */
  get positionsUntrustworthyReason(): string | undefined {
    if (!this.#positionsSnapshotReceived) {
      return `no position snapshot (mt ${MT.PositionsSnapshot}) has arrived yet, so we do not ` +
        `know what is open`;
    }
    if (!this.#conn.isOpen) {
      return `the trading socket is closed, so the positions we hold are frozen at whatever ` +
        `they were: ${this.#conn.closeReason?.message ?? 'no reason given'}`;
    }
    if (this.#sequenceGap) {
      return `a heartbeat sequence gap means a position update may have been missed, so a ` +
        `closed position could still show as open`;
    }
    return undefined;
  }

  /**
   * Observe the open-position set. Fires on every frame that changes it, and
   * on the initial snapshot even when that snapshot is empty.
   */
  onPositions(listener: (positions: readonly PositionEntry[]) => void): () => void {
    this.#positionListeners.add(listener);
    return () => {
      this.#positionListeners.delete(listener);
    };
  }

  /**
   * The last status seen for `orderId`, or undefined if this session never
   * heard about it. Feed it to reconcileCancelTimeout() after a cancel times
   * out; never use it to decide that an action succeeded.
   */
  lastOrderState(orderId: number): LastOrderState | undefined {
    return this.#orderStates.get(orderId);
  }

  /** Frames already received, oldest first, capped by the connection. */
  get recentMessages(): readonly InboundMessage[] {
    return this.#conn.recentMessages;
  }

  /** Observe every inbound frame. Returns an unsubscribe function. */
  onMessage(listener: (message: InboundMessage) => void): () => void {
    return this.#conn.onMessage(listener);
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
    await this.#conn.open();

    // Must be the first frame on the socket.
    this.#send(buildApiKeySignInFrame({
      chainId: this.#options.network.chainId,
      apiKey: this.#options.apiKey,
      secret: this.#options.secret,
    }));

    this.#conn.startPing(this.#options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    this.#armStallWatchdog();

    await this.#awaitWalletSnapshot(this.#options.signInTimeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS);
  }

  /**
   * Watch for total silence and close the connection when it stalls.
   *
   * Polls at half the timeout rather than re-arming a timer per frame: frames
   * arrive several times a second. Closing routes into the ordinary close path
   * — in-flight requests fail, subscribers are told, the owner reconnects —
   * so a dead socket is indistinguishable from a dropped one, which is right.
   */
  #armStallWatchdog(): void {
    this.#stopStallWatchdog();
    if (this.#stallTimeoutMs <= 0) return;
    this.#lastFrameAtMs = this.#now();
    const tick = Math.max(1, Math.floor(this.#stallTimeoutMs / 2));
    this.#stallTimer = setInterval(() => {
      const silentFor = this.#now() - this.#lastFrameAtMs;
      if (silentFor < this.#stallTimeoutMs) return;
      this.#logger.warn(
        `no frames on the trading socket for ${silentFor}ms — heartbeats land every block, so ` +
          `the connection is open but dead. Dropping it so a reconnect can take over.`,
      );
      this.#stopStallWatchdog();
      this.#conn.close(`stalled: no frames for ${silentFor}ms`);
    }, tick);
    this.#stallTimer.unref?.();
  }

  #stopStallWatchdog(): void {
    if (this.#stallTimer !== undefined) clearInterval(this.#stallTimer);
    this.#stallTimer = undefined;
  }

  #awaitWalletSnapshot(timeoutMs: number): Promise<void> {
    if (this.#accountId !== undefined) return Promise.resolve();
    if (this.#conn.closeReason !== undefined) return Promise.reject(this.#conn.closeReason);

    return new Promise<void>((resolve, reject) => {
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        unsubscribeMessage?.();
        unsubscribeClose?.();
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
      // Declared before they are assigned: finish() may run on either signal,
      // and must be able to drop whichever of the two did not fire.
      let unsubscribeClose: (() => void) | undefined;
      let unsubscribeMessage: (() => void) | undefined;

      unsubscribeClose = this.#conn.onClose((error) => finish(() => reject(error)));
      unsubscribeMessage = this.#conn.onMessage((message) => {
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
    if (!this.#conn.isOpen) {
      throw this.#conn.closeReason ??
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
    return { ack, outcome, reason, order, orderId: orderIdOf(order) };
  }

  close(): void {
    this.#conn.close();
  }

  #send(frame: unknown): void {
    this.#conn.send(frame);
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

  /**
   * A close fails every request still in flight rather than leaving it to time
   * out against a socket that will never answer.
   */
  #failPending(error: Error): void {
    for (const [sn, pending] of this.#pending) {
      pending.reject?.(error);
      this.#pending.delete(sn);
    }
  }

  /**
   * Read `b` and `lb` off an account object.
   *
   * A field we cannot parse LEAVES THE PREVIOUS VALUE STANDING rather than
   * clearing it or defaulting to zero: the last figure we did parse is the last
   * thing we know, and zero would be reported as a real balance of nothing.
   */
  #readBalance(account: Record<string, unknown>): void {
    this.#balanceCNS = amountAt(account, 'b') ?? this.#balanceCNS;
    this.#lockedBalanceCNS = amountAt(account, 'lb') ?? this.#lockedBalanceCNS;
  }

  #track(message: InboundMessage): void {
    const mt = message['mt'];

    if (mt === MT.WalletSnapshot) {
      const addr = message['addr'];
      if (typeof addr === 'string' && addr !== '') this.#walletAddress ??= addr.toLowerCase();
      const accounts = message['as'];
      if (Array.isArray(accounts) && isRecord(accounts[0])) {
        const account = accounts[0];
        this.#accountId ??= numberAt(account, 'id');
        this.#lastForwardedRequestId = numberAt(account, 'lfr') ?? this.#lastForwardedRequestId;
        if (typeof account['fw'] === 'boolean') this.#forwardingAllowed = account['fw'];
        if (typeof account['fr'] === 'boolean') this.#accountFrozen = account['fr'];
        this.#readBalance(account);
      }
      this.#lastSn = numberAt(message, 'sn') ?? this.#lastSn;
      return;
    }

    if (mt === MT.AccountUpdate) {
      this.#lastForwardedRequestId = numberAt(message, 'lfr') ?? this.#lastForwardedRequestId;
      // The update carries the whole account, balance included, so it is what
      // keeps the figure current between sign-ins.
      this.#readBalance(message);
      return;
    }

    if (mt === MT.Heartbeat) {
      const sn = numberAt(message, 'sn');
      if (sn !== undefined && this.#lastSn !== undefined && sn !== this.#lastSn + 1) {
        const first = !this.#sequenceGap;
        this.#sequenceGap = true;
        this.#logger.warn(
          `heartbeat sequence gap: expected ${this.#lastSn + 1}, got ${sn}. Messages may have ` +
            `been lost; this session's view of orders and positions is no longer trustworthy.`,
        );
        // Same reason as on close: the set is unchanged but can no longer be
        // relied on, and a missed mt 27 is invisible from the set itself.
        if (first) this.#emitPositions();
      }
      if (sn !== undefined) this.#lastSn = sn;
      this.#headBlock = numberAt(message, 'h') ?? this.#headBlock;
      return;
    }

    if (mt === MT.OrdersSnapshot) {
      for (const order of this.#orderEntries(message)) {
        const id = orderIdOf(order);
        if (id === undefined) continue;
        this.#knownOrderIds.add(id);
        this.#recordOrderState(id, order, 'snapshot');
      }
      return;
    }

    if (mt === MT.StatusResponse) {
      this.#onCommandStatus(message);
      return;
    }

    if (mt === MT.OrdersUpdate) {
      this.#onOrdersUpdate(message);
      return;
    }

    if (mt === MT.PositionsSnapshot) {
      this.#onPositionsSnapshot(message);
      return;
    }

    if (mt === MT.PositionsUpdate) {
      this.#onPositionsUpdate(message);
    }
  }

  /**
   * `mt: 26` — the whole truth, so it REPLACES what we hold.
   *
   * Merging a snapshot into the existing set would keep any position the
   * server has since forgotten about. On reconnect that is precisely how a
   * closed position survives forever.
   */
  #onPositionsSnapshot(message: InboundMessage): void {
    this.#positions.clear();
    for (const entry of this.#positionEntries(message)) {
      this.#applyPosition(entry);
    }
    this.#positionsSnapshotReceived = true;
    // Always emitted, even when empty: "no positions" is an answer, and a
    // caller waiting for the first one must not wait forever on a flat
    // account.
    this.#emitPositions();
  }

  /**
   * `mt: 27` — a delta, applied row by row.
   *
   * An update that arrives before the snapshot is applied anyway. Dropping it
   * would lose a real change, and the snapshot that follows overwrites the set
   * wholesale in any case.
   */
  #onPositionsUpdate(message: InboundMessage): void {
    let changed = false;
    for (const entry of this.#positionEntries(message)) {
      if (this.#applyPosition(entry)) changed = true;
    }
    if (changed) this.#emitPositions();
  }

  /**
   * Add, replace or REMOVE one position row.
   *
   * A CLOSED POSITION ARRIVES AS A ROW, not as an omission: `st: 2` with
   * `s: 0` and `c: "0"`, measured on testnet. Upserting whatever arrives would
   * leave a zero-size ghost in the set forever, so anything that is not Open
   * deletes. That covers Liquidated, Deleveraged and Unwound too, whose exact
   * shapes have never been observed — the rule reads only `st`.
   */
  #applyPosition(entry: PositionEntry): boolean {
    const pid = positionIdOf(entry);
    if (pid === undefined) {
      this.#logger.warn(
        `position row with no usable pid, ignoring: ${JSON.stringify(entry).slice(0, 200)}`,
      );
      return false;
    }
    if (isOpenPosition(entry['st'])) {
      this.#positions.set(pid, entry);
      this.#closedRows.delete(pid);
      return true;
    }
    // Kept, not just dropped: the closing row carries the exit price (`xp`),
    // the position stream's own word on what a close filled at.
    this.#closedRows.set(pid, entry);
    if (this.#closedRows.size > CLOSED_ROWS_KEPT) this.#closedRows.delete(this.#closedRows.keys().next().value!);
    return this.#positions.delete(pid);
  }

  #positionEntries(message: InboundMessage): PositionEntry[] {
    const d = message['d'];
    return Array.isArray(d) ? d.filter(isRecord) : [];
  }

  #emitPositions(): void {
    const positions = this.positions;
    for (const listener of this.#positionListeners) listener(positions);
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
      const id = orderIdOf(order);

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

      if (id !== undefined) {
        this.#knownOrderIds.add(id);
        this.#recordOrderState(id, order, 'update');
      }
    }
  }

  /**
   * Remember an order's latest status. A live update always wins over the
   * sign-in snapshot; between two updates the later one wins, which is simply
   * arrival order — the socket does not reorder frames.
   */
  #recordOrderState(orderId: number, order: OrderUpdateEntry, source: 'snapshot' | 'update'): void {
    const existing = this.#orderStates.get(orderId);
    if (existing?.source === 'update' && source === 'snapshot') return;
    this.#orderStates.set(orderId, {
      orderId,
      st: numberAt(order, 'st'),
      sr: numberAt(order, 'sr'),
      source,
    });
  }
}
