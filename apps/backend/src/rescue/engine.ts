/**
 * THE RESCUE ENGINE: once a second, every enabled rule is judged by `decide`
 * against its account's own loop, and a `fire` becomes ONE add-margin sent
 * through that account's executor. The executor already owns what makes a
 * top-up safe (one in flight per position, the feed gate, the forwarding
 * pre-flight, the `action_log` row, reconciliation against the position's
 * margin and NEVER a re-send on `sr 32`). This adds what automation needs:
 *
 *   - the KILL SWITCH read three times: in `decide`, again before the claim,
 *     and inside the executor right before the send (`stopCheck`), so a switch
 *     flipped while an attempt is in flight stops it;
 *   - ONE RESCUE IN FLIGHT PER ACCOUNT, and RESERVATIONS (owner, 7 Oct 2026).
 *     The minimum free balance is account-wide, the limits per position, and
 *     the exchange's balance only falls once a top-up has landed (seconds
 *     later). So the account is locked from the balance check through the
 *     settlement, and every amount sent is RESERVED off the balance `decide`
 *     sees until the exchange's own figure has caught up. Released: on a
 *     refusal (nothing was sent), on not-applied (the position shows nothing
 *     left), and on applied once the exchange balance has fallen by the amount.
 *     HELD on unknown: we cannot say whether the money left. Reservations live
 *     in memory ON PURPOSE: at boot the exchange balance is the truth and no
 *     phantom hold survives a restart;
 *   - the MARKET checked before anything is claimed: retired (absent from the
 *     venue's market list) ends the rule, worded as the market and never as
 *     the position; closed (paused) holds WITHOUT an attempt row;
 *   - the CLAIM: `rescue_attempts` row `(rule, n)` with the idempotency key,
 *     inserted before anything is sent. A taken claim sends nothing;
 *   - the RECORD: trigger, what was sent, the receipt and the verified outcome,
 *     in separate fields;
 *   - the LIMITS updated from the VERIFIED delta, never the requested amount;
 *     spent limits END the rule with one handover;
 *   - an UNKNOWN outcome PAUSES the rule until the person turns it back on, and
 *     counts against the limits as if it landed (it may have);
 *   - a refusal waits a minute; the SAME refusal twice in a row pauses the
 *     rule, so a dead cause writes at most two rows, never one a minute.
 */
import { didApply, type ActionCommand, type ActionOutcome, type RefusalCode } from '../actions/types.ts';
import type { ActingMarket, ActionAvailability } from '@perpguard/shared';
import type { RiskAssessment } from '../risk/types.ts';
import type { AutomationStore } from './automation.ts';
import { atOrBelowTrigger, decide, holdDetail, TRANSIENT_HOLDS, type HoldReason } from './decide.ts';
import type { RescueNotice } from './render.ts';
import { rescueKey, type RescueRule, type RescueStore } from './store.ts';

/** What the engine needs from one account's session. */
export interface RescueAccount {
  snapshot(): readonly RiskAssessment[];
  feedConnected(): boolean;
  /** Open position ids from a FULLY LOADED list, or undefined when the list is not live. */
  openPositionIds(): ReadonlySet<number> | undefined;
  freeFloorCNS(): bigint | undefined;
  /** Asked of the acting venue BY MARKET ID, before anything is claimed. */
  availability(market: ActingMarket): Promise<ActionAvailability>;
  execute(command: ActionCommand): Promise<ActionOutcome>;
}

export interface RescueEngineOptions {
  readonly store: RescueStore;
  readonly automation: AutomationStore;
  readonly account: (accountId: number) => RescueAccount | undefined;
  readonly notify: (accountId: number, notice: RescueNotice) => Promise<void>;
  readonly logger: { info(message: string): void; warn(message: string): void };
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly tickMs?: number;
  /** How long to wait after a refusal before judging the rule again. */
  readonly refusalBackoffMs?: number;
  /** How long to wait for the loop to re-measure the distance after a rescue landed. */
  readonly remeasureMs?: number;
  /** How long a transient hold (a reconnect, a first snapshot) must last before it is said. */
  readonly transientHoldMs?: number;
  /**
   * How long an applied rescue's reservation may wait for the exchange balance
   * to fall by its amount. Past it the reservation is released WITH A WARNING:
   * a deposit landing at the same moment can hide the fall, and a hold that can
   * never release would starve every later rescue on the account.
   */
  readonly reservationCatchUpMs?: number;
}

