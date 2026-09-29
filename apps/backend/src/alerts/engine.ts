/**
 * The alerts engine: the only part of this layer that touches the outside world.
 *
 * It subscribes to risk state changes, runs the PURE rules, delivers through the
 * injected transport with backoff, and records the outcome through the injected
 * log. It formats nothing itself and decides nothing itself.
 *
 * A DANGER ALERT THAT DID NOT ARRIVE IS NEVER SILENTLY DROPPED. Every attempt
 * sequence ends in an `alert_log` row, and an exhausted one also calls
 * `onDeliveryFailure` and logs at error level. A risk monitor whose warnings
 * vanish into a dead transport looks exactly like a risk monitor with nothing to
 * warn about, which is the same failure as a feed that has gone blind while
 * looking healthy.
 *
 * Deliveries are SERIALISED through one promise chain. Two alerts for the same
 * position racing each other could interleave their retries and land out of
 * order, so a DANGER could arrive after the WATCH that preceded it.
 */
import type { MarketRiskConfig } from '@perpguard/shared';
import type { MarketConfigs, RiskChange } from '../risk/types.ts';
import { decide } from './rules.ts';
import {
  DEFAULT_ALERT_CONFIG,
  emptyHistory,
  type AlertConfig,
  type AlertDecision,
  type AlertHistory,
  type AlertLog,
  type AlertLogEntry,
  type AlertMessage,
  type AlertTransport,
  type DeliveryResult,
  type Unsubscribe,
} from './types.ts';

/** Just enough of the risk loop to subscribe to. Keeps the engine testable. */
export interface RiskChangeSource {
  onChange(listener: (change: RiskChange) => void): Unsubscribe;
}

/** Where the engine reports problems. `console` satisfies it. */
export interface AlertLogger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

export interface AlertEngineOptions {
  readonly source: RiskChangeSource;
  /** Market configs by id, for the scaling every rendered number needs. */
  readonly configs: MarketConfigs;
  readonly transport: AlertTransport;
  readonly log: AlertLog;
  /** Who to alert. One user for now; the bot will key this per chat. */
  readonly userId: string;
  readonly alerts?: Partial<AlertConfig>;
  /** Injected so tests need no clock. */
  readonly now?: () => number;
  /** Injected so tests do not wait out the backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called once per exhausted attempt sequence, after the row is written. */
  readonly onDeliveryFailure?: (entry: AlertLogEntry, message: AlertMessage) => void;
  readonly logger?: AlertLogger;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class AlertEngine {
  readonly #source: RiskChangeSource;
  readonly #configs: MarketConfigs;
  readonly #transport: AlertTransport;
  readonly #log: AlertLog;
  readonly #userId: string;
  readonly #alerts: AlertConfig;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onDeliveryFailure: ((entry: AlertLogEntry, message: AlertMessage) => void) | undefined;
  readonly #logger: AlertLogger;

  /** Per-position alert history. IN MEMORY on purpose — see AlertHistory. */
  readonly #history = new Map<number, AlertHistory>();
  /** Serialises deliveries, and is what `drain()` awaits. */
  #queue: Promise<void> = Promise.resolve();
  #unsubscribe: Unsubscribe | undefined;

  constructor(options: AlertEngineOptions) {
    this.#source = options.source;
    this.#configs = options.configs;
    this.#transport = options.transport;
    this.#log = options.log;
    this.#userId = options.userId;
    this.#alerts = { ...DEFAULT_ALERT_CONFIG, ...options.alerts };
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onDeliveryFailure = options.onDeliveryFailure;
    this.#logger = options.logger ?? {
      error: (message, detail) => console.error(message, detail ?? ''),
      warn: (message, detail) => console.warn(message, detail ?? ''),
    };
  }

