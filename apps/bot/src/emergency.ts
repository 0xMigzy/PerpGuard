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
import { esc, money, signedPnl } from '@perpguard/backend/alerts/plain';
import type { PartialResult } from '@perpguard/backend/emergency/partial';
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
  | { readonly kind: 'ran'; readonly results: readonly EmergencyResult[]; readonly complete: boolean; readonly replayed: boolean; readonly automationOff?: boolean };

export interface EmergencyControl {
  /** Every open position, or undefined when the list cannot be seen (or the account has no session). */
  preview(accountId: number): readonly EmergencyPosition[] | undefined;
  closeAll(accountId: number, requestId: string, by: string): Promise<EmergencyReport>;
  closeOne(accountId: number, marketId: number, requestId: string, by: string): Promise<EmergencyReport>;
  /** 🚪 Close position: that position's automation off first (never the account's), then the same verified close. */
  closePosition?(accountId: number, marketId: number, requestId: string, by: string): Promise<EmergencyReport>;
  /** 🚪 Close part of a position: what closing `closeLNS` of it is estimated to realise and cost, at the mark. */
  estimatePartial?(accountId: number, marketId: number, closeLNS: bigint): { readonly realisedCNS: bigint | undefined; readonly feeCNS: bigint | undefined };
  /** 🚪 Close part of a position: one reduce-only market order, once, judged by the position before and after. Automation is not touched. */
  reducePosition?(accountId: number, marketId: number, closeLNS: bigint, expected: { readonly positionId: number; readonly sizeLNS: bigint }, requestId: string, by: string): Promise<PartialReport>;
}

/** What became of a partial close, in the bot's terms. `result` is read from the position, never the receipt. */
export type PartialReport =
  | { readonly kind: 'nothing-sent'; readonly why: 'already-flat' | 'cannot-see' | 'no-session' | 'changed' | 'too-small' }
  | { readonly kind: 'already-running' }
  | {
      readonly kind: 'ran';
      readonly position: EmergencyPosition;
      readonly requestedLNS: bigint;
      readonly result: PartialResult;
      /** From the exchange's own fill, before the fee. Undefined when it did not report one. */
      readonly realisedCNS: bigint | undefined;
      readonly feeCNS: bigint | undefined;
      readonly replayed: boolean;
    };

/** The shares the Close position screen offers. */
export const CLOSE_PERCENTS = [25, 50, 75] as const;

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

// ── 🚪 Close position (owner, 8 Oct 2026) ─────────────────────────────────

/**
 * 🚪 CLOSE POSITION? Size, the current price and what closing realises, confirmed by a TAP; never
 * on the first. If Auto is on for this position, it is turned off first, and this screen says so.
 */
export function closePositionConfirmScreen(input: {
  readonly position: EmergencyPosition | undefined;
  /** The mark, already formatted for the market. Undefined when there is no price. */
  readonly markText: string | undefined;
  readonly autoOn: boolean;
  readonly marketId: number;
}): Screen {
  const back: Button = { text: 'Cancel', route: { to: 'close-pos', marketId: input.marketId } };
  const p = input.position;
  if (p === undefined) {
    return {
      html: ['🚪 <b>CLOSE POSITION?</b>', '', "I can't see this position right now, so I won't close it. Nothing was sent."].join('\n'),
      buttons: [[{ text: '↻ Look again', route: { to: 'position', marketId: input.marketId } }], [back]],
    };
  }
  const pnl = p.unrealisedPnlCNS;
  const lines = [
    `🚪 <b>Close ${esc(p.symbol)} ${p.side}?</b>`,
    '',
    `Size <b>${sizeOf(p.sizeLNS, p.lotDecimals)}</b>${input.markText === undefined ? '' : ` · price now ${esc(input.markText)}`}`,
    pnl === undefined
      ? "I can't price it right now, so I can't say what closing realises."
      : `You realise <b>${esc(signedPnl(pnl))}</b> ${pnl < 0n ? '(a loss)' : pnl > 0n ? '(a profit)' : ''} at today\u2019s price.`,
    'It closes at whatever price it gets, so the real figure will differ.',
  ];
  if (input.autoOn) lines.push('', '🤖 Auto top-up is on for this position. I\u2019ll turn it off first, so nothing is added while it closes.');
  lines.push('', "I'll read the result from your positions afterwards, not from the exchange's receipt.");
  return { html: lines.join('\n'), buttons: [[{ text: `🚪 Yes, close ${p.symbol} ${p.side}`, route: { to: 'close-pos-go', marketId: p.marketId }, fresh: true }], [back]] };
}

