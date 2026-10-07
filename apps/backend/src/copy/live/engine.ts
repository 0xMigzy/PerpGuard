/**
 * 🔁 COPY TRADING, HALF B: the loop (owner, 7 Oct 2026). Testnet only.
 *
 * Every 30 seconds, for each follower copying someone: read the leader's
 * positions from the index, plan the steps (`decide.ts`), and act on them ONE
 * AT A TIME per account through that account's own executor.
 *
 *   - ARMED BY A TAP ONLY: a rule whose signature does not verify, or whose
 *     armer is no longer linked, is switched off and never acted on.
 *   - THE KILL SWITCH ON EVERY PATH: read before a pass, before every claim,
 *     and by the executor right before the send (`stopCheck`).
 *   - AT MOST ONCE PER LEADER EVENT: the leg is CLAIMED in Postgres (unique
 *     per rule and leader position) BEFORE anything is sent.
 *   - EVERY OPEN IS VERIFIED FROM THE POSITION LIST, never the receipt: a
 *     position appeared (open), nothing appeared and the venue refused (not
 *     opened, said, never retried), or neither (UNKNOWN: copying pauses and
 *     says so). Closes the same way.
 *   - HELD, NEVER GUESSED, while the index is behind or the account blind:
 *     said once.
 *   - STOPPING NEVER MOVES MONEY: switching it off leaves copied positions open.
 */
import type { CopySourcePosition, Side, VenueMarket } from '@perpguard/shared';
import type { ActionCommand, ActionOutcome } from '../../actions/types.ts';
import type { AutomationStore } from '../../rescue/automation.ts';
import { decideOpen, plan, type ActingCopyMarket } from './decide.ts';
import { closeKeyOf, openKeyOf, type CopyLeg, type CopyRule, type CopyStore } from './store.ts';

/** What the loop needs from the follower's own session. */
export interface CopyAccount {
  /** The position list is fully loaded: anything else and nothing is judged. */
  positionsLive(): boolean;
  positions(): readonly { readonly marketId: number; readonly positionId: number | undefined; readonly side: Side; readonly marginCNS: bigint | undefined; readonly unrealisedPnlCNS: bigint | undefined }[];
  freeFloorCNS(): bigint | undefined;
  execute(command: ActionCommand): Promise<ActionOutcome>;
}

export type CopyNotice =
  | { readonly kind: 'copied'; readonly rule: CopyRule; readonly leg: CopyLeg; readonly marginCNS: bigint; readonly leverageCapped: boolean; readonly partial: boolean }
  | { readonly kind: 'skipped'; readonly rule: CopyRule; readonly leg: CopyLeg }
  | { readonly kind: 'not-opened'; readonly rule: CopyRule; readonly leg: CopyLeg }
  | { readonly kind: 'unknown'; readonly rule: CopyRule; readonly leg: CopyLeg; readonly what: 'open' | 'close' }
  | { readonly kind: 'closed'; readonly rule: CopyRule; readonly leg: CopyLeg; readonly resultCNS: bigint | undefined }
  | { readonly kind: 'close-not-landed'; readonly rule: CopyRule; readonly leg: CopyLeg }
  | { readonly kind: 'closed-by-you'; readonly rule: CopyRule; readonly leg: CopyLeg }
  | { readonly kind: 'held'; readonly rule: CopyRule; readonly why: string }
  | { readonly kind: 'ignored'; readonly rule: CopyRule; readonly why: string };

export interface CopyEngineOptions {
  readonly store: CopyStore;
  readonly automation: Pick<AutomationStore, 'automationStopped' | 'get' | 'transition'>;
  /** Why this rule must NOT be acted on (`control.armProblem`), or undefined. */
  readonly armProblem: (rule: CopyRule) => string | undefined;
  readonly account: (accountId: number) => CopyAccount | undefined;
  /** The leader from the index: positions opened since the start, and its equity now. */
  readonly leader: (accountId: number, sinceMs: number) => Promise<{ readonly positions: readonly CopySourcePosition[]; readonly equityCNS: bigint } | undefined>;
  /** Undefined when the index is serving current figures; else why not. */
  readonly indexProblem: () => Promise<string | undefined>;
  readonly actingNetwork: string;
  readonly actingMarkets: () => readonly VenueMarket[];
  readonly markOf: (marketId: number) => number | undefined;
  readonly collateralDecimals: number;
  readonly notify: (followerAccountId: number, notice: CopyNotice) => void;
  readonly logger: { info(m: string): void; warn(m: string): void };
  readonly now?: () => number;
  readonly tickMs?: number;
}

