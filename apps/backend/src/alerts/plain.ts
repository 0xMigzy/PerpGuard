/**
 * Plain words for people who are not traders, in Telegram HTML.
 *
 * The bot's screens and its watch alerts speak the way `docs/bot-screens.html`
 * lays out, and every rule from that page lives here once:
 *
 *   - AUSD AMOUNTS IN BOLD. The money is what a beginner looks for first.
 *   - MONEY BEFORE PERCENTAGES. What they would lose comes before how far away.
 *   - EACH TERM EXPLAINED ONCE where it appears ({@link DISTANCE_EXPLAINED}).
 *   - NEVER THE WORD "SAFE". Say what the closing price becomes instead.
 *   - A NEGATIVE BUFFER IS "past the closing price", never a negative number.
 *
 * Money is integer micros all the way to the string. A figure shown as what
 * someone HAS is floored, so it never overstates; a figure shown as what
 * something NEEDS is ceiled, so it never understates. P&L ROUNDS AGAINST THE
 * READER (owner, 7 Oct 2026): a LOSS rounds AWAY from zero, a GAIN toward it,
 * so nobody deciding whether to exit is ever shown a smaller loss (or a bigger
 * gain) than the real one: −64.8 reads −65, +31.7 reads +31 (`signedPnl`).
 *
 * Every string that did not come from this file is escaped. A market symbol or
 * a label is data, and HTML parse mode would otherwise read a `<` in one as
 * markup and reject the whole message.
 */
import type { MarketRiskConfig } from '@perpguard/shared';
import { isBlind, type RiskAssessment, type WatchedScope } from '../risk/types.ts';
import { formatPricePNS } from './render.ts';
import type { AlertKind } from './types.ts';

/** Escape for Telegram's HTML parse mode, which knows only these three. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Signed P&L as text, "−65 AUSD" / "+31 AUSD". A LOSS ROUNDS AWAY FROM ZERO, a
 * gain toward it: never a smaller loss or a bigger gain than the real one.
 * Under one AUSD either way is "under 1 AUSD", which is true and overstates
 * nothing.
 */
export function signedPnl(cns: bigint, collateralDecimals = 6): string {
  const unit = 10n ** BigInt(collateralDecimals);
  const abs = cns < 0n ? -cns : cns;
  const sign = cns < 0n ? '−' : '+';
  if (abs > 0n && abs < unit) return `${sign}under 1 AUSD`;
  return `${sign}${wholeAusd(abs, cns < 0n ? 'ceil' : 'floor', collateralDecimals)} AUSD`;
}

