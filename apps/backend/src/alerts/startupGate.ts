/**
 * Holds alert delivery while the backend comes up, so a restart never sends
 * anyone "I cannot see this position".
 *
 * On boot every loop starts blind: the trading socket is signing in, the
 * position list is awaiting its snapshot, the watch loop has not read the
 * index yet. The engines decide alerts about that blindness exactly as they
 * should during a real outage — but during a restart it is not news, it is
 * the process starting. So everything the engines send is HELD here until
 * the first assessment pass completes cleanly, then:
 *
 *   - CLEAN OPEN (every loop assessed, nothing blind): the blind alerts held
 *     are dropped, and so is any "recovered" whose previous state was blind —
 *     a recovery from a blindness nobody was told about. Every real severity
 *     (WATCH, DANGER, past liquidation) is delivered.
 *   - DEADLINE OPEN (still not clean after the deadline): this is a real
 *     outage, not a restart, so everything held is delivered as decided.
 *
 * A dropped blind alert also drops the next "recovered" for the same
 * position and recipient after opening, for the same reason. Dropping is
 * reported as `suppressed`, which the engine logs and does not record as a
 * delivery or a failure.
 */
import type { AlertMessage, AlertRecipient, AlertTransport, DeliveryResult } from './types.ts';

export interface StartupGateOptions {
  readonly inner: AlertTransport;
  /**
   * True once THIS SCOPE has completed a pass with nothing blind. A scope is
   * one linked account (`account:<id>`), the watched wallets (`watch`), or
   * `global` for anything else. PER SCOPE (7 Oct 2026): one person's broken
   * key must not hold everyone else's alerts for the whole deadline.
   */
  readonly isClean: (scope: string) => boolean;
  /** Open regardless after this long: by then blindness is an outage, not a restart. */
  readonly deadlineMs: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly logger?: { info(message: string): void; warn(message: string): void };
}

const BLIND = new Set(['feed-down', 'positions-untrusted']);
const isBlindState = (state: string | undefined): boolean => state === 'FEED_DOWN' || state === 'POSITIONS_UNTRUSTED';

/** Which scope an alert waits on: its linked account, the watch tier, or the whole process. */
export function scopeOf(message: AlertMessage): string {
  if (message.watch !== undefined) return 'watch';
  if (message.accountId !== undefined) return `account:${message.accountId}`;
  return 'global';
}

interface Held {
  readonly scope: string;
  readonly recipient: AlertRecipient;
  readonly message: AlertMessage;
  readonly resolve: (result: DeliveryResult) => void;
}

export class StartupDeliveryGate implements AlertTransport {
  readonly #options: StartupGateOptions;
  readonly #now: () => number;
  readonly #startedAtMs: number;
  readonly #held: Held[] = [];
  /** Each scope that has opened, and how. */
  readonly #opened = new Map<string, 'clean' | 'deadline'>();
  /** Position+recipient keys whose blind alert was dropped; their next recovery is dropped too. */
  readonly #droppedBlind = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: StartupGateOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#startedAtMs = this.#now();
  }

  /** Start watching for the moment to open each scope. */
  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.check(), this.#options.pollMs ?? 1_000);
    this.#timer.unref?.();
  }

  /** Holding while anything is held; otherwise how the scopes opened (a deadline anywhere says so). */
  get state(): 'holding' | 'clean' | 'deadline' {
    if (this.#held.length > 0 || this.#opened.size === 0) return 'holding';
    return [...this.#opened.values()].includes('deadline') ? 'deadline' : 'clean';
  }

  get heldCount(): number {
    return this.#held.length;
  }

  /** How a scope opened, or undefined while it is still held. For tests. */
  scopeState(scope: string): 'clean' | 'deadline' | undefined {
    return this.#opened.get(scope);
  }

  #pastDeadline(): boolean {
    return this.#now() - this.#startedAtMs >= this.#options.deadlineMs;
  }

  /** One look at every scope with something held: open it if clean, or if the deadline has passed. Exposed for tests. */
  check(): void {
    for (const scope of new Set(this.#held.map((h) => h.scope))) {
      if (this.#options.isClean(scope)) this.#openNow(scope, 'clean');
      else if (this.#pastDeadline()) this.#openNow(scope, 'deadline');
    }
    if (this.#held.length === 0 && this.#pastDeadline() && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async send(recipient: AlertRecipient, message: AlertMessage): Promise<DeliveryResult> {
    const scope = scopeOf(message);
    if (!this.#opened.has(scope)) {
      // A scope opens at its first alert when it is already clean (nothing to hold) or the deadline has passed.
      if (this.#options.isClean(scope)) this.#openNow(scope, 'clean');
      else if (this.#pastDeadline()) this.#openNow(scope, 'deadline');
      else return new Promise<DeliveryResult>((resolve) => this.#held.push({ scope, recipient, message, resolve }));
    }
    const key = keyOf(recipient, message);
    if (message.kind === 'recovered' && this.#droppedBlind.has(key)) {
      this.#droppedBlind.delete(key);
      return suppressed('a recovery from a startup blindness nobody was told about');
    }
    return this.#options.inner.send(recipient, message);
  }

  #openNow(scope: string, how: 'clean' | 'deadline'): void {
    this.#opened.set(scope, how);
    const held: Held[] = [];
    for (let i = this.#held.length - 1; i >= 0; i--) if (this.#held[i]!.scope === scope) held.unshift(...this.#held.splice(i, 1));
    let dropped = 0;
    for (const h of held) {
      if (how === 'clean' && BLIND.has(h.message.kind)) {
        this.#droppedBlind.add(keyOf(h.recipient, h.message));
        h.resolve(suppressed('the backend was starting, and this account came up clean'));
        dropped += 1;
      } else if (how === 'clean' && h.message.kind === 'recovered' && isBlindState(h.message.previousState)) {
        h.resolve(suppressed('a recovery from the startup blindness'));
        dropped += 1;
      } else {
        void this.#options.inner.send(h.recipient, h.message).then(h.resolve, (error: unknown) => h.resolve({ ok: false, reason: String(error), retryable: true }));
      }
    }
    const after = Math.round((this.#now() - this.#startedAtMs) / 1000);
    const line = `alert delivery opened for ${scope} (${how}) after ${after}s: ${held.length} held, ${dropped} startup blindness alert(s) dropped, ${held.length - dropped} delivered`;
    if (how === 'clean') this.#options.logger?.info(line);
    else this.#options.logger?.warn(`${line} — the deadline passed before ${scope} was clean, so this is treated as a real outage`);
  }
}

function keyOf(recipient: AlertRecipient, message: AlertMessage): string {
  return `${message.watch?.accountId ?? message.accountId ?? '-'}:${message.marketId}:${recipient.userId}`;
}

function suppressed(reason: string): DeliveryResult {
  return { ok: false, suppressed: true, reason, retryable: false };
}
