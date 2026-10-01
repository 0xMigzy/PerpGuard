/**
 * Stale-while-revalidate for answers that cost seconds and change once a block.
 *
 * The analytics figures are aggregates over millions of indexed rows: a 30-day
 * protocol window is five scans of the fill table, run twice for the
 * previous-period comparison, and it measured 3.6s on a quiet box and 5s once
 * a page's other six calls were queued behind it. Nothing about those numbers
 * changes faster than a block, and a page polls them every 30 seconds, so a
 * fresh build per request spends almost all of its time redoing the previous
 * one while the reader waits.
 *
 * THE RULE: SERVE WHAT WE HAVE, SAY HOW OLD IT IS, REFRESH BEHIND IT. A request
 * blocks only when there is nothing to serve at all. Past the TTL the cached
 * value is still returned — immediately — and ONE refresh is started behind
 * it; concurrent callers share that refresh rather than each starting one. The
 * age travels with the value so a page can show "computed 40s ago" instead of
 * presenting a snapshot as the present, which is the same honesty rule the
 * indexer-health envelope already follows.
 *
 * A REFRESH THAT FAILS KEEPS THE OLD VALUE. A transient database error must not
 * blank a dashboard that was fine a second ago; the failure is logged, the age
 * keeps growing, and the next request tries again.
 *
 * Pure apart from the injected clock and the loaders it is handed.
 */

export interface CacheEntry<T> {
  readonly value: T;
  /** When the value was COMPUTED, not when it was served. */
  readonly cachedAtMs: number;
  readonly ageMs: number;
  /** True when this answer is past its TTL and a refresh is running behind it. */
  readonly revalidating: boolean;
}

interface Slot {
  value: unknown;
  cachedAtMs: number;
  inFlight: Promise<unknown> | undefined;
}

export interface SwrCacheOptions {
  readonly now?: () => number;
  readonly onRefreshError?: (key: string, error: unknown) => void;
  /** Entries untouched for this long are dropped on the next sweep. */
  readonly idleEvictMs?: number;
}

const DEFAULT_IDLE_EVICT_MS = 30 * 60_000;

export class SwrCache {
  readonly #slots = new Map<string, Slot>();
  readonly #lastReadMs = new Map<string, number>();
  readonly #now: () => number;
  readonly #onRefreshError: ((key: string, error: unknown) => void) | undefined;
  readonly #idleEvictMs: number;

  constructor(options: SwrCacheOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onRefreshError = options.onRefreshError;
    this.#idleEvictMs = options.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS;
  }

  get size(): number {
    return this.#slots.size;
  }

  /**
   * The value for `key`, computed by `load` when there is none.
   *
   * Fresh: returned as is. Stale: returned as is AND refreshed once behind the
   * caller. Missing: awaited, with concurrent callers joining one load.
   */
  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<CacheEntry<T>> {
    const now = this.#now();
    this.#lastReadMs.set(key, now);
    this.#sweep(now);
    const slot = this.#slots.get(key);

    if (slot === undefined || slot.value === undefined) {
      const value = await this.#load(key, load);
      return { value, cachedAtMs: this.#now(), ageMs: 0, revalidating: false };
    }

    const ageMs = now - slot.cachedAtMs;
    if (ageMs >= ttlMs && slot.inFlight === undefined) {
      // Behind the caller. Errors are reported, never thrown at a reader who
      // was handed a perfectly good value.
      void this.#load(key, load).catch((error: unknown) => this.#onRefreshError?.(key, error));
    }
    return { value: slot.value as T, cachedAtMs: slot.cachedAtMs, ageMs, revalidating: slot.inFlight !== undefined };
  }

  /** Compute `key` now, whatever its age. Used to warm the default views at boot. */
  async warm<T>(key: string, load: () => Promise<T>): Promise<void> {
    await this.#load(key, load);
  }

  /** Age of the cached answer, or undefined when there is none. For tests and health. */
  ageOf(key: string): number | undefined {
    const slot = this.#slots.get(key);
    return slot === undefined || slot.value === undefined ? undefined : this.#now() - slot.cachedAtMs;
  }

  /** Keys read within the last `withinMs`: the hot set worth keeping warm. */
  recentlyRead(withinMs: number): readonly string[] {
    const cutoff = this.#now() - withinMs;
    return [...this.#lastReadMs].filter(([, at]) => at >= cutoff).map(([key]) => key);
  }

  #load<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#slots.get(key);
    if (existing?.inFlight !== undefined) return existing.inFlight as Promise<T>;
    const slot: Slot = existing ?? { value: undefined, cachedAtMs: 0, inFlight: undefined };
    this.#slots.set(key, slot);
    const inFlight = load().then(
      (value) => {
        slot.value = value;
        slot.cachedAtMs = this.#now();
        slot.inFlight = undefined;
        return value;
      },
      (error: unknown) => {
        slot.inFlight = undefined;
        // A slot that never held a value is removed, so the next caller loads
        // rather than finding an empty shell and treating it as cached.
        if (slot.value === undefined) this.#slots.delete(key);
        throw error;
      },
    );
    slot.inFlight = inFlight;
    return inFlight;
  }

  #sweep(now: number): void {
    for (const [key, at] of this.#lastReadMs) {
      if (now - at <= this.#idleEvictMs) continue;
      const slot = this.#slots.get(key);
      if (slot?.inFlight !== undefined) continue;
      this.#slots.delete(key);
      this.#lastReadMs.delete(key);
    }
  }
}
