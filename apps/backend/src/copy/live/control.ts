/**
 * 🔁 Starting, stopping and resuming copying. Every check is server-side,
 * whatever the screens allowed (owner, 7 Oct 2026):
 *
 *   - STARTED ONLY BY A TAP from the chat linked to the follower account, and
 *     SIGNED (`arming.ts`). One leader at a time; one automation per account
 *     (Copy and Auto top-up never run together); refused while the kill
 *     switch is on.
 *   - A LEADER WHOSE BOOKS DO NOT RECONCILE IS REFUSED, in words: PerpGuard
 *     won't copy a trader whose books it can't verify against the chain.
 *   - STOPPING LEAVES COPIED POSITIONS OPEN AND SAYS SO. Stopping never moves money.
 *   - RESUMING after an unknown first settles each unknown leg against the
 *     position list: a position there is the copy; none is "not opened".
 */
import type { ArmContext } from '../../rescue/arming.ts';
import type { AutomationStore } from '../../rescue/automation.ts';
import type { CopyArmSigner } from './arming.ts';
import type { CopyLeg, CopyRule, CopyStore } from './store.ts';

export type CopyResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string };

export interface CopyControlOptions {
  readonly store: CopyStore;
  readonly automation: Pick<AutomationStore, 'automationStopped' | 'get' | 'transition'>;
  readonly signer: CopyArmSigner | undefined;
  readonly isLinked: (telegramUserId: number, chatId: number, accountId: number) => boolean;
  /** The leader's books reconcile and it can be copied; else the sentence why not. */
  readonly verifyLeader: (leaderAccountId: number) => Promise<CopyResult>;
  /** The follower's open positions, when the list is fully loaded. */
  readonly positions: (followerAccountId: number) => readonly { readonly marketId: number; readonly positionId: number | undefined; readonly side: 'long' | 'short' }[] | undefined;
  readonly busy: (followerAccountId: number) => boolean;
  readonly collateralDecimals: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export const DEFAULT_KEEP_FREE_AUSD = 500;
export const COPY_RULE_TEXT = 'PerpGuard copies when they open and when they close, not every adjustment in between.';
export const UNVERIFIED_LEADER_TEXT = "PerpGuard won't copy a trader whose books it can't verify against the chain.";

const OPEN_LEG = new Set(['open', 'opening', 'closing', 'close-not-landed', 'unknown']);

export class CopyControlService {
  readonly #o: CopyControlOptions;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(options: CopyControlOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
  }

