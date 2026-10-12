/**
 * Events in words, for Telegram. Pure.
 *
 * Plain voice, like every other screen: money first and in bold, whole AUSD,
 * what someone LOST or HELD floored, no "safe", no promises.
 *
 * EVERY ALERT ENDS IN A TIME AND ITS LINKS (owner, 12 Oct 2026): the moment
 * it is a claim about ("Oct 12 · 04:36 UTC"), then "0xa217…6205 · tx ↗": the
 * wallet's page on this deployment's site and the transaction on the MAINNET
 * explorer (these accounts are mainnet on both bots). They replaced the block
 * footers and the two link buttons: one way to each place, one explorer.
 *
 * LINKS ONLY, NEVER AN ACTION. An event alert can be read by anyone the feed
 * reaches, so it carries no button at all now, only links in its text, which
 * open a page and call nothing back; the bot's gate still refuses any
 * callback from a chat that is not linked.
 */
import type { FillAction } from '@perpguard/shared';
import type { MarketRiskConfig } from '@perpguard/shared';
import { NO_BUTTONS, esc, freeVerdict, freshness, fromLiquidation, held, watchedPositionLines } from '../alerts/plain.ts';
import { alertTime, provenanceLine } from '../alerts/provenance.ts';
import type { RiskAssessment } from '../risk/types.ts';
import { levelsLabel, severityOf } from './warnings.ts';
import type { LargeTradeEvent, LiquidationEvent, PerpEvent, PositionChangeEvent } from './types.ts';

export interface RenderedEvent {
  readonly html: string;
  readonly links: ReadonlyArray<{ readonly text: string; readonly url: string }>;
}

export interface RenderContext {
  /** This deployment's own site, for the wallet link. Undefined: the wallet is named without a link. */
  readonly webUrl: string | undefined;
  /** The MAINNET explorer's transaction prefix: these alerts are about mainnet accounts on both bots. Undefined: no tx link. */
  readonly explorerTxUrl?: string | undefined;
  /** The owner address of the account this one alert is about, when it could be found. Set per alert by the sender. */
  readonly address?: string | undefined;
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

/** The last lines of an event alert: the time, "Watching only" where it applies, then the links. */
function footer(o: { readonly atMs: number; readonly accountId: number; readonly txHash: string | undefined; readonly watching: boolean }, ctx: RenderContext): string[] {
  const links = provenanceLine({ wallet: { accountId: o.accountId, address: ctx.address, siteUrl: ctx.webUrl }, explorerTxUrl: ctx.explorerTxUrl, txHash: o.txHash });
  return ['', `<i>${alertTime(o.atMs)}</i>`, ...(o.watching ? [NO_BUTTONS] : []), ...(links === undefined ? [] : [links])];
}

const ACTION_WORDS: Readonly<Record<FillAction, string>> = { open: 'Opened', add: 'Added to', reduce: 'Reduced', close: 'Closed', flip: 'Flipped to' };

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
  lines.push(...footer({ atMs: l.atMs, accountId: l.accountId, txHash: l.txHash, watching: why === 'watching' }, ctx));
  return { html: lines.join('\n'), links: [] };
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
  lines.push(...footer({ atMs: o.atMs, accountId: o.accountId, txHash: o.txHash, watching: false }, ctx));
  return { html: lines.join('\n'), links: [] };
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
  // A PLAIN TIME: when it opened or closed, by the index; for an add or a reduce, when it was seen.
  const atMs = event.kind === 'position-opened' ? event.openedAtMs : event.kind === 'position-closed' ? (event.closedAtMs ?? event.seenAtMs) : event.seenAtMs;
  lines.push(...footer({ atMs, accountId: event.accountId, txHash: event.txHash, watching: true }, ctx));
  return { html: lines.join('\n'), links: [] };
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

/**
 * A watched position reaching one of the chat's warning levels (spec 28):
 * the level it reached, the position in the screen's own lines, what they hold
 * free against it, and how fresh all of that is. Links only.
 */
export function renderWarning(assessment: RiskAssessment, level: number, levels: readonly number[], market: MarketRiskConfig | undefined, ctx: RenderContext): RenderedEvent {
  const scope = assessment.watch!;
  const distancePct = (assessment.liqBufferPct ?? 0) * 100;
  const s = severityOf(level, levels, distancePct);
  const lines = [
    // WHAT HAPPENED, NOT WHICH SETTING FIRED (owner, 8 Oct 2026): the position's own distance.
    `${s.dot} <b>#${scope.accountId} is ${fromLiquidation(assessment.liqBufferPct)}</b>`,
    '',
    ...watchedPositionLines(assessment, market),
    '',
  ];
  if (scope.freeBalanceCNS !== undefined) lines.push(`They hold free ${held(scope.freeBalanceCNS)}`);
  lines.push(freeVerdict(scope, [assessment]));
  lines.push(`<i>You warn at ${levelsLabel(levels)}. Each level warns once and waits for the position to recover before it can warn again.</i>`);
  // No transaction: a warning is about a distance, not an event. The time of the reading, and the wallet's page.
  const links = provenanceLine({ wallet: { accountId: scope.accountId, address: ctx.address, siteUrl: ctx.webUrl } });
  lines.push(freshness(scope, assessment), NO_BUTTONS, ...(links === undefined ? [] : [links]));
  return { html: lines.join('\n'), links: [] };
}
