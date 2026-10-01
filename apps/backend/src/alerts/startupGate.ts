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
  /** True once every loop has completed a pass with nothing blind. */
  readonly isClean: () => boolean;
  /** Open regardless after this long: by then blindness is an outage, not a restart. */
  readonly deadlineMs: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly logger?: { info(message: string): void; warn(message: string): void };
}

const BLIND = new Set(['feed-down', 'positions-untrusted']);
const isBlindState = (state: string | undefined): boolean => state === 'FEED_DOWN' || state === 'POSITIONS_UNTRUSTED';

interface Held {
  readonly recipient: AlertRecipient;
  readonly message: AlertMessage;
  readonly resolve: (result: DeliveryResult) => void;
}

export class StartupDeliveryGate implements AlertTransport {
  readonly #options: StartupGateOptions;
  readonly #now: () => number;
  readonly #startedAtMs: number;
  readonly #held: Held[] = [];
  /** Position+recipient keys whose blind alert was dropped; their next recovery is dropped too. */
  readonly #droppedBlind = new Set<string>();
  #open: 'clean' | 'deadline' | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: StartupGateOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#startedAtMs = this.#now();
  }

  /** Start watching for the moment to open. */
  start(): void {
    if (this.#timer !== undefined || this.#open !== undefined) return;
    this.#timer = setInterval(() => this.check(), this.#options.pollMs ?? 1_000);
    this.#timer.unref?.();
  }

  get state(): 'holding' | 'clean' | 'deadline' {
    return this.#open ?? 'holding';
  }

  get heldCount(): number {
    return this.#held.length;
  }

  /** One look: open if clean, or if the deadline has passed. Exposed for tests. */
  check(): void {
    if (this.#open !== undefined) return;
    if (this.#options.isClean()) this.#openNow('clean');
    else if (this.#now() - this.#startedAtMs >= this.#options.deadlineMs) this.#openNow('deadline');
  }

  async send(recipient: AlertRecipient, message: AlertMessage): Promise<DeliveryResult> {
    if (this.#open === undefined) {
      return new Promise<DeliveryResult>((resolve) => this.#held.push({ recipient, message, resolve }));
    }
    const key = keyOf(recipient, message);
    if (message.kind === 'recovered' && this.#droppedBlind.has(key)) {
      this.#droppedBlind.delete(key);
      return suppressed('a recovery from a startup blindness nobody was told about');
    }
    return this.#options.inner.send(recipient, message);
  }

  #openNow(how: 'clean' | 'deadline'): void {
    this.#open = how;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    const held = this.#held.splice(0);
    let dropped = 0;
    for (const h of held) {
      if (how === 'clean' && BLIND.has(h.message.kind)) {
        this.#droppedBlind.add(keyOf(h.recipient, h.message));
        h.resolve(suppressed('the backend was starting, and every loop came up clean'));
        dropped += 1;
      } else if (how === 'clean' && h.message.kind === 'recovered' && isBlindState(h.message.previousState)) {
        h.resolve(suppressed('a recovery from the startup blindness'));
        dropped += 1;
      } else {
        void this.#options.inner.send(h.recipient, h.message).then(h.resolve, (error: unknown) => h.resolve({ ok: false, reason: String(error), retryable: true }));
      }
    }
    const after = Math.round((this.#now() - this.#startedAtMs) / 1000);
    const line = `alert delivery opened (${how}) after ${after}s: ${held.length} held, ${dropped} startup blindness alert(s) dropped, ${held.length - dropped} delivered`;
    if (how === 'clean') this.#options.logger?.info(line);
    else this.#options.logger?.warn(`${line} — the deadline passed before every loop was clean, so this is treated as a real outage`);
  }
}

function keyOf(recipient: AlertRecipient, message: AlertMessage): string {
  return `${message.watch?.accountId ?? message.accountId ?? '-'}:${message.marketId}:${recipient.userId}`;
}

function suppressed(reason: string): DeliveryResult {
  return { ok: false, suppressed: true, reason, retryable: false };
}