export const RESCUE_USER = 'perpguard:rescue';

/** One amount held off an account's free balance. */
interface Reservation {
  readonly key: string;
  readonly amountCNS: bigint;
  /** The exchange's floor when the reservation was taken. Caught up once it has fallen by the amount. */
  readonly floorAtReserveCNS: bigint | undefined;
  /** Set once the outcome is applied: from then on it waits only for the exchange to catch up. */
  appliedAtMs: number | undefined;
  /** An unknown outcome: held until restart, never released by a timer. */
  unknown: boolean;
}

export class RescueEngine {
  readonly #o: RescueEngineOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #belowSince = new Map<number, number>();
  readonly #inFlight = new Set<number>();
  /** Accounts with a rescue between its balance check and its settlement. */
  readonly #accountBusy = new Set<number>();
  readonly #reservations = new Map<number, Reservation[]>();
  readonly #retryAfter = new Map<number, number>();
  /** The code of a rule's last refusal, cleared by anything else. Two in a row pause it. */
  readonly #lastRefusal = new Map<number, RefusalCode>();
  /** `rule:reason` -> when that hold was first seen, for transient reasons. */
  readonly #holdSince = new Map<string, number>();
  readonly #noSessionLogged = new Set<number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: RescueEngineOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.tick(), this.#o.tickMs ?? 1_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Whether a rule has an attempt in flight right now. */
  busy(ruleId: number): boolean {
    return this.#inFlight.has(ruleId);
  }

