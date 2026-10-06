/**
 * Events in words, for Telegram. Pure.
 *
 * Plain voice, like every other screen: money first and in bold, whole AUSD,
 * what someone LOST or HELD floored, no "safe", no promises. Every message
 * says which block the index had reached and how far behind the chain that
 * was: every event here comes from the index, and a figure from it must never
 * pass for a live one.
 *
 * LINKS ONLY, NEVER AN ACTION. An event alert can be read by anyone the feed
 * reaches, so its only buttons are URLs: the trader's page on the site and
 * the transaction on Monadscan (viem's explorer for Monad mainnet). A URL
 * button opens a page and calls nothing back; the bot's gate still refuses
 * any callback from a chat that is not linked.
 */
import type { FillAction } from '@perpguard/shared';
import { esc } from '../alerts/plain.ts';
import type { EventFreshness, LargeTradeEvent, LiquidationEvent, PerpEvent, PositionChangeEvent } from './types.ts';

export const EXPLORER_TX_URL = 'https://monadscan.com/tx/';

export interface RenderedEvent {
  readonly html: string;
  readonly links: ReadonlyArray<{ readonly text: string; readonly url: string }>;
}

export interface RenderContext {
  /** The public site, for the trader link. Undefined: no link. */
  readonly webUrl: string | undefined;
  /** How often the watch loop re-reads a watched account, for the "seen every" line. */
  readonly watchEveryMs: number;
}

const grouped = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
/** Whole AUSD, bold. `floor` for what is held or lost, `round` for a size. */
const ausd = (value: number, mode: 'floor' | 'round'): string => {
  const whole = mode === 'floor' ? Math.trunc(value) : Math.round(value);
  if (mode === 'floor' && whole === 0 && value !== 0) return `<b>under 1 AUSD</b>`;
  return `<b>${grouped(whole)} AUSD</b>`;
};
const price = (p: number | undefined): string | undefined =>
  p === undefined ? undefined : p.toLocaleString('en-US', { maximumFractionDigits: p >= 1_000 ? 1 : p >= 1 ? 4 : 6 });
const size = (lots: number, symbol: string): string => `${lots.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${esc(symbol)}`;
const symbolOf = (market: { readonly symbol: string | undefined; readonly indexerName: string }): string => market.symbol ?? market.indexerName;

/** "As of block 111,124,139, 140 blocks behind the chain." */
function freshnessText(f: EventFreshness): string {
  const block = f.indexerBlock === undefined ? 'From the mainnet index' : `As of block ${grouped(f.indexerBlock)}`;
  const behind = f.blocksBehind === undefined ? '' : `, ${grouped(f.blocksBehind)} block${f.blocksBehind === 1 ? '' : 's'} behind the chain`;
  return `${block}${behind}.`;
}

export function freshnessLine(f: EventFreshness): string {
  return `<i>${freshnessText(f)}</i>`;
}

const ACTION_WORDS: Readonly<Record<FillAction, string>> = { open: 'Opened', add: 'Added to', reduce: 'Reduced', close: 'Closed', flip: 'Flipped to' };

function traderLink(accountId: number, ctx: RenderContext): RenderedEvent['links'] {
  return ctx.webUrl === undefined ? [] : [{ text: '👤 View trader', url: `${ctx.webUrl.replace(/\/$/, '')}/traders/${accountId}` }];
}

export function renderLiquidation(event: LiquidationEvent, why: 'watching' | 'feed', ctx: RenderContext): RenderedEvent {
  const l = event.liquidation;
  const symbol = symbolOf(l.market);
  const what = `${esc(symbol)} ${l.side}`;
  const pnl = l.realizedPnlAusd + l.fundingAusd;
  const lines = [
    why === 'watching' ? `💥 <b>#${l.accountId} was liquidated</b> · ${what}` : `💥 <b>LIQUIDATION</b> · ${ausd(l.notionalAusd, 'round')} ${what}`,
    why === 'watching' ? `Size ${ausd(l.notionalAusd, 'round')} (${size(l.sizeLots, symbol)})${l.isFull ? '' : ', part of the position'}` : `Account <b>#${l.accountId}</b> · ${size(l.sizeLots, symbol)}${l.isFull ? '' : ', part of the position'}`,
  ];
  const at = price(l.execPrice ?? l.markPrice);
  const entry = price(l.entryPrice);
  if (at !== undefined) lines.push(`Closed at ${at}${entry === undefined ? '' : `, entered at ${entry}`}`);
  lines.push(pnl < 0 ? `Realised loss ${ausd(-pnl, 'floor')} (profit and loss plus funding; fees not included)` : `Realised result ${ausd(pnl, 'floor')} in profit, after funding`);
  lines.push('', freshnessLine(event.freshness));
  return { html: lines.join('\n'), links: [...traderLink(l.accountId, ctx), { text: '🔎 Monadscan', url: `${EXPLORER_TX_URL}${l.txHash}` }] };
}

