/**
 * 🔁 What copying says, in the plain voice: money first, a loss rounded away
 * from zero, never "failed" for something that may have landed. Every message
 * ends with what PerpGuard copies (opens and closes, not every adjustment) and
 * carries a one-tap Stop copying.
 */
import { esc, signedPnl } from '../../alerts/plain.ts';
import { COPY_RULE_TEXT } from './control.ts';
import type { CopyNotice } from './engine.ts';

export interface RenderedCopy {
  readonly html: string;
  /** The buttons by meaning; the caller encodes them. */
  readonly buttons: readonly ('stop' | 'status' | 'positions' | 'resume')[];
}

const size = (units: bigint | undefined, decimals: number): string => {
  if (units === undefined) return '?';
  const p = 10n ** BigInt(decimals);
  const frac = (units % p).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? (units / p).toString() : `${units / p}.${frac}`;
};
const ausdCeil = (cns: bigint, d: number): string => {
  const cent = d >= 2 ? 10n ** BigInt(d - 2) : 1n;
  const c = cns % cent === 0n ? cns / cent : cns / cent + 1n;
  return `${(c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(c % 100n).toString().padStart(2, '0')} AUSD`;
};

/** A result in words: a loss rounded away from zero; under one AUSD said as such, never "+under 1". */
function resultWords(cns: bigint, d: number): string {
  const unit = 10n ** BigInt(d);
  if (cns === 0n) return 'flat';
  if ((cns < 0n ? -cns : cns) < unit) return cns < 0n ? 'a loss of under 1 AUSD' : 'a gain of under 1 AUSD';
  return signedPnl(cns, d);
}

export function renderCopy(n: CopyNotice, input: { readonly collateralDecimals: number; readonly sizeDecimalsOf: (marketId: number | undefined) => number }): RenderedCopy {
  const d = input.collateralDecimals;
  const leader = `#${n.rule.leaderAccountId}`;
  const foot = `<i>${COPY_RULE_TEXT}</i>`;
  switch (n.kind) {
    case 'copied': {
      const l = n.leg;
      return {
        html: [
          `🔁 <b>COPIED</b> · ${esc(l.symbol)} ${l.side} · as ${leader} opened theirs`,
          '',
          `Opened <b>${size(l.sizeLNS, input.sizeDecimalsOf(l.actingMarketId))} ${esc(l.symbol)}</b> ${l.side} at ${(l.leverageHundredths ?? 0) / 100}x, margin <b>${ausdCeil(n.marginCNS, d)}</b>.`,
          ...(n.partial ? ['⚠️ It filled only in part: that is the size shown.'] : []),
          ...(n.leverageCapped ? ["Their leverage is above this network's maximum, so the copy uses the maximum: the same size with more margin."] : []),
          'Checked against your position list, not the receipt.',
          '',
          foot,
        ].join('\n'),
        buttons: ['positions', 'stop'],
      };
    }
    case 'skipped':
      return { html: [`⏭ <b>NOT COPIED</b> · ${esc(n.leg.symbol)} ${n.leg.side} · ${leader} opened it`, '', esc(n.leg.reason ?? 'Skipped.'), '', foot].join('\n'), buttons: ['status', 'stop'] };
    case 'not-opened':
      return {
        html: [
          `⚠️ <b>NOT OPENED</b> · ${esc(n.leg.symbol)} ${n.leg.side}`,
          '',
          `I sent the copy of ${leader}'s ${esc(n.leg.symbol)} open once. No position appeared on your list and the exchange reported the order did not fill. Nothing was opened, and it will not be sent again.`,
          '',
          foot,
        ].join('\n'),
        buttons: ['status', 'stop'],
      };
    case 'unknown':
      return {
        html: [
          `⏸ <b>COPYING PAUSED</b> · ${esc(n.leg.symbol)} ${n.leg.side}`,
          '',
          n.what === 'open'
            ? `I sent the copy of ${leader}'s ${esc(n.leg.symbol)} open once, and cannot tell yet whether it opened: nothing on your position list, and no refusal from the exchange. It may still land. Copying is paused until you look: check My Positions, then Resume, and I will settle it against your list.`
            : `I sent the close of your ${esc(n.leg.symbol)} copy once, and cannot tell whether it closed. Copying is paused until you look: check My Positions, then Resume.`,
          '',
          'Nothing will be sent again for it.',
        ].join('\n'),
        buttons: ['positions', 'resume', 'stop'],
      };
    case 'closed':
      return {
        html: [
          `🔁 <b>CLOSED</b> · ${esc(n.leg.symbol)} ${n.leg.side} · as ${leader} closed theirs`,
          '',
          n.resultCNS === undefined ? 'Your copy is closed.' : `Your copy is closed, at about <b>${esc(resultWords(n.resultCNS, d))}</b> (unrealised at the mark just before the close, before fees).`,
          'Checked against your position list.',
          '',
          foot,
        ].join('\n'),
        buttons: ['status', 'stop'],
      };
    case 'close-not-landed':
      return {
        html: [`⚠️ <b>STILL OPEN</b> · ${esc(n.leg.symbol)} ${n.leg.side}`, '', `${leader} closed theirs. I sent the close of your copy once and it did not land: <b>your ${esc(n.leg.symbol)} copy is still open</b>. It will not be sent again; close it from My Positions.`].join('\n'),
        buttons: ['positions', 'stop'],
      };
    case 'closed-by-you':
      return { html: [`🔁 ${leader} closed ${esc(n.leg.symbol)}. Your copy was already gone (closed by you, or by the exchange), so nothing was sent.`, '', foot].join('\n'), buttons: ['status'] };
    case 'held':
      return { html: [`⏸ <b>COPYING WAITING</b> · ${leader}`, '', `Nothing is being copied right now: ${esc(n.why)}. It carries on by itself when that clears; anything they open meanwhile is copied then, if still open.`].join('\n'), buttons: ['status', 'stop'] };
    case 'ignored':
      return { html: [`⛔ <b>COPYING SWITCHED OFF</b> · ${leader}`, '', `This copy was ${esc(n.why)}, so it was never acted on and is now off. Start it again from the trader's card if you want it.`].join('\n'), buttons: ['status'] };
  }
}