// ── 🚪 Close position: the options, and closing part of it (owner, 10 Oct 2026) ──

const feeText = (feeCNS: bigint): string => (feeCNS > 0n && feeCNS < 1_000_000n ? '<b>under 1 AUSD</b>' : money(feeCNS, 'ceil'));

/**
 * 🚪 CLOSE POSITION: how much. 25%, 50% and 75% (only those that come to at least one size unit and
 * leave at least one open), Close all, and a typed percentage. Nothing is sent from this screen.
 */
export function closeOptionsScreen(input: {
  readonly position: EmergencyPosition | undefined;
  readonly marketId: number;
  /** The percentages that can be offered for this position's size, in order. */
  readonly percents: readonly number[];
}): Screen {
  const back: Button = { text: '← Back', route: { to: 'position', marketId: input.marketId } };
  const p = input.position;
  if (p === undefined) {
    return {
      html: ['🚪 <b>CLOSE POSITION</b>', '', "I can't see this position right now, so I won't close it. Nothing was sent."].join('\n'),
      buttons: [[{ text: '↻ Look again', route: { to: 'position', marketId: input.marketId } }], [back]],
    };
  }
  const lines = [
    `🚪 <b>CLOSE ${esc(p.symbol)} ${p.side}</b>`,
    '',
    `Size <b>${sizeOf(p.sizeLNS, p.lotDecimals)}</b>${p.unrealisedPnlCNS === undefined ? '' : ` · unrealised ${esc(signedPnl(p.unrealisedPnlCNS))}`}`,
    'How much of it do you want to close? I\u2019ll show you the figures before anything is sent.',
  ];
  const route = { 25: 'close-pos-25', 50: 'close-pos-50', 75: 'close-pos-75' } as const;
  const shares: Button[] = input.percents.filter((pct): pct is 25 | 50 | 75 => pct === 25 || pct === 50 || pct === 75).map((pct) => ({ text: `${pct}%`, route: { to: route[pct], marketId: p.marketId } }));
  if (shares.length < CLOSE_PERCENTS.length) lines.push('', 'A share that comes to less than the smallest size this market trades is not offered.');
  const buttons: Button[][] = [];
  if (shares.length > 0) buttons.push(shares);
  buttons.push([{ text: 'Close all', route: { to: 'close-pos-all', marketId: p.marketId } }]);
  buttons.push([{ text: '🎛 Custom %', route: { to: 'close-pos-pct', marketId: p.marketId } }]);
  buttons.push([back]);
  return { html: lines.join('\n'), buttons };
}

/** "25", "12.5%", " 50 % " -> the percentage, or what to send instead. Whole position is 100. */
export function parseClosePercent(text: string): { readonly pct: number } | { readonly error: string } {
  const cleaned = text.trim().replace(/\s*%$/, '').replace(',', '.');
  const error = 'Send a percentage of the position to close, from 1 to 100, like 40.';
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(cleaned)) return { error };
  const pct = Number(cleaned);
  return pct >= 1 && pct <= 100 ? { pct } : { error };
}

/**
 * 🚪 CLOSE PART? Size before and after, what it is estimated to realise and to cost, then
 * ✅ Confirm / ✖ Cancel. NO LIQUIDATION DISTANCE: on Perpl a partial close releases margin in
 * proportion, so the liquidation price does not move. Auto top-up is left as it is, and it says so.
 */
