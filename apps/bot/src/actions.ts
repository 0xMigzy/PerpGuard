/**
 * The port a button tap goes through, and the short-lived store that holds what
 * the button meant.
 *
 * NOTHING HERE EXECUTES ANYTHING. This is the port; the implementation that
 * actually sends lives in `apps/backend/src/actions` and reaches the bot through
 * `VenueActionExecutor` in `executor.ts` next door.
 *
 * The reason that layer exists at all, and the reason this port's outcome type is
 * shaped the way it is: adding margin on Perpl comes back `st: 7 Failed,
 * sr: 32 OrderDescIdTooLow` on `mt: 24` while the collateral IS credited. So an
 * implementation has to reconcile against the position's `c` before and after,
 * must never re-send on the reported failure, and must never report that failure
 * to the user. A naive send would double a trader's collateral the first time the
 * venue lied about it — that happened during the investigation, 0.0559 ->
 * 0.083584 -> 0.111268 AUSD. See CLAUDE.md and `docs/evidence.md`.
 *
 * {@link StubActionExecutor} is still here for the tests and for a bot wired
 * without a trading session, and it still refuses to pretend it acted.
 */
import type { ActionAvailability } from '@perpguard/shared';
import type { AlertAction } from '@perpguard/backend/alerts';

/**
 * What an execution attempt reports.
 *
 * THERE IS EXACTLY ONE THING THAT EARNS `applied`, AND IT IS NOT THE VENUE'S
 * WORD. It is the position itself: the margin read before the action, read again
 * after, showing the delta that was asked for. Nothing else counts — not
 * `mt: 3`, which means forwarded and nothing more, and emphatically not
 * `mt: 24`, which for a top-up comes back `st: 7 Failed, sr: 32
 * OrderDescIdTooLow` while the collateral is credited in full.
 *
 * This type had no success variant at all while the reconciliation did not exist,
 * because "we have not built this" and "your margin is in" must never be
 * representable by the same shape. The variant is here now because
 * `apps/backend/src/actions` reconciles against the position and can therefore
 * say it. If that reconciliation is ever removed, this variant goes with it.
 *
 * `unknown` is a first-class outcome for the same reason. An action whose effect
 * cannot be established is neither success nor failure, and the one conclusion a
 * reader must never draw from it is "so try again".
 */
export type ExecutionOutcome =
  /**
   * Reconciled against the position, and the change is there.
   *
   * Earned by evidence, never by a status code.
   */
  | {
      readonly kind: 'applied';
      readonly detail: string;
      /**
       * The venue reported a rejection, and reconciliation found the change
       * there anyway: the `t: 6` top-up's `sr 32`. Said on the outcome screen
       * WITH the fact that it applied, never as a failure.
       */
      readonly venueRejected?: boolean;
    }
  /** Sent, reconciled, and the position did not move. */
  | { readonly kind: 'not-applied'; readonly detail: string }
  /**
   * Sent, and what it did cannot be established.
   *
   * `nextStep` is mandatory: an unknown outcome that does not say what to do
   * about it is a dead end, and the user must not fill that silence with a retry.
   */
  | { readonly kind: 'unknown'; readonly detail: string; readonly nextStep: string }
  /** Built, but not wired. Honest, and never mistakable for a fill. */
  | { readonly kind: 'not-implemented'; readonly detail: string }
  /** Refused before submission — an unavailable market, a `fw` flag that is false. */
  | { readonly kind: 'refused'; readonly detail: string }
  /**
   * Sent, outcome not yet known. What `mt: 3` earns and nothing more.
   *
   * Kept for a venue that admits a request and cannot be reconciled at all.
   */
  | { readonly kind: 'submitted'; readonly detail: string };

export interface ExecuteRequest {
  /** One in-flight action per position; also the `action_log` row key. */
  readonly idempotencyKey: string;
  /** The app user whose position this is. */
  readonly userId: string;
  /** The account the requesting chat is linked to, resolved at request time. */
  readonly accountId?: number;
  /** The action exactly as it was rendered, amount included. Never re-derived. */
  readonly action: AlertAction;
}

/**
 * Where a confirmed tap goes.
 *
 * `availability` is part of the port rather than a separate dependency because
 * both questions are asked of the SAME venue — the ACTING one, which is not the
 * venue a position was read from. Analytics runs on mainnet and actions on
 * testnet, and the two do not list the same markets.
 */
export interface ActionExecutor {
  /** @param symbol canonical ticker, e.g. 'BTC'. */
  availability(symbol: string): Promise<ActionAvailability>;
  execute(request: ExecuteRequest): Promise<ExecutionOutcome>;
}