  get config(): AlertConfig {
    return this.#alerts;
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#source.onChange((change) => {
      this.handle(change);
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** History for one position, for tests and for the UI to show "last alerted". */
  historyFor(marketId: number): AlertHistory | undefined {
    return this.#history.get(marketId);
  }

  /** Resolves once every queued delivery has finished. */
  async drain(): Promise<void> {
    await this.#queue;
  }

  /**
   * Run one change through the rules and queue any delivery.
   *
   * Returns the decision synchronously — the rules are pure, so the verdict is
   * available immediately — while the sending happens on the queue. Tests read
   * the decision and then `await drain()`.
   */
  handle(change: RiskChange): AlertDecision {
    const assessment = change.assessment;
    const market = this.#configs.get(assessment.marketId);
    if (market === undefined) {
      // Without the market's scaling every price in the message would be wrong by
      // a power of ten, and would look entirely plausible. Say so and send
      // nothing; the loop keeps monitoring either way.
      this.#logger.warn(
        `no market config for market ${assessment.marketId} (${assessment.symbol}); ` +
          `cannot render an alert without its price and collateral decimals`,
      );
      return {
        send: false,
        message: undefined,
        suppressedReason: `no market config for market ${assessment.marketId}`,
        history: this.#history.get(assessment.marketId) ?? emptyHistory(assessment.marketId),
      };
    }

    const decision = decide(
      change,
      { alerts: this.#alerts, market },
      this.#history.get(assessment.marketId),
      this.#now(),
    );
    // Stored whether or not anything is sent: a suppressed tick still resets
    // latches, and dropping it would silence the next real alert.
    this.#history.set(assessment.marketId, decision.history);

    if (decision.send && decision.message !== undefined) {
      const message = decision.message;
      this.#queue = this.#queue.then(() => this.#deliver(message, market));
    }
    return decision;
  }

  /**
   * Send, retrying with backoff, and record exactly one row for the sequence.
   *
   * A transport that THROWS is treated as a retryable failure: a thrown network
   * error is the ordinary case and is no more final than a returned one. A
   * transport that returns `retryable: false` stops the loop, because three
   * attempts against a blocked chat is three ways of failing the same way.
   */
  async #deliver(message: AlertMessage, market: MarketRiskConfig): Promise<void> {
    const createdAtMs = this.#now();
    const alertKey = `${market.marketId}:${message.state}:${message.atMs}`;
    let attempts = 0;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= this.#alerts.maxAttempts; attempt += 1) {
      attempts = attempt;
      let result: DeliveryResult;
      try {
        result = await this.#transport.send(this.#userId, message);
      } catch (error) {
        result = { ok: false, reason: describeError(error), retryable: true };
      }

      if (result.ok) {
        await this.#record({
          alertKey,
          userId: this.#userId,
          marketId: message.marketId,
          symbol: message.symbol,
          kind: message.kind,
          state: message.state,
          previousState: message.previousState,
          text: message.text,
          actions: message.actions,
          attempts,
          outcome: 'delivered',
          lastError,
          createdAtMs,
          deliveredAtMs: this.#now(),
        });
        return;
      }

      lastError = result.reason ?? 'transport reported failure with no reason';
      if (result.retryable === false) {
        this.#logger.warn(
          `alert for ${message.symbol} failed permanently on attempt ${attempt}: ${lastError}`,
        );
        break;
      }
      if (attempt < this.#alerts.maxAttempts) {
        await this.#sleep(this.#backoffFor(attempt));
      }
    }

    const entry: AlertLogEntry = {
      alertKey,
      userId: this.#userId,
      marketId: message.marketId,
      symbol: message.symbol,
      kind: message.kind,
      state: message.state,
      previousState: message.previousState,
      text: message.text,
      actions: message.actions,
      attempts,
      outcome: 'failed',
      lastError,
      createdAtMs,
      deliveredAtMs: undefined,
    };
    await this.#record(entry);

    // SURFACED, not just recorded. The row is for later; this is for now.
    this.#logger.error(
      `alert for ${message.symbol} (${message.state}) was NOT delivered after ` +
        `${attempts} attempt(s): ${lastError}`,
      { alertKey, text: message.text },
    );
    this.#onDeliveryFailure?.(entry, message);
  }

  #backoffFor(attempt: number): number {
    const schedule = this.#alerts.backoffMs;
    if (schedule.length === 0) return 0;
    return schedule[Math.min(attempt - 1, schedule.length - 1)]!;
  }

  /**
   * Write the row, and never let a failing log swallow a failing alert.
   *
   * If the database is down the row is lost, and that is bad — but losing the
   * error-level line and the `onDeliveryFailure` call as well would turn one
   * outage into total silence.
   */
  async #record(entry: AlertLogEntry): Promise<void> {
    try {
      await this.#log.record(entry);
    } catch (error) {
      this.#logger.error(
        `failed to write the alert_log row for ${entry.symbol} (${entry.outcome}): ` +
          describeError(error),
        { alertKey: entry.alertKey },
      );
    }
  }
}
