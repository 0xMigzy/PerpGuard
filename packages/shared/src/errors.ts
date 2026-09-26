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
