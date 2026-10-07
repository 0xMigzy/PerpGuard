/**
 * 🛟 LIQUIDATION RESCUE, the bot's half (spec 38-42). The bot never touches a
 * rule store: it reads and writes through `RescueControl`, which the backend
 * implements and which RE-VALIDATES every rule server-side (the position, its
 * id, every limit, the automation mode). The screens here only collect a
 * draft and show what will be enabled.
 *
 *   38  menu: account, execution, status; one button per open position
 *   39  a position: its card, its rule if it has one, Configure / Stop / Resume / Add Margin Now
 *   40  trigger: 10 / 5 / 3 / 2% or custom
 *   41  amount: +100 / +250 / +500 / +1,000 AUSD or custom
 *   42  the rule with its FOUR LIMITS, each changeable, then ENABLE or Cancel
 *
 * "% of available balance" (spec 41) is NOT BUILT, so it has no button.
 */
import type { MarketRiskConfig } from '@perpguard/shared';
import { distance, esc, held, money, pct, shortDistance } from '@perpguard/backend/alerts/plain';
import { isBlind, type RiskAssessment } from '@perpguard/backend/risk';
import { positionCard } from './account.ts';
import type { Button, Screen } from './screens.ts';
import type { ExecutionState } from './trading.ts';

export interface RescueRuleView {
  readonly marketId: number;
  readonly symbol: string;
  readonly positionId: number;
  readonly triggerPct: number;
  readonly amountCNS: bigint;
  readonly maxRescues: number;
  readonly maxTotalCNS: bigint;
  readonly minRemainingCNS: bigint;
  readonly cooldownMs: number;
  readonly rescueCount: number;
  readonly totalRescuedCNS: bigint;
  readonly enabled: boolean;
  /** Set when the rule stopped itself: 'unknown outcome', 'position closed'. */
  readonly pausedReason: string | undefined;
}

export interface RescueDraft {
  readonly marketId: number;
  /** The collateral token's decimals, from the venue's context. Every amount here is in its units. */
  readonly collateralDecimals: number;
  readonly positionId: number;
  readonly triggerPct: number | undefined;
  readonly amountCNS: bigint | undefined;
  readonly maxRescues: number;
  /** Undefined until the person picks one: then it follows count x amount. */
  readonly maxTotalCNS: bigint | undefined;
  readonly minRemainingCNS: bigint;
  readonly cooldownMs: number;
}

export type RescueResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string };

export interface RescueControl {
  /** This account's rules, the current one per market (enabled or paused). */
  rules(accountId: number): readonly RescueRuleView[];
  /** True when the kill switch is on. */
  stopped(accountId: number): boolean;
  /** Another automation runs on this account (Copy Trading), named, or undefined. */
  otherAutomation(accountId: number): string | undefined;
  enable(accountId: number, draft: RescueDraft): Promise<RescueResult>;
  disable(accountId: number, marketId: number): Promise<RescueResult>;
  resume(accountId: number, marketId: number): Promise<RescueResult>;
}

/** One whole collateral unit (1 AUSD) in the token's own decimals. Never assumed to be 6. */
export const unitOf = (collateralDecimals: number): bigint => 10n ** BigInt(collateralDecimals);
export const RESCUE_TRIGGERS_PCT = [10, 5, 3, 2] as const;
export const RESCUE_AMOUNTS_AUSD = [100, 250, 500, 1_000] as const;
/** The four limits, each its own choice. Max total is NEVER derived once picked. */
export const RESCUE_LIMITS = [
  { name: 'Maximum rescues', options: [1, 2, 3, 5] },
  { name: 'Maximum total', options: [100, 250, 500, 1_000, 2_500, 5_000] },
  { name: 'Minimum remaining', options: [100, 250, 500, 1_000, 2_500] },
  { name: 'Cooldown', options: [5, 15, 30, 60] },
] as const;
/** Defaults in WHOLE AUSD; turned into the token's units with `unitOf`. */
export const RESCUE_DEFAULTS = { triggerPct: 0.03, amountAusd: 100n, maxRescues: 2, minRemainingAusd: 500n, cooldownMs: 15 * 60_000 } as const;
const defaultAmount = (d: Pick<RescueDraft, 'collateralDecimals'>): bigint => RESCUE_DEFAULTS.amountAusd * unitOf(d.collateralDecimals);

