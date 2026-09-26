/** Base class for anything that goes wrong talking to a trading venue. */
export class VenueError extends Error {
  readonly venue: string;

  constructor(venue: string, message: string, options?: { cause?: unknown }) {
    super(`[${venue}] ${message}`, options);
    this.name = 'VenueError';
    this.venue = venue;
  }
}

/** A venue REST/WS call returned a non-2xx or unusable response. */
export class VenueRequestError extends VenueError {
  readonly status: number | undefined;
  readonly url: string;

  constructor(
    venue: string,
    url: string,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(venue, message, options);
    this.name = 'VenueRequestError';
    this.url = url;
    this.status = options?.status;
  }
}

/**
 * Sign-in to an authenticated venue channel failed.
 *
 * On Perpl this is websocket close code 3401: a bad signature, a timestamp
 * outside the ±30s window, a replayed nonce, or a revoked key. Never retried
 * with the same frame — the nonce is spent.
 */
export class VenueAuthError extends VenueError {
  readonly closeCode: number | undefined;

  constructor(venue: string, message: string, options?: { closeCode?: number; cause?: unknown }) {
    super(venue, message, options);
    this.name = 'VenueAuthError';
    this.closeCode = options?.closeCode;
  }
}

/**
 * An action was sent but its outcome never arrived.
 *
 * This is deliberately an error rather than an ActionResult: 'forwarded',
 * 'confirmed' and 'rejected' cannot express "we do not know", and a timed-out
 * order may still be resting, filling, or already filled. Callers must surface
 * it as unknown and reconcile — never as either success or failure.
 */
export class ActionTimeoutError extends VenueError {
  readonly idempotencyKey: string;
  /** Which wait expired: the mt 3 admission, or the mt 24 outcome. */
  readonly stage: 'ack' | 'result';
  readonly waitedMs: number;
  /** Perpl's `rq` idempotency key, for reconciliation against order history. */
  readonly requestId: number | undefined;
  /** The venue order id, when the order got far enough to have one. */
  readonly venueRef: string | undefined;

  constructor(
    venue: string,
    message: string,
    details: {
      idempotencyKey: string;
      stage: 'ack' | 'result';
      waitedMs: number;
      requestId?: number;
      venueRef?: string;
    },
  ) {
    super(venue, message);
    this.name = 'ActionTimeoutError';
    this.idempotencyKey = details.idempotencyKey;
    this.stage = details.stage;
    this.waitedMs = details.waitedMs;
    this.requestId = details.requestId;
    this.venueRef = details.venueRef;
  }
}

/**
 * Thrown by venue methods that are declared but not yet implemented.
 *
 * Stubs throw rather than resolving to an empty/neutral value on purpose: a
 * caller must never be able to mistake "not built yet" for "the action
 * succeeded". See the `mt: 3` vs `mt: 24` note on ActionResult.
 */
export class NotImplementedError extends VenueError {
  constructor(venue: string, method: string) {
    super(venue, `${method} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** Configuration could not be resolved from the environment. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
