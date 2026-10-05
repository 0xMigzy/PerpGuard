import {
  FUNDING_VENUES,
  venueCell,
  type ExternalFundingQuote,
  type ExternalFundingSnapshot,
  type FundingVenueId,
  type VenueFundingCell,
  type VenueFundingMarket,
  type VenueFundingPayload,
  type VenueFundingStatus,
} from '@perpguard/shared';

/**
 * Other venues' funding, held server-side. The browser never calls Hyperliquid
 * or Binance: it reads this, through the backend's own route.
 *
 * POLLED ONLY WHILE READ. A read older than `ttlMs` starts one refresh per
 * venue (never two at once); nobody reading means no outbound calls at all.
 * At the defaults that is at most one Hyperliquid request and two Binance
 * requests (weight 11) a minute, however many people have the page open.
 *
 * A FAILED VENUE NEVER BLOCKS THE OTHERS OR THE PAGE. Its last good figures
 * are served with their age until `unavailableAfterMs`; past that it is
 * `unavailable` and none of its old figures are shown as current. A read waits
 * for a venue (at most `firstWaitMs`) only when it would otherwise have
 * nothing current to show: the first read, or the first after an idle spell.
 */
export interface VenueFundingStoreOptions {
  /** Each venue's read. `wantedTickers` are Perpl's live tickers. */
  readonly fetchers: Readonly<Record<FundingVenueId, (wantedTickers: readonly string[]) => Promise<ExternalFundingSnapshot>>>;
  readonly ttlMs?: number;
  readonly unavailableAfterMs?: number;
  readonly firstWaitMs?: number;
  readonly now?: () => number;
  readonly onError?: (venue: FundingVenueId, error: unknown) => void;
}

export const VENUE_FUNDING_TTL_MS = 60_000;
export const VENUE_FUNDING_UNAVAILABLE_AFTER_MS = 3 * 60_000;

interface Slot {
  good: { readonly quotes: readonly ExternalFundingQuote[]; readonly atMs: number } | undefined;
  lastError: { readonly atMs: number; readonly message: string } | undefined;
  lastAttemptAtMs: number | undefined;
  inFlight: Promise<void> | undefined;
}

export interface VenueReading {
  readonly status: VenueFundingStatus;
  /** Empty when unavailable. */
  readonly quotes: readonly ExternalFundingQuote[];
}

/** A short, renderable reason. Never a stack, never a header. */
export function describeFetchError(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timed out';
  if (error instanceof Error && /HTTP \d{3}/.test(error.message)) return error.message.match(/HTTP \d{3}/)![0];
  if (error instanceof Error && /fetch failed/i.test(error.message)) return 'could not connect';
  return 'unreadable reply';
}

export class VenueFundingStore {
  readonly #fetchers: VenueFundingStoreOptions['fetchers'];
  readonly #ttlMs: number;
  readonly #unavailableAfterMs: number;
  readonly #firstWaitMs: number;
  readonly #now: () => number;
  readonly #onError: VenueFundingStoreOptions['onError'];
  readonly #slots = new Map<FundingVenueId, Slot>(FUNDING_VENUES.map((v) => [v, { good: undefined, lastError: undefined, lastAttemptAtMs: undefined, inFlight: undefined }]));

  constructor(options: VenueFundingStoreOptions) {
    this.#fetchers = options.fetchers;
    this.#ttlMs = options.ttlMs ?? VENUE_FUNDING_TTL_MS;
    this.#unavailableAfterMs = options.unavailableAfterMs ?? VENUE_FUNDING_UNAVAILABLE_AFTER_MS;
    this.#firstWaitMs = options.firstWaitMs ?? 8_000;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError;
  }

  async read(wantedTickers: readonly string[]): Promise<Readonly<Record<FundingVenueId, VenueReading>>> {
    const entries = await Promise.all(FUNDING_VENUES.map(async (venue) => [venue, await this.#readVenue(venue, wantedTickers)] as const));
    return Object.fromEntries(entries) as Record<FundingVenueId, VenueReading>;
  }

  async #readVenue(venue: FundingVenueId, wanted: readonly string[]): Promise<VenueReading> {
    const slot = this.#slots.get(venue)!;
    const now = this.#now();
    if (slot.inFlight === undefined && (slot.lastAttemptAtMs === undefined || now - slot.lastAttemptAtMs >= this.#ttlMs)) {
      slot.lastAttemptAtMs = now;
      slot.inFlight = this.#fetchers[venue](wanted).then(
        (snapshot) => {
          slot.good = { quotes: snapshot.quotes, atMs: this.#now() };
          slot.inFlight = undefined;
        },
        (error: unknown) => {
          slot.lastError = { atMs: this.#now(), message: describeFetchError(error) };
          slot.inFlight = undefined;
          this.#onError?.(venue, error);
        },
      );
    }
    // Wait (briefly) whenever the answer would otherwise be "unavailable": on
    // the first read, and after an idle spell longer than the window. Nobody
    // reading for ten minutes is not an outage; only a refresh that fails is.
    if (slot.inFlight !== undefined && !this.#fresh(slot)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([slot.inFlight, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#firstWaitMs)))]);
      clearTimeout(timer);
    }
    return this.#reading(slot);
  }

  #fresh(slot: Slot): boolean {
    return slot.good !== undefined && this.#now() - slot.good.atMs <= this.#unavailableAfterMs;
  }

  #reading(slot: Slot): VenueReading {
    const fresh = this.#fresh(slot);
    const failedSinceGood = slot.lastError !== undefined && slot.lastError.atMs >= (slot.good?.atMs ?? 0);
    const status: VenueFundingStatus = {
      state: fresh ? 'ok' : 'unavailable',
      lastGoodAtMs: slot.good?.atMs,
      ...(failedSinceGood ? { error: slot.lastError!.message } : {}),
    };
    return { status, quotes: fresh ? slot.good!.quotes : [] };
  }
}

/**
 * Perpl's live markets against each venue. Pure. A venue that is unavailable
 * gives every market an `unavailable` cell; otherwise the cell is matched by
 * ticker and confirmed by price (`venueCell`).
 */
export function buildVenueFundingPayload(
  markets: readonly { readonly marketId: number; readonly symbol: string; readonly markPrice: number }[],
  readings: Readonly<Record<FundingVenueId, VenueReading>>,
): VenueFundingPayload {
  const rows: VenueFundingMarket[] = markets.map((m) => {
    const cells = Object.fromEntries(
      FUNDING_VENUES.map((venue): [FundingVenueId, VenueFundingCell] => [
        venue,
        readings[venue].status.state === 'unavailable' ? { kind: 'unavailable' } : venueCell(m.symbol, m.markPrice, readings[venue].quotes),
      ]),
    ) as Record<FundingVenueId, VenueFundingCell>;
    return { marketId: m.marketId, symbol: m.symbol, perplMarkPrice: m.markPrice, venues: cells };
  });
  return {
    markets: rows,
    venues: Object.fromEntries(FUNDING_VENUES.map((v) => [v, readings[v].status])) as Record<FundingVenueId, VenueFundingStatus>,
  };
}
