/**
 * 🆘 KILL SWITCH, the close half (owner, 8 Oct 2026). Stop everything stops
 * automation FIRST, then closes every position one at a time, confirmed by a
 * tap on the screen that shows what it costs. One run in flight per account,
 * each request id runs once, nothing is ever re-sent. Each position's outcome
 * is read from the position list afterwards, never from the receipt; anything
 * still open is said plainly with a retry, and it never says done unless
 * every position is verified closed. Stop automation only is `killSwitch.ts`.
 *
 * The bot formats; the backend (`apps/backend/src/emergency/`) closes and
 * judges. This file never decides that anything closed.
 */
import { esc, signedPnl } from '@perpguard/backend/alerts/plain';
import { shortWhen, type Button, type Screen } from './screens.ts';

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

/** A confirmation is good for this long after the cost was shown: prices move. */
export const STOP_ALL_CONFIRM_MS = 2 * 60_000;

const sizeOf = (lns: bigint, dp: number): string => {
  const unit = 10n ** BigInt(dp);
  const whole = lns / unit;
  const frac = (lns % unit).toString().padStart(dp, '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac === '' ? '' : `.${frac}`}`;
};
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

// ── 🆘 the screen ───────────────────────────────────────────────────────────

const MENU: Button = { text: '🏠 Menu', route: { to: 'home' } };
const POSITIONS: Button = { text: '📊 My positions', route: { to: 'positions' } };

/**
 * 🆘 KILL SWITCH (owner, 8 Oct 2026). ONE main action, Stop everything: stop
 * automation, then close every position. Under it, smaller, Stop automation
 * only, which leaves positions open and needs nothing from the exchange: on
 * the day the connection is dropping, closing is impossible but stopping
 * still works, and that is the day this exists for.
 */
export function killScreen(input: { readonly stopped: boolean; readonly changedAtMs: number | undefined; readonly canClose: boolean }): Screen {
  const lines = ['🆘 <b>KILL SWITCH</b>', ''];
  if (input.stopped) {
    lines.push(`🛑 Automation stopped${input.changedAtMs === undefined ? '' : ` since ${shortWhen(input.changedAtMs)}`}. Your positions are still open.`, '');
    if (input.canClose) lines.push("Stop everything closes all your positions at whatever price they get. This realises your losses and can't be undone.");
  } else {
    lines.push(
      input.canClose ? 'Stops every automation and closes all your positions at whatever price they get.' : 'Stops every automation.',
      '',
      input.canClose ? "This realises your losses and can't be undone." : 'Your positions stay open.',
    );
  }
  const buttons: Button[][] = [];
  if (input.canClose) buttons.push([{ text: '🆘 Stop everything', route: { to: 'stop-all' } }]);
  if (input.stopped) buttons.push([{ text: '▶️ Resume automation', route: { to: 'kill-resume-ask' } }]);
  else buttons.push([{ text: 'Stop automation only — leaves your positions open', route: { to: 'kill-confirm' } }]);
  buttons.push([{ text: '← Back', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}

// ── 🆘 the cost ─────────────────────────────────────────────────────────────

/** `−84 AUSD`: a loss rounded away from zero. */
const pnlText = (cns: bigint | undefined): string => (cns === undefined ? 'not priced' : signedPnl(cns));

/**
 * 🆘 STOP EVERYTHING? The cost, position by position, and what they add up
 * to; confirmed by a TAP. Prices move while it runs, said so.
 */
export function stopAllConfirmScreen(positions: readonly EmergencyPosition[] | undefined): Screen {
  const cancel: Button = { text: 'Cancel', route: { to: 'kill' } };
  if (positions === undefined) {
    return {
      html: ['🆘 <b>STOP EVERYTHING?</b>', '', "I can't see your positions right now, so I can't close them.", 'I can still stop automation — that works without the exchange.'].join('\n'),
      buttons: [[{ text: 'Stop automation only', route: { to: 'kill-confirm' } }], [cancel]],
    };
  }
  if (positions.length === 0) {
    return {
      html: ['🆘 <b>STOP EVERYTHING?</b>', '', "You have no open positions, so there's nothing to close. This stops automation."].join('\n'),
      buttons: [[{ text: '🆘 Yes, stop automation', route: { to: 'kill-stop' }, fresh: true }], [cancel]],
    };
  }
  const known = positions.filter((p) => p.unrealisedPnlCNS !== undefined);
  const total = known.reduce((s, p) => s + (p.unrealisedPnlCNS ?? 0n), 0n);
  const names = positions.map((p) => `${p.symbol} ${p.side}`);
  const nameW = Math.max(...names.map((n) => n.length));
  const sizes = positions.map((p) => sizeOf(p.sizeLNS, p.lotDecimals));
  const sizeW = Math.max(...sizes.map((x) => x.length));
  const pnls = positions.map((p) => pnlText(p.unrealisedPnlCNS));
  const pnlW = Math.max(...pnls.map((x) => x.length), pnlText(total).length);
  const rows = positions.map((_, i) => `${pad(names[i]!, nameW)}  ${lpad(sizes[i]!, sizeW)}  ${lpad(pnls[i]!, pnlW)}`);
  const width = nameW + sizeW + pnlW + 4;
  const table = [...rows, lpad('─'.repeat(Math.max(8, pnlW)), width), `${pad('You realise', width - pnlW)}${lpad(pnlText(total), pnlW)}`];
  const lines = ['🆘 <b>STOP EVERYTHING?</b>', '', `Closing ${positions.length} position${positions.length === 1 ? '' : 's'}:`, `<pre>${esc(table.join('\n'))}</pre>`];
  const unpriced = positions.filter((p) => p.unrealisedPnlCNS === undefined).map((p) => p.symbol);
  if (unpriced.length > 0) lines.push(`${esc(unpriced.join(', '))} can't be priced right now, so the total leaves ${unpriced.length === 1 ? 'it' : 'them'} out.`);
  lines.push('Prices move while this runs, so the real figure will differ.', 'Automation stops first.');
  return { html: lines.join('\n'), buttons: [[{ text: '🆘 Yes, stop everything', route: { to: 'stop-all-go' }, fresh: true }], [cancel]] };
}

export function stopAllExpiredScreen(): Screen {
  return {
    html: "🆘 <b>STOP EVERYTHING</b>\n\nThat list is more than two minutes old and prices have moved, so nothing was sent. Here it is again.",
    buttons: [[{ text: '🆘 Stop everything', route: { to: 'stop-all' } }], [MENU]],
  };
}

export function closeAllNothingScreen(why: 'already-flat' | 'cannot-see' | 'no-session'): Screen {
  const text: Record<typeof why, string> = {
    'already-flat': 'You have no open positions, so nothing was closed.',
    'cannot-see': "I can't see your positions right now, so I didn't close anything. Check them on Perpl, or try again in a moment.",
    'no-session': "Your trading account isn't connected right now, so I couldn't close anything. Close your positions on Perpl.",
  };
  return { html: `🆘 <b>STOP EVERYTHING</b>\n\n${text[why]}`, buttons: [[POSITIONS, MENU]] };
}

// ── 🆘 the result ───────────────────────────────────────────────────────────

/**
 * What became of each position, READ FROM THE POSITION LIST, never the
 * receipt. DONE only when every one is verified closed; anything still open
 * is said plainly with its own retry.
 */
export function closeAllResultScreen(report: EmergencyReport, stopped: boolean): Screen {
  if (report.kind === 'already-running') {
    return { html: '🆘 <b>STOP EVERYTHING</b>\n\nThis is already running on your account. Nothing new was sent; the result follows when it finishes.', buttons: [[POSITIONS, MENU]] };
  }
  if (report.kind === 'nothing-sent') {
    const s = closeAllNothingScreen(report.why);
    return { ...s, html: `${s.html}${stopped ? '\n\n🛑 Automation is stopped.' : ''}` };
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
  const lines = [`🆘 <b>${report.complete ? 'ALL CLOSED' : 'NOT ALL CLOSED'}</b>`, '', `<pre>${esc(rows.join('\n'))}</pre>`];
  if (stopped) lines.push('🛑 Automation is stopped.');
  const open = report.results.filter((r) => r.kind !== 'closed');
  for (const r of open) {
    lines.push(
      r.kind === 'partial'
        ? `<b>${esc(r.position.symbol)} didn't fully close</b>: ${esc(r.why)}.`
        : r.kind === 'still-open'
          ? `<b>${esc(r.position.symbol)} is still open</b>: ${esc(r.why)}.`
          : `<b>${esc(r.position.symbol)}: I can't tell yet.</b> ${esc(r.why)}`,
    );
  }
  if (open.some((r) => r.kind === 'partial' || r.kind === 'still-open')) lines.push('Tap below to try again, or close it on Perpl.');
  if (report.replayed) lines.push('', 'This is the result of a request that already ran. Nothing new was sent.');
  const retries: Button[] = open.filter((r) => r.kind === 'partial' || r.kind === 'still-open').map((r) => ({ text: `Retry ${r.position.symbol}`, route: { to: 'close-retry', marketId: r.position.marketId } }));
  return { html: lines.join('\n'), buttons: [...(retries.length === 0 ? [] : [retries]), [POSITIONS, MENU]] };
}

export function closeRetryScreen(p: EmergencyPosition): Screen {
  return {
    html: [
      `🆘 <b>Close ${esc(p.symbol)}?</b>`,
      '',
      `${esc(p.symbol)} ${p.side}: <b>${sizeOf(p.sizeLNS, p.lotDecimals)}</b> left, ${esc(pnlText(p.unrealisedPnlCNS))}.`,
      "It closes at whatever price it gets. I'll read the result from the position afterwards.",
    ].join('\n'),
    buttons: [[{ text: `Close ${p.symbol}`, route: { to: 'close-retry-go', marketId: p.marketId }, fresh: true }], [{ text: 'Cancel', route: { to: 'kill' } }]],
  };
}
