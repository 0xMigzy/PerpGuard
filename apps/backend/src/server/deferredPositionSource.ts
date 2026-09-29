/**
 * A {@link PositionSource} that exists before the socket it will read from does.
 *
 * The risk loop, the bot and `/health` are all built at startup and all need a
 * position source; the real one cannot exist until the trading socket has signed
 * in, and sign-in may take a while or never happen at all. Building the whole
 * stack lazily instead would mean `/health` had nothing to report in exactly the
 * case it is most needed.
 *
 * SO THE GAP IS REPORTED, NOT PAPERED OVER. Until a real source is attached this
 * answers `awaiting-snapshot` with the sign-in reason — never `live`, and never
 * an empty `live` set, which would read as "you have no positions" when the
 * truth is "we have not been told". Those two must not look alike.
 */
import type { PositionSourceStatus, Unsubscribe, VenuePosition } from '@perpguard/shared';
import type { PositionSource } from '../risk/types.ts';

export interface DeferredPositionSourceOptions {
  /** Why there is no real source yet. Asked fresh each time, so it stays current. */
  readonly reason: () => string;
}

export class DeferredPositionSource implements PositionSource {
  readonly #reason: () => string;
  readonly #listeners = new Set<(positions: readonly VenuePosition[]) => void>();
  #inner: PositionSource | undefined;
  #detach: Unsubscribe | undefined;

  constructor(options: DeferredPositionSourceOptions) {
    this.#reason = options.reason;
  }

  get attached(): boolean {
    return this.#inner !== undefined;
  }

  /**
   * Hand over the real source.
   *
   * Its updates are forwarded to everyone already subscribed, and one is emitted
   * immediately: the snapshot that prompted the attach may already have arrived,
   * and a loop waiting for the next one would sit idle holding nothing.
   */
  attach(source: PositionSource): void {
    this.#detach?.();
    this.#inner = source;
    this.#detach = source.onSnapshot((positions) => {
      for (const listener of this.#listeners) listener(positions);
    });
    for (const listener of this.#listeners) listener(source.snapshot());
  }

  snapshot(): readonly VenuePosition[] {
    return this.#inner?.snapshot() ?? [];
  }

  onSnapshot(listener: (positions: readonly VenuePosition[]) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  status(): PositionSourceStatus {
    const inner = this.#inner;
    if (inner !== undefined) return inner.status();
    return {
      state: 'awaiting-snapshot',
      reason: this.#reason(),
      lastUpdateMs: undefined,
      ageMs: undefined,
    };
  }

  stop(): void {
    this.#detach?.();
    this.#detach = undefined;
  }
}
