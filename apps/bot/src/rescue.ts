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
import { distanceLabel } from '@perpguard/backend/manual/distance';
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
  /** Who armed it with a tap, and when. Undefined on a rule armed any other way (never acted on). */
  readonly armedBy?: number | undefined;
  readonly armedAtMs?: number | undefined;
}

/** Who tapped, from which chat: the only thing that can arm Auto top-up. */
export interface ArmTap {
  readonly telegramUserId: number;
  readonly chatId: number;
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
  /** Arms Auto top-up. ONLY ever called from the tap's handler, with that tap. */
  enable(accountId: number, draft: RescueDraft, arm: ArmTap): Promise<RescueResult>;
  disable(accountId: number, marketId: number): Promise<RescueResult>;
  resume(accountId: number, marketId: number, arm: ArmTap): Promise<RescueResult>;
  /** ONE NUMBER: every armed AUTO top-up on the account moves to the alert distance (a fraction). */
  followAlertDistance?(accountId: number, triggerPct: number): Promise<void>;
}

/** One whole collateral unit (1 AUSD) in the token's own decimals. Never assumed to be 6. */
export const unitOf = (collateralDecimals: number): bigint => 10n ** BigInt(collateralDecimals);
export const RESCUE_TRIGGERS_PCT = [10, 5, 3, 2] as const;
export const RESCUE_AMOUNTS_AUSD = [100, 250, 500, 1_000] as const;
/** The four limits, each its own choice. Max total is NEVER derived once picked. */
export const RESCUE_LIMITS = [
  { name: 'Maximum top-ups', options: [1, 2, 3, 5] },
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
  /** The account's alert distance, percent. */
  readonly alertPct: number;
}): Screen {
  const on = input.rules.filter((r) => r.enabled && r.pausedReason === undefined);
  const lines = [
    '🛟 <b>RESCUE</b>',
    '',
    `🔔 <b>Alert</b>, always on: when a position gets within <b>${distanceLabel(input.alertPct)}</b> of liquidation, I message you once with its distance, your free balance and amounts to add. Nothing moves unless you tap and confirm. Change the distance in ⚙️ Settings.`,
    '',
    '🤖 <b>Auto top-up</b>, off until you turn it on for a position: at that same distance it adds the amount you chose by itself, within limits you set. One tap turns it off.',
    '',
    `Account: <b>#${input.accountId}</b>`,
    `Execution: ${input.execution.dot} ${esc(input.execution.label)}`,
    `Auto top-up: ${on.length === 0 ? '⚪ off everywhere' : `🟢 on for ${on.map((r) => esc(r.symbol)).join(', ')}`}`,
  ];
  if (input.stopped) lines.push('', '🛑 <b>PerpGuard is stopped</b> (🆘 Emergency). Auto top-up is off on every position and cannot be turned on until automation is resumed. Alerts still come.');
  if (input.otherAutomation !== undefined) lines.push('', `${esc(input.otherAutomation)} is running on this account. One automation at a time: stop it before turning Auto top-up on.`);
  const open = input.assessments.filter((a) => a.positionId !== undefined && !isBlind(a.state));
  const buttons: Button[][] = open.slice(0, 8).map((a) => {
    const r = input.rules.find((x) => x.marketId === a.marketId && x.positionId === a.positionId);
    return [{ text: `${a.symbol} · ${shortDistance(a.liqBufferPct)} · auto ${ruleStatus(r).replace(/ \(.*\)/, '')}`, route: { to: 'rescue-pos', marketId: a.marketId } }];
  });
  if (open.length === 0) lines.push('', 'No open positions, so there is nothing to watch over yet.');
  else lines.push('', 'Choose a position:');
  buttons.push([{ text: '← Back', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}

// ── 39 a position ───────────────────────────────────────────────────────────

export function rescuePositionScreen(input: {
  readonly assessment: RiskAssessment;
  readonly market: MarketRiskConfig | undefined;
  readonly rule: RescueRuleView | undefined;
  /** The account's alert distance, percent. */
  readonly alertPct: number;
  /** Who is looking, so "armed by you" is said only to the person who armed it. */
  readonly viewerTelegramUserId: number;
}): Screen {
  const { assessment: a, rule: r } = input;
  const lines = ['🛟 <b>RESCUE</b>', '', ...positionCard(a, input.market), '', `🔔 Alert: on, at <b>${distanceLabel(input.alertPct)}</b> from liquidation`, `🤖 Auto top-up: ${ruleStatus(r)}`];
  if (r?.enabled === true && r.armedAtMs !== undefined) {
    // HOW IT WAS ARMED, on the screen (owner, 7 Oct 2026).
    lines.push(`   armed by ${r.armedBy === input.viewerTelegramUserId ? 'you' : `Telegram user ${r.armedBy}`} in the bot, ${new Date(r.armedAtMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  }
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
  // ONE TAP OFF; turning on goes through the setup and its review.
  if (r?.enabled === true) {
    buttons.push([{ text: '⛔ Turn off auto', route: { to: 'rescue-stop', marketId: a.marketId } }]);
    buttons.push([{ text: '⚙️ Change auto', route: { to: 'rescue-cfg', marketId: a.marketId } }]);
  } else {
    buttons.push([{ text: '🤖 Turn on auto', route: { to: 'rescue-cfg', marketId: a.marketId } }]);
  }
  buttons.push([{ text: '➕ Add Margin Now', route: { to: 'margin-add', marketId: a.marketId } }]);
  buttons.push([{ text: '← Back', route: { to: 'rescue' } }]);
  return { html: lines.join('\n'), buttons };
}

function ruleLines(r: RescueRuleView, d: number): string[] {
  return [
    `   Adds ${money(r.amountCNS, 'ceil', d)} at ≤ <b>${pct(r.triggerPct)}</b>`,
    `   Top-ups used ${r.rescueCount} / ${r.maxRescues} · added ${held(r.totalRescuedCNS, d)} of ${money(r.maxTotalCNS, 'floor', d)}`,
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
    html: [
      `🤖 <b>AUTO TOP-UP · ${esc(a.symbol)}</b>`,
      '',
      `It acts where your alert fires: <b>${pct(d.triggerPct ?? 0)}</b> from liquidation (change it in ⚙️ Settings).`,
      '',
      'Add this much margin each time:',
    ].join('\n'),
    buttons: [
      RESCUE_AMOUNTS_AUSD.map((n, i) => ({ text: `+${n.toLocaleString('en-US')}`, route: { to: 'rescue-amt', level: i } }) as Button),
      [{ text: '🎛 Custom', route: { to: 'rescue-amt-custom' } }],
      [{ text: '← Back', route: { to: 'rescue-pos', marketId: a.marketId } }],
    ],
  };
}

// ── 42 the rule and its limits ──────────────────────────────────────────────

export function rescueReviewScreen(a: RiskAssessment, d: RescueDraft, input: { readonly stopped: boolean; readonly free: bigint | undefined }): Screen {
  const amount = d.amountCNS ?? defaultAmount(d);
  const dp = d.collateralDecimals;
  const lines = [
    '🤖 <b>AUTO TOP-UP</b>',
    '',
    `<b>${esc(a.symbol)}${a.side === undefined ? '' : ` ${a.side}`}</b> · now ${distance(a.liqBufferPct)}`,
    '',
    `Acts at: ≤ <b>${pct(d.triggerPct ?? 0)}</b> from liquidation (your alert distance), on two looks a second apart`,
    `Adds: ${money(amount, 'ceil', dp)} each time`,
    '',
    `Maximum top-ups: <b>${d.maxRescues}</b>`,
    `Maximum total: ${money(capOf(d), 'floor', dp)}${d.maxTotalCNS === undefined ? ' (top-ups × amount until you pick one)' : ''}`,
    `Minimum remaining: ${money(d.minRemainingCNS, 'floor', dp)} free, never spent`,
    `Cooldown: <b>${minutes(d.cooldownMs)}</b>`,
  ];
  if (a.liqBufferPct !== undefined && d.triggerPct !== undefined && a.liqBufferPct <= d.triggerPct) {
    lines.push('', `⚠️ It is already at or below that distance, so the first top-up goes out about a second after you turn it on.`);
  }
  if (capOf(d) < amount) lines.push('', '⚠️ The maximum total is below one top-up, so it could never act. Raise it.');
  if (input.free !== undefined && input.free - amount < d.minRemainingCNS) {
    lines.push('', `⚠️ Your free balance is ${held(input.free, dp)}. A top-up now would take it below the minimum kept, so it would wait, not send less.`);
  }
  if (input.stopped) lines.push('', '🛑 PerpGuard is stopped (🆘 Emergency), so Auto top-up cannot be turned on. Resume automation first.');
  lines.push('', 'It sends one top-up at a time, checks the position itself for the result, never sends the same one twice, and messages you each time. One tap turns it off.');
  return {
    html: lines.join('\n'),
    buttons: [
      [{ text: '🔢 Top-ups', route: { to: 'rescue-limit', level: 0 } }, { text: '💵 Total', route: { to: 'rescue-limit', level: 1 } }],
      [{ text: '🏦 Keep free', route: { to: 'rescue-limit', level: 2 } }, { text: '⏱ Cooldown', route: { to: 'rescue-limit', level: 3 } }],
      // While automation is stopped the way on is to resume it, not a button the server would refuse.
      input.stopped ? [{ text: '🆘 Emergency', route: { to: 'kill' } }] : [{ text: '🟢 TURN ON AUTO', route: { to: 'rescue-on' } }],
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
