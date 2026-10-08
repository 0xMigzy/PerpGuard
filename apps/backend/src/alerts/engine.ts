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
 *
 * BLINDNESS IS ONE STATE, AND IT IS NEWS ONLY AFTER A MINUTE (owner, 8 Oct
 * 2026). FEED_DOWN and POSITIONS_UNTRUSTED are one blind spell PER ACCOUNT:
 * moving between them is never a message, and neither is a second position
 * going blind. Nothing is sent for the first `blindQuietMs` (60 s); if any
 * position is still blind then, ONE message for the account naming them all,
 * and nothing more until the last one clears; then ONE message, and none at
 * all if nobody was told. The trading socket drops ~40 times an hour and is
 * back within a second; each drop was a message per position. A restart is a
 * spell like any other, so its first minute is silent too (and
 * `StartupDeliveryGate` still holds and drops on top). A position that closes
 * while blind leaves no change behind, so the spell reads the loop's own
 * snapshot, and re-reads it every `blindRecheckMs` once told.
 */
import type { MarketRiskConfig } from '@perpguard/shared';
import type { MarketConfigs, RiskAssessment, RiskChange } from '../risk/types.ts';
import { isBlind } from '../risk/types.ts';
import { buildMessage } from './render.ts';
import { accountBlindMessage, accountClearMessage, type SpellMember } from './blindAccount.ts';
import { decide, kindFor } from './rules.ts';
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
  /** Every position's current assessment. Lets a blind spell notice a position that closed while blind. */
  snapshot?(): readonly RiskAssessment[];
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
  /** How long a position may be blind before anyone is told. Default 60 s. */
  readonly blindQuietMs?: number;
  /** Once told, how often a spell re-reads the loop for positions that closed while blind. Default 15 s. */
  readonly blindRecheckMs?: number;
  /** Runs `fn` after `ms`; returns a cancel. Injected so tests drive the minute. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

/** Default: a blind spell shorter than this is never mentioned, before or after. */
export const BLIND_QUIET_MS = 60_000;

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** One account's blind spell. `first` speaks for it downstream (see blindAccount.ts). */
interface Spell {
  readonly sinceMs: number;
  readonly first: { readonly change: RiskChange; readonly market: MarketRiskConfig; readonly message: AlertMessage };
  /** The positions blind now, by history key, with their latest assessment. */
  readonly members: Map<string, RiskAssessment>;
  /** Every position seen blind in the spell, for the clear message. */
  readonly names: Set<string>;
  /** The latest non-blind state seen, for the clear message's own state. */
  lastClear: RiskAssessment['state'];
  announced: boolean;
  cancel: () => void;
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
  readonly #blindQuietMs: number;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  readonly #blindRecheckMs: number;
  /** Accounts in a blind spell, by account (or 'global'). */
  readonly #spells = new Map<string, Spell>();

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
    this.#blindQuietMs = options.blindQuietMs ?? BLIND_QUIET_MS;
    this.#blindRecheckMs = options.blindRecheckMs ?? 15_000;
    this.#schedule = options.schedule ?? defaultSchedule;
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
    for (const spell of this.#spells.values()) spell.cancel();
    this.#spells.clear();
  }

