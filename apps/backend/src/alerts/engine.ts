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
 *
 * ONE DECISION PER POSITION, FANNED OUT TO MANY RECIPIENTS. Whether to speak —
 * cooldown, dwell, escalation, the stale-price gate — is decided once, from
 * the position's own history, exactly as it was when there was one owner. The
 * recipient list is then asked for, and each recipient gets a copy shaped by
 * its rights: the owner with actions, a watcher with none. Adding recipients
 * never changes when an alert fires; it only changes who hears it.
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
  type AlertRecipient,
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
  /**
   * Every suppression, with its reason.
   *
   * INFO RATHER THAN DEBUG, on purpose. "Why didn't I get an alert?" is a
   * question that WILL be asked — by a test user, or by us at 2am during judging
   * week — and it is only answerable if the answer was written down at a level
   * that is actually on. A suppression logged at debug in a deployment with debug
   * off is a suppression that never happened as far as anyone can tell.
   *
   * The volume is fine: the loop emits only on a state CHANGE, and hysteresis
   * plus dwell time make those rare by design. This is not a per-tick log.
   */
  info(message: string, detail?: unknown): void;
}

export interface AlertEngineOptions {
  readonly source: RiskChangeSource;
  /** Market configs by id, for the scaling every rendered number needs. */
  readonly configs: MarketConfigs;
  readonly transport: AlertTransport;
  readonly log: AlertLog;
  /**
   * Who to alert for the owner's own positions: one app user, with actions.
   * Either this or `recipients` is required.
   */
  readonly userId?: string;
  /**
   * Who to alert for a change, asked PER CHANGE so a subscription added after
   * boot is honoured. Overrides `userId`. An empty list means the decision was
   * made and nobody is there to hear it, which is logged, not an error.
   */
  readonly recipients?: (change: RiskChange) => readonly AlertRecipient[];
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
  readonly #recipients: (change: RiskChange) => readonly AlertRecipient[];
  readonly #alerts: AlertConfig;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onDeliveryFailure: ((entry: AlertLogEntry, message: AlertMessage) => void) | undefined;
  readonly #logger: AlertLogger;

  /** Per-position alert history. IN MEMORY on purpose — see AlertHistory. */
  readonly #history = new Map<string, AlertHistory>();
  /** Serialises deliveries, and is what `drain()` awaits. */
  #queue: Promise<void> = Promise.resolve();
  #unsubscribe: Unsubscribe | undefined;

  constructor(options: AlertEngineOptions) {
    this.#source = options.source;
    this.#configs = options.configs;
    this.#transport = options.transport;
    this.#log = options.log;
    const { userId, recipients } = options;
    if (recipients === undefined && userId === undefined) {
      throw new RangeError('AlertEngine needs a userId or a recipients function: an alert with nobody to send it to is a decision made for no one');
    }
    this.#recipients = recipients ?? (() => [{ userId: userId as string, rights: 'act' }]);
    this.#alerts = { ...DEFAULT_ALERT_CONFIG, ...options.alerts };
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onDeliveryFailure = options.onDeliveryFailure;
    this.#logger = options.logger ?? {
      error: (message, detail) => console.error(message, detail ?? ''),
      warn: (message, detail) => console.warn(message, detail ?? ''),
      info: (message, detail) => console.info(message, detail ?? ''),
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

  /**
   * History for one position, for tests and for the UI to show "last alerted".
   * The owner's own positions are keyed by market alone; a watched account's by
   * account and market, so two accounts on the same market never share a cooldown.
   */
  historyFor(marketId: number, accountId?: number): AlertHistory | undefined {
    return this.#history.get(historyKey(marketId, accountId));
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
        history: this.#history.get(historyKey(assessment.marketId, scopeOf(assessment))) ?? emptyHistory(assessment.marketId),
      };
    }

    const key = historyKey(assessment.marketId, scopeOf(assessment));
    const decision = decide(
      change,
      { alerts: this.#alerts, market },
      this.#history.get(key),
      this.#now(),
    );
    // Stored whether or not anything is sent: a suppressed tick still resets
    // latches, and dropping it would silence the next real alert.
    this.#history.set(key, decision.history);

    if (decision.send && decision.message !== undefined) {
      const message = decision.message;
      // The list is read NOW, once per decision, so every copy of this alert
      // goes to the same set and a subscription change mid-delivery cannot
      // split it.
      const recipients = this.#recipients(change);
      if (recipients.length === 0) {
        this.#logger.info(
          `alert for ${assessment.symbol} (${assessment.state}) decided, but nobody is subscribed to hear it`,
          { marketId: assessment.marketId, state: assessment.state, atMs: assessment.atMs, accountId: assessment.watch?.accountId },
        );
      }
      for (const recipient of recipients) {
        this.#queue = this.#queue.then(() => this.#deliver(message, market, recipient));
      }
    } else {
      // The alert_log table is for DELIVERY OUTCOMES only — cooldown suppresses
      // most changes, and a row each would bury the failures that matter. But the
      // reason still has to be recoverable, so it goes to the application log.
      this.#logger.info(
        `no alert for ${assessment.symbol} (${assessment.state}): ` +
          `${decision.suppressedReason ?? 'no reason given'}`,
        { marketId: assessment.marketId, state: assessment.state, atMs: assessment.atMs },
      );
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
  async #deliver(message: AlertMessage, market: MarketRiskConfig, recipient: AlertRecipient): Promise<void> {
    const createdAtMs = this.#now();
    // An alert names its account, and each recipient's copy its own attempt
    // sequence, so two accounts on one market, or two chats on one account,
    // never share a row. (A pre-account owner alert keeps the old key shape.)
    const accountId = message.watch?.accountId ?? message.accountId;
    const alertKey =
      accountId === undefined
        ? `${market.marketId}:${message.state}:${message.atMs}`
        : `${accountId}:${market.marketId}:${message.state}:${message.atMs}:${recipient.userId}`;
    let attempts = 0;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= this.#alerts.maxAttempts; attempt += 1) {
      attempts = attempt;
      let result: DeliveryResult;
      try {
        result = await this.#transport.send(recipient, message);
      } catch (error) {
        result = { ok: false, reason: describeError(error), retryable: true };
      }

      if (result.suppressed === true) {
        this.#logger.info(`alert for ${message.symbol} (${message.state}) to ${recipient.userId} not sent: ${result.reason ?? 'suppressed'}`);
        return;
      }

      if (result.ok) {
        await this.#record({
          ...(accountId === undefined ? {} : { accountId }),
          alertKey,
          userId: recipient.userId,
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
      ...(accountId === undefined ? {} : { accountId }),
      alertKey,
      userId: recipient.userId,
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

/** By account and market whenever an account is known; by market alone only for pre-account assessments. */
function historyKey(marketId: number, accountId: number | undefined): string {
  return accountId === undefined ? String(marketId) : `${accountId}:${marketId}`;
}

/** The account an assessment is scoped to: a linked session's own, or a watched one's. */
function scopeOf(assessment: { readonly accountId?: number; readonly watch?: { readonly accountId: number } }): number | undefined {
  return assessment.accountId ?? assessment.watch?.accountId;
}