export const freshDraft = (a: Pick<RiskAssessment, 'marketId' | 'positionId'>, rule: RescueRuleView | undefined, collateralDecimals: number): RescueDraft => ({
  marketId: a.marketId,
  collateralDecimals,
  positionId: a.positionId ?? 0,
  triggerPct: undefined,
  amountCNS: undefined,
  maxRescues: rule?.maxRescues ?? RESCUE_DEFAULTS.maxRescues,
  maxTotalCNS: undefined,
  minRemainingCNS: rule?.minRemainingCNS ?? RESCUE_DEFAULTS.minRemainingAusd * unitOf(collateralDecimals),
  cooldownMs: rule?.cooldownMs ?? RESCUE_DEFAULTS.cooldownMs,
});

/** The cap shown and sent: the person's pick, or count x amount until they pick one. */
export const capOf = (d: RescueDraft): bigint => d.maxTotalCNS ?? BigInt(d.maxRescues) * (d.amountCNS ?? defaultAmount(d));

/** Applies a limit choice. `level` = limit index x 100 + option index. Undefined when out of range. */
export function applyLimit(d: RescueDraft, level: number): RescueDraft | undefined {
  const limit = RESCUE_LIMITS[Math.floor(level / 100)];
  const value = limit?.options[level % 100];
  if (limit === undefined || value === undefined) return undefined;
  switch (Math.floor(level / 100)) {
    case 0:
      return { ...d, maxRescues: value };
    case 1:
      return { ...d, maxTotalCNS: BigInt(value) * unitOf(d.collateralDecimals) };
    case 2:
      return { ...d, minRemainingCNS: BigInt(value) * unitOf(d.collateralDecimals) };
    default:
      return { ...d, cooldownMs: value * 60_000 };
  }
}

/** "4" or "4%" or "3.5" -> 0.04 / 0.035. Between 0.5% and 20%. */
export function parseTriggerPct(text: string): { readonly pct: number } | { readonly error: string } {
  const m = /^\s*(\d+(?:\.\d{1,2})?)\s*%?\s*$/.exec(text);
  const v = m === null ? NaN : Number(m[1]);
  if (!Number.isFinite(v) || v < 0.5 || v > 20) return { error: 'Send a percentage between 0.5 and 20, like 4 or 3.5.' };
  return { pct: v / 100 };
}

