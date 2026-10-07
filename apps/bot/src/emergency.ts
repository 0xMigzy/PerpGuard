/**
 * 🆘 EMERGENCY (owner, 7 Oct 2026): two separate actions, never one button.
 *
 *   🔴 STOP PERPGUARD    the kill switch, unchanged (`killSwitch.ts`): local,
 *                        instant, sends nothing, positions untouched.
 *   🚪 CLOSE EVERYTHING  closes every open position. Confirmed by TYPING
 *                        "CLOSE ALL", after a screen listing every position,
 *                        its side, size and unrealised P&L and the total.
 *                        Stops PerpGuard first. The result is read from the
 *                        position list, position by position, and anything
 *                        still open gets its own Retry.
 *
 * The bot formats; the backend (`apps/backend/src/emergency/`) closes and
 * judges. This file never decides that anything closed.
 */
import { esc, signedPnl } from '@perpguard/backend/alerts/plain';
import type { Button, Screen } from './screens.ts';

export interface EmergencyPosition {
  readonly marketId: number;
  readonly symbol: string;
  readonly positionId: number;
  readonly side: 'long' | 'short';
  readonly sizeLNS: bigint;
  readonly lotDecimals: number;
  readonly unrealisedPnlCNS: bigint | undefined;
}

export type EmergencyResult =
  | { readonly kind: 'closed'; readonly position: EmergencyPosition; readonly exitPrice: number | undefined }
  | { readonly kind: 'partial'; readonly position: EmergencyPosition; readonly closedLNS: bigint; readonly remainingLNS: bigint; readonly why: string }
  | { readonly kind: 'still-open'; readonly position: EmergencyPosition; readonly why: string }
  | { readonly kind: 'not-seen'; readonly position: EmergencyPosition; readonly why: string };

export type EmergencyReport =
  | { readonly kind: 'nothing-sent'; readonly why: 'already-flat' | 'cannot-see' | 'no-session' }
  | { readonly kind: 'already-running' }
  | { readonly kind: 'ran'; readonly results: readonly EmergencyResult[]; readonly complete: boolean; readonly replayed: boolean };

export interface EmergencyControl {
  /** Every open position, or undefined when the list cannot be seen (or the account has no session). */
  preview(accountId: number): readonly EmergencyPosition[] | undefined;
  closeAll(accountId: number, requestId: string, by: string): Promise<EmergencyReport>;
  closeOne(accountId: number, marketId: number, requestId: string, by: string): Promise<EmergencyReport>;
}

/** The typed confirmation. Trimmed; case does not matter, the words do. */
export const CLOSE_ALL_PHRASE = 'CLOSE ALL';
export const isCloseAllConfirmation = (text: string): boolean => text.trim().replace(/\s+/g, ' ').toUpperCase() === CLOSE_ALL_PHRASE;
/** A typed confirmation is good for this long after the list was shown: prices move. */
export const CLOSE_ALL_CONFIRM_MS = 2 * 60_000;

