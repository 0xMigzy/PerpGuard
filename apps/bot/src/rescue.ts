/**
 * 🛟 RESCUE, the bot's half (owner, 8 Oct 2026): automatic top-ups, per
 * position, off until a tap turns them on. The bot never touches a rule
 * store: it reads and writes through `RescueControl`, which the backend
 * implements, RE-VALIDATES server-side (the position, its id, every limit,
 * the automation mode) and signs with the tap.
 *
 *   menu        one button per open position, with its Rescue state
 *   a position  the rule as ONE SENTENCE; Change amount, Change limits,
 *               Turn on. While on: who turned it on and when, top-ups used,
 *               ⛔ Turn off.
 *   amount      +100 / +250 / +500 / +1,000 AUSD or 🎛 Custom amount
 *   limits      all four on one screen, each a row of choices
 */
import type { MarketRiskConfig } from '@perpguard/shared';
import { esc, held, money, positionName } from '@perpguard/backend/alerts/plain';
import { isBlind, type RiskAssessment } from '@perpguard/backend/risk';
import { bandDot, shortBuffer } from './account.ts';
import { shortWhen } from './screens.ts';
import type { Button, Screen } from './screens.ts';

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
  enable(accountId: number, draft: RescueDraft, arm: ArmTap, options?: { readonly fromNextCrossing?: boolean }): Promise<RescueResult>;
  disable(accountId: number, marketId: number): Promise<RescueResult>;
  resume(accountId: number, marketId: number, arm: ArmTap): Promise<RescueResult>;
  /** ONE NUMBER: every armed AUTO top-up on the account moves to the alert distance (a fraction). */
  followAlertDistance?(accountId: number, triggerPct: number): Promise<void>;
}

/** One whole collateral unit (1 AUSD) in the token's own decimals. Never assumed to be 6. */
export const unitOf = (collateralDecimals: number): bigint => 10n ** BigInt(collateralDecimals);
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
const whole = (cns: bigint, d: number): string => money(cns, 'floor', d).replace(/<\/?b>/g, '');
const ceiled = (cns: bigint, d: number): string => money(cns, 'ceil', d).replace(/<\/?b>/g, '');
const pctOf = (fraction: number): string => `${Number((fraction * 100).toFixed(1))}%`;
const isOn = (r: RescueRuleView | undefined): boolean => r?.enabled === true && r.pausedReason === undefined;

/** What the menu's button says about a position's rule. */
const stateWord = (r: RescueRuleView | undefined): string => (r?.enabled !== true ? 'off' : r.pausedReason !== undefined ? '⏸ paused' : '🟢 on');

// ── the menu ────────────────────────────────────────────────────────────────