/** Whole AUSD, grouped. `floor` for what someone has, `ceil` for what is needed (and for a loss: see `signedPnl`). */
export function wholeAusd(amountCNS: bigint, mode: 'floor' | 'ceil', collateralDecimals = 6): string {
  const unit = 10n ** BigInt(collateralDecimals);
  const negative = amountCNS < 0n;
  const abs = negative ? -amountCNS : amountCNS;
  let whole = abs / unit;
  const rest = abs % unit;
  // Ceil away from zero for a need, floor toward zero for a holding.
  if (mode === 'ceil' && rest !== 0n) whole += 1n;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** `<b>1,940 AUSD</b>` — every amount of money on a screen reads like this. */
export function money(amountCNS: bigint, mode: 'floor' | 'ceil', collateralDecimals = 6): string {
  return `<b>${wholeAusd(amountCNS, mode, collateralDecimals)} AUSD</b>`;
}

/**
 * Money someone HOLDS. A balance under one AUSD is "under 1 AUSD", never the
 * "0 AUSD" flooring would print: that reads as empty when it is not.
 */
export function held(amountCNS: bigint, collateralDecimals = 6): string {
  const unit = 10n ** BigInt(collateralDecimals);
  if (amountCNS > 0n && amountCNS < unit) return '<b>under 1 AUSD</b>';
  return money(amountCNS, 'floor', collateralDecimals);
}

/** The buffer as a percentage, one decimal. Callers never pass a negative one here. */
export function pct(buffer: number): string {
  return `${(buffer * 100).toFixed(1)}%`;
}

/**
 * How far from being closed, in words. SIGNED buffer in, never a negative
 * percentage out.
 */
export function distance(buffer: number | undefined): string {
  if (buffer === undefined) return 'no closing price (no size)';
  if (buffer < 0) return 'past its closing price';
  return `${pct(buffer)} from being closed`;
}

/** `2.7% from liquidation`, or `past liquidation`. Signed buffer in, never a negative percentage out. */
export function fromLiquidation(buffer: number | undefined): string {
  if (buffer === undefined) return 'no liquidation price';
  if (buffer < 0) return 'past liquidation';
  return `${pct(buffer)} from liquidation`;
}

/** The short form used in lists: `5.1%`, or `past closing price`. */
export function shortDistance(buffer: number | undefined): string {
  if (buffer === undefined) return '—';
  if (buffer < 0) return 'past closing price';
  return pct(buffer);
}

/** The one-sentence explanation of that percentage, said once per screen. */
export const DISTANCE_EXPLAINED = 'The percentage is how far the price can move against them before the exchange closes it.';

/** 🔴 for danger and past it, 🟠 for watch, 🟢 for clear, ⚪ when we cannot see. */
export function dot(state: RiskAssessment['state']): string {
  switch (state) {
    case 'PAST_LIQUIDATION':
    case 'DANGER':
      return '🔴';
    case 'WATCH':
      return '🟠';
    case 'SAFE':
      return '🟢';
    case 'FEED_DOWN':
    case 'POSITIONS_UNTRUSTED':
      return '⚪';
  }
}

/** `MON long`. The side is never guessed; an unknown one is left out. */
export function positionName(assessment: Pick<RiskAssessment, 'symbol' | 'side'>): string {
  return esc(assessment.side === undefined ? assessment.symbol : `${assessment.symbol} ${assessment.side}`);
}

/** `18,400 MON`. Size as indexed, in base units. */
export function sizePhrase(units: number | undefined, symbol: string): string | undefined {
  if (units === undefined || !Number.isFinite(units)) return undefined;
  return `${units.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${esc(symbol)}`;
}

/**
 * How current a watched account's numbers are, in one line. Kept on every
 * watched message: the index is some blocks behind the chain, and a number
 * from it must never pass for a live one.
 */
export function freshness(scope: WatchedScope, assessment: Pick<RiskAssessment, 'priceIsOld' | 'priceAgeMs'>): string {
  const block = scope.indexerBlock === undefined ? 'the mainnet index' : `block ${scope.indexerBlock.toLocaleString('en-US')}`;
  const behind =
    scope.blocksBehind === undefined ? '' : `, ${scope.blocksBehind.toLocaleString('en-US')} block${scope.blocksBehind === 1 ? '' : 's'} behind the chain`;
  const state = scope.indexerState === 'synced' ? '' : ` (indexer ${esc(scope.indexerState)})`;
  const price = assessment.priceIsOld && assessment.priceAgeMs !== undefined ? `; the price is ${Math.floor(assessment.priceAgeMs / 1000)}s old` : '';
  return `<i>Positions as of ${block}${behind}${state}${price}.</i>`;
}

/** The rule underneath the watch tier, said where a watcher reads it. */
/**
 * Said on every watched screen and watch alert (owner, 7 Oct 2026): what the
 * missing buttons mean, and why: watching is mainnet and read-only, and
 * PerpGuard's actions run on testnet only.
 */
export const NO_BUTTONS = 'Watching only — nothing here to press.';

/**
 * THE NETWORK, SAID ONCE (owner, 8 Oct 2026; was a 🧪 TESTNET banner): every
 * action screen and message names the acting network, and a screen that
 * already names it is left alone. Undefined network: no badge.
 */
export function actingBadge(network: string | undefined): string | undefined {
  if (network === 'testnet') return 'testnet';
  if (network === 'mainnet') return '⚠️ <b>MAINNET</b> · real funds';
  return undefined;
}

/** A screen's HTML with the network on its first line, unless the screen already names it. Idempotent. */
export function withBadge(html: string, network: string | undefined): string {
  const badge = actingBadge(network);
  if (badge === undefined || network === undefined || html.includes(network)) return html;
  return `${badge}\n${html}`;
}

/**
 * Their free balance against what this position would need, in one sentence.
 *
 * "Enough" means enough to lift it back out of DANGER (`toClearDangerCNS`),
 * a figure computed the same way as an owner's top-up. Nothing is claimed
 * when the free balance is unknown, and nothing about "enough" when the
 * position does not need anything.
 */
export function freeVerdict(scope: WatchedScope | undefined, assessments: readonly RiskAssessment[]): string {
  const free = scope?.freeBalanceCNS;
  if (free === undefined) return 'I cannot see their free balance in the index right now.';
  const needing = assessments.filter((a) => (a.watch?.toClearDangerCNS ?? 0n) > 0n);
  const need = needing.reduce((sum, a) => sum + (a.watch?.toClearDangerCNS ?? 0n), 0n);
  const isolation = "Perpl keeps each position's money separate, so none of it moves on its own.";
  if (need === 0n) return isolation;
  const what = needing.length === 1 ? (assessments.length === 1 ? 'it' : positionName(needing[0]!)) : `those ${needing.length}`;
  if (free >= need) {
    return `They are holding more than enough to survive this: pulling ${what} out of danger takes ${money(need, 'ceil')}. ${isolation}`;
  }
  return `That is not enough to pull ${what} out of danger, which takes ${money(need, 'ceil')}. ${isolation}`;
}

/**
 * One watched position, as the wallet screen lays it out: name and size, then
 * the price now, the price that closes it, and what closing it costs them.
 */
export function watchedPositionLines(assessment: RiskAssessment, market: MarketRiskConfig | undefined): string[] {
  const name = positionName(assessment);
  const size = sizePhrase(assessment.watch?.sizeUnits, assessment.symbol);
  const lines = [`${dot(assessment.state)} <b>${name}</b>${size === undefined ? '' : ` · ${size}`}`];
  if (isBlind(assessment.state)) {
    lines.push(assessment.state === 'FEED_DOWN' ? 'I cannot price it right now: the venue sent no price.' : 'I cannot see it right now: the index is not serving current positions.');
    return lines;
  }
  if (market === undefined) {
    lines.push('I have no market details for it, so I cannot quote its prices.');
    return lines;
  }
  lines.push(`Price now ${formatPricePNS(assessment.markPricePNS, market)}`);
  if (assessment.liquidationPricePNS !== undefined && assessment.liquidationPricePNS > 0n) {
    lines.push(`Closed out at ${formatPricePNS(assessment.liquidationPricePNS, market)} · ${distance(assessment.liqBufferPct)}`);
  } else {
    lines.push('No closing price: there is more behind it than it could lose.');
  }
  if (assessment.marginCNS !== undefined) lines.push(`They would lose ${held(assessment.marginCNS, market.collateralDecimals)}`);
  return lines;
}

/**
 * A watch alert, in the screen's voice.
 *
 *   🔴 #3388 · MON long is 1.8% from being closed
 *   MON is 2.3980. At 2.3510 the exchange closes this position
 *   and they lose the 1,940 AUSD behind it.
 *   They hold 2,910 AUSD free — enough to survive, if they move it.
 *   Watching only — nothing here to press.
 */
export function renderWatchAlertHtml(assessment: RiskAssessment, kind: AlertKind, market: MarketRiskConfig): string {
  const scope = assessment.watch;
  if (scope === undefined) throw new RangeError('renderWatchAlertHtml is for watched assessments only');
  const who = `#${scope.accountId}`;
  const name = positionName(assessment);
  const lines: string[] = [];

  if (kind === 'feed-down' || kind === 'positions-untrusted') {
    lines.push(`${dot(assessment.state)} <b>${who} · ${name}: I cannot see it right now</b>`);
    lines.push(
      kind === 'feed-down'
        ? 'The venue stopped sending a price for this market, so I cannot tell how close it is to being closed.'
        : 'The index is not serving current positions, so this one may have moved or closed without my knowing.',
    );
    lines.push('I will say so the moment I can see it again.');
  } else {
    const head =
      kind === 'recovered'
        ? `${dot(assessment.state)} <b>${who} · ${name} is ${distance(assessment.liqBufferPct)} again</b>`
        : `${dot(assessment.state)} <b>${who} · ${name} is ${distance(assessment.liqBufferPct)}</b>`;
    lines.push(head);
    const symbol = esc(assessment.symbol);
    const now = formatPricePNS(assessment.markPricePNS, market);
    const liq = assessment.liquidationPricePNS;
    const lose = assessment.marginCNS === undefined ? 'the money behind it' : `the ${held(assessment.marginCNS, market.collateralDecimals)} behind it`;
    if (liq !== undefined && liq > 0n) {
      const closes = formatPricePNS(liq, market);
      lines.push(
        kind === 'past-liquidation'
          ? `${symbol} is ${now}, already past ${closes}, where the exchange closes this position. They can lose ${lose} at any moment.`
          : `${symbol} is ${now}. At ${closes} the exchange closes this position and they lose ${lose}.`,
      );
    } else {
      lines.push(`${symbol} is ${now}. There is more behind this position than it could lose, so it has no closing price.`);
    }
    if (kind !== 'recovered' && scope.freeBalanceCNS !== undefined) {
      const need = scope.toClearDangerCNS ?? 0n;
      const free = held(scope.freeBalanceCNS, market.collateralDecimals);
      if (scope.freeBalanceCNS === 0n) lines.push(need === 0n ? 'They hold no free AUSD.' : `They hold no free AUSD to move: pulling it out of danger takes ${money(need, 'ceil', market.collateralDecimals)}.`);
      else if (need === 0n) lines.push(`They hold ${free} free, and Perpl will not move it on its own.`);
      else if (scope.freeBalanceCNS >= need) lines.push(`They hold ${free} free — enough to survive, if they move it.`);
      else lines.push(`They hold ${free} free — not enough: pulling it out of danger takes ${money(need, 'ceil', market.collateralDecimals)}.`);
    }
  }
  lines.push(freshness(scope, assessment));
  lines.push(NO_BUTTONS);
  return lines.join('\n');
}
