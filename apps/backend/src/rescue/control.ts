/**
 * The bot's door to Rescue rules, and the server-side check on every one.
 *
 * ENABLE re-validates everything the screens showed, against the account's
 * LIVE position at the moment of the tap: the position is open and is the one
 * the draft named (same venue id), the trigger and the four limits are in
 * range, the cap is at least one rescue, and no other automation runs on the
 * account (Rescue XOR Copy: an atomic move of `automation_state.mode`). A
 * position's previous rule is ended and replaced, never stacked.
 */
import type { RiskAssessment } from '../risk/types.ts';
import type { AutomationStore } from './automation.ts';
import type { RescueRule, RescueStore } from './store.ts';

export interface RescueDraftInput {
  readonly marketId: number;
  readonly positionId: number;
  readonly triggerPct: number | undefined;
  readonly amountCNS: bigint | undefined;
  readonly maxRescues: number;
  readonly maxTotalCNS: bigint | undefined;
  readonly minRemainingCNS: bigint;
  readonly cooldownMs: number;
}

type Result = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string };

/** An amount in the collateral's own units, as words: `25 AUSD`, `25.5 AUSD`. */
const fmtIn = (cns: bigint, decimals: number): string => {
  const unit = 10n ** BigInt(decimals);
  const rest = cns % unit;
  return `${(cns / unit).toLocaleString('en-US')}${rest === 0n ? '' : `.${String(rest).padStart(decimals, '0').replace(/0+$/, '')}`} AUSD`;
};

export class RescueControlService {
  readonly #store: RescueStore;
  readonly #automation: AutomationStore;
  readonly #snapshot: (accountId: number) => readonly RiskAssessment[] | undefined;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  /** The collateral token's decimals, from the venue's context. Never assumed to be 6. */
  readonly #decimals: number;

  constructor(o: {
    readonly collateralDecimals: number;
    readonly store: RescueStore;
    readonly automation: AutomationStore;
    /** The account's live assessments, or undefined when it has no session. */
    readonly snapshot: (accountId: number) => readonly RiskAssessment[] | undefined;
    readonly now?: () => number;
    readonly log?: (line: string) => void;
  }) {
    this.#store = o.store;
    this.#automation = o.automation;
    this.#snapshot = o.snapshot;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
    if (!Number.isInteger(o.collateralDecimals) || o.collateralDecimals < 0 || o.collateralDecimals > 18) throw new RangeError(`collateral decimals must be 0..18, got ${o.collateralDecimals}`);
    this.#decimals = o.collateralDecimals;
  }

