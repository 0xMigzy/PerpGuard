/**
 * Turning an assessment into the words a trader reads. Pure: no I/O, no clock,
 * and nothing recomputed.
 *
 * EVERY NUMBER HERE ALREADY EXISTS ON THE ASSESSMENT. This module formats and
 * nothing else — it never adds margin to a position to find out where the
 * liquidation price would land, because then two code paths would be deriving
 * the figure a trader acts on and they would eventually disagree.
 *
 * Three rules run through all of it:
 *
 *   PRECISION COMES FROM THE MARKET. Prices render at the market's own
 *   `priceDecimals`, amounts at its `collateralDecimals`. Hard-coding either is
 *   the same class of bug as hard-coding a maintenance margin ratio: it would
 *   look right on BTC and be wrong everywhere else.
 *
 *   TOP-UPS CEIL, NEVER ROUND. See CLAUDE.md. A rounded-down figure prints an
 *   amount that does not reach the buffer it claims, and the user tops up short.
 *
 *   THE CHEAP OPTION IS NEVER CALLED SAFE. Each option line states what it buys
 *   and carries no adjective at all. "Clears the danger band" is a fact;
 *   "safe", "secure" and "fine" are claims the cheap option cannot support.
 */
import { scaledToNumber, type MarketRiskConfig } from '@perpguard/shared';
import type { RiskAssessment, TopUpOption } from '../risk/types.ts';
import type {
  AlertAction,
  AlertActionIntent,
  AlertConfig,
  AlertKind,
  AlertMessage,
} from './types.ts';
import { renderWatchAlertHtml } from './plain.ts';

/**
 * Grouped decimal formatting, pinned to en-US.
 *
 * The locale is explicit because the default follows the host: a German runner
 * would render 76.446,7 and a message is not the place to discover that.
 */