/** "25" or "25.5" AUSD -> the token's units. Between 1 and 100,000 AUSD, up to two decimals. */
export function parseRescueAmount(text: string, collateralDecimals: number): { readonly amountCNS: bigint } | { readonly error: string } {
  const AUSD = unitOf(collateralDecimals);
  const m = /^\s*(\d{1,6})(?:\.(\d{1,2}))?\s*(?:ausd)?\s*$/i.exec(text.replace(/,/g, ''));
  if (m === null) return { error: 'Send an amount in AUSD, like 25 or 150.' };
  if (collateralDecimals < 2) return { error: 'This collateral cannot take hundredths. Send a whole amount.' };
  const cns = BigInt(m[1]!) * AUSD + (BigInt((m[2] ?? '').padEnd(2, '0')) * AUSD) / 100n;
  if (cns < AUSD || cns > 100_000n * AUSD) return { error: 'Send an amount between 1 and 100,000 AUSD.' };
  return { amountCNS: cns };
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} minutes`;
/** ON, PAUSED (on, waiting for the person) or OFF (ended), with the reason when there is one. */
const ruleStatus = (r: RescueRuleView | undefined): string =>
  r === undefined
    ? '⚪ OFF'
    : !r.enabled
      ? `⚪ OFF${r.pausedReason === undefined ? '' : ` (${esc(r.pausedReason)})`}`
      : r.pausedReason !== undefined
        ? `⏸ PAUSED (${esc(r.pausedReason)})`
        : '🟢 ON';

// ── 38 the menu ─────────────────────────────────────────────────────────────

export function rescueMenuScreen(input: {
  readonly accountId: number;
  readonly execution: ExecutionState;
  readonly assessments: readonly RiskAssessment[];
  readonly rules: readonly RescueRuleView[];
  readonly stopped: boolean;
  readonly otherAutomation: string | undefined;
}): Screen {
  const on = input.rules.filter((r) => r.enabled && r.pausedReason === undefined);
  const lines = [
    '🛟 <b>LIQUIDATION RESCUE</b>',
    '',
    'Adds margin to your own position, automatically, when it gets close to liquidation. Never removes margin. Every rule has limits.',
    '',
    `Account: <b>#${input.accountId}</b>`,
    `Execution: ${input.execution.dot} ${esc(input.execution.label)}`,
    `Status: ${on.length === 0 ? '⚪ OFF' : `🟢 ON for ${on.map((r) => esc(r.symbol)).join(', ')}`}`,
  ];
  if (input.stopped) lines.push('', '⛔ <b>Automation is stopped</b> (kill switch). Rules stay, and nothing acts until it is turned back on.');
  if (input.otherAutomation !== undefined) lines.push('', `${esc(input.otherAutomation)} is running on this account. One automation at a time: stop it before turning Rescue on.`);
  const open = input.assessments.filter((a) => a.positionId !== undefined && !isBlind(a.state));
  const buttons: Button[][] = open.slice(0, 8).map((a) => {
    const r = input.rules.find((x) => x.marketId === a.marketId && x.positionId === a.positionId);
    return [{ text: `${a.symbol} · ${shortDistance(a.liqBufferPct)} · ${ruleStatus(r).replace(/ \(.*\)/, '')}`, route: { to: 'rescue-pos', marketId: a.marketId } }];
  });
  if (open.length === 0) lines.push('', 'No open positions, so there is nothing to protect yet.');
  else lines.push('', 'Choose a position:');
  buttons.push([{ text: '← Back', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}

// ── 39 a position ───────────────────────────────────────────────────────────

export function rescuePositionScreen(input: { readonly assessment: RiskAssessment; readonly market: MarketRiskConfig | undefined; readonly rule: RescueRuleView | undefined }): Screen {
  const { assessment: a, rule: r } = input;
  const lines = ['🛟 <b>RESCUE</b>', '', ...positionCard(a, input.market), '', `Rescue: ${ruleStatus(r)}`];
  if (r !== undefined) {
    // Amounts need the collateral's decimals, which come with the market's config; without it no figure is shown.
    if (input.market === undefined) lines.push('   No market details, so no amounts to show.');
    else lines.push(...ruleLines(r, input.market.collateralDecimals));
  }
  const buttons: Button[][] = [];
  if (r?.enabled === true && r.pausedReason !== undefined) {
    lines.push(
      '',
      r.pausedReason === 'unknown outcome'
        ? 'Paused because a rescue could not be confirmed. Check the margin above before resuming: it may already have landed.'
        : 'Paused because the same refusal came back twice. Nothing was sent. Resume once the cause has cleared.',
    );
    buttons.push([{ text: '▶️ Resume Rescue', route: { to: 'rescue-resume', marketId: a.marketId } }]);
  }
  buttons.push([{ text: r?.enabled === true ? '⚙️ Change Rescue' : '⚙️ Configure Rescue', route: { to: 'rescue-cfg', marketId: a.marketId } }]);
  if (r?.enabled === true) buttons.push([{ text: '⛔ Stop Rescue', route: { to: 'rescue-stop', marketId: a.marketId } }]);
  buttons.push([{ text: '➕ Add Margin Now', route: { to: 'margin-add', marketId: a.marketId } }]);
  buttons.push([{ text: '← Back', route: { to: 'rescue' } }]);
  return { html: lines.join('\n'), buttons };
}

function ruleLines(r: RescueRuleView, d: number): string[] {
  return [
    `   Trigger ≤ <b>${pct(r.triggerPct)}</b> · add ${money(r.amountCNS, 'ceil', d)}`,
    `   Rescues used ${r.rescueCount} / ${r.maxRescues} · added ${held(r.totalRescuedCNS, d)} of ${money(r.maxTotalCNS, 'floor', d)}`,
    `   Keeps ${money(r.minRemainingCNS, 'floor', d)} free · ${minutes(r.cooldownMs)} apart`,
  ];
}

// ── 40 trigger, 41 amount ───────────────────────────────────────────────────

export function rescueTriggerScreen(a: RiskAssessment): Screen {
  return {
    html: [`🛟 <b>${esc(a.symbol)}</b> is ${distance(a.liqBufferPct)}.`, '', 'Rescue when it gets this close to liquidation:'].join('\n'),
    buttons: [
      RESCUE_TRIGGERS_PCT.map((p, i) => ({ text: `${p}%`, route: { to: 'rescue-trig', level: i } }) as Button),
      [{ text: '🎛 Custom', route: { to: 'rescue-trig-custom' } }],
      [{ text: '← Back', route: { to: 'rescue-pos', marketId: a.marketId } }],
    ],
  };
}

export function rescueAmountScreen(a: RiskAssessment, d: RescueDraft): Screen {
  return {
    html: [`🛟 <b>${esc(a.symbol)}</b> · trigger ≤ <b>${pct(d.triggerPct ?? 0)}</b>`, '', 'Add this much margin each time:'].join('\n'),
    buttons: [
      RESCUE_AMOUNTS_AUSD.map((n, i) => ({ text: `+${n.toLocaleString('en-US')}`, route: { to: 'rescue-amt', level: i } }) as Button),
      [{ text: '🎛 Custom', route: { to: 'rescue-amt-custom' } }],
      [{ text: '← Back', route: { to: 'rescue-cfg', marketId: a.marketId } }],
    ],
  };
}

// ── 42 the rule and its limits ──────────────────────────────────────────────

export function rescueReviewScreen(a: RiskAssessment, d: RescueDraft, input: { readonly stopped: boolean; readonly free: bigint | undefined }): Screen {
  const amount = d.amountCNS ?? defaultAmount(d);
  const dp = d.collateralDecimals;
  const lines = [
    '🛟 <b>RESCUE RULE</b>',
    '',
    `<b>${esc(a.symbol)}${a.side === undefined ? '' : ` ${a.side}`}</b> · now ${distance(a.liqBufferPct)}`,
    '',
    `Trigger: ≤ <b>${pct(d.triggerPct ?? 0)}</b> from liquidation, on two looks a second apart`,
    `Action: add ${money(amount, 'ceil', dp)} margin`,
    '',
    `Maximum rescues: <b>${d.maxRescues}</b>`,
    `Maximum total: ${money(capOf(d), 'floor', dp)}${d.maxTotalCNS === undefined ? ' (rescues × amount until you pick one)' : ''}`,
    `Minimum remaining: ${money(d.minRemainingCNS, 'floor', dp)} free, never spent`,
    `Cooldown: <b>${minutes(d.cooldownMs)}</b>`,
  ];
  if (a.liqBufferPct !== undefined && d.triggerPct !== undefined && a.liqBufferPct <= d.triggerPct) {
    lines.push('', `⚠️ It is already at or below the trigger, so the first rescue goes out about a second after you enable it.`);
  }
  if (capOf(d) < amount) lines.push('', '⚠️ The maximum total is below one rescue, so this rule could never act. Raise it.');
  if (input.free !== undefined && input.free - amount < d.minRemainingCNS) {
    lines.push('', `⚠️ Your free balance is ${held(input.free, dp)}. A rescue now would take it below the minimum kept, so it would wait, not send less.`);
  }
  if (input.stopped) lines.push('', '⛔ Automation is stopped (kill switch). The rule is saved but nothing acts until it is turned back on.');
  lines.push('', 'Rescue sends one top-up at a time, checks the position itself for the result, and never sends the same one twice.');
  return {
    html: lines.join('\n'),
    buttons: [
      [{ text: '🔢 Rescues', route: { to: 'rescue-limit', level: 0 } }, { text: '💵 Total', route: { to: 'rescue-limit', level: 1 } }],
      [{ text: '🏦 Keep free', route: { to: 'rescue-limit', level: 2 } }, { text: '⏱ Cooldown', route: { to: 'rescue-limit', level: 3 } }],
      [{ text: '🟢 ENABLE RESCUE', route: { to: 'rescue-on' } }],
      [{ text: 'Cancel', route: { to: 'rescue-pos', marketId: a.marketId } }],
    ],
  };
}

export function rescueLimitScreen(index: number, d: RescueDraft): Screen | undefined {
  const limit = RESCUE_LIMITS[index];
  if (limit === undefined) return undefined;
  const unit = index === 3 ? ' min' : index === 0 ? '' : ' AUSD';
  const options = limit.options
    .map((v, i) => ({ v, i }))
    // A cap below one rescue could never act: not offered.
    .filter(({ v }) => index !== 1 || BigInt(v) * unitOf(d.collateralDecimals) >= (d.amountCNS ?? defaultAmount(d)));
  return {
    html: `🛟 <b>${limit.name}</b>`,
    buttons: [
      ...chunk(options.map(({ v, i }) => ({ text: `${v.toLocaleString('en-US')}${unit}`, route: { to: 'rescue-lim', level: index * 100 + i } }) as Button), 3),
      [{ text: '← Back', route: { to: 'rescue-review' } }],
    ],
  };
}

const chunk = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Per chat and person: the rule being put together. Dropped after 15 minutes. */
export class RescueDraftStore {
  readonly #drafts = new Map<string, { draft: RescueDraft; atMs: number }>();
  readonly #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  get(chatId: number, userId: number): RescueDraft | undefined {
    const e = this.#drafts.get(`${chatId}:${userId}`);
    if (e === undefined || this.#now() - e.atMs > 15 * 60_000) return undefined;
    return e.draft;
  }
  set(chatId: number, userId: number, draft: RescueDraft): void {
    this.#drafts.set(`${chatId}:${userId}`, { draft, atMs: this.#now() });
  }
  delete(chatId: number, userId: number): void {
    this.#drafts.delete(`${chatId}:${userId}`);
  }
}