  /** The current rule per market: the enabled one, else the most recent paused or ended one for an OPEN position. */
  rules(accountId: number): readonly RescueRule[] {
    const all = [...this.#store.rulesFor(accountId)].sort((a, b) => b.id - a.id);
    const out = new Map<number, RescueRule>();
    for (const r of all) if (r.enabled && !out.has(r.marketId)) out.set(r.marketId, r);
    const open = this.#snapshot(accountId) ?? [];
    for (const r of all) {
      if (out.has(r.marketId)) continue;
      if (open.some((a) => a.marketId === r.marketId && a.positionId === r.positionId)) out.set(r.marketId, r);
    }
    return [...out.values()];
  }

  stopped(accountId: number): boolean {
    return this.#automation.automationStopped(accountId);
  }

  otherAutomation(accountId: number): string | undefined {
    return this.#automation.get(accountId).mode === 'COPY_TRADING' ? 'Copy Trading' : undefined;
  }

  async enable(accountId: number, d: RescueDraftInput): Promise<Result> {
    // THE KILL SWITCH BLOCKS NEW AUTOMATION: nothing is turned on while it is on.
    if (this.#automation.automationStopped(accountId)) {
      return { ok: false, text: 'Automation is stopped (kill switch). Turn it back on from 🔴 Kill Switch first. Nothing was turned on.' };
    }
    const live = this.#snapshot(accountId);
    if (live === undefined) return { ok: false, text: 'Your account is not connected right now, so nothing was turned on.' };
    const a = live.find((x) => x.marketId === d.marketId);
    if (a === undefined || a.positionId !== d.positionId) return { ok: false, text: 'That position is not open any more, so nothing was turned on.' };
    const amount = d.amountCNS;
    const cap = d.maxTotalCNS;
    if (d.triggerPct === undefined || !(d.triggerPct >= 0.005 && d.triggerPct <= 0.2)) return { ok: false, text: 'The trigger must be between 0.5% and 20%. Nothing was turned on.' };
    const AUSD = 10n ** BigInt(this.#decimals);
    if (amount === undefined || amount < AUSD || amount > 100_000n * AUSD) return { ok: false, text: 'The amount must be between 1 and 100,000 AUSD. Nothing was turned on.' };
    if (!Number.isInteger(d.maxRescues) || d.maxRescues < 1 || d.maxRescues > 10) return { ok: false, text: 'Maximum rescues must be between 1 and 10. Nothing was turned on.' };
    if (cap === undefined || cap < amount) return { ok: false, text: 'The maximum total must cover at least one rescue. Nothing was turned on.' };
    if (d.minRemainingCNS < 0n) return { ok: false, text: 'The minimum remaining cannot be negative. Nothing was turned on.' };
    if (!Number.isInteger(d.cooldownMs) || d.cooldownMs < 60_000 || d.cooldownMs > 24 * 3_600_000) return { ok: false, text: 'The cooldown must be between 1 minute and 24 hours. Nothing was turned on.' };

    // ONE AUTOMATION AT A TIME: NONE -> LIQUIDATION_RESCUE, atomically. Already Rescue is fine.
    const mode = this.#automation.get(accountId).mode;
    if (mode === 'COPY_TRADING') return { ok: false, text: 'Copy Trading is running on this account. One automation at a time: stop it first. Nothing was turned on.' };
    if (mode === 'NONE' && !(await this.#automation.transition(accountId, 'NONE', 'LIQUIDATION_RESCUE'))) {
      if (this.#automation.get(accountId).mode !== 'LIQUIDATION_RESCUE') return { ok: false, text: 'Another automation was turned on at the same moment. Nothing was turned on.' };
    }

    // Replaced, never stacked: the market's current rule ends first (the unique index allows one enabled per market).
    for (const old of this.#store.rulesFor(accountId)) {
      if (old.marketId === d.marketId && old.enabled) await this.#store.update(old.id, { enabled: false, pausedReason: 'replaced' });
    }
    const rule = await this.#store.create(
      {
        accountId,
        marketId: d.marketId,
        symbol: a.symbol,
        positionId: d.positionId,
        triggerPct: d.triggerPct,
        amountCNS: amount,
        maxRescues: d.maxRescues,
        maxTotalCNS: cap,
        minRemainingCNS: d.minRemainingCNS,
        cooldownMs: d.cooldownMs,
      },
      this.#now(),
    );
    this.#log(
      `rescue rule ${rule.id} ENABLED on account ${accountId} ${a.symbol} position ${d.positionId}: trigger ${(d.triggerPct * 100).toFixed(2)}%, amount ${amount}, max ${d.maxRescues} rescues / ${cap} total, keeps ${d.minRemainingCNS}, cooldown ${d.cooldownMs} ms`,
    );
    return { ok: true, text: `Rescue is on for ${a.symbol}: at ${(d.triggerPct * 100).toFixed(1)}% it adds ${fmtIn(amount, this.#decimals)}, at most ${d.maxRescues} times and ${fmtIn(cap, this.#decimals)} in all.` };
  }

  async disable(accountId: number, marketId: number): Promise<Result> {
    const on = this.#store.rulesFor(accountId).filter((r) => r.marketId === marketId && r.enabled);
    if (on.length === 0) return { ok: true, text: 'Rescue was already off for this position.' };
    for (const r of on) await this.#store.update(r.id, { enabled: false, pausedReason: 'stopped by you' });
    if (!this.#store.rulesFor(accountId).some((r) => r.enabled)) await this.#automation.transition(accountId, 'LIQUIDATION_RESCUE', 'NONE');
    this.#log(`rescue rule(s) ${on.map((r) => r.id).join(', ')} stopped by the person on account ${accountId} market ${marketId}`);
    return { ok: true, text: `Rescue is off for ${on[0]!.symbol}. Nothing more will be added automatically.` };
  }

  /** Clears a pause the rule put on itself (an unknown outcome). Counts and limits are kept. */
  async resume(accountId: number, marketId: number): Promise<Result> {
    const r = this.#store.rulesFor(accountId).find((x) => x.marketId === marketId && x.enabled && x.pausedReason !== undefined);
    if (r === undefined) return { ok: false, text: 'There is no paused rule on this position.' };
    await this.#store.update(r.id, { pausedReason: undefined, lastNotice: undefined });
    this.#log(`rescue rule ${r.id} resumed by the person on account ${accountId}`);
    return { ok: true, text: `Rescue resumed for ${r.symbol}. Rescues used so far: ${r.rescueCount} / ${r.maxRescues}.` };
  }
}