function group(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** A price in the market's own units -> the string a user sees. */
export function formatPricePNS(pricePNS: bigint, market: MarketRiskConfig): string {
  return group(scaledToNumber(pricePNS, market.priceDecimals), market.priceDecimals);
}

/**
 * A top-up amount, CEILED to the displayed precision.
 *
 * Returns the ceiled micros alongside the text so the action can send exactly
 * what was shown. The two must not be derived separately — that is the whole
 * point of returning them together.
 *
 * Ceiling in integers, never through a float: `561460000` micros at 0 displayed
 * decimals is 562, and `562000000` is what the button sends.
 */
export function ceilAusd(
  amountCNS: bigint,
  market: MarketRiskConfig,
  displayDecimals: number,
): { readonly amountCNS: bigint; readonly text: string } {
  if (amountCNS < 0n) {
    throw new RangeError(`a top-up amount cannot be negative, got ${amountCNS}`);
  }
  // Past the market's own precision there is nothing more to show, so the figure
  // is already exact and ceiling is a no-op.
  const decimals = Math.min(displayDecimals, market.collateralDecimals);
  const divisor = 10n ** BigInt(market.collateralDecimals - decimals);
  const units = (amountCNS + divisor - 1n) / divisor;
  const ceiled = units * divisor;
  return {
    amountCNS: ceiled,
    text: group(scaledToNumber(ceiled, market.collateralDecimals), decimals),
  };
}

/** A signed buffer fraction as a percentage. Sign preserved; callers gate on it. */
export function formatBufferPct(buffer: number, decimals: number): string {
  return `${(buffer * 100).toFixed(decimals)}%`;
}

/**
 * How the CURRENT buffer reads.
 *
 * A NEGATIVE BUFFER IS NEVER SHOWN AS A NEGATIVE PERCENTAGE. `liqBufferPct` is
 * signed, and negative means the position is already past its liquidation price;
 * "-1.4%" invites the reader to see a small number rather than a doomed position.
 * The words say what it is. (CLAUDE.md.)
 */
export function describeBuffer(buffer: number | undefined, decimals: number): string {
  if (buffer === undefined) return 'no buffer: the position has no size';
  if (buffer < 0) return 'past liquidation';
  return `buffer ${formatBufferPct(buffer, decimals)}`;
}

/**
 * How old a price is, in words.
 *
 * Used only when `priceIsOld` is set, so STALE NUMBERS ARE NEVER PRESENTED AS
 * CURRENT. Note what this is not: an old price on Perpl is a QUIET MARKET, which
 * is the venue's current truth and perfectly fine to act on. The sentence says
 * the age and passes no judgement on it.
 */
export function describeAge(ageMs: number | undefined): string {
  if (ageMs === undefined) return 'price age unknown';
  if (ageMs < 1_000) return `price is ${ageMs} ms old`;
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `price is ${seconds} second${seconds === 1 ? '' : 's'} old`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `price is ${minutes} minute${minutes === 1 ? '' : 's'} old`;
  const hours = Math.floor(minutes / 60);
  return `price is ${hours} hour${hours === 1 ? '' : 's'} old`;
}

/** Title-cased state, for a headline. */
function headline(state: RiskAssessment['state']): string {
  return state.replace(/_/g, ' ');
}

/**
 * The headline, which must NAME WHICH POSITION THIS IS.
 *
 * A trader holding both sides of BTC has two positions with the same symbol and
 * opposite exposure. "DANGER · BTC" cannot tell them apart, and the failure is
 * not merely confusing: it can send someone to add margin to the position that is
 * fine while the other one liquidates.
 *
 * The side is omitted only when we genuinely do not know it — a position we went
 * blind on before ever assessing. It is never guessed.
 */
function title(assessment: RiskAssessment): string {
  const state = headline(assessment.state);
  const own = assessment.side === undefined
    ? `${state} · ${assessment.symbol}`
    : `${state} · ${assessment.symbol} ${assessment.side}`;
  // A watcher may follow several accounts; the first word says which.
  return assessment.watch === undefined ? own : `Watching ${assessment.watch.label} · ${own}`;
}

/**
 * How current a WATCHED account's numbers are, said in the message.
 *
 * The positions come from the index, which can be behind the chain, and the
 * mark from the venue, which can be old on a quiet market. Both ages are
 * stated, and the line ends by saying what the reader cannot do, because the
 * absence of buttons must read as a rule rather than as a rendering slip.
 */
function watchLine(assessment: RiskAssessment): string {
  const w = assessment.watch;
  if (w === undefined) return '';
  const index =
    w.indexerBlock === undefined
      ? `index state ${w.indexerState}`
      : `positions as indexed at block ${w.indexerBlock.toLocaleString('en-US')}` +
        (w.blocksBehind === undefined ? '' : `, ${w.blocksBehind.toLocaleString('en-US')} block${w.blocksBehind === 1 ? '' : 's'} behind the chain`) +
        (w.indexerState === 'synced' ? '' : ` (indexer ${w.indexerState})`);
  return `Watching only: ${index}; ${describeAge(assessment.priceAgeMs)} from the venue. Not live, and nothing here can be acted on from this chat.`;
}

/**
 * Why this message exists, as a sentence a person would say.
 *
 * DELIBERATELY NOT `assessment.reason`. That field is the loop's own account,
 * written for a log and for the UI's detail view: it reads like a log line, and it
 * quotes the buffer at its own precision — so echoing it put "2.66%" next to the
 * body's "2.7%", and a trader reads two numbers as two facts. Every percentage in
 * a message now comes from one place at one precision, and `reason` stays
 * available to callers that want the plumbing detail.
 */
function changeLine(assessment: RiskAssessment, snapshot: boolean): string {
  // A SNAPSHOT IS NOT A CHANGE. `/positions` renders the loop's latest
  // assessment, which the loop rebuilds on EVERY tick with the previous TICK's
  // state — so a position sitting in DANGER carries `previousState: DANGER`,
  // and this line used to print "DANGER … Changed from DANGER". The previous
  // state was reported correctly; the line was the wrong line for a view.
  if (snapshot) return '';
  if (assessment.previousState === undefined) {
    return 'First time PerpGuard has seen this position.';
  }
  // Never claim a change that did not happen, whoever the caller is.
  if (assessment.previousState === assessment.state) return '';
  return `Changed from ${headline(assessment.previousState)}.`;
}

/**
 * THE ONE SHAPE A TOP-UP LINE HAS: what it costs, and what it buys.
 *
 *   Add 562 → buffer 4.0%, liquidation 80,647.1
 *
 * Exported because the bot offers a THIRD top-up whose amount the user types,
 * and that line has to be this line. Two formatters would eventually disagree
 * about a separator, a precision or a word, and the disagreement would surface
 * as a trader comparing an offered option against their own amount and finding
 * the screens do not match. Same reason `/positions` renders through this
 * module rather than through a formatter of its own.
 *
 * A NEGATIVE RESULTING BUFFER IS NOT A NEGATIVE PERCENTAGE. It cannot arise from
 * the two computed options — both reach a positive target by construction — but a
 * typed amount too small to rescue a doomed position lands exactly there, and
 * "buffer -1.4%" invites the reader to see a small number rather than a position
 * that is still past liquidation. (CLAUDE.md.)
 */
export function topUpLine(
  amountText: string,
  bufferPct: number | undefined,
  liquidationPricePNS: bigint | undefined,
  market: MarketRiskConfig,
  bufferDecimals: number,
): string {
  const buffer =
    bufferPct === undefined
      ? 'buffer unknown'
      : bufferPct < 0
        ? 'still past liquidation'
        : `buffer ${formatBufferPct(bufferPct, bufferDecimals)}`;
  // A liquidation price at or below zero is not a price: the formula puts it
  // there when the collateral exceeds anything the market could take away, and a
  // price cannot go negative. Said in words, because "liquidation -9,918,229.9"
  // is arithmetic leaking into a message. Unreachable from the computed options,
  // which aim at modest buffers; entirely reachable once the user picks the amount.
  const liquidation =
    liquidationPricePNS === undefined
      ? 'liquidation n/a'
      : liquidationPricePNS <= 0n
        ? 'no liquidation price left to reach'
        : `liquidation ${formatPricePNS(liquidationPricePNS, market)}`;
  return `Add ${amountText} → ${buffer}, ${liquidation}`;
}

/**
 * One offered option's line.
 *
 * The buffer and liquidation price quoted are for the EXACT unrounded amount,
 * while the amount shown is ceiled. So the action lands a shade better than the
 * line claims. That asymmetry is deliberate and only runs one way: a top-up may
 * over-deliver against its stated buffer, never under.
 */
function optionLine(
  option: TopUpOption,
  market: MarketRiskConfig,
  config: AlertConfig,
): { readonly label: string; readonly amountCNS: bigint } {
  const { amountCNS, text } = ceilAusd(option.amountCNS, market, config.ausdDisplayDecimals);
  return {
    label: topUpLine(
      text,
      option.resultingBufferPct ?? option.targetBufferPct,
      option.resultingLiquidationPricePNS,
      market,
      config.bufferDecimals,
    ),
    amountCNS,
  };
}

/**
 * The top-up block, cheap option first.
 *
 * An option whose amount is zero is OMITTED rather than rendered as "add 0": the
 * position already has that much room, so there is nothing to offer. A position
 * at an 8% buffer therefore gets one option, not two, and a SAFE one gets none.
 *
 * The unit is stated once, in the label, rather than repeated on every line.
 */
function topUpBlock(
  assessment: RiskAssessment,
  market: MarketRiskConfig,
  config: AlertConfig,
): { readonly lines: readonly string[]; readonly actions: readonly AlertAction[] } {
  const topUp = assessment.topUp;
  if (topUp === undefined) return { lines: [], actions: [] };

  const lines: string[] = [];
  const actions: AlertAction[] = [];
  const candidates: ReadonlyArray<readonly [AlertActionIntent, TopUpOption]> = [
    ['clear-danger', topUp.clearDanger],
    ['to-safe', topUp.toSafe],
  ];

  for (const [intent, option] of candidates) {
    if (option.amountCNS <= 0n) continue;
    const { label, amountCNS } = optionLine(option, market, config);
    lines.push(label);
    actions.push({
      ...(assessment.accountId === undefined ? {} : { accountId: assessment.accountId }),
      type: 'add-margin',
      intent,
      marketId: assessment.marketId,
      symbol: assessment.symbol,
      positionId: assessment.positionId,
      amountCNS,
      label,
      ...(option.resultingLiquidationPricePNS === undefined ? {} : { resultingLiquidationPricePNS: option.resultingLiquidationPricePNS }),
      ...(option.resultingBufferPct === undefined ? {} : { resultingBufferPct: option.resultingBufferPct }),
      ...(assessment.liqBufferPct === undefined ? {} : { fromBufferPct: assessment.liqBufferPct }),
    });
  }

  if (lines.length === 0) return { lines: [], actions: [] };
  return { lines: ['Top up (AUSD):', ...lines], actions };
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The buffer / liquidation / mark line every assessed message opens with. */
function positionLine(
  assessment: RiskAssessment,
  market: MarketRiskConfig,
  config: AlertConfig,
): string {
  const parts = [capitalize(describeBuffer(assessment.liqBufferPct, config.bufferDecimals))];
  if (assessment.liquidationPricePNS !== undefined) {
    // Same rule as `topUpLine`: at or below zero is not a price, it is
    // collateral exceeding anything the market could take away.
    parts.push(
      assessment.liquidationPricePNS <= 0n
        ? 'no liquidation price left to reach'
        : `liquidation ${formatPricePNS(assessment.liquidationPricePNS, market)}`,
    );
  }
  parts.push(`mark ${formatPricePNS(assessment.markPricePNS, market)}`);
  return `${parts[0]!} — ${parts.slice(1).join(', ')}`;
}

/**
 * What we last knew, for a message sent while blind.
 *
 * Labelled as the past, because that is what it is. Keeping it is the same rule
 * as the UI's: a monitor that has gone blind must not look healthy, and must not
 * pretend it knows nothing either.
 */
function lastKnownLine(assessment: RiskAssessment, market: MarketRiskConfig, config: AlertConfig): string | undefined {
  const last = assessment.lastKnownState;
  if (last === undefined) return undefined;
  const detail =
    assessment.liqBufferPct === undefined
      ? ''
      : `, ${describeBuffer(assessment.liqBufferPct, config.bufferDecimals)}` +
        (assessment.liquidationPricePNS === undefined
          ? ''
          : assessment.liquidationPricePNS <= 0n
            ? ', no liquidation price left to reach'
            : `, liquidation ${formatPricePNS(assessment.liquidationPricePNS, market)}`);
  return `Last known before this: ${headline(last)}${detail}.`;
}

/**
 * ISOLATED MARGIN, said out loud.
 *
 * The single most important thing a Perpl trader can misunderstand, and the
 * reason this product exists: free account balance is NEVER pulled in to rescue a
 * losing position. Someone reading a DANGER alert while holding plenty of spare
 * AUSD needs to know it will not save them on its own.
 */
const ISOLATED_MARGIN_NOTE =
  'Isolated margin: your free AUSD is not used to rescue this position automatically.';

export interface RenderedAlert {
  readonly title: string;
  readonly lines: readonly string[];
  readonly text: string;
  readonly actions: readonly AlertAction[];
}

/**
 * What a render needs besides the assessment. `snapshot` marks a VIEW of the
 * current state (`/positions`, a position screen) rather than an alert about a
 * change: a view has no "Changed from" line, because nothing changed.
 */
export interface RenderContext {
  readonly alerts: AlertConfig;
  readonly market: MarketRiskConfig;
  readonly snapshot?: boolean;
}

/**
 * Render one alert.
 *
 * The caller has already decided this message should exist and what kind it is;
 * this only writes it. Blind kinds carry NO ACTIONS — we cannot vouch for a price,
 * so we do not invite anyone to act on one.
 */
export function renderAlert(
  assessment: RiskAssessment,
  kind: AlertKind,
  context: RenderContext,
): RenderedAlert {
  const { alerts: config, market } = context;
  if (market.marketId !== assessment.marketId) {
    // Rendering one market's position against another's scaling produces prices
    // that are wrong by a power of ten and look entirely plausible.
    throw new RangeError(
      `cannot render a market ${assessment.marketId} assessment against market ` +
        `${market.marketId} (${market.symbol}) config: every price and amount ` +
        `would be scaled by the wrong market's decimals.`,
    );
  }

  const heading = title(assessment);
  const lines: string[] = [];
  let actions: readonly AlertAction[] = [];

  switch (kind) {
    case 'feed-down': {
      lines.push("Price feed is down. I can't assess your positions until it's back.");
      const last = lastKnownLine(assessment, market, config);
      if (last !== undefined) lines.push(last);
      break;
    }
    case 'positions-untrusted': {
      lines.push("I've lost track of your positions. What you see may no longer be true.");
      // POSITION TRUST LOSES TO NOTHING, so this is the state reported even when
      // the feed is also down. Saying so keeps the other cause from being hidden
      // by that choice — they have different fixes and the user may need both.
      if (assessment.feed !== 'connected') {
        lines.push(`The price feed is also ${assessment.feed}.`);
      }
      const last = lastKnownLine(assessment, market, config);
      if (last !== undefined) lines.push(last);
      break;
    }
    case 'past-liquidation': {
      lines.push(positionLine(assessment, market, config));
      lines.push('The mark has passed this position’s liquidation price.');
      lines.push(ISOLATED_MARGIN_NOTE);
      break;
    }
    case 'danger': {
      lines.push(positionLine(assessment, market, config));
      lines.push(ISOLATED_MARGIN_NOTE);
      break;
    }
    case 'watch': {
      lines.push(positionLine(assessment, market, config));
      break;
    }
    case 'recovered': {
      lines.push(positionLine(assessment, market, config));
      // Out of a blind spell the position may be anywhere: say we can see it,
      // never that it is above the threshold unless it is.
      if (assessment.previousState === 'FEED_DOWN' || assessment.previousState === 'POSITIONS_UNTRUSTED') {
        lines.push(assessment.state === 'SAFE' ? 'I can see it again, and it is above the safe threshold.' : 'I can see it again.');
        break;
      }
      const target = assessment.topUp?.toSafe.targetBufferPct;
      lines.push(
        target === undefined
          ? 'Back above the safe threshold.'
          : `Back above the ${formatBufferPct(target, config.bufferDecimals)} safe threshold.`,
      );
      break;
    }
  }

  if (assessment.watch !== undefined) {
    // NO ACTIONS FOR A WATCHER, enforced here as well as in the bot's gate: a
    // watched assessment never carries top-ups, and even if one did, a watcher
    // gets the words and not the buttons.
    actions = [];
    lines.push(watchLine(assessment));
  } else if (kind !== 'feed-down' && kind !== 'positions-untrusted') {
    const block = topUpBlock(assessment, market, config);
    lines.push(...block.lines);
    actions = block.actions;

    // STALE NUMBERS ARE NEVER PRESENTED AS CURRENT. Said last so it qualifies
    // everything above it, and in words rather than as a timestamp.
    if (assessment.priceIsOld) {
      lines.push(`Note: ${describeAge(assessment.priceAgeMs)}.`);
    }
  }

  const change = changeLine(assessment, context.snapshot === true);
  if (change !== '') lines.push(change);

  return { title: heading, lines, text: [heading, ...lines].join('\n'), actions };
}

/** Assemble the full message. `kind` and `atMs` come from the caller's decision. */
export function buildMessage(
  assessment: RiskAssessment,
  kind: AlertKind,
  context: RenderContext,
): AlertMessage {
  const rendered = renderAlert(assessment, kind, context);
  const html = assessment.watch !== undefined && context.snapshot !== true ? renderWatchAlertHtml(assessment, kind, context.market) : undefined;
  return {
    ...(html === undefined ? {} : { html }),
    ...(assessment.accountId === undefined ? {} : { accountId: assessment.accountId }),
    ...(assessment.watch === undefined ? {} : { watch: assessment.watch }),
    kind,
    state: assessment.state,
    previousState: assessment.previousState,
    marketId: assessment.marketId,
    symbol: assessment.symbol,
    positionId: assessment.positionId,
    title: rendered.title,
    lines: rendered.lines,
    text: rendered.text,
    actions: rendered.actions,
    atMs: assessment.atMs,
  };
}