export function renderLargeTrade(event: LargeTradeEvent, ctx: RenderContext): RenderedEvent {
  const o = event.order;
  const symbol = symbolOf(o.market);
  const d = event.direction;
  const lines = [
    `🐋 <b>LARGE TRADE</b> · ${ausd(o.notionalAusd, 'round')} ${esc(symbol)}`,
    `Account <b>#${o.accountId}</b> · ${d === undefined ? 'direction not known' : `${ACTION_WORDS[d.action]} ${d.action === 'flip' ? d.side : `a ${d.side}`}`}`,
    `${size(o.sizeLots, symbol)}${o.averagePrice === undefined ? '' : ` at ${price(o.averagePrice)} average`} · ${o.fills} fill${o.fills === 1 ? '' : 's'}`,
  ];
  if (d === undefined) lines.push('<i>The index does not record which way a taker traded, and the transaction did not settle it: unreadable, or more than one answer in it.</i>');
  lines.push('', freshnessLine(event.freshness));
  return { html: lines.join('\n'), links: [...traderLink(o.accountId, ctx), { text: '🔎 Monadscan', url: `${EXPLORER_TX_URL}${o.txHash}` }] };
}

const CHANGE: Readonly<Record<PositionChangeEvent['kind'], { readonly icon: string; readonly verb: string }>> = {
  'position-opened': { icon: '🆕', verb: 'opened' },
  'position-increased': { icon: '➕', verb: 'added to' },
  'position-reduced': { icon: '➖', verb: 'reduced' },
  'position-closed': { icon: '🏁', verb: 'closed' },
};

export function renderPositionChange(event: PositionChangeEvent, ctx: RenderContext): RenderedEvent {
  const symbol = symbolOf(event.market);
  const c = CHANGE[event.kind];
  const lines = [`${c.icon} <b>#${event.accountId} ${c.verb} ${esc(symbol)} ${event.side}</b>`];
  if (event.kind === 'position-opened') lines.push(`Size ${size(event.sizeAfter, symbol)}`);
  else if (event.kind === 'position-closed') lines.push(`It was ${size(event.sizeBefore, symbol)}`);
  else lines.push(`${size(event.sizeBefore, symbol)} → ${size(event.sizeAfter, symbol)}`);
  if (event.kind !== 'position-closed') {
    const parts = [
      price(event.entryPrice) === undefined ? undefined : `entry ${price(event.entryPrice)}`,
      event.marginAusd === undefined ? undefined : `margin ${ausd(event.marginAusd, 'floor')}`,
      event.leverage === undefined || !Number.isFinite(event.leverage) ? undefined : `${event.leverage.toLocaleString('en-US', { maximumFractionDigits: 1 })}x`,
    ].filter((p): p is string => p !== undefined);
    if (parts.length > 0) lines.push(parts.join(' · ').replace(/^./, (ch) => ch.toUpperCase()));
  }
  // Both delays, said: the index trails the chain, and we read it every N seconds.
  lines.push('', `<i>${freshnessText(event.freshness)} Checked every ${Math.round(ctx.watchEveryMs / 1000)} seconds on top of that.</i>`);
  return { html: lines.join('\n'), links: traderLink(event.accountId, ctx) };
}

export function renderEvent(event: PerpEvent, why: 'watching' | 'feed', ctx: RenderContext): RenderedEvent {
  switch (event.kind) {
    case 'liquidation':
      return renderLiquidation(event, why, ctx);
    case 'large-trade':
      return renderLargeTrade(event, ctx);
    default:
      return renderPositionChange(event, ctx);
  }
}