  /** The amounts held off an account's balance right now. For tests and /health. */
  reservedCNS(accountId: number): bigint {
    return (this.#reservations.get(accountId) ?? []).reduce((sum, r) => sum + r.amountCNS, 0n);
  }

  /** One pass over every enabled rule. Attempts run in the background; a rule in flight is skipped. */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const rule of this.#o.store.enabledRules()) {
        if (rule.pausedReason !== undefined || this.#inFlight.has(rule.id)) continue;
        try {
          await this.#judge(rule);
        } catch (error) {
          this.#o.logger.warn(`rescue rule ${rule.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Whether a rescue on this account is between its balance check and its settlement. */
  inFlightOn(accountId: number): boolean {
    return this.#accountBusy.has(accountId);
  }

  /** Waits for this account's rescue in flight to settle, up to `timeoutMs`. True when nothing is left in flight. */
  async settleAccount(accountId: number, timeoutMs: number): Promise<boolean> {
    const until = this.#now() + timeoutMs;
    while (this.#accountBusy.has(accountId)) {
      if (this.#now() >= until) return false;
      await this.#sleep(25);
    }
    return true;
  }

  /** Waits until no attempt is in flight. For tests and shutdown; the tick does not wait. */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) await this.#sleep(10);
  }

  async #judge(rule: RescueRule): Promise<void> {
    const now = this.#now();
    const account = this.#o.account(rule.accountId);
    if (account === undefined) {
      // Nothing can be judged without the session; at boot it opens in seconds. Logged, not said.
      if (!this.#noSessionLogged.has(rule.id)) this.#o.logger.info(`rescue rule ${rule.id}: account ${rule.accountId} has no open session; waiting`);
      this.#noSessionLogged.add(rule.id);
      return;
    }
    this.#noSessionLogged.delete(rule.id);
    const assessment = account.snapshot().find((a) => a.marketId === rule.marketId);

    // The trigger's two looks: remembered from the first look at or below, forgotten the moment it is above.
    if (atOrBelowTrigger(rule, assessment)) {
      if (!this.#belowSince.has(rule.id)) this.#belowSince.set(rule.id, now);
    } else {
      this.#belowSince.delete(rule.id);
    }

    const retryAfter = this.#retryAfter.get(rule.id);
    if (retryAfter !== undefined && now < retryAfter) return;

    // ONE RESCUE PER ACCOUNT AT A TIME: another position's rescue is between its
    // balance check and its settlement, so this one's balance check would read
    // a figure that has not yet paid for it.
    if (this.#accountBusy.has(rule.accountId)) return;

    const floor = this.#availableFloor(rule.accountId, account.freeFloorCNS());
    const decision = decide({
      rule,
      assessment,
      openPositionIds: account.openPositionIds(),
      belowSinceMs: this.#belowSince.get(rule.id),
      automationStopped: this.#o.automation.automationStopped(rule.accountId),
      feedConnected: account.feedConnected(),
      freeFloorCNS: floor,
      nowMs: now,
    });

    if (decision.kind !== 'hold') for (const k of [...this.#holdSince.keys()]) if (k.startsWith(`${rule.id}:`)) this.#holdSince.delete(k);
    switch (decision.kind) {
      case 'idle':
        // Back above the trigger: what was said about the last episode no longer holds.
        if (rule.lastNotice !== undefined) await this.#o.store.update(rule.id, { lastNotice: undefined });
        return;
      case 'arming':
        return;
      case 'hold':
        await this.#holdOnce(rule, decision.reason, assessment);
        return;
      case 'exhausted': {
        // SPENT LIMITS END THE RULE: said once, and nothing more is judged.
        // (Until 7 Oct 2026 the rule stayed on and repeated the handover on
        // every dip below the trigger: four times in one night.)
        if (assessment === undefined) return;
        const ended = await this.#o.store.update(rule.id, { enabled: false, pausedReason: 'limits reached', lastNotice: 'exhausted' });
        this.#belowSince.delete(rule.id);
        this.#o.logger.info(`rescue rule ${rule.id}: limits reached on account ${rule.accountId} ${rule.symbol} (${decision.detail}); handed over, rule ended`);
        await this.#releaseModeIfIdle(rule.accountId);
        this.#tell(rule.accountId, { kind: 'exhausted', rule: ended, assessment, why: decision.detail });
        return;
      }
      case 'ended':
        await this.#end(rule, decision.detail, 'position');
        return;
      case 'fire': {
        if (assessment === undefined) return;
        // THE LOCK AND THE RESERVATION, taken in the same synchronous step as the
        // balance check above: nothing else runs between `decide` and here.
        this.#accountBusy.add(rule.accountId);
        this.#inFlight.add(rule.id);
        void this.#attempt(rule, assessment, account, decision.amountCNS).finally(() => {
          this.#inFlight.delete(rule.id);
          this.#accountBusy.delete(rule.accountId);
        });
        return;
      }
    }
  }

  async #attempt(rule: RescueRule, trigger: RiskAssessment, account: RescueAccount, amountCNS: bigint): Promise<void> {
    const { store, automation, logger } = this.#o;
    // THE KILL SWITCH, AGAIN, before anything is claimed.
    if (automation.automationStopped(rule.accountId)) return;

    // THE MARKET, BEFORE ANY ROW: a retired market ends the rule, a closed one
    // waits. Neither writes an attempt.
    let availability: ActionAvailability;
    try {
      availability = await account.availability({ marketId: rule.marketId, symbol: rule.symbol });
    } catch (error) {
      logger.warn(`rescue rule ${rule.id}: could not ask whether market ${rule.marketId} can be acted on (${error instanceof Error ? error.message : String(error)}); waiting`);
      this.#retryAfter.set(rule.id, this.#now() + (this.#o.refusalBackoffMs ?? 60_000));
      return;
    }
    if (!availability.actionable) {
      if (availability.code === 'not-listed-on-acting-network') {
        await this.#end(rule, `the exchange no longer lists ${rule.symbol} (market ${rule.marketId})`, 'market');
        return;
      }
      if (availability.code === 'market-closed') {
        await this.#holdOnce(rule, 'market-closed', trigger, undefined, true);
        this.#retryAfter.set(rule.id, this.#now() + (this.#o.refusalBackoffMs ?? 60_000));
        return;
      }
      await this.#holdOnce(rule, 'refused', trigger, availability.reason, true);
      this.#retryAfter.set(rule.id, this.#now() + (this.#o.refusalBackoffMs ?? 60_000));
      return;
    }

    const attemptNo = store.attempts(rule.id).length + 1;
    const idempotencyKey = rescueKey(rule, attemptNo);
    const triggeredAtMs = this.#now();
    const claimed = await store.claim({
      ruleId: rule.id,
      attemptNo,
      idempotencyKey,
      accountId: rule.accountId,
      marketId: rule.marketId,
      positionId: rule.positionId,
      triggerDistancePct: trigger.liqBufferPct ?? 0,
      triggerMark: String(trigger.markPricePNS),
      triggeredAtMs,
      amountCNS,
    });
    if (!claimed) {
      logger.warn(`rescue ${idempotencyKey}: already claimed; nothing sent`);
      return;
    }
    const reservation = this.#reserve(rule.accountId, idempotencyKey, amountCNS, account.freeFloorCNS());
    // The cooldown runs from the attempt, whatever it turns out to be.
    await store.update(rule.id, { lastAttemptAtMs: triggeredAtMs });
    logger.info(
      `rescue ${idempotencyKey}: triggered at ${((trigger.liqBufferPct ?? 0) * 100).toFixed(2)}% (trigger ${(rule.triggerPct * 100).toFixed(2)}%), sending ${amountCNS}; ${this.reservedCNS(rule.accountId)} reserved on account ${rule.accountId}`,
    );

    /** Stamped by the executor's last gate, which runs immediately before the one send. Undefined: never sent. */
    let sentAtMs: number | undefined;
    let outcome: ActionOutcome;
    try {
      outcome = await account.execute({
        kind: 'add-margin',
        idempotencyKey,
        userId: RESCUE_USER,
        accountId: rule.accountId,
        marketId: rule.marketId,
        symbol: rule.symbol,
        positionId: rule.positionId,
        amountCNS,
        // THE KILL SWITCH, A THIRD TIME, right before the send, after every await of pre-flight.
        stopCheck: () => {
          if (automation.automationStopped(rule.accountId)) return 'Automation was stopped (the kill switch is on) while this rescue was being prepared.';
          const now = store.rule(rule.id);
          if (now === undefined || !now.enabled) return 'Rescue was switched off for this position while this rescue was being prepared.';
          sentAtMs = this.#now();
          return undefined;
        },
      });
    } catch (error) {
      // The executor reports rather than throws; a throw is a bug, and we cannot say what reached the venue.
      const detail = `the executor threw: ${error instanceof Error ? error.message : String(error)}`;
      reservation.unknown = true;
      await store.record(rule.id, attemptNo, { sentAtMs, outcome: 'unknown', detail, verifiedAtMs: this.#now() });
      const paused = await store.update(rule.id, { pausedReason: 'unknown outcome', lastNotice: 'paused' });
      this.#tell(rule.accountId, { kind: 'paused', rule: paused, amountCNS, detail });
      return;
    }

    if (outcome.kind === 'refused') {
      // NOTHING WAS SENT: the reservation goes at once, so the next rescue can use that amount.
      this.#release(rule.accountId, idempotencyKey, 'refused before sending');
      await store.record(rule.id, attemptNo, { outcome: 'refused', receiptReason: outcome.code, detail: outcome.detail, verifiedAtMs: this.#now() });
      // Nothing was sent, so the cooldown does not apply; a short wait does, so nothing loops.
      await store.update(rule.id, { lastAttemptAtMs: rule.lastAttemptAtMs });
      this.#retryAfter.set(rule.id, this.#now() + (this.#o.refusalBackoffMs ?? 60_000));
      logger.info(`rescue ${idempotencyKey}: refused (${outcome.code}): ${outcome.detail}`);
      // THE SAME REFUSAL TWICE IN A ROW: nothing it depends on has changed, so
      // the rule pauses rather than writing a row a minute forever.
      if (this.#lastRefusal.get(rule.id) === outcome.code && outcome.code !== 'automation-stopped') {
        this.#lastRefusal.delete(rule.id);
        const paused = await store.update(rule.id, { pausedReason: `refused twice: ${outcome.code}`, lastNotice: 'paused' });
        logger.warn(`rescue rule ${rule.id}: refused twice in a row (${outcome.code}); paused until the person resumes it`);
        this.#tell(rule.accountId, { kind: 'paused-refused', rule: paused, detail: outcome.detail });
        return;
      }
      this.#lastRefusal.set(rule.id, outcome.code);
      const reason: HoldReason =
        outcome.code === 'automation-stopped' ? 'stopped' : outcome.code === 'feed-down' ? 'feed-down' : outcome.code === 'already-in-flight' ? 'in-flight' : outcome.code === 'positions-untrusted' ? 'positions-untrusted' : 'refused';
      await this.#holdOnce(store.rule(rule.id) ?? rule, reason, trigger, reason === 'refused' ? outcome.detail : undefined, true);
      return;
    }
    this.#lastRefusal.delete(rule.id);

    const rec = outcome.reconciliation;
    await store.record(rule.id, attemptNo, {
      sentAtMs,
      receiptStatus: outcome.reported.status,
      receiptReason: outcome.reported.reason,
      venueRef: outcome.reported.venueRef,
      outcome: outcome.kind,
      marginBeforeCNS: rec?.before,
      marginAfterCNS: rec?.after,
      appliedCNS: rec?.delta,
      verifiedAtMs: this.#now(),
      detail: outcome.detail,
    });

    if (outcome.kind === 'unknown') {
      // It may have landed: count it against the limits as if it did, HOLD the reservation, and stop.
      reservation.unknown = true;
      const paused = await store.update(rule.id, {
        pausedReason: 'unknown outcome',
        lastNotice: 'paused',
        rescueCount: rule.rescueCount + 1,
        totalRescuedCNS: rule.totalRescuedCNS + amountCNS,
      });
      logger.warn(`rescue ${idempotencyKey}: UNKNOWN — rule paused, ${amountCNS} stays reserved until a restart. ${outcome.detail}`);
      this.#tell(rule.accountId, { kind: 'paused', rule: paused, amountCNS, detail: outcome.nextStep });
      return;
    }

    if (outcome.kind === 'not-applied' || !didApply(outcome) || rec === undefined || rec.after === undefined || rec.delta === undefined) {
      // The position shows nothing landed, so nothing left the account.
      this.#release(rule.accountId, idempotencyKey, 'not applied: the position did not move');
      logger.info(`rescue ${idempotencyKey}: not applied — the position's margin did not move. ${outcome.detail}`);
      this.#tell(rule.accountId, { kind: 'not-applied', rule: store.rule(rule.id) ?? rule, amountCNS, cooldownMs: rule.cooldownMs });
      return;
    }

    // APPLIED, off the position. The reservation now waits for the exchange's balance to catch up.
    reservation.appliedAtMs = this.#now();
    const updated = await store.update(rule.id, {
      rescueCount: rule.rescueCount + 1,
      totalRescuedCNS: rule.totalRescuedCNS + rec.delta,
      lastNotice: undefined,
    });
    const distanceAfterPct = await this.#remeasure(account, rule, rec.after);
    if (distanceAfterPct !== undefined) await store.record(rule.id, attemptNo, { distanceAfterPct });
    logger.info(
      `rescue ${idempotencyKey}: APPLIED ${rec.delta} (margin ${rec.before} -> ${rec.after}); receipt ${outcome.reported.status}` +
        `${outcome.reported.reason === undefined ? '' : ` (${outcome.reported.reason})`}; distance now ${distanceAfterPct === undefined ? 'not re-measured' : `${(distanceAfterPct * 100).toFixed(2)}%`}; rescues ${updated.rescueCount}/${updated.maxRescues}`,
    );
    this.#belowSince.delete(rule.id);
    this.#tell(rule.accountId, {
      kind: 'rescued',
      rule: updated,
      triggerDistancePct: trigger.liqBufferPct ?? 0,
      appliedCNS: rec.delta,
      marginBeforeCNS: rec.before,
      marginAfterCNS: rec.after,
      distanceAfterPct,
      receiptDisagreed: outcome.reported.status === 'rejected',
    });
  }

  // ── reservations ──────────────────────────────────────────────────────────

  #reserve(accountId: number, key: string, amountCNS: bigint, floorCNS: bigint | undefined): Reservation {
    const r: Reservation = { key, amountCNS, floorAtReserveCNS: floorCNS, appliedAtMs: undefined, unknown: false };
    this.#reservations.set(accountId, [...(this.#reservations.get(accountId) ?? []), r]);
    return r;
  }

  #release(accountId: number, key: string, why: string): void {
    const left = (this.#reservations.get(accountId) ?? []).filter((r) => r.key !== key);
    if (left.length === 0) this.#reservations.delete(accountId);
    else this.#reservations.set(accountId, left);
    this.#o.logger.info(`rescue ${key}: reservation released (${why}); ${this.reservedCNS(accountId)} still reserved on account ${accountId}`);
  }

  /**
   * The exchange's floor less what is still reserved. An applied reservation is
   * released here once the exchange's figure has fallen by its amount, or,
   * with a warning, once it has waited past the catch-up limit.
   */
  #availableFloor(accountId: number, floorCNS: bigint | undefined): bigint | undefined {
    if (floorCNS === undefined) return undefined;
    const now = this.#now();
    for (const r of [...(this.#reservations.get(accountId) ?? [])]) {
      if (r.appliedAtMs === undefined || r.unknown) continue;
      if (r.floorAtReserveCNS !== undefined && floorCNS <= r.floorAtReserveCNS - r.amountCNS) {
        this.#release(accountId, r.key, 'applied, and the exchange balance has caught up');
      } else if (now - r.appliedAtMs > (this.#o.reservationCatchUpMs ?? 120_000)) {
        this.#o.logger.warn(
          `rescue ${r.key}: the exchange balance has not fallen by ${r.amountCNS} in ${Math.round((now - r.appliedAtMs) / 1000)} s (was ${r.floorAtReserveCNS}, now ${floorCNS}); releasing the reservation and trusting the exchange's figure`,
        );
        this.#release(accountId, r.key, 'applied; catch-up limit passed');
      }
    }
    return floorCNS - this.reservedCNS(accountId);
  }

  /** The distance after the rescue, read off the loop once it has assessed the new margin. Never computed here. */
  async #remeasure(account: RescueAccount, rule: RescueRule, marginAfterCNS: bigint): Promise<number | undefined> {
    const until = this.#now() + (this.#o.remeasureMs ?? 10_000);
    for (;;) {
      const a = account.snapshot().find((x) => x.marketId === rule.marketId && x.positionId === rule.positionId);
      if (a?.marginCNS !== undefined && a.marginCNS >= marginAfterCNS && a.liqBufferPct !== undefined) return a.liqBufferPct;
      if (this.#now() >= until) return undefined;
      await this.#sleep(250);
    }
  }

  async #end(rule: RescueRule, detail: string, cause: 'position' | 'market'): Promise<void> {
    const ended = await this.#o.store.update(rule.id, { enabled: false, pausedReason: cause === 'market' ? 'market not listed' : 'position closed', lastNotice: 'ended' });
    this.#belowSince.delete(rule.id);
    this.#o.logger.info(`rescue rule ${rule.id}: ended (${detail})`);
    await this.#releaseModeIfIdle(rule.accountId);
    this.#tell(rule.accountId, { kind: 'ended', rule: ended, detail, cause });
  }

  async #holdOnce(rule: RescueRule, reason: HoldReason, assessment: RiskAssessment | undefined, detail?: string, now = false): Promise<void> {
    const notice = `held:${reason}`;
    if (rule.lastNotice === notice) return;
    if (!now && TRANSIENT_HOLDS.has(reason)) {
      const key = `${rule.id}:${reason}`;
      const since = this.#holdSince.get(key) ?? this.#now();
      this.#holdSince.set(key, since);
      if (this.#now() - since < (this.#o.transientHoldMs ?? 30_000)) return;
    }
    await this.#o.store.update(rule.id, { lastNotice: notice });
    this.#o.logger.info(`rescue rule ${rule.id}: holding (${detail ?? holdDetail(reason)})`);
    this.#tell(rule.accountId, { kind: 'held', rule, reason, detail: detail ?? holdDetail(reason), assessment });
  }

  /**
   * Hands a message to the transport WITHOUT WAITING: one person's slow
   * Telegram send must never hold up another person's rule in the same tick,
   * or this account's lock. A failure is logged; the decision it reports has
   * already been recorded.
   */
  #tell(accountId: number, notice: RescueNotice): void {
    void this.#o.notify(accountId, notice).catch((error: unknown) => {
      this.#o.logger.warn(`rescue: the ${notice.kind} message for account ${accountId} did not go: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async #releaseModeIfIdle(accountId: number): Promise<void> {
    if (this.#o.store.rulesFor(accountId).some((r) => r.enabled)) return;
    await this.#o.automation.transition(accountId, 'LIQUIDATION_RESCUE', 'NONE');
  }
}