export function partialCloseConfirmScreen(input: {
  readonly position: EmergencyPosition;
  /** As the person chose it: 25, 50, 75, or what they typed. */
  readonly pct: number;
  readonly closeLNS: bigint;
  readonly remainLNS: bigint;
  readonly estimate: { readonly realisedCNS: bigint | undefined; readonly feeCNS: bigint | undefined } | undefined;
  readonly autoOn: boolean;
}): Screen {
  const p = input.position;
  const realised = input.estimate?.realisedCNS;
  const fee = input.estimate?.feeCNS;
  const lines = [
    `🚪 <b>Close ${input.pct}% of ${esc(p.symbol)} ${p.side}?</b>`,
    '',
    `Size: <b>${sizeOf(p.sizeLNS, p.lotDecimals)}</b> → <b>${sizeOf(input.remainLNS, p.lotDecimals)}</b> (closing ${sizeOf(input.closeLNS, p.lotDecimals)})`,
    realised === undefined
      ? "Estimated realised P&L: I can't price it right now."
      : `Estimated realised P&L: <b>${esc(signedPnl(realised))}</b>${realised < 0n ? ' (a loss)' : realised > 0n ? ' (a profit)' : ''}`,
    fee === undefined ? "Estimated fee: I can't price it right now." : `Estimated fee: ${feeText(fee)}`,
    'It fills at whatever price it gets, so the real figures will differ.',
  ];
  if (input.autoOn) lines.push('', '🤖 Auto top-up stays on for this position.');
  lines.push('', "I'll read the new size from your positions afterwards, not from the exchange's receipt.");
  return {
    html: lines.join('\n'),
    buttons: [[{ text: '✅ Confirm', route: { to: 'close-part-go', marketId: p.marketId }, fresh: true }, { text: '✖ Cancel', route: { to: 'close-pos', marketId: p.marketId } }]],
  };
}

/** A typed percentage that cannot be a partial close of this position, said with what would work. */
export function closePercentRefusal(position: EmergencyPosition, pct: number, why: 'too-small' | 'whole' | 'bad-percent'): string {
  if (why === 'too-small') return `${pct}% of ${sizeOf(position.sizeLNS, position.lotDecimals)} ${esc(position.symbol)} is less than the smallest size this market trades, so I can't send it. Send a larger percentage, or 100 to close it all.`;
  return 'Send a percentage of the position to close, from 1 to 100, like 40.';
}

/**
 * What became of a partial close, READ FROM THE POSITION: the actual new size, and the realised
 * P&L from the exchange's own fill when it reported one. Never "reduced" for a position that is
 * the same size.
 */
export function partialCloseResultScreen(report: PartialReport, marketId: number): Screen {
  const view: Button = { text: '📊 View position', route: { to: 'position', marketId } };
  const again: Button = { text: '🚪 Close position', route: { to: 'close-pos', marketId } };
  const head = '🚪 <b>CLOSE POSITION</b>';
  if (report.kind === 'already-running') {
    return { html: `${head}\n\nA close is already running on your account. Nothing new was sent; check your positions in a moment.`, buttons: [[POSITIONS, MENU]] };
  }
  if (report.kind === 'nothing-sent') {
    const text: Record<typeof report.why, string> = {
      'already-flat': 'That position is no longer open, so nothing was sent.',
      'cannot-see': "I can't see your positions right now, so I didn't close anything. Check it on Perpl, or try again in a moment.",
      'no-session': "Your trading account isn't connected right now, so I couldn't close anything. Close it on Perpl.",
      changed: 'The position has changed size since I showed you those figures, so nothing was sent. Open it again for today\u2019s figures.',
      'too-small': 'That comes to less than the smallest size this market trades, so nothing was sent.',
    };
    return { html: `${head}\n\n${text[report.why]}`, buttons: report.why === 'changed' || report.why === 'too-small' ? [[again], [POSITIONS, MENU]] : [[POSITIONS, MENU]] };
  }
  const p = report.position;
  const name = `${esc(p.symbol)} ${p.side}`;
  const r = report.result;
  const lines: string[] = [];
  const buttons: Button[][] = [];
  switch (r.kind) {
    case 'reduced':
      lines.push(`✅ <b>${name} REDUCED</b>`, '', `Size: <b>${sizeOf(r.beforeLNS, p.lotDecimals)}</b> → <b>${sizeOf(r.afterLNS, p.lotDecimals)}</b> (${sizeOf(r.closedLNS, p.lotDecimals)} closed)`);
      if (!r.asAsked) lines.push(`That is not the ${sizeOf(report.requestedLNS, p.lotDecimals)} I sent: the position shows ${sizeOf(r.closedLNS, p.lotDecimals)} closed.`);
      lines.push(
        report.realisedCNS === undefined
          ? "The exchange hasn't reported the fill to me, so I can't state the realised P&L. It is in the position's history on Perpl."
          : `Realised P&L: <b>${esc(signedPnl(report.realisedCNS))}</b> before fees${report.feeCNS === undefined ? '' : ` · fee ${feeText(report.feeCNS)}`}`,
      );
      buttons.push([view]);
      break;
    case 'unchanged':
      lines.push(`⚠️ <b>${name} IS THE SAME SIZE</b>`, '', `Nothing was closed: ${esc(r.why)}.`, `It is still <b>${sizeOf(r.beforeLNS, p.lotDecimals)}</b>. Tap below to try again, or close it on Perpl.`);
      buttons.push([again]);
      break;
    case 'gone':
      lines.push(`⚠️ <b>${name} IS NO LONGER OPEN</b>`, '', `I sent a partial close of ${sizeOf(report.requestedLNS, p.lotDecimals)}, and the whole position has left your positions. Check its history on Perpl for what closed it.`);
      break;
    case 'not-seen':
      lines.push(`❔ <b>${name}: I CAN'T TELL YET</b>`, '', `${esc(r.why)}. Do not send it again until you have looked.`);
      break;
  }
  if (report.replayed) lines.push('', 'This is the result of a request that already ran. Nothing new was sent.');
  buttons.push([POSITIONS, MENU]);
  return { html: lines.join('\n'), buttons };
}

