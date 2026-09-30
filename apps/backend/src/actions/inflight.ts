/**
 * One in-flight action per position.
 *
 * REFUSED, NEVER QUEUED, and the difference matters. A queue would hold a
 * second top-up and send it the moment the first settled — which, for the one
 * action that reports failure while applying in full, is the exact shape of the
 * bug that added a trader's margin twice. A refusal makes the user look at the
 * position again and decide with current numbers.
 *
 * KEYED ON MARKET ID, not on `positionId`. Three reasons, in order of weight:
 * the venue handle is optional on a position and an action with none is refused
 * before it ever reaches here; the risk loop already tracks one position per
 * market, so the market id is the key every other layer agrees on; and a market
 * that goes flat and reopens gets a NEW position id, so keying on it would let a
 * second action through against what is, to a trader, the same exposure.
 *
 * Synchronous by construction. `claim` does no I/O and cannot yield, so two
 * callers racing on one event-loop turn cannot both win — which is the only
 * guarantee that makes this a lock rather than a suggestion.
 */

export interface Lease {
  readonly marketId: number;
  readonly idempotencyKey: string;
  readonly claimedAtMs: number;
}

export type ClaimResult =
  | { readonly ok: true; readonly lease: Lease }
  | {
      readonly ok: false;
      /** The action that holds it, so a refusal can name what to wait for. */
      readonly held: Lease;
      readonly reason: string;
    };

export interface InFlightRegistryOptions {
  readonly now?: () => number;
  /**
   * How long a lease may be held before it is treated as abandoned.
   *
   * A BACKSTOP FOR A CRASH, NOT A TIMEOUT FOR AN ACTION. Every path through the
   * executor releases its lease in a `finally`, so this only fires if the process
   * died mid-action or a `finally` was somehow skipped. Without it a single
   * abandoned lease would lock one position out of every future rescue for the
   * lifetime of the process, which is a worse failure than the duplicate it
   * guards against — the position that most needs a top-up would be the one that
   * could not have one.
   *
   * Generous on purpose: an action's own settle wait is seconds, so anything
   * still held after this is not slow, it is gone.
   */
  readonly staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export class InFlightRegistry {
  readonly #leases = new Map<number, Lease>();
  readonly #now: () => number;
  readonly #staleAfterMs: number;

  constructor(options: InFlightRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  get size(): number {
    this.#sweep();
    return this.#leases.size;
  }

  /** The lease on a market, if one is live. For reporting, not for gating. */
  held(marketId: number): Lease | undefined {
    this.#sweep();
    return this.#leases.get(marketId);
  }

  claim(marketId: number, idempotencyKey: string): ClaimResult {
    this.#sweep();
    const existing = this.#leases.get(marketId);
    if (existing !== undefined) {
      const heldForMs = this.#now() - existing.claimedAtMs;
      return {
        ok: false,
        held: existing,
        reason:
          `an action on market ${marketId} is already in flight (${existing.idempotencyKey}, ` +
          `sent ${heldForMs}ms ago) and has not settled. Refusing rather than queueing: a ` +
          `second action sent behind the first is how the same top-up lands twice. Wait for it ` +
          `to settle, then read the position again.`,
      };
    }

    const lease: Lease = { marketId, idempotencyKey, claimedAtMs: this.#now() };
    this.#leases.set(marketId, lease);
    return { ok: true, lease };
  }

  /**
   * Release a lease.
   *
   * Only ever releases the caller's OWN lease. A release that matched on market
   * alone would let a stale `finally` from an abandoned action free the lock a
   * live action is holding — and then two actions really would be in flight at
   * once, with nothing left to notice.
   */
  release(lease: Lease): void {
    const existing = this.#leases.get(lease.marketId);
    if (existing?.idempotencyKey === lease.idempotencyKey) {
      this.#leases.delete(lease.marketId);
    }
  }

  #sweep(): void {
    const cutoff = this.#now() - this.#staleAfterMs;
    for (const [marketId, lease] of this.#leases) {
      if (lease.claimedAtMs <= cutoff) this.#leases.delete(marketId);
    }
  }
}
