/**
 * What the alert path has actually managed, for `/health` to report.
 *
 * An {@link AlertLog} DECORATOR rather than a getter on the engine. The engine
 * already writes exactly one row per attempt sequence and already treats a
 * failing log as non-fatal, so wrapping the log is the one place that sees every
 * outcome without the engine growing a second reporting path that could
 * disagree with the first.
 *
 * It NEVER SWALLOWS a write failure: the inner log's rejection propagates
 * unchanged, because the engine has its own handling for that and a decorator
 * that quietly succeeded would remove it.
 *
 * `lastFailure` is deliberately sticky — it is cleared by the next successful
 * delivery and by nothing else. A failure that scrolled away because a later
 * alert happened to land is a failure nobody would ever see.
 */
import type { AlertLog, AlertLogEntry } from '../alerts/types.ts';
import type { AlertDeliveryStatus } from './health.ts';

export interface AlertActivityOptions {
  readonly inner: AlertLog;
  /** Whether rows survive a restart. False for the in-memory log. */
  readonly durable: boolean;
  /** False when no transport is wired: warnings would go nowhere. */
  readonly transportConfigured: boolean;
  /** Why there is no transport. Safe to render; never contains a token. */
  readonly transportReason?: string;
}

export class AlertActivity implements AlertLog {
  readonly #inner: AlertLog;
  readonly #durable: boolean;
  readonly #transportConfigured: boolean;
  readonly #transportReason: string | undefined;

  #delivered = 0;
  #failed = 0;
  #lastDeliveredAtMs: number | undefined;
  #lastDelivered: string | undefined;
  #lastFailureAtMs: number | undefined;
  #lastFailure: string | undefined;

  constructor(options: AlertActivityOptions) {
    this.#inner = options.inner;
    this.#durable = options.durable;
    this.#transportConfigured = options.transportConfigured;
    this.#transportReason = options.transportReason;
  }

  async record(entry: AlertLogEntry): Promise<void> {
    // Counted BEFORE the write. The outcome is a fact about delivery, and a
    // database that is down must not also erase our knowledge of what landed.
    if (entry.outcome === 'delivered') {
      this.#delivered += 1;
      this.#lastDeliveredAtMs = entry.deliveredAtMs ?? entry.createdAtMs;
      this.#lastDelivered = `${entry.symbol} ${entry.state}`;
      this.#lastFailure = undefined;
      this.#lastFailureAtMs = undefined;
    } else {
      this.#failed += 1;
      this.#lastFailureAtMs = entry.createdAtMs;
      this.#lastFailure = `${entry.symbol} ${entry.state}: ${entry.lastError ?? 'no reason given'}`;
    }
    await this.#inner.record(entry);
  }

  status(): AlertDeliveryStatus {
    return {
      transportConfigured: this.#transportConfigured,
      ...(this.#transportReason === undefined ? {} : { transportReason: this.#transportReason }),
      durableLog: this.#durable,
      delivered: this.#delivered,
      failed: this.#failed,
      ...(this.#lastDeliveredAtMs === undefined
        ? {}
        : { lastDeliveredAtMs: this.#lastDeliveredAtMs }),
      ...(this.#lastDelivered === undefined ? {} : { lastDelivered: this.#lastDelivered }),
      ...(this.#lastFailureAtMs === undefined ? {} : { lastFailureAtMs: this.#lastFailureAtMs }),
      ...(this.#lastFailure === undefined ? {} : { lastFailure: this.#lastFailure }),
    };
  }
}