  /** The current (or most recent) rule and its legs. */
  status(followerAccountId: number): { readonly rule: CopyRule | undefined; readonly legs: readonly CopyLeg[] } {
    const rule = this.#o.store.ruleFor(followerAccountId);
    return { rule, legs: rule === undefined ? [] : this.#o.store.legs(rule.id) };
  }

  /** Why this rule must NOT be acted on, or undefined when it may. */
  armProblem(rule: CopyRule): string | undefined {
    if (rule.armProof === undefined || rule.armedBy === undefined || rule.armedChat === undefined) return 'not started by a tap in the bot';
    if (this.#o.signer === undefined || !this.#o.signer.verify(rule, rule.armProof)) return 'its signature does not verify';
    if (!this.#o.isLinked(rule.armedBy, rule.armedChat, rule.followerAccountId)) return 'the person who started it is no longer linked to this account';
    return undefined;
  }

  async start(followerAccountId: number, leaderAccountId: number, keepFreeCNS: bigint, arm: ArmContext): Promise<CopyResult> {
    if (this.#o.signer === undefined) return { ok: false, text: 'Copying cannot be started here: the server has no key to sign it with. Nothing was started.' };
    if (!this.#o.isLinked(arm.telegramUserId, arm.chatId, followerAccountId)) return { ok: false, text: 'Only the person linked to this account, from their own chat, can start copying. Nothing was started.' };
    if (this.#o.automation.automationStopped(followerAccountId)) return { ok: false, text: 'PerpGuard is stopped (🆘 Emergency). Resume it first. Nothing was started.' };
    if (keepFreeCNS < 0n) return { ok: false, text: 'The free balance kept cannot be negative. Nothing was started.' };
    const current = this.#o.store.ruleFor(followerAccountId);
    if (current?.enabled === true) {
      return { ok: false, text: current.leaderAccountId === leaderAccountId ? `You are already copying #${leaderAccountId}.` : `You are copying #${current.leaderAccountId}. Stop that first: one trader at a time. Nothing was started.` };
    }
    const verified = await this.#o.verifyLeader(leaderAccountId);
    if (!verified.ok) return { ok: false, text: `${verified.text} Nothing was started.` };

    const mode = this.#o.automation.get(followerAccountId).mode;
    if (mode === 'LIQUIDATION_RESCUE') return { ok: false, text: 'Auto top-up is on for this account. One automation at a time: turn it off first. Nothing was started.' };
    if (mode === 'NONE' && !(await this.#o.automation.transition(followerAccountId, 'NONE', 'COPY_TRADING')) && this.#o.automation.get(followerAccountId).mode !== 'COPY_TRADING') {
      return { ok: false, text: 'Another automation was turned on at the same moment. Nothing was started.' };
    }
    const now = this.#now();
    const fields = { followerAccountId, leaderAccountId, startedAtMs: now, armedBy: arm.telegramUserId, armedChat: arm.chatId, armedAtMs: now };
    const rule = await this.#o.store.create({ ...fields, keepFreeCNS, armProof: this.#o.signer.sign(fields) });
    this.#log(`copy rule ${rule.id} STARTED by tg:${arm.telegramUserId} in chat ${arm.chatId}: account ${followerAccountId} copies #${leaderAccountId}, keeps ${keepFreeCNS} free`);
    return { ok: true, text: `Copying #${leaderAccountId} from now. When they open a position, you open one in proportion to your account; when they close, yours closes. ${COPY_RULE_TEXT}` };
  }

  async stop(followerAccountId: number): Promise<CopyResult> {
    const rule = this.#o.store.ruleFor(followerAccountId);
    if (rule === undefined || !rule.enabled) return { ok: true, text: 'Copying was already off.' };
    const sending = this.#o.busy(followerAccountId);
    await this.#o.store.update(rule.id, { enabled: false, pausedReason: 'stopped by you' });
    await this.#o.automation.transition(followerAccountId, 'COPY_TRADING', 'NONE');
    const open = this.#o.store.legs(rule.id).filter((l) => OPEN_LEG.has(l.status)).length;
    this.#log(`copy rule ${rule.id} STOPPED by the person on account ${followerAccountId}; ${open} copied position(s) left open${sending ? '; an action was in flight' : ''}`);
    const left = open === 0 ? 'No copied positions are open.' : `${open} copied position${open === 1 ? ' is' : 's are'} still open: PerpGuard did not close ${open === 1 ? 'it' : 'them'}. Stopping never moves money. Close ${open === 1 ? 'it' : 'them'} from My Positions if you want.`;
    const inFlight = sending ? ' One order was already on its way when you tapped: it cannot be recalled, and you will get its result.' : '';
    return { ok: true, text: `Copying #${rule.leaderAccountId} stopped. ${left}${inFlight}` };
  }

  /** The kill switch's half: copying off, nothing sent, copied positions left open. */
  async stopAll(followerAccountId: number): Promise<{ readonly leaderAccountId: number; readonly openCopies: number } | undefined> {
    const rule = this.#o.store.ruleFor(followerAccountId);
    if (rule === undefined || !rule.enabled) return undefined;
    await this.#o.store.update(rule.id, { enabled: false, pausedReason: 'kill switch' });
    const openCopies = this.#o.store.legs(rule.id).filter((l) => OPEN_LEG.has(l.status)).length;
    this.#log(`copy rule ${rule.id} stopped by the kill switch on account ${followerAccountId}; ${openCopies} copied position(s) left open`);
    return { leaderAccountId: rule.leaderAccountId, openCopies };
  }

  async setKeepFree(followerAccountId: number, keepFreeCNS: bigint, arm: ArmContext): Promise<CopyResult> {
    if (!this.#o.isLinked(arm.telegramUserId, arm.chatId, followerAccountId)) return { ok: false, text: 'Only the person linked to this account can change this.' };
    if (keepFreeCNS < 0n) return { ok: false, text: 'The free balance kept cannot be negative.' };
    const rule = this.#o.store.ruleFor(followerAccountId);
    if (rule === undefined || !rule.enabled) return { ok: false, text: 'You are not copying anyone.' };
    await this.#o.store.update(rule.id, { keepFreeCNS });
    this.#log(`copy rule ${rule.id}: keep free set to ${keepFreeCNS}`);
    return { ok: true, text: 'Set.' };
  }

  async resume(followerAccountId: number, arm: ArmContext): Promise<CopyResult> {
    if (!this.#o.isLinked(arm.telegramUserId, arm.chatId, followerAccountId)) return { ok: false, text: 'Only the person linked to this account can resume copying.' };
    const rule = this.#o.store.ruleFor(followerAccountId);
    if (rule === undefined || !rule.enabled || rule.pausedReason === undefined) return { ok: false, text: 'Copying is not paused.' };
    if (this.#o.automation.automationStopped(followerAccountId)) return { ok: false, text: 'PerpGuard is stopped (🆘 Emergency). Resume it first.' };
    if (this.armProblem(rule) !== undefined) return { ok: false, text: 'That copy was not started by a tap in the bot, so it cannot be resumed. Start copying again instead.' };
    const positions = this.#o.positions(followerAccountId);
    if (positions === undefined) return { ok: false, text: 'Your positions are not loaded right now, so I cannot settle what happened. Try again in a moment.' };
    const settled: string[] = [];
    for (const leg of this.#o.store.legs(rule.id).filter((l) => l.status === 'unknown')) {
      const there = positions.find((x) => x.marketId === leg.actingMarketId && x.side === leg.side);
      const wasClose = leg.closeKey !== undefined;
      if (wasClose) {
        await this.#o.store.updateLeg(rule.id, leg.leaderKey, there === undefined ? { status: 'closed', closedAtMs: this.#now() } : { status: 'close-not-landed', positionId: there.positionId });
        settled.push(`${leg.symbol}: ${there === undefined ? 'closed' : 'still open'}`);
      } else {
        await this.#o.store.updateLeg(rule.id, leg.leaderKey, there === undefined ? { status: 'not-opened' } : { status: 'open', positionId: there.positionId, openedAtMs: this.#now() });
        settled.push(`${leg.symbol}: ${there === undefined ? 'not opened' : 'opened'}`);
      }
    }
    await this.#o.store.update(rule.id, { pausedReason: undefined, lastNotice: undefined });
    this.#log(`copy rule ${rule.id} resumed by the person; settled ${settled.join(', ') || 'nothing'}`);
    return { ok: true, text: `Copying #${rule.leaderAccountId} resumed.${settled.length === 0 ? '' : ` Checked against your positions: ${settled.join('; ')}.`}` };
  }
}
