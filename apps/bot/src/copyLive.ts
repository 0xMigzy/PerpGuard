/**
 * 🔁 COPY TRADING, HALF B: the screens (owner, 7 Oct 2026). Testnet only, for
 * a linked chat. Setup states every rule and limit before anything starts;
 * the status screen shows what was copied, what was not and why, and stops in
 * one tap. Every money figure is the backend's; this file only words it.
 */
import { esc } from '@perpguard/backend/alerts/plain';
import type { Button, Screen } from './screens.ts';

/** What the bot needs from the backend's `CopyControlService`. */
export interface CopyLiveControl {
  status(followerAccountId: number): { readonly rule: CopyRuleView | undefined; readonly legs: readonly CopyLegView[] };
  start(followerAccountId: number, leaderAccountId: number, keepFreeCNS: bigint, arm: { readonly telegramUserId: number; readonly chatId: number }): Promise<{ readonly ok: boolean; readonly text: string }>;
  stop(followerAccountId: number): Promise<{ readonly ok: boolean; readonly text: string }>;
  resume(followerAccountId: number, arm: { readonly telegramUserId: number; readonly chatId: number }): Promise<{ readonly ok: boolean; readonly text: string }>;
  setKeepFree(followerAccountId: number, keepFreeCNS: bigint, arm: { readonly telegramUserId: number; readonly chatId: number }): Promise<{ readonly ok: boolean; readonly text: string }>;
}

export interface CopyRuleView {
  readonly leaderAccountId: number;
  readonly keepFreeCNS: bigint;
  readonly enabled: boolean;
  readonly pausedReason: string | undefined;
  readonly startedAtMs: number;
}

export interface CopyLegView {
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly status: string;
  readonly reason: string | undefined;
  readonly leaderOpenedAtMs: number;
}

/** The free balance never spent: the one number (default 500, 0 allowed). */
export const KEEP_FREE_PRESETS_AUSD = [0, 100, 500, 1_000] as const;
export const DEFAULT_KEEP_FREE_INDEX = 2;
export const COPY_RULE_TEXT = 'PerpGuard copies when they open and when they close, not every adjustment in between.';

const whole = (cns: bigint, d = 6): string => `${(cns / 10n ** BigInt(d)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} AUSD`;
const keepRow = (current: bigint, route: 'copy-keep' | 'copy-keep-set'): Button[] =>
  KEEP_FREE_PRESETS_AUSD.map((a, level) => ({ text: `${current === BigInt(a) * 1_000_000n ? '✅ ' : ''}${a.toLocaleString('en-US')}`, route: { to: route, level } }));

export function copySetupScreen(input: {
  readonly leaderAccountId: number;
  readonly network: string;
  readonly keepFreeCNS: bigint;
  /** The leader can be copied (books reconciled, not too busy), or the sentence why not. */
  readonly verified: { readonly ok: boolean; readonly text: string } | undefined;
  /** The trader card's lines, reused: activity and the replay's two windows. */
  readonly activityLine: string | undefined;
  readonly copiedLine: string | undefined;
  readonly copyingOther: number | undefined;
  readonly stopped: boolean;
}): Screen {
  const id = input.leaderAccountId;
  const lines = [
    `🔁 <b>COPY #${id}</b> · on ${esc(input.network)}`,
    '',
    `When #${id} opens a position on mainnet, PerpGuard opens one on your ${esc(input.network)} account, sized to your account: your equity over theirs (2% of theirs is 2% of yours), at ${esc(input.network)}'s price. When they close it, yours closes.`,
    '',
    `<b>${COPY_RULE_TEXT}</b>`,
    '',
    `No limit on how many: if they open ten, you copy ten. It never spends the last <b>${whole(input.keepFreeCNS)}</b> of your free balance; an open that would is skipped, and you are told.`,
    `Markets ${esc(input.network)} does not list are skipped, by name. A market where you already hold a position is skipped: a copy would change your own.`,
    'Every copy is checked against your position list, never the receipt. One that does not open is said and never sent again; one that cannot be confirmed pauses copying until you look.',
  ];
  if (input.activityLine !== undefined) lines.push('', input.activityLine);
  if (input.copiedLine !== undefined) lines.push(input.copiedLine);
  lines.push('', '<i>Prices and timing differ: a copy follows within about 30 seconds plus the index\'s delay, at testnet prices. Past profit predicts nothing. Stopping leaves copied positions open; it never moves money.</i>');

  const buttons: Button[][] = [];
  if (input.verified !== undefined && !input.verified.ok) {
    lines.push('', `⛔ <b>${esc(input.verified.text)}</b>`);
  } else if (input.stopped) {
    lines.push('', '🛑 PerpGuard is stopped (🆘 Emergency): resume it before copying anyone.');
    buttons.push([{ text: '🆘 Emergency', route: { to: 'kill' } }]);
  } else if (input.copyingOther !== undefined) {
    lines.push('', `You are copying #${input.copyingOther}. One trader at a time: stop that first.`);
    buttons.push([{ text: '🔁 Copy Trading', route: { to: 'copy-status' } }]);
  } else {
    lines.push('', 'Keep free (AUSD):');
    buttons.push(keepRow(input.keepFreeCNS, 'copy-keep'));
    buttons.push([{ text: `✅ Start copying #${id}`, route: { to: 'copy-start' } }]);
  }
  buttons.push([{ text: '← Back', route: { to: 'trader', accountId: id } }]);
  return { html: lines.join('\n'), buttons };
}

