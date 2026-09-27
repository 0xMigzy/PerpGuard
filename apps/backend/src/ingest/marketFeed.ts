/**
 * The backend's in-memory view of the latest price per market.
 *
 * Deliberately dumb: it holds what the venue feed pushed and answers how old
 * it is. No I/O, no websocket, no venue types beyond PriceUpdate — the feed
 * that fills it is a Venue behind the Venue interface, and swapping venues
 * must not touch this file.
 *
 * The staleness rule it exists to enforce: never act on price data older than
 * STALE_MS.
 */
import type { PriceUpdate } from '@perpguard/shared';

/** Why a market has no usable price. */
export type StaleReason = 'no-data' | 'expired';

export interface Staleness {
  readonly stale: boolean;
  /** Age of the held price in ms, or undefined when nothing was ever received. */
  readonly ageMs: number | undefined;
  /** Only set when stale. */
  readonly reason?: StaleReason;
}

export class MarketFeed {
  readonly #staleMs: number;
  readonly #now: () => number;
  readonly #byMarketId = new Map<number, PriceUpdate>();
  /** Symbol -> market id, so callers can ask either way. */
  readonly #bySymbol = new Map<string, number>();

  /**
   * @param staleMs from STALE_MS, via loadAppConfig. Passed in rather than
   * read here so this stays pure and testable.
   */
  constructor(staleMs: number, now: () => number = Date.now) {
    if (!Number.isFinite(staleMs) || staleMs <= 0) {
      throw new RangeError(`staleMs must be a positive number, got ${staleMs}`);
    }
    this.#staleMs = staleMs;
    this.#now = now;
  }

  get staleMs(): number {
    return this.#staleMs;
  }

  /** How many markets have a price. */
  get size(): number {
    return this.#byMarketId.size;
  }

  /**
   * Record a tick. Out-of-order frames are dropped: a slow update that lands
   * after a newer one must not make the cache go backwards in time.
   */
  record(update: PriceUpdate): void {
    const existing = this.#byMarketId.get(update.marketId);
    if (existing !== undefined && existing.receivedAtMs > update.receivedAtMs) return;
    this.#byMarketId.set(update.marketId, update);
    this.#bySymbol.set(update.symbol, update.marketId);
  }

  get(marketId: number): PriceUpdate | undefined {
    return this.#byMarketId.get(marketId);
  }

  getBySymbol(symbol: string): PriceUpdate | undefined {
    const marketId = this.#bySymbol.get(symbol);
    return marketId === undefined ? undefined : this.#byMarketId.get(marketId);
  }

  /** Every held price, newest per market. */
  snapshot(): PriceUpdate[] {
    return [...this.#byMarketId.values()];
  }

  /**
   * Age of the held price in ms, or undefined if none was ever received.
   *
   * Measured from when WE received it, not the venue's `at.t`: a venue clock
   * that drifts must not be able to make a dead feed look fresh.
   */
  ageMs(marketId: number): number | undefined {
    const update = this.#byMarketId.get(marketId);
    if (update === undefined) return undefined;
    return Math.max(0, this.#now() - update.receivedAtMs);
  }

  /**
   * Whether this market's price is too old to act on.
   *
   * A market we have never heard from is STALE, not fresh. Never-received and
   * long-expired are the same thing to a caller about to act, and the
   * fail-safe direction is the one that blocks the action rather than the one
   * that lets it through on a price that does not exist.
   */
  isStale(marketId: number): boolean {
    return this.staleness(marketId).stale;
  }

  /** isStale with the detail the UI needs to explain itself. */
  staleness(marketId: number): Staleness {
    const ageMs = this.ageMs(marketId);
    if (ageMs === undefined) return { stale: true, ageMs: undefined, reason: 'no-data' };
    if (ageMs > this.#staleMs) return { stale: true, ageMs, reason: 'expired' };
    return { stale: false, ageMs };
  }

  isStaleBySymbol(symbol: string): boolean {
    const marketId = this.#bySymbol.get(symbol);
    // An unknown symbol has no price, so it is stale by the same rule.
    return marketId === undefined ? true : this.isStale(marketId);
  }

  /** Market ids whose price has gone stale. For alerting on a dead feed. */
  staleMarketIds(): number[] {
    return [...this.#byMarketId.keys()].filter((id) => this.isStale(id));
  }
}
