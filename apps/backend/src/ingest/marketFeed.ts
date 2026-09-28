/**
 * The backend's in-memory view of the latest price per market.
 *
 * Deliberately dumb: it holds what the venue feed pushed and answers how old
 * it is. No I/O, no websocket, no venue types beyond PriceUpdate — the feed
 * that fills it is a Venue behind the Venue interface, and swapping venues
 * must not touch this file.
 *
 * Two questions live here and they are NOT the same question:
 *
 *   "how old is this price?"        -> ageMs / isPriceOld. A quiet market on a
 *                                      healthy feed has an old price that is
 *                                      the venue's current truth.
 *   "can I act on this at all?"     -> canAct, which needs FeedHealth, because
 *                                      only connection state distinguishes a
 *                                      quiet market from a frozen one.
 *
 * Age alone must never gate an action. For the first few seconds a dead feed
 * and a quiet market look identical, and after that the quiet market is still
 * fine while the dead one is dangerous.
 */
import type { FeedHealth, PriceUpdate } from '@perpguard/shared';

/** Why a market cannot be acted on right now. */
export type PriceGateCode =
  /** The feed is down or retrying; every held price is frozen. */
  | 'feed-disconnected'
  /** The feed is healthy but has never sent this market a price. */
  | 'no-price';

/**
 * Whether prices for one market can be acted on, and why not if they cannot.
 *
 * `priceIsOld` is reported alongside rather than folded into `ok`: an old
 * price on a connected feed is a quiet market, which is actionable and should
 * merely be labelled with its age.
 */
export interface PriceGate {
  readonly ok: boolean;
  readonly code?: PriceGateCode;
  /** Human-readable, safe to render next to a disabled control. */
  readonly reason?: string;
  readonly feed: FeedHealth['state'];
  /** Undefined when no price has ever arrived for this market. */
  readonly ageMs: number | undefined;
  /** Age exceeds STALE_MS. Informational — it does not by itself block. */
  readonly priceIsOld: boolean;
}

export class MarketFeed {
  readonly #staleMs: number;
  readonly #now: () => number;
  readonly #byMarketId = new Map<number, PriceUpdate>();
  /** Symbol -> market id, so callers can ask either way. */
  readonly #bySymbol = new Map<string, number>();

  /**
   * @param staleMs from STALE_MS, via loadAppConfig. Passed in rather than
   * read here so this stays pure and testable. It decides when a price is
   * LABELLED old, not when acting is refused.
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

  marketIdFor(symbol: string): number | undefined {
    return this.#bySymbol.get(symbol);
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
   * Whether this price is older than STALE_MS.
   *
   * This is a LABEL, not a verdict. On Perpl a mark price only changes when it
   * moves, so a market that has not traded recently reports true while being
   * completely healthy and completely actionable. Use it to show an age in the
   * UI. Use canAct() to decide anything.
   *
   * A market with no price at all reports true: there is nothing here that
   * could be fresh.
   */
  isPriceOld(marketId: number): boolean {
    const ageMs = this.ageMs(marketId);
    return ageMs === undefined || ageMs > this.#staleMs;
  }

  isPriceOldBySymbol(symbol: string): boolean {
    const marketId = this.#bySymbol.get(symbol);
    return marketId === undefined ? true : this.isPriceOld(marketId);
  }

  /** Market ids whose price is older than STALE_MS. Quiet markets included. */
  oldPriceMarketIds(): number[] {
    return [...this.#byMarketId.keys()].filter((id) => this.isPriceOld(id));
  }

  /**
   * Whether prices for this market can be acted on, given the feed's health.
   *
   * The rule, and the whole reason this takes FeedHealth: acting is refused
   * when the FEED is not connected, never because a price is merely old. A
   * disconnected feed means every held price is frozen at whatever it was when
   * the connection died, and the market may have moved arbitrarily far since.
   * A quiet market on a live feed is the venue's current truth and stays fully
   * actionable — it just gets its age shown.
   *
   * Health is passed in rather than fetched so this stays pure.
   */
  canAct(marketId: number, feed: FeedHealth): PriceGate {
    const ageMs = this.ageMs(marketId);
    const priceIsOld = this.isPriceOld(marketId);
    const base = { feed: feed.state, ageMs, priceIsOld } as const;

    if (feed.state !== 'connected') {
      return {
        ...base,
        ok: false,
        code: 'feed-disconnected',
        reason:
          feed.reason ??
          `the price feed is ${feed.state}, so every price we hold is frozen and may be wrong`,
      };
    }

    if (ageMs === undefined) {
      return {
        ...base,
        ok: false,
        code: 'no-price',
        reason: 'the feed is connected but has never sent a price for this market',
      };
    }

    // Connected, and we have a price. Old or not, it is the venue's latest.
    return { ...base, ok: true };
  }

  canActBySymbol(symbol: string, feed: FeedHealth): PriceGate {
    const marketId = this.#bySymbol.get(symbol);
    if (marketId === undefined) {
      return {
        ok: false,
        code: feed.state === 'connected' ? 'no-price' : 'feed-disconnected',
        reason:
          feed.state === 'connected'
            ? `the feed is connected but has never sent a price for ${symbol}`
            : (feed.reason ?? `the price feed is ${feed.state}`),
        feed: feed.state,
        ageMs: undefined,
        priceIsOld: true,
      };
    }
    return this.canAct(marketId, feed);
  }
}