export function closePositionExpiredScreen(marketId: number): Screen {
  return {
    html: '🚪 <b>CLOSE POSITION</b>\n\nThat was more than two minutes ago and the price has moved, so nothing was sent. Here it is again.',
    buttons: [[{ text: '🚪 Close position', route: { to: 'close-pos', marketId } }], [{ text: '← Back', route: { to: 'position', marketId } }]],
  };
}

/**
 * What became of it, READ FROM THE POSITION LIST. "Closed" only when the list no longer has it;
 * a partial close says what remains, with a retry that is a NEW request after a new confirmation.
 */
export function closePositionResultScreen(report: EmergencyReport, marketId: number): Screen {
  const again: Button = { text: '🚪 Close what\u2019s left', route: { to: 'close-pos-all', marketId } };
  if (report.kind === 'already-running') {
    return { html: '🚪 <b>CLOSE POSITION</b>\n\nA close is already running on your account. Nothing new was sent; check your positions in a moment.', buttons: [[POSITIONS, MENU]] };
  }
  if (report.kind === 'nothing-sent') {
    const text: Record<typeof report.why, string> = {
      'already-flat': 'That position is no longer open, so nothing was sent.',
      'cannot-see': "I can't see your positions right now, so I didn't close anything. Check it on Perpl, or try again in a moment.",
      'no-session': "Your trading account isn't connected right now, so I couldn't close anything. Close it on Perpl.",
    };
    return { html: `🚪 <b>CLOSE POSITION</b>\n\n${text[report.why]}`, buttons: [[POSITIONS, MENU]] };
  }
  const r = report.results[0];
  const lines: string[] = [];
  const buttons: Button[][] = [];
  if (r === undefined) {
    lines.push('🚪 <b>CLOSE POSITION</b>', '', 'That position is no longer open, so nothing was sent.');
  } else {
    const p = r.position;
    const name = `${esc(p.symbol)} ${p.side}`;
    switch (r.kind) {
      case 'closed':
        lines.push(`✅ <b>${name} CLOSED</b>`, '', `${sizeOf(p.sizeLNS, p.lotDecimals)} closed${r.exitPrice === undefined ? '' : ` at ${r.exitPrice.toLocaleString('en-US')}`}. It's gone from your positions.`);
        break;
      case 'partial':
        lines.push(`⚠️ <b>${name} PARTLY CLOSED</b>`, '', `<b>${sizeOf(r.remainingLNS, p.lotDecimals)} of ${sizeOf(p.sizeLNS, p.lotDecimals)} is still open</b>: ${esc(r.why)}.`, 'Tap below to close what\u2019s left, or close it on Perpl.');
        buttons.push([again]);
        break;
      case 'still-open':
        lines.push(`⚠️ <b>${name} IS STILL OPEN</b>`, '', `${esc(r.why)}.`, 'Tap below to try again, or close it on Perpl.');
        buttons.push([again]);
        break;
      case 'not-seen':
        lines.push(`❔ <b>${name}: I CAN'T TELL YET</b>`, '', esc(r.why));
        break;
    }
  }
  if (report.automationOff === true) lines.push('', '🤖 Auto top-up is off for this position.');
  if (report.replayed) lines.push('', 'This is the result of a request that already ran. Nothing new was sent.');
  buttons.push([POSITIONS, MENU]);
  return { html: lines.join('\n'), buttons };
}
