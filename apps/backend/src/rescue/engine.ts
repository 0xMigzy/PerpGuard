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
 *   - the CLAIM: `rescue_attempts` row `(rule, n)` with the idempotency key,
 *     inserted before anything is sent. A taken claim sends nothing;
 *   - the RECORD: trigger, what was sent, the receipt and the verified outcome,
 *     in separate fields;
 *   - the LIMITS updated from the VERIFIED delta, never the requested amount;
 *   - an UNKNOWN outcome PAUSES the rule until the person turns it back on, and
 *     counts against the limits as if it landed (it may have);
 *   - a refusal (nothing sent) waits a minute before the rule is judged again,
 *     so nothing ever loops.
 */
import { didApply, type ActionCommand, type ActionOutcome } from '../actions/types.ts';
import type { RiskAssessment } from '../risk/types.ts';
import type { AutomationStore } from './automation.ts';
import { atOrBelowTrigger, decide, holdDetail, TRANSIENT_HOLDS, type HoldReason } from './decide.ts';
import type { RescueNotice } from './render.ts';
import { rescueKey, type RescueRule, type RescueStore } from './store.ts';

/** What the engine needs from one account's session. */
export interface RescueAccount {
  snapshot(): readonly RiskAssessment[];
  feedConnected(): boolean;
  positionsLive(): boolean;
  freeFloorCNS(): bigint | undefined;
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
}

export const RESCUE_USER = 'perpguard:rescue';

export class RescueEngine {
  readonly #o: RescueEngineOptions;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #belowSince = new Map<number, number>();
  readonly #inFlight = new Set<number>();
  readonly #retryAfter = new Map<number, number>();
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

  /** Runs one rule's attempt to completion. For tests and the live run; the tick does not wait. */
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

    const decision = decide({
      rule,
      assessment,
      belowSinceMs: this.#belowSince.get(rule.id),
      automationStopped: this.#o.automation.automationStopped(rule.accountId),
      feedConnected: account.feedConnected(),
      positionsLive: account.positionsLive(),
      freeFloorCNS: account.freeFloorCNS(),
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
      case 'exhausted':
        if (rule.lastNotice === 'exhausted' || assessment === undefined) return;
        await this.#o.store.update(rule.id, { lastNotice: 'exhausted' });
        this.#o.logger.info(`rescue rule ${rule.id}: limits reached on account ${rule.accountId} ${rule.symbol} (${decision.detail}); handed over`);
        await this.#o.notify(rule.accountId, { kind: 'exhausted', rule: this.#o.store.rule(rule.id) ?? rule, assessment, why: decision.detail });
        return;
      case 'ended': {
        const ended = await this.#o.store.update(rule.id, { enabled: false, pausedReason: 'position closed', lastNotice: 'ended' });
        this.#belowSince.delete(rule.id);
        this.#o.logger.info(`rescue rule ${rule.id}: ended (${decision.detail})`);
        await this.#releaseModeIfIdle(rule.accountId);
        await this.#o.notify(rule.accountId, { kind: 'ended', rule: ended, detail: decision.detail });
        return;
      }
      case 'fire':
        if (assessment === undefined) return;
        this.#inFlight.add(rule.id);
        void this.#attempt(rule, assessment, account, decision.amountCNS).finally(() => this.#inFlight.delete(rule.id));
        return;
    }
  }

  async #attempt(rule: RescueRule, trigger: RiskAssessment, account: RescueAccount, amountCNS: bigint): Promise<void> {
    const { store, automation, logger } = this.#o;
    // THE KILL SWITCH, AGAIN, before anything is claimed.
    if (automation.automationStopped(rule.accountId)) return;

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
    // The cooldown runs from the attempt, whatever it turns out to be.
    await store.update(rule.id, { lastAttemptAtMs: triggeredAtMs });
    logger.info(`rescue ${idempotencyKey}: triggered at ${((trigger.liqBufferPct ?? 0) * 100).toFixed(2)}% (trigger ${(rule.triggerPct * 100).toFixed(2)}%), sending ${amountCNS}`);

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
          return undefined;
        },
      });
    } catch (error) {
      // The executor reports rather than throws; a throw is a bug, and we cannot say what reached the venue.
      const detail = `the executor threw: ${error instanceof Error ? error.message : String(error)}`;
      await store.record(rule.id, attemptNo, { outcome: 'unknown', detail, verifiedAtMs: this.#now() });
      const paused = await store.update(rule.id, { pausedReason: 'unknown outcome', lastNotice: 'paused' });
      await this.#o.notify(rule.accountId, { kind: 'paused', rule: paused, amountCNS, detail });
      return;
    }

    if (outcome.kind === 'refused') {
      await store.record(rule.id, attemptNo, { outcome: 'refused', receiptReason: outcome.code, detail: outcome.detail, verifiedAtMs: this.#now() });
      // Nothing was sent, so the cooldown does not apply; a short wait does, so nothing loops.
      await store.update(rule.id, { lastAttemptAtMs: rule.lastAttemptAtMs });
      this.#retryAfter.set(rule.id, this.#now() + (this.#o.refusalBackoffMs ?? 60_000));
      logger.info(`rescue ${idempotencyKey}: refused (${outcome.code}): ${outcome.detail}`);
      const reason: HoldReason =
        outcome.code === 'automation-stopped' ? 'stopped' : outcome.code === 'feed-down' ? 'feed-down' : outcome.code === 'already-in-flight' ? 'in-flight' : outcome.code === 'positions-untrusted' ? 'positions-untrusted' : 'refused';
      await this.#holdOnce(store.rule(rule.id) ?? rule, reason, trigger, reason === 'refused' ? outcome.detail : undefined, true);
      return;
    }

    const rec = outcome.reconciliation;
    await store.record(rule.id, attemptNo, {
      sentAtMs: triggeredAtMs,
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
      // It may have landed: count it against the limits as if it did, and stop.
      const paused = await store.update(rule.id, {
        pausedReason: 'unknown outcome',
        lastNotice: 'paused',
        rescueCount: rule.rescueCount + 1,
        totalRescuedCNS: rule.totalRescuedCNS + amountCNS,
      });
      logger.warn(`rescue ${idempotencyKey}: UNKNOWN — rule paused. ${outcome.detail}`);
      await this.#o.notify(rule.accountId, { kind: 'paused', rule: paused, amountCNS, detail: outcome.nextStep });
      return;
    }

    if (outcome.kind === 'not-applied' || !didApply(outcome) || rec === undefined || rec.after === undefined || rec.delta === undefined) {
      logger.info(`rescue ${idempotencyKey}: not applied — the position's margin did not move. ${outcome.detail}`);
      await this.#o.notify(rule.accountId, { kind: 'not-applied', rule: store.rule(rule.id) ?? rule, amountCNS, cooldownMs: rule.cooldownMs });
      return;
    }

    // APPLIED, off the position. The limits move by what LANDED.
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
    await this.#o.notify(rule.accountId, {
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
    await this.#o.notify(rule.accountId, { kind: 'held', rule, reason, detail: detail ?? holdDetail(reason), assessment });
  }

  async #releaseModeIfIdle(accountId: number): Promise<void> {
    if (this.#o.store.rulesFor(accountId).some((r) => r.enabled)) return;
    await this.#o.automation.transition(accountId, 'LIQUIDATION_RESCUE', 'NONE');
  }
}
