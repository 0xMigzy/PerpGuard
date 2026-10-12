/**
 * `/equity <address or account id>`: one account's money now, broken down as
 * the trader page breaks it down: free balance + margin in use + unrealised
 * P&L = equity. Pure: the figures are the page's own (`accountSummary`, read by
 * the backend's `readAccountEquity`), so nothing is computed here, only worded.
 *
 * TO THE CENT, unlike the bot's whole-AUSD plain voice: the three parts are
 * each rounded to the cent first and equity is their sum, so the arithmetic
 * printed in the message adds up exactly, as it does on the page.
 *
 * PUBLIC, like /watch: it reads the mainnet index and the venue's marks and
 * touches no account. There is no "Watching only" line: nothing is being watched. Equity is WITHHELD while any open position has no mark:
 * a partial sum is not equity.
 */
import type { AccountSummary } from '@perpguard/shared';

/** What the backend answers: the page's summary, or that the index holds no such account. */
export type EquityReading =
  | { readonly kind: 'ok'; readonly accountId: number; readonly summary: AccountSummary; readonly marksAsOfMs: number | undefined }
  | { readonly kind: 'unknown-account'; readonly accountId: number };

export const EQUITY_USAGE = 'Send /equity followed by a 0x address or an account id, for example /equity 5213.';
export const EQUITY_UNAVAILABLE = 'Equity is not available right now: I could not read the mainnet index or the prices. Nothing was changed; try again in a minute.';

export const unknownAccountText = (accountId: number): string => `There is no Perpl account #${accountId} in the mainnet index.`;

const cents = (ausd: number): string => Math.abs(ausd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A signed amount with a true minus sign; zero carries none. */
const signed = (ausd: number): string => (ausd < 0 ? `−${cents(ausd)}` : ausd > 0 ? `+${cents(ausd)}` : cents(ausd));
const plain = (ausd: number): string => (ausd < 0 ? `−${cents(ausd)}` : cents(ausd));

function ageWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/**
 * The reply, as HTML. `nowMs` dates the marks, which is the reply's one freshness note.
 */
export function equityHtml(reading: Extract<EquityReading, { kind: 'ok' }>, o: { readonly nowMs: number }): string {
  const s = reading.summary;
  const positions = `${s.positions} open position${s.positions === 1 ? '' : 's'}`;
  const lines: string[] = [];
  if (s.equityAusd === undefined) {
    lines.push(`💰 <b>#${reading.accountId} · equity not totalled</b>`);
    lines.push(`${s.unpriced} of ${positions} ${s.unpriced === 1 ? 'has' : 'have'} no price right now, and a partial sum is not equity.`);
    lines.push('', `Free balance: <b>${plain(s.freeAusd)} AUSD</b>`, `Margin in use: <b>${plain(s.marginAusd)} AUSD</b>`);
    if (s.unpriced < s.positions) lines.push(`Unrealised P&amp;L, priced positions only: <b>${signed(s.unrealisedAusd)} AUSD</b>`);
  } else {
    lines.push(`💰 <b>#${reading.accountId} · equity ${plain(s.equityAusd)} AUSD</b>`);
    lines.push('', `Free balance: <b>${plain(s.freeAusd)} AUSD</b>`, `Margin in use: <b>${plain(s.marginAusd)} AUSD</b>`, `Unrealised P&amp;L: <b>${signed(s.unrealisedAusd)} AUSD</b>`);
    lines.push(`Free + margin + unrealised = <b>${plain(s.equityAusd)} AUSD</b>`);
  }
  const marks = s.positions === 0 ? 'No open positions.' : reading.marksAsOfMs === undefined ? `${positions}.` : `${positions}, priced with marks up to ${ageWords(o.nowMs - reading.marksAsOfMs)} old.`;
  // THE ONLY FRESHNESS NOTE (owner, 12 Oct 2026): how old the marks are. The sentence about the index and the venue is gone.
  lines.push('', marks);
  return lines.join('\n');
}