const sizeOf = (lns: bigint, dp: number): string => {
  const unit = 10n ** BigInt(dp);
  const whole = lns / unit;
  const frac = (lns % unit).toString().padStart(dp, '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac === '' ? '' : `.${frac}`}`;
};
/** Signed P&L: a loss rounds away from zero, a gain toward it. Never a smaller loss than the real one. */
const pnl = (cns: bigint | undefined): string => (cns === undefined ? 'not priced' : signedPnl(cns));
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

// ── 🆘 the screen ───────────────────────────────────────────────────────────

export function emergencyScreen(input: { readonly accountId: number; readonly stopped: boolean; readonly changedAtMs: number | undefined; readonly rescueOn: readonly string[]; readonly canClose: boolean }): Screen {
  const lines = ['🆘 <b>EMERGENCY</b>', '', `Trading Account: <b>#${input.accountId}</b>`, ''];
  if (input.stopped) {
    lines.push(`🛑 <b>PerpGuard is stopped</b>${input.changedAtMs === undefined ? '' : ` since ${new Date(input.changedAtMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`}. New automated actions are blocked; your positions were not touched.`, '');
  } else {
    lines.push('🔴 <b>STOP PERPGUARD</b>', 'Blocks every automated action right now. Your positions and margin are untouched. Works even if the exchange is unreachable.', '');
    if (input.rescueOn.length > 0) lines.push(`Running now: 🛟 Rescue on ${input.rescueOn.map(esc).join(', ')}`, '');
  }
  lines.push('🚪 <b>CLOSE EVERYTHING</b>', 'Exits the market. Closes all your positions at whatever price they get. Realises your losses. Cannot be undone.');
  const buttons: Button[][] = [];
  if (input.stopped) buttons.push([{ text: '▶️ Resume automation', route: { to: 'kill-resume-ask' } }]);
  else buttons.push([{ text: '🔴 Stop PerpGuard', route: { to: 'kill-confirm' } }]);
  if (input.canClose) buttons.push([{ text: '🚪 Close everything', route: { to: 'close-all' } }]);
  buttons.push([{ text: '← Back', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}

// ── 🚪 the confirmation ─────────────────────────────────────────────────────

export function closeAllConfirmText(positions: readonly EmergencyPosition[]): string {
  const known = positions.filter((p) => p.unrealisedPnlCNS !== undefined);
  const total = known.reduce((s, p) => s + (p.unrealisedPnlCNS ?? 0n), 0n);
  const rows = positions.map((p) => `${pad(p.symbol, 5)} ${pad(p.side, 5)} ${lpad(sizeOf(p.sizeLNS, p.lotDecimals), 9)}  ${lpad(pnl(p.unrealisedPnlCNS), 15)}`);
  const width = Math.max(...rows.map((r) => r.length), 20);
  const lines = [
    '🚪 <b>CLOSE EVERYTHING</b>',
    '',
    `About to close <b>${positions.length} position${positions.length === 1 ? '' : 's'}</b>:`,
    `<pre>${esc([...rows, lpad('────────', width), `${pad('Realised now', width - 15)}${lpad(pnl(total), 15)}`].join('\n'))}</pre>`,
  ];
  const unpriced = positions.filter((p) => p.unrealisedPnlCNS === undefined).map((p) => p.symbol);
  if (unpriced.length > 0) lines.push(`${esc(unpriced.join(', '))} cannot be priced right now, so the total leaves ${unpriced.length === 1 ? 'it' : 'them'} out.`);
  lines.push(
    '',
    'Prices move while this runs, so the real figure will differ.',
    'PerpGuard stops first, so nothing tops up what you are exiting.',
    '',
    `<b>Type ${CLOSE_ALL_PHRASE} to confirm.</b> Anything else cancels. Nothing is sent until you do.`,
  );
  return lines.join('\n');
}

export function closeAllNothingScreen(why: 'already-flat' | 'cannot-see' | 'no-session'): Screen {
  const text: Record<typeof why, string> = {
    'already-flat': 'You have no open positions, so there is nothing to close. Nothing was sent.',
    'cannot-see': 'I cannot see your positions right now, so I will not close anything blind. Nothing was sent. Check them on Perpl, or try again in a moment.',
    'no-session': 'Your trading account is not connected right now, so nothing can be closed from here. Nothing was sent. Close positions on Perpl directly.',
  };
  return { html: `🚪 <b>CLOSE EVERYTHING</b>\n\n${text[why]}`, buttons: [[{ text: '📊 View positions', route: { to: 'positions' } }, { text: '🏠 Main Menu', route: { to: 'home' } }]] };
}

// ── 🚪 the result ───────────────────────────────────────────────────────────

export function closeAllResultScreen(report: EmergencyReport, stopped: boolean): Screen {
  const home: Button[] = [{ text: '📊 View positions', route: { to: 'positions' } }, { text: '🏠 Main Menu', route: { to: 'home' } }];
  if (report.kind === 'already-running') {
    return { html: '🚪 <b>CLOSE EVERYTHING</b>\n\nA close-everything is already running on this account. Nothing new was sent; its result follows when it finishes.', buttons: [home] };
  }
  if (report.kind === 'nothing-sent') {
    const s = closeAllNothingScreen(report.why);
    return { ...s, html: `${s.html}${stopped ? '\n\nPerpGuard is stopped.' : ''}` };
  }
  const rows = report.results.map((r) => {
    const p = r.position;
    const total = sizeOf(p.sizeLNS, p.lotDecimals);
    switch (r.kind) {
      case 'closed':
        return `${pad(p.symbol, 5)} closed         ${lpad(total, 9)}${r.exitPrice === undefined ? '' : `  at ${r.exitPrice.toLocaleString('en-US')}`}`;
      case 'partial':
        return `${pad(p.symbol, 5)} PARTLY closed  ${sizeOf(r.remainingLNS, p.lotDecimals)} of ${total} left`;
      case 'still-open':
        return `${pad(p.symbol, 5)} STILL OPEN     ${total}`;
      case 'not-seen':
        return `${pad(p.symbol, 5)} NOT SEEN       ${total}`;
    }
  });
  const lines = [`🚪 <b>CLOSE EVERYTHING — ${report.complete ? 'DONE' : 'NOT ALL CLOSED'}</b>`, '', `<pre>${esc(rows.join('\n'))}</pre>`];
  if (stopped) lines.push('PerpGuard is stopped.');
  const open = report.results.filter((r) => r.kind !== 'closed');
  for (const r of open) {
    const what =
      r.kind === 'partial'
        ? `<b>${esc(r.position.symbol)} did not fully close</b>: ${esc(r.why)}.`
        : r.kind === 'still-open'
          ? `<b>${esc(r.position.symbol)} is still open</b>: ${esc(r.why)}.`
          : `<b>${esc(r.position.symbol)}: I cannot say.</b> ${esc(r.why)}`;
    lines.push(what);
  }
  if (open.some((r) => r.kind === 'partial' || r.kind === 'still-open')) lines.push('Tap below to try again, or close it on Perpl.');
  if (report.replayed) lines.push('', 'This is the result of a request that already ran. Nothing new was sent.');
  const retries: Button[] = open.filter((r) => r.kind === 'partial' || r.kind === 'still-open').map((r) => ({ text: `Retry ${r.position.symbol}`, route: { to: 'close-retry', marketId: r.position.marketId } }));
  return { html: lines.join('\n'), buttons: [...(retries.length === 0 ? [] : [retries]), home] };
}

export function closeRetryScreen(p: EmergencyPosition): Screen {
  return {
    html: [
      `🚪 <b>CLOSE ${esc(p.symbol)}</b>`,
      '',
      `${esc(p.symbol)} ${p.side}, <b>${sizeOf(p.sizeLNS, p.lotDecimals)}</b> left, P&amp;L ${esc(pnl(p.unrealisedPnlCNS))}.`,
      'This sends a close at whatever price it gets. The result is read from the position afterwards.',
    ].join('\n'),
    buttons: [[{ text: `🚪 Close ${p.symbol}`, route: { to: 'close-retry-go', marketId: p.marketId }, fresh: true }], [{ text: 'Cancel', route: { to: 'kill' } }]],
  };
}