  /** Whether this account is in a blind spell, how many positions, and whether it has been told. For tests and /health. */
  spellFor(accountId?: number): { readonly sinceMs: number; readonly blind: number; readonly announced: boolean } | undefined {
    const spell = this.#spells.get(spellKey(accountId));
    return spell === undefined ? undefined : { sinceMs: spell.sinceMs, blind: spell.members.size, announced: spell.announced };
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

    const verdict = this.#throughSpell(key, change, market, decision);
    if (verdict.send && verdict.message !== undefined) {
      const message = verdict.message;
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
          `${verdict.suppressedReason ?? 'no reason given'}`,
        { marketId: assessment.marketId, state: assessment.state, atMs: assessment.atMs },
      );
    }
    return verdict;
  }

  /**
   * The blind-spell rule, applied to the rules' verdict. Blind: never sent from
   * here; the account's spell is opened or joined, and its timer speaks. Not
   * blind: leaves the spell, and the last one out closes it with one message
   * if it was told, none if not. A recovery FROM blind is never sent per
   * position: the account's message says it. A real alert (worse than before)
   * always goes.
   */
  #throughSpell(key: string, change: RiskChange, market: MarketRiskConfig, decision: AlertDecision): AlertDecision {
    const assessment = change.assessment;
    const account = spellKey(scopeOf(assessment));
    const quiet = (reason: string): AlertDecision => ({ send: false, message: undefined, suppressedReason: reason, history: decision.history });
    let spell = this.#spells.get(account);

    if (isBlind(assessment.state)) {
      if (spell === undefined) {
        const message = buildMessage(assessment, kindFor(assessment.state), { alerts: this.#alerts, market });
        const opened: Spell = { sinceMs: this.#now(), first: { change, market, message }, members: new Map(), names: new Set(), lastClear: 'SAFE', announced: false, cancel: () => {} };
        opened.members.set(key, assessment);
        opened.names.add(nameOf(assessment));
        this.#spells.set(account, opened);
        opened.cancel = this.#schedule(() => this.#announce(account, opened), this.#blindQuietMs);
        spell = opened;
      }
      spell.members.set(key, assessment);
      spell.names.add(nameOf(assessment));
      return quiet(`blind: one spell for ${account} (${spell.members.size} position(s), since ${Math.round((this.#now() - spell.sinceMs) / 1000)}s ago${spell.announced ? ', already told' : `, said only if it lasts ${Math.round(this.#blindQuietMs / 1000)}s`})`);
    }

    const previous = decision.message?.previousState;
    const fromBlind = decision.send && decision.message?.kind === 'recovered' && previous !== undefined && isBlind(previous);
    if (spell === undefined) {
      return fromBlind ? quiet('a recovery from blindness is said once per account, by the spell') : decision;
    }
    spell.members.delete(key);
    spell.lastClear = assessment.state;
    this.#prune(account, spell);
    const closing = spell.members.size === 0 ? this.#close(account, spell) : undefined;
    if (!fromBlind && decision.send) {
      // A real alert on coming back. If the spell's clear message is due too,
      // it goes first, then this.
      if (closing !== undefined) this.#sendTo(spell.first.change, closing, spell.first.market);
      return decision;
    }
    if (closing !== undefined) return { send: true, message: closing, suppressedReason: undefined, history: decision.history };
    return quiet(spell.members.size === 0 ? `blind spell for ${account} over in ${Math.round((this.#now() - spell.sinceMs) / 1000)}s, under the quiet minute: nobody was told, so no recovery` : `${spell.members.size} position(s) of ${account} still blind; the clear is said once, for the account`);
  }

  /** Drop members the loop no longer has blind (closed while blind leave no change). */
  #prune(account: string, spell: Spell): void {
    const snapshot = this.#source.snapshot?.();
    if (snapshot === undefined) return;
    const blindNow = new Set(snapshot.filter((a) => isBlind(a.state) && spellKey(scopeOf(a)) === account).map((a) => historyKey(a.marketId, scopeOf(a))));
    for (const key of [...spell.members.keys()]) if (!blindNow.has(key)) spell.members.delete(key);
  }

  /** Ends the spell. The clear message if it was told, else undefined. */
  #close(account: string, spell: Spell): AlertMessage | undefined {
    spell.cancel();
    if (this.#spells.get(account) === spell) this.#spells.delete(account);
    const lastedMs = this.#now() - spell.sinceMs;
    if (!spell.announced) {
      this.#logger.info(`blind spell for ${account} over in ${Math.round(lastedMs / 1000)}s: under ${Math.round(this.#blindQuietMs / 1000)}s, nobody told, nothing to say`);
      return undefined;
    }
    return accountClearMessage(spell.first.message, [...spell.names], spell.first.change.assessment.state, lastedMs, this.#now(), spell.lastClear);
  }

  #sendTo(change: RiskChange, message: AlertMessage, market: MarketRiskConfig): void {
    const recipients = this.#recipients({ ...change, previousState: message.previousState, assessment: { ...change.assessment, state: message.state, previousState: message.previousState } });
    for (const recipient of recipients) {
      this.#queue = this.#queue.then(() => this.#deliver(message, market, recipient));
    }
  }

  /** The minute is up: if anything of the account is still blind, say it, once; then watch for the clear. */
  #announce(account: string, spell: Spell): void {
    if (this.#spells.get(account) !== spell || spell.announced) return;
    this.#prune(account, spell);
    if (spell.members.size === 0) {
      this.#close(account, spell);
      return;
    }
    spell.announced = true;
    const members: SpellMember[] = [...spell.members.values()];
    const message = accountBlindMessage(spell.first.message, members, this.#now() - spell.sinceMs, this.#now());
    this.#logger.info(`${account} blind for ${Math.round((this.#now() - spell.sinceMs) / 1000)}s (${members.length} position(s), ${message.state}): telling once`);
    this.#sendTo(spell.first.change, message, spell.first.market);
    const recheck = (): void => {
      if (this.#spells.get(account) !== spell) return;
      this.#prune(account, spell);
      if (spell.members.size === 0) {
        const clear = this.#close(account, spell);
        if (clear !== undefined) this.#sendTo(spell.first.change, clear, spell.first.market);
        return;
      }
      spell.cancel = this.#schedule(recheck, this.#blindRecheckMs);
    };
    spell.cancel = this.#schedule(recheck, this.#blindRecheckMs);
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

/** The account a spell belongs to. */
function spellKey(accountId: number | undefined): string {
  return accountId === undefined ? 'global' : `account ${accountId}`;
}

const nameOf = (a: Pick<RiskAssessment, 'symbol' | 'side'>): string => (a.side === undefined ? a.symbol : `${a.symbol} ${a.side}`);