export function rescueMenuScreen(input: {
  readonly accountId: number;
  readonly network?: string | undefined;
  readonly assessments: readonly RiskAssessment[];
  readonly rules: readonly RescueRuleView[];
  readonly stopped: boolean;
  readonly otherAutomation: string | undefined;
}): Screen {
  const lines = ['🛟 <b>RESCUE</b>', '', 'Automatic top-ups, per position. Off until you turn one on.'];
  if (input.stopped) lines.push('', '🛑 Automation is stopped (🆘 Kill switch). Resume it there before turning Rescue on.');
  if (input.otherAutomation !== undefined) lines.push('', `${esc(input.otherAutomation)} is running on this account. Only one can run at a time.`);
  const open = input.assessments.filter((a) => a.positionId !== undefined && !isBlind(a.state));
  if (open.length === 0) lines.push('', 'No open positions to protect.');
  const buttons: Button[][] = open.slice(0, 8).map((a) => {
    const r = input.rules.find((x) => x.marketId === a.marketId && x.positionId === a.positionId);
    return [{ text: `${bandDot(a)} ${a.symbol}${a.side === undefined ? '' : ` ${a.side}`} · ${shortBuffer(a.liqBufferPct)} · ${stateWord(r)}`, route: { to: 'rescue-pos', marketId: a.marketId } }];
  });
  buttons.push([{ text: '← Back', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}

// ── the rule, in one sentence ───────────────────────────────────────────────

export interface RuleTerms {
  readonly triggerPct: number;
  readonly amountCNS: bigint;
  readonly maxRescues: number;
  readonly maxTotalCNS: bigint;
  readonly minRemainingCNS: bigint;
  readonly cooldownMs: number;
}

/**
 * "If BTC reaches 5% from liquidation, add 100 AUSD. Up to 2 times. Never
 * spending your last 500 AUSD. At least 15 minutes apart." The total cap is
 * said only when it is tighter than count × amount, which is when it bites.
 */
export function ruleSentence(symbol: string, t: RuleTerms, d: number): string[] {
  const lines = [
    `If ${esc(symbol)} reaches ${pctOf(t.triggerPct)} from liquidation, add ${ceiled(t.amountCNS, d)}.`,
    `Up to ${t.maxRescues === 1 ? 'once' : `${t.maxRescues} times`}. Never spending your last ${whole(t.minRemainingCNS, d)}.`,
    `At least ${minutes(t.cooldownMs)} apart.`,
  ];
  if (t.maxTotalCNS < BigInt(t.maxRescues) * t.amountCNS) lines.push(`No more than ${whole(t.maxTotalCNS, d)} in all.`);
  return lines;
}

export function rescuePositionScreen(input: {
  readonly assessment: RiskAssessment;
  readonly market: MarketRiskConfig | undefined;
  readonly rule: RescueRuleView | undefined;
  /** The rule being put together, shown while Rescue is off. */
  readonly draft: RescueDraft;
  /** Who is looking, so "by you" is said only to the person who turned it on. */
  readonly viewerTelegramUserId: number;
  readonly stopped: boolean;
  /** The free-balance floor, for the "it would wait" warning. */
  readonly free: bigint | undefined;
}): Screen {
  const { assessment: a, rule: r, draft } = input;
  const d = input.market?.collateralDecimals ?? draft.collateralDecimals;
  const head = `🛟 <b>RESCUE · ${positionName(a)}</b>`;
  const back: Button = { text: '← Back', route: { to: 'rescue' } };

  if (r?.enabled === true) {
    const lines = [`${head} · ${r.pausedReason === undefined ? '🟢 On' : '⏸ Paused'}`, '', ...ruleSentence(a.symbol, r, d), ''];
    if (r.armedAtMs !== undefined) lines.push(`Turned on by ${r.armedBy === input.viewerTelegramUserId ? 'you' : `Telegram user ${r.armedBy}`}, ${shortWhen(r.armedAtMs)}.`);
    lines.push(`Top-ups used: ${r.rescueCount} of ${r.maxRescues} · ${whole(r.totalRescuedCNS, d)} added.`);
    const buttons: Button[][] = [];
    if (r.pausedReason !== undefined) {
      lines.push(
        '',
        r.pausedReason === 'unknown outcome'
          ? "Paused: I couldn't confirm the last top-up. Check the margin before resuming — it may already have landed."
          : 'Paused: the exchange refused the same thing twice. Nothing was sent. Resume once that has cleared.',
      );
      buttons.push([{ text: '▶️ Resume', route: { to: 'rescue-resume', marketId: a.marketId } }]);
    }
    buttons.push([{ text: '⛔ Turn off', route: { to: 'rescue-stop', marketId: a.marketId } }], [back]);
    return { html: lines.join('\n'), buttons };
  }

  const amount = draft.amountCNS ?? defaultAmount(draft);
  const terms: RuleTerms = { triggerPct: draft.triggerPct ?? 0, amountCNS: amount, maxRescues: draft.maxRescues, maxTotalCNS: capOf(draft), minRemainingCNS: draft.minRemainingCNS, cooldownMs: draft.cooldownMs };
  const lines = [head, '', ...ruleSentence(a.symbol, terms, d)];
  if (r !== undefined && r.pausedReason !== undefined) lines.push('', `<i>The last rule ended: ${esc(r.pausedReason)}.</i>`);
  const inside = a.liqBufferPct !== undefined && draft.triggerPct !== undefined && a.liqBufferPct <= draft.triggerPct;
  if (capOf(draft) < amount) lines.push('', '⚠️ The total cap is below one top-up, so it could never act. Raise it under Change limits.');
  if (input.free !== undefined && input.free - amount < draft.minRemainingCNS) lines.push('', `⚠️ Your free balance is ${held(input.free, d)}: a top-up now would go below what you keep, so it would wait rather than send less.`);

  const buttons: Button[][] = [[{ text: 'Change amount', route: { to: 'rescue-cfg', marketId: a.marketId } }, { text: 'Change limits', route: { to: 'rescue-limits' } }]];
  if (input.stopped) {
    lines.push('', '🛑 Automation is stopped. Resume it under 🆘 Kill switch to turn Rescue on.');
    buttons.push([{ text: '🆘 Kill switch', route: { to: 'kill' } }]);
  } else if (inside) {
    // ARMED INSIDE THE LINE IS A CHOICE (owner's finding, 7 Oct 2026: arming at the line fired within two seconds).
    lines.push('', `It's already inside ${pctOf(draft.triggerPct ?? 0)}. Add ${ceiled(amount, d)} as soon as it's on, or wait until it has climbed back above and falls to it again?`);
    buttons.push([{ text: `🟢 Turn on · add now`, route: { to: 'rescue-on' } }], [{ text: '🟢 Turn on · next time', route: { to: 'rescue-on-next' } }]);
  } else {
    buttons.push([{ text: '🟢 Turn on', route: { to: 'rescue-on' } }]);
  }
  buttons.push([back]);
  return { html: lines.join('\n'), buttons };
}

// ── amount ──────────────────────────────────────────────────────────────────

export function rescueAmountScreen(a: RiskAssessment): Screen {
  return {
    html: `🛟 <b>RESCUE · ${positionName(a)}</b>\n\nAdd how much each time?`,
    buttons: [
      RESCUE_AMOUNTS_AUSD.map((n, i) => ({ text: `+${n.toLocaleString('en-US')}`, route: { to: 'rescue-amt', level: i } }) as Button),
      [{ text: '🎛 Custom amount', route: { to: 'rescue-amt-custom' } }],
      [{ text: '← Back', route: { to: 'rescue-pos', marketId: a.marketId } }],
    ],
  };
}

// ── the four limits, on one screen ──────────────────────────────────────────

const LIMIT_LABEL: readonly ((v: number) => string)[] = [
  (v) => (v === 1 ? 'Once' : `${v} times`),
  (v) => `${v.toLocaleString('en-US')} in all`,
  (v) => `Keep ${v.toLocaleString('en-US')}`,
  (v) => `${v} min apart`,
];

/** The value a draft holds for limit `index`, in the options' units. */
function currentLimit(d: RescueDraft, index: number): number {
  const unit = unitOf(d.collateralDecimals);
  switch (index) {
    case 0:
      return d.maxRescues;
    case 1:
      return Number(capOf(d) / unit);
    case 2:
      return Number(d.minRemainingCNS / unit);
    default:
      return Math.round(d.cooldownMs / 60_000);
  }
}

export function rescueLimitsScreen(a: RiskAssessment, d: RescueDraft): Screen {
  const amount = d.amountCNS ?? defaultAmount(d);
  const rows: Button[][] = RESCUE_LIMITS.map((limit, index) =>
    limit.options
      .map((v, i) => ({ v, i }))
      // A cap below one top-up could never act: not offered.
      .filter(({ v }) => index !== 1 || BigInt(v) * unitOf(d.collateralDecimals) >= amount)
      .map(({ v, i }) => ({ text: `${currentLimit(d, index) === v ? '✅ ' : ''}${LIMIT_LABEL[index]!(v)}`, route: { to: 'rescue-lim', level: index * 100 + i } }) as Button),
  );
  return {
    html: [
      `🛟 <b>RESCUE · ${positionName(a)}</b> · limits`,
      '',
      'How many top-ups at most, how much in all, how much free balance to always keep, and how long to wait between top-ups. Tap to change.',
    ].join('\n'),
    buttons: [...rows.flatMap((row) => chunk(row, 3)), [{ text: '← Back', route: { to: 'rescue-pos', marketId: a.marketId } }]],
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
