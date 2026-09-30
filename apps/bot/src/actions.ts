/**
 * The port a button tap goes through, and the short-lived store that holds what
 * the button meant.
 *
 * NOTHING HERE EXECUTES ANYTHING YET. The executor is stubbed on purpose: adding
 * margin on Perpl comes back `st: 7 Failed, sr: 32 OrderDescIdTooLow` on
 * `mt: 24` while the collateral IS credited, so the real implementation has to
 * reconcile against the position's `c` before and after, must never re-send on
 * the reported failure, and must never report that failure to the user. A naive
 * send wired up today would double a trader's collateral the first time the
 * venue lied about it — that happened during the investigation, 0.0559 ->
 * 0.083584 -> 0.111268 AUSD. See CLAUDE.md and `docs/evidence.md`.
 *
 * So the port exists, the confirmation screen exists, and execution says plainly
 * that it lands next.
 */
import type { ActionAvailability } from '@perpguard/shared';
import type { AlertAction } from '@perpguard/backend/alerts';

/**
 * What an execution attempt reports.
 *
 * THERE IS NO SUCCESS VARIANT, and that is the same discipline as `mt: 3` not
 * being success: nothing in this codebase may claim an action landed until
 * something has actually confirmed it did. Adding a `succeeded` case before the
 * reconciliation exists would make "we have not built this" and "your margin is
 * in" representable by the same shape.
 */
export type ExecutionOutcome =
  /** Built, but not wired. Honest, and never mistakable for a fill. */
  | { readonly kind: 'not-implemented'; readonly detail: string }
  /** Refused before submission — an unavailable market, a `fw` flag that is false. */
  | { readonly kind: 'refused'; readonly detail: string }
  /**
   * Sent, outcome not yet known. What `mt: 3` earns and nothing more.
   * Unused today; declared so the real executor need not widen the type.
   */
  | { readonly kind: 'submitted'; readonly detail: string };

export interface ExecuteRequest {
  /** One in-flight action per position; also the `action_log` row key. */
  readonly idempotencyKey: string;
  /** The app user whose position this is. */
  readonly userId: string;
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