const STATUS_WORD: Readonly<Record<string, string>> = {
  open: 'open',
  opening: 'opening…',
  closing: 'closing…',
  closed: 'closed',
  'not-opened': 'not opened',
  unknown: 'not confirmed',
  'close-not-landed': 'still open (close did not land)',
  'closed-by-you': 'closed by you',
  skipped: 'skipped',
};

export function copyStatusScreen(input: { readonly rule: CopyRuleView | undefined; readonly legs: readonly CopyLegView[]; readonly nowMs?: number }): Screen {
  const r = input.rule;
  if (r === undefined || (!r.enabled && input.legs.length === 0)) {
    return {
      html: ['🔁 <b>COPY TRADING</b>', '', 'You are not copying anyone. Open 🏆 Top Traders, pick a trader, and tap 🔁 Copy this trader.', '', `<i>${COPY_RULE_TEXT}</i>`].join('\n'),
      buttons: [[{ text: '🏆 Top Traders', route: { to: 'top' } }], [{ text: '← Home', route: { to: 'home' } }]],
    };
  }
  const state = !r.enabled ? `⚪ OFF${r.pausedReason === undefined ? '' : ` (${esc(r.pausedReason)})`}` : r.pausedReason !== undefined ? `⏸ PAUSED: ${esc(r.pausedReason)}` : '🟢 ON';
  const since = new Date(r.startedAtMs).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [`🔁 <b>COPYING #${r.leaderAccountId}</b> · ${state}`, `Since ${since} UTC · keeps <b>${whole(r.keepFreeCNS)}</b> free`, ''];
  const open = input.legs.filter((l) => ['open', 'opening', 'closing', 'close-not-landed', 'unknown'].includes(l.status));
  const done = input.legs.filter((l) => !open.includes(l));
  lines.push(open.length === 0 ? 'No copied positions open.' : `<b>Copied positions open: ${open.length}</b>`);
  for (const l of open.slice(-8)) lines.push(`• ${esc(l.symbol)} ${l.side} · ${STATUS_WORD[l.status] ?? l.status}`);
  if (done.length > 0) {
    const skipped = done.filter((l) => l.status === 'skipped').length;
    const closed = done.filter((l) => l.status === 'closed' || l.status === 'closed-by-you').length;
    const notOpened = done.filter((l) => l.status === 'not-opened').length;
    lines.push('', `Earlier: ${closed} closed · ${skipped} skipped · ${notOpened} not opened`);
    for (const l of done.slice(-4).reverse()) lines.push(`• ${esc(l.symbol)} ${l.side} · ${STATUS_WORD[l.status] ?? l.status}${l.reason === undefined || l.status !== 'skipped' ? '' : `: ${esc(l.reason)}`}`);
  }
  lines.push('', `<i>${COPY_RULE_TEXT} Stopping leaves copied positions open; it never moves money.</i>`);
  const buttons: Button[][] = [];
  if (r.enabled) {
    if (r.pausedReason !== undefined) buttons.push([{ text: '▶️ Resume copying', route: { to: 'copy-resume' } }]);
    buttons.push([{ text: '⛔ Stop copying', route: { to: 'copy-stop' } }]);
    buttons.push(keepRow(r.keepFreeCNS, 'copy-keep-set'));
  }
  buttons.push([{ text: '📊 My Positions', route: { to: 'positions' } }, { text: '← Home', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}
