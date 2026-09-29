/**
 * Live positions as a source the risk loop can subscribe to.
 *
 * Wraps the authenticated trading socket and hands out decoded positions plus,
 * crucially, WHETHER THEY CAN BE BELIEVED.
 *
 * That second part is the whole reason this is not just a getter. A frozen
 * position set is more dangerous than a stale price, because nothing about the
 * set itself reveals the problem: a price at least carries a timestamp, while a
 * position that was closed a minute ago looks exactly like one that is still
 * open. The trading socket does not reconnect, so a drop freezes the set
 * indefinitely; a heartbeat sequence gap means an `mt: 27` may have been
 * missed. Either way the honest answer is "I do not know", and the loop must
 * be able to hear it.
 *
 * Same principle as `MarketFeed.feedStatus()` for prices, and deliberately
 * shaped the same way — but a SEPARATE question with a separate answer, so a
 * message can say "position data is stale" rather than "price feed is down".
 */
import type { NetworkName } from '../config.ts';
import { parsePositionFrame, type PerplPosition } from './perpl-positions.ts';
import type { PerplTradingSocket } from './perpl-trading-socket.ts';
import type { Unsubscribe, VenueMarket } from './types.ts';

/** Whether the position set reflects reality right now. */
export type PositionSourceState =
  /** Subscribed, snapshot received, no gaps. The set is the truth. */
  | 'live'
  /** Connected but not yet told what is open. Not the same as "nothing open". */
  | 'awaiting-snapshot'
  /**
   * The set is frozen: the socket closed, or a sequence gap means we may have
   * missed an update. Positions shown are the last known, not the current.
   */
  | 'stale';

export interface PositionSourceStatus {
  readonly state: PositionSourceState;
  /** Human-readable, safe to render directly. Absent when live. */
  readonly reason?: string;
  /** When the set last changed, or was last confirmed by a snapshot. */
  readonly lastUpdateMs: number | undefined;
  /** How old that is. Undefined before anything has arrived. */
  readonly ageMs: number | undefined;
}

/** Whether positions from a source in this state may be assessed. */
export function positionsAreUsable(status: PositionSourceStatus): boolean {
  return status.state === 'live';
}

export interface PerplPositionSourceOptions {
  readonly socket: PerplTradingSocket;
  readonly network: NetworkName;
  /** Keyed by market id. Needed for scaling; never hard-coded. */
  readonly markets: ReadonlyMap<number, VenueMarket>;
  readonly collateralDecimals: number;
  readonly now?: () => number;
  readonly onSkippedMarket?: (marketId: number) => void;
}

/**
 * Decoded positions off one authenticated socket.
 *
 * Implements the shape the risk loop's `PositionSource` port expects —
 * `snapshot()` and `onSnapshot()` — and adds `status()` alongside, which the
 * loop gates on.
 */
export class PerplPositionSource {
  readonly #socket: PerplTradingSocket;
  readonly #network: NetworkName;
  readonly #markets: ReadonlyMap<number, VenueMarket>;
  readonly #collateralDecimals: number;
  readonly #now: () => number;
  readonly #onSkippedMarket: ((marketId: number) => void) | undefined;

  readonly #listeners = new Set<(positions: readonly PerplPosition[]) => void>();
  #positions: readonly PerplPosition[] = [];
  #lastUpdateMs: number | undefined;
  #unsubscribe: Unsubscribe | undefined;
  /** Markets already warned about, so one unlistable market warns once. */
  readonly #warnedMarkets = new Set<number>();

  constructor(options: PerplPositionSourceOptions) {
    this.#socket = options.socket;
    this.#network = options.network;
    this.#markets = options.markets;
    this.#collateralDecimals = options.collateralDecimals;
    this.#now = options.now ?? Date.now;
    this.#onSkippedMarket = options.onSkippedMarket;
  }

  /** Subscribe to the socket. Idempotent. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#socket.onPositions(() => this.#refresh());
    // The snapshot may already have arrived before we subscribed.
    if (this.#socket.positionsSnapshotReceived) this.#refresh();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /**
   * The positions we hold.
   *
   * ALWAYS THE LAST KNOWN SET, even when stale — a monitor that has lost its
   * feed keeps showing what it last knew and says so, rather than going blank.
   * Callers decide what to do with it by asking {@link status}.
   */
  snapshot(): readonly PerplPosition[] {
    return this.#positions;
  }

  onSnapshot(listener: (positions: readonly PerplPosition[]) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Whether the set above reflects reality. Ask before acting on it. */
  status(): PositionSourceStatus {
    const lastUpdateMs = this.#lastUpdateMs;
    const ageMs = lastUpdateMs === undefined ? undefined : this.#now() - lastUpdateMs;
    const base = { lastUpdateMs, ageMs };

    const untrustworthy = this.#socket.positionsUntrustworthyReason;
    if (untrustworthy === undefined) return { ...base, state: 'live' };

    // Not yet told is its own state: it is recoverable and expected at
    // startup, where "stale" would read as a fault.
    if (!this.#socket.positionsSnapshotReceived) {
      return { ...base, state: 'awaiting-snapshot', reason: untrustworthy };
    }
    return { ...base, state: 'stale', reason: untrustworthy };
  }

  #refresh(): void {
    const decoded = parsePositionFrame(
      this.#socket.positions,
      this.#markets,
      this.#network,
      this.#collateralDecimals,
    );
    for (const marketId of decoded.skipped) {
      if (this.#warnedMarkets.has(marketId)) continue;
      this.#warnedMarkets.add(marketId);
      this.#onSkippedMarket?.(marketId);
    }

    this.#positions = decoded.open;
    this.#lastUpdateMs = this.#now();
    for (const listener of this.#listeners) listener(this.#positions);
  }
}