export interface StubActionExecutorOptions {
  /** Injected so the bot can be exercised against an unavailable market. */
  readonly availability?: (symbol: string) => Promise<ActionAvailability>;
}

/** The placeholder executor. Answers availability; refuses to pretend it acted. */
export class StubActionExecutor implements ActionExecutor {
  readonly calls: ExecuteRequest[] = [];
  readonly #availability: ((symbol: string) => Promise<ActionAvailability>) | undefined;

  constructor(options: StubActionExecutorOptions = {}) {
    this.#availability = options.availability;
  }

  async availability(symbol: string): Promise<ActionAvailability> {
    if (this.#availability !== undefined) return this.#availability(symbol);
    // Nothing to ask yet. Saying "read only" rather than "available" keeps the
    // bot from offering a live button it cannot honour.
    return {
      actionable: false,
      network: 'testnet',
      code: 'venue-read-only',
      reason: 'no acting venue is wired up yet, so PerpGuard cannot send this action',
    };
  }

  async execute(request: ExecuteRequest): Promise<ExecutionOutcome> {
    this.calls.push(request);
    return {
      kind: 'not-implemented',
      detail:
        'Execution lands in the next piece of work. Nothing was sent — add the ' +
        'margin in the Perpl app for now.',
    };
  }
}

/** One action parked between the button being sent and the button being tapped. */
export interface PendingAction {
  readonly token: string;
  /** Who may tap it. A token handed to one user is not a token for another. */
  readonly userId: string;
  readonly telegramUserId: number;
  readonly action: AlertAction;
  readonly createdAtMs: number;
}

export interface PendingActionStoreOptions {
  /**
   * How long a button stays live.
   *
   * IT EXPIRES ON PURPOSE, and the expiry is a safety property rather than
   * housekeeping. `amountCNS` is the top-up that reached a buffer at the moment
   * the message was rendered; twenty minutes and a moved mark later it is not
   * that amount any more. Letting an old button execute would send a figure the
   * user read in a context that no longer holds. Expiring sends them to
   * `/positions` for a current one.
   */
  readonly ttlMs?: number;
  /** Cap, so a chatty alert stream cannot grow this without bound. */
  readonly maxEntries?: number;
  readonly now?: () => number;
  /** Injected so tokens are deterministic under test. */
  readonly nextToken?: () => string;
}

/**
 * How long anything the user was shown an amount against stays live.
 *
 * EXPORTED so the custom-amount prompt shares it rather than declaring its own
 * fifteen minutes. The two expire for one reason — a figure quoted against a
 * mark stops being that figure when the mark moves — so they must expire
 * together, and two constants set to the same number is exactly how they stop
 * being the same number.
 */
export const ACTION_TTL_MS = 15 * 60_000;

const DEFAULT_TTL_MS = ACTION_TTL_MS;

/** Lowercase alnum, which is what {@link encodeCallback} accepts. */
function randomToken(): string {
  let token = '';
  while (token.length < 8) {
    token += Math.floor(Math.random() * 36 ** 6)
      .toString(36)
      .padStart(6, '0');
  }
  return token.slice(0, 8);
}

export class PendingActionStore {
  readonly #entries = new Map<string, PendingAction>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #nextToken: () => string;

  constructor(options: PendingActionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxEntries = options.maxEntries ?? 200;
    this.#now = options.now ?? Date.now;
    this.#nextToken = options.nextToken ?? randomToken;
  }

  get size(): number {
    return this.#entries.size;
  }

  put(entry: Omit<PendingAction, 'token' | 'createdAtMs'>): PendingAction {
    this.#sweep();
    if (this.#entries.size >= this.#maxEntries) {
      // Oldest first: Map preserves insertion order and entries are only ever
      // appended, so the first key is the oldest.
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    let token = this.#nextToken();
    while (this.#entries.has(token)) token = this.#nextToken();
    const pending: PendingAction = { ...entry, token, createdAtMs: this.#now() };
    this.#entries.set(token, pending);
    return pending;
  }

  /** The action behind a token, or undefined if it never existed or has expired. */
  get(token: string): PendingAction | undefined {
    this.#sweep();
    return this.#entries.get(token);
  }

  delete(token: string): void {
    this.#entries.delete(token);
  }

  #sweep(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [token, entry] of this.#entries) {
      if (entry.createdAtMs <= cutoff) this.#entries.delete(token);
    }
  }
}