export class CopyEngine {
  readonly #o: CopyEngineOptions;
  readonly #now: () => number;
  readonly #busy = new Set<number>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: CopyEngineOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.tick(), this.#o.tickMs ?? 30_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Whether an action is on its way for this follower right now. */
  busy(followerAccountId: number): boolean {
    return this.#busy.has(followerAccountId);
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const rule of this.#o.store.enabledRules()) {
        try {
          await this.#pass(rule);
        } catch (error) {
          this.#o.logger.warn(`copy rule ${rule.id} (account ${rule.followerAccountId} copying #${rule.leaderAccountId}): the pass failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Why automation must not act on this rule right now: the kill switch, or the rule off or paused. */
  #stopReason(ruleId: number): string | undefined {
    const r = this.#o.store.rule(ruleId);
    if (r === undefined || !r.enabled) return 'Copying was switched off.';
    if (this.#o.automation.automationStopped(r.followerAccountId)) return 'PerpGuard is stopped (kill switch).';
    if (r.pausedReason !== undefined) return `Copying is paused: ${r.pausedReason}.`;
    return undefined;
  }

  async #hold(rule: CopyRule, why: string): Promise<void> {
    if (rule.lastNotice === `held:${why}`) return;
    await this.#o.store.update(rule.id, { lastNotice: `held:${why}` });
    this.#o.notify(rule.followerAccountId, { kind: 'held', rule, why });
  }

  async #pass(rule: CopyRule): Promise<void> {
    if (rule.pausedReason !== undefined) return;
    const problem = this.#o.armProblem(rule);
    if (problem !== undefined) {
      await this.#o.store.update(rule.id, { enabled: false, pausedReason: `ignored: ${problem}` });
      await this.#o.automation.transition(rule.followerAccountId, 'COPY_TRADING', 'NONE');
      this.#o.logger.warn(`copy rule ${rule.id} on account ${rule.followerAccountId} IGNORED and switched off: ${problem}`);
      this.#o.notify(rule.followerAccountId, { kind: 'ignored', rule, why: problem });
      return;
    }
    if (this.#o.automation.automationStopped(rule.followerAccountId)) return;
    if (this.#busy.has(rule.followerAccountId)) return;

    const account = this.#o.account(rule.followerAccountId);
    if (account === undefined || !account.positionsLive()) return this.#hold(rule, 'your account is not connected right now, so I cannot see your positions');
    const indexProblem = await this.#o.indexProblem();
    if (indexProblem !== undefined) return this.#hold(rule, `the index is not current (${indexProblem}), so I cannot tell what the leader did`);
    const leader = await this.#o.leader(rule.leaderAccountId, rule.startedAtMs);
    if (leader === undefined) return this.#hold(rule, `the index has no account #${rule.leaderAccountId}`);
    if (rule.lastNotice?.startsWith('held:') === true) await this.#o.store.update(rule.id, { lastNotice: undefined });

    const steps = plan(rule, this.#o.store.legs(rule.id), leader.positions);
    if (steps.length === 0) return;
    // ONE ACTION IN FLIGHT PER ACCOUNT, from the first step to the last settlement.
    this.#busy.add(rule.followerAccountId);
    try {
      for (const step of steps) {
        if (this.#stopReason(rule.id) !== undefined) return;
        const current = this.#o.store.rule(rule.id) ?? rule;
        if (step.kind === 'missed') await this.#missed(current, step.leader);
        else if (step.kind === 'open') await this.#open(current, step.leader, leader.equityCNS, account);
        else await this.#close(current, step.leg, account);
      }
    } finally {
      this.#busy.delete(rule.followerAccountId);
    }
  }

  #legBase(rule: CopyRule, p: CopySourcePosition) {
    return {
      ruleId: rule.id,
      leaderKey: p.key,
      leaderMarketId: p.market.marketId,
      symbol: p.market.symbol ?? p.market.indexerName,
      side: p.side,
      leaderOpenedAtMs: p.openedAtMs,
      openKey: openKeyOf(rule.followerAccountId, p.key),
    };
  }

  async #missed(rule: CopyRule, p: CopySourcePosition): Promise<void> {
    const reason = 'They opened and closed it between two looks (every 30 seconds), so there was nothing to copy.';
    if (!(await this.#o.store.claim({ ...this.#legBase(rule, p), status: 'skipped', reason, actingMarketId: undefined, sizeLNS: undefined, leverageHundredths: undefined }))) return;
    const leg = this.#o.store.legs(rule.id).find((l) => l.leaderKey === p.key)!;
    this.#o.notify(rule.followerAccountId, { kind: 'skipped', rule, leg });
  }

  async #open(rule: CopyRule, p: CopySourcePosition, leaderEquityCNS: bigint, account: CopyAccount): Promise<void> {
    const ticker = p.market.symbol?.toUpperCase();
    const market = ticker === undefined ? undefined : this.#o.actingMarkets().find((m) => m.symbol.toUpperCase() === ticker);
    const acting: ActingCopyMarket | undefined = market === undefined ? undefined : { marketId: market.marketId, symbol: market.symbol, sizeDecimals: market.sizeDecimals, maxLeverage: market.maxLeverage, markPrice: this.#o.markOf(market.marketId) };
    const positions = account.positions();
    const free = account.freeFloorCNS();
    const marginIn = positions.reduce((a, x) => a + (x.marginCNS ?? 0n), 0n);
    const decision = decideOpen({
      leader: p,
      leaderEquityCNS,
      followerEquityCNS: (free ?? 0n) + marginIn,
      followerFreeCNS: free,
      keepFreeCNS: rule.keepFreeCNS,
      acting,
      actingNetwork: this.#o.actingNetwork,
      followerHoldsMarket: acting !== undefined && positions.some((x) => x.marketId === acting.marketId),
      collateralDecimals: this.#o.collateralDecimals,
    });
    const base = this.#legBase(rule, p);
    if (decision.kind === 'skip') {
      if (!(await this.#o.store.claim({ ...base, status: 'skipped', reason: decision.text, actingMarketId: acting?.marketId, sizeLNS: undefined, leverageHundredths: undefined }))) return;
      this.#o.logger.info(`copy ${base.openKey}: skipped (${decision.reason}) ${decision.text}`);
      this.#o.notify(rule.followerAccountId, { kind: 'skipped', rule, leg: this.#leg(rule, p.key) });
      return;
    }
    // The kill switch, again, right before the claim.
    if (this.#stopReason(rule.id) !== undefined) return;
    // CLAIMED BEFORE THE SEND: a restart, a second pass or a race can never open it twice.
    if (!(await this.#o.store.claim({ ...base, status: 'opening', reason: undefined, actingMarketId: decision.actingMarketId, sizeLNS: decision.sizeLNS, leverageHundredths: decision.leverageHundredths }))) return;
    this.#o.logger.info(`copy ${base.openKey}: opening ${decision.side} ${decision.sizeLNS} units of ${decision.symbol} (market ${decision.actingMarketId}) at ${decision.leverageHundredths / 100}x, about ${decision.marginCNS} margin, share ${decision.share}`);
    const outcome = await account.execute({
      kind: 'open-position',
      idempotencyKey: base.openKey,
      userId: `copy:${rule.id}`,
      accountId: rule.followerAccountId,
      marketId: decision.actingMarketId,
      symbol: decision.symbol,
      positionId: undefined,
      side: decision.side,
      sizeLNS: decision.sizeLNS,
      leverageHundredths: decision.leverageHundredths,
      stopCheck: () => this.#stopReason(rule.id),
    });
    const now = this.#now();
    if (outcome.kind === 'applied') {
      const opened = account.positions().find((x) => x.marketId === decision.actingMarketId);
      const size = outcome.reconciliation.after ?? decision.sizeLNS;
      await this.#o.store.updateLeg(rule.id, p.key, { status: 'open', positionId: opened?.positionId, sizeLNS: size, openedAtMs: now });
      this.#o.notify(rule.followerAccountId, { kind: 'copied', rule, leg: this.#leg(rule, p.key), marginCNS: opened?.marginCNS ?? decision.marginCNS, leverageCapped: decision.leverageCapped, partial: size < decision.sizeLNS });
    } else if (outcome.kind === 'not-applied') {
      await this.#o.store.updateLeg(rule.id, p.key, { status: 'not-opened', reason: outcome.detail });
      this.#o.notify(rule.followerAccountId, { kind: 'not-opened', rule, leg: this.#leg(rule, p.key) });
    } else if (outcome.kind === 'refused') {
      await this.#o.store.updateLeg(rule.id, p.key, { status: 'skipped', reason: outcome.detail });
      this.#o.notify(rule.followerAccountId, { kind: 'skipped', rule, leg: this.#leg(rule, p.key) });
    } else {
      // UNKNOWN: it may still land. Copying pauses until the person has looked.
      await this.#o.store.updateLeg(rule.id, p.key, { status: 'unknown', reason: outcome.detail });
      const paused = await this.#o.store.update(rule.id, { pausedReason: `an open of ${decision.symbol} could not be confirmed either way` });
      this.#o.logger.warn(`copy ${base.openKey}: UNKNOWN, copying paused: ${outcome.detail}`);
      this.#o.notify(rule.followerAccountId, { kind: 'unknown', rule: paused, leg: this.#leg(rule, p.key), what: 'open' });
    }
  }

  async #close(rule: CopyRule, leg: CopyLeg, account: CopyAccount): Promise<void> {
    const ours = account.positions().find((x) => x.marketId === leg.actingMarketId && (leg.positionId === undefined || x.positionId === leg.positionId));
    if (ours === undefined) {
      // Closed by the person (or liquidated) before the leader closed: nothing to send.
      await this.#o.store.updateLeg(rule.id, leg.leaderKey, { status: 'closed-by-you', closedAtMs: this.#now() });
      this.#o.notify(rule.followerAccountId, { kind: 'closed-by-you', rule, leg: this.#leg(rule, leg.leaderKey) });
      return;
    }
    if (this.#stopReason(rule.id) !== undefined) return;
    // Claimed by the leg's status (`closing`) before the send; the key carries the moment, so a close
    // refused before sending (the kill switch) can be sent later under its own action_log row.
    const closeKey = `${closeKeyOf(rule.followerAccountId, leg.leaderKey)}:${this.#now()}`;
    await this.#o.store.updateLeg(rule.id, leg.leaderKey, { status: 'closing', closeKey });
    const resultBefore = ours.unrealisedPnlCNS;
    const outcome = await account.execute({
      kind: 'close-position',
      idempotencyKey: closeKey,
      userId: `copy:${rule.id}`,
      accountId: rule.followerAccountId,
      marketId: leg.actingMarketId!,
      symbol: leg.symbol,
      positionId: ours.positionId,
      stopCheck: () => this.#stopReason(rule.id),
    });
    if (outcome.kind === 'applied') {
      await this.#o.store.updateLeg(rule.id, leg.leaderKey, { status: 'closed', closedAtMs: this.#now() });
      this.#o.notify(rule.followerAccountId, { kind: 'closed', rule, leg: this.#leg(rule, leg.leaderKey), resultCNS: resultBefore });
    } else if (outcome.kind === 'not-applied' || outcome.kind === 'refused') {
      // Still open, and said: never retried blind. A refusal (the kill switch went on) leaves it open too.
      await this.#o.store.updateLeg(rule.id, leg.leaderKey, { status: outcome.kind === 'refused' ? 'open' : 'close-not-landed', reason: outcome.detail });
      if (outcome.kind === 'not-applied') this.#o.notify(rule.followerAccountId, { kind: 'close-not-landed', rule, leg: this.#leg(rule, leg.leaderKey) });
    } else {
      await this.#o.store.updateLeg(rule.id, leg.leaderKey, { status: 'unknown', reason: outcome.detail });
      const paused = await this.#o.store.update(rule.id, { pausedReason: `a close of ${leg.symbol} could not be confirmed either way` });
      this.#o.notify(rule.followerAccountId, { kind: 'unknown', rule: paused, leg: this.#leg(rule, leg.leaderKey), what: 'close' });
    }
  }

  #leg(rule: CopyRule, leaderKey: string): CopyLeg {
    return this.#o.store.legs(rule.id).find((l) => l.leaderKey === leaderKey)!;
  }
}
