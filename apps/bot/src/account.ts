/**
 * The account half: screens for a LINKED chat's own positions.
 *
 * Reachable only through routes the gate keeps behind the link, resolved at
 * tap time like any command. Every money-moving button here is an ACTION
 * button minted into the pending-action store, so it goes through the same
 * token cross-check, confirmation, one-in-flight lock and reconciliation as
 * an alert's top-up. Nothing on these screens executes on the first tap.
 *
 * The voice is the read-only half's: money first and in bold, each term once,
 * never the word "safe", never a negative percentage, and NEVER AN AMOUNT
 * PRESENTED AS AFFORDABLE WHEN IT MAY NOT BE: the free balance we read is a
 * floor, so a top-up above it is offered WITH a warning rather than hidden.
 */
import { scaledToNumber, type ActionAvailability, type FeedHealth, type MarketRiskConfig, type PositionSourceStatus } from '@perpguard/shared';
import type { AlertAction, AlertActionIntent } from '@perpguard/backend/alerts';
import { formatPricePNS } from '@perpguard/backend/alerts/render';
import { distance, dot, esc, held, money, pct, positionName, shortDistance } from '@perpguard/backend/alerts/plain';
import { isBlind, type RiskAssessment } from '@perpguard/backend/risk';
import { WARN_LEVELS, warnLevelInfo, type WarnLevel } from '@perpguard/backend/risk/warn';
import type { FreeBalanceReading } from './balance.ts';
import type { ExecutionOutcome } from './actions.ts';
import type { AccountSettings } from './settings.ts';
import type { Button, Screen } from './screens.ts';

const BACK_TO_POSITIONS: Button = { text: '← Back', route: { to: 'positions' } };

/** `0.5 BTC` from lots. Undefined when the size is not known. */
export function sizeOf(assessment: RiskAssessment, market: MarketRiskConfig | undefined): string | undefined {
  if (assessment.lotLNS === undefined || market === undefined) return undefined;
  return `${scaledToNumber(assessment.lotLNS, market.lotDecimals).toLocaleString('en-US', { maximumFractionDigits: market.lotDecimals })} ${esc(assessment.symbol)}`;
}

/** The line that says the monitor cannot see, or undefined when it can. Never a healthy look while blind. */
export function blindLine(feed: FeedHealth, positions: PositionSourceStatus): string | undefined {
  if (feed.state !== 'connected') return '⚠️ <b>The price feed is down.</b> Every number here is frozen at the moment it dropped, and nothing can be sent until it is back.';
  if (positions.state !== 'live') return `⚠️ <b>I cannot see your positions right now</b> (the list is ${esc(positions.state)}). What is shown may no longer be true.`;
  return undefined;
}

// ── My positions ────────────────────────────────────────────────────────────

export interface PositionsInput {
  readonly accountId: number;
  readonly assessments: readonly RiskAssessment[];
  readonly feed: FeedHealth;
  readonly positions: PositionSourceStatus;
  readonly free: FreeBalanceReading;
  readonly configs: ReadonlyMap<number, MarketRiskConfig>;
}

export function positionsScreen(input: PositionsInput): Screen {
  const blind = blindLine(input.feed, input.positions);
  const lines: string[] = [];
  if (input.assessments.length === 0) {
    lines.push(`<b>Account #${input.accountId}</b>`);
    // AN EMPTY LIST IS NOT "NO POSITIONS" unless the list is live.
    lines.push(input.positions.state === 'live' ? 'No open positions.' : 'I have nothing to show, and that does not mean you have no positions: I have not been told what is open.');
  } else {
    lines.push(`<b>Account #${input.accountId}</b> · ${input.assessments.length} open`);
    lines.push('');
    for (const a of ordered(input.assessments)) {
      const size = sizeOf(a, input.configs.get(a.marketId));
      lines.push(`${dot(a.state)} ${positionName(a)}${size === undefined ? '' : ` ${size}`} · <b>${isBlind(a.state) ? 'cannot see' : shortDistance(a.liqBufferPct)}</b>`);
    }
  }
  lines.push('');
  lines.push(input.free.known ? `Free balance at least ${held(input.free.floorCNS)}` : `Free balance unknown: ${esc(input.free.reason)}`);
  if (input.assessments.length > 0) lines.push('<i>The percentage is how far the price can move against you before the exchange closes the position.</i>');
  if (blind !== undefined) lines.push('', blind);

  const buttons: Button[][] = ordered(input.assessments).map((a) => [
    { text: `${a.symbol}${a.side === undefined ? '' : ` ${a.side}`} · ${isBlind(a.state) ? 'cannot see' : shortDistance(a.liqBufferPct)}`, route: { to: 'position', marketId: a.marketId } },
  ]);
  buttons.push([{ text: '← Back', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}

// ── Margin ──────────────────────────────────────────────────────────────────

/**
 * 💰 MARGIN: the same positions, framed for adding margin. Choosing one opens
 * its position screen, whose Add buttons go through the one confirmation,
 * lock and reconciliation every top-up uses. Nothing here sends anything.
 */
export function marginScreen(input: PositionsInput): Screen {
  const lines = ['💰 <b>MARGIN</b>', "Add margin to one position. Each position's margin is separate: Perpl never moves your free balance into a position by itself.", ''];
  lines.push(input.free.known ? `Free balance at least ${held(input.free.floorCNS)}` : `Free balance unknown: ${esc(input.free.reason)}`);
  if (input.assessments.length === 0) {
    lines.push('', input.positions.state === 'live' ? 'No open positions, so there is nothing to add margin to.' : 'I have not been told what is open, so I cannot offer anything yet.');
  } else {
    lines.push('', 'Choose a position:');
  }
  const blind = blindLine(input.feed, input.positions);
  if (blind !== undefined) lines.push('', blind);
  const buttons: Button[][] = ordered(input.assessments).map((a) => [
    { text: `${a.symbol}${a.side === undefined ? '' : ` ${a.side}`} · ${isBlind(a.state) ? 'cannot see' : shortDistance(a.liqBufferPct)}`, route: { to: 'position', marketId: a.marketId } },
  ]);
  buttons.push([{ text: '← Back', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}

/** Closest to its closing price first; blind ones first of all. */
function ordered(assessments: readonly RiskAssessment[]): RiskAssessment[] {
  return [...assessments].sort((a, b) => (a.liqBufferPct ?? -Infinity) - (b.liqBufferPct ?? -Infinity));
}

// ── one position ────────────────────────────────────────────────────────────

export interface PositionInput {
  readonly assessment: RiskAssessment;
  readonly market: MarketRiskConfig;
  readonly free: FreeBalanceReading;
  readonly feed: FeedHealth;
  readonly positions: PositionSourceStatus;
  /** Asked of the ACTING venue. Undefined means it could not be asked. */
  readonly availability: ActionAvailability | undefined;
  /** The top-ups the alerts layer computed for this assessment, ceiled. */
  readonly topUps: readonly AlertAction[];
  /** Mints a pending-action token and returns the button's callback data. */
  readonly button: (action: AlertAction, kind: 'act' | 'custom' | 'blocked') => string;
  readonly bufferDecimals: number;
}

/** Share of the position the Reduce button closes. */
export const REDUCE_SHARE = 0.25;

export function positionScreen(input: PositionInput): Screen {
  const { assessment: a, market } = input;
  const name = positionName(a);
  const lines: string[] = [`${dot(a.state)} <b>${name} · ${isBlind(a.state) ? 'I cannot see it right now' : distance(a.liqBufferPct)}</b>`];
  const blind = blindLine(input.feed, input.positions);

  const liq = a.liquidationPricePNS;
  const lose = a.marginCNS === undefined ? 'the money behind it' : `the ${held(a.marginCNS, market.collateralDecimals)} behind it`;
  if (!isBlind(a.state)) {
    lines.push(
      liq !== undefined && liq > 0n
        ? `${esc(a.symbol)} is ${formatPricePNS(a.markPricePNS, market)}. At ${formatPricePNS(liq, market)} the exchange closes this and you lose ${lose}.`
        : `${esc(a.symbol)} is ${formatPricePNS(a.markPricePNS, market)}. There is more behind this position than it could lose, so it has no closing price.`,
    );
  }
  lines.push('');
  lines.push(input.free.known ? `You hold free at least ${held(input.free.floorCNS, market.collateralDecimals)}` : `Your free balance is unknown: ${esc(input.free.reason)}`);
  lines.push("Perpl will not use it to save this position. Each position's money is kept separate.");

  const buttons: Button[][] = [];
  const kind: 'act' | 'blocked' = input.availability?.actionable === true ? 'act' : 'blocked';
  const position = { marketId: a.marketId, symbol: a.symbol, positionId: a.positionId, ...(a.accountId === undefined ? {} : { accountId: a.accountId }) };

  if (blind !== undefined || isBlind(a.state)) {
    // NO ACTIONS WHILE BLIND: a top-up or a close against a frozen price is
    // exactly what the feed rule forbids. The way back is to look again.
    lines.push('', blind ?? '⚠️ <b>I cannot see this position right now</b>, so I will not offer to act on it.');
    buttons.push([{ text: '↻ Look again', route: { to: 'position', marketId: a.marketId } }]);
    buttons.push([BACK_TO_POSITIONS]);
    return { html: lines.join('\n'), buttons };
  }

  // Top-ups: the computed options. One above the free-balance FLOOR is still
  // offered, with a warning: the floor can understate what is spendable
  // (whether Perpl's locked balance sits inside the balance is unanswered),
  // and refusing a real rescue on our own conservative number costs a trader
  // the position, where a request the venue rejects costs one message.
  const topUps = dedupe(input.topUps);
  if (topUps.length > 0) {
    lines.push('', `Adding to it moves that closing price further ${a.side === 'short' ? 'up' : 'down'}:`);
    for (const t of topUps) {
      const after = t.resultingLiquidationPricePNS === undefined ? '' : ` → closes at ${formatPricePNS(t.resultingLiquidationPricePNS, market)}`;
      buttons.push([{ text: `Add ${wholeOf(t.amountCNS, market)} AUSD${after}`, data: input.button(t, kind) }]);
    }
    const free = input.free;
    if (free.known) {
      const over = topUps.filter((t) => t.amountCNS > free.floorCNS);
      if (over.length > 0) {
        lines.push(`${over.length === topUps.length ? (topUps.length === 1 ? 'This may be' : 'These may be') : 'The larger one may be'} more than you hold free: I can see at least ${held(free.floorCNS, market.collateralDecimals)}, a floor rather than your balance. The exchange will refuse what you cannot cover.`);
      }
    }
  }

  const custom: AlertAction = { ...position, type: 'add-margin', intent: 'custom', amountCNS: 0n, label: 'Custom amount' };
  buttons.push([{ text: 'Add custom amount', data: input.button(custom, input.availability?.actionable === true ? 'custom' : 'blocked') }]);

  const reduceLots = a.lotLNS === undefined ? 0n : (a.lotLNS * BigInt(Math.round(REDUCE_SHARE * 100))) / 100n;
  if (reduceLots > 0n) {
    const reduce: AlertAction = { ...position, type: 'reduce-position', intent: 'reduce', amountCNS: 0n, sizeLNS: reduceLots, label: `Reduce ${Math.round(REDUCE_SHARE * 100)}%` };
    buttons.push([{ text: `Reduce ${Math.round(REDUCE_SHARE * 100)}%`, data: input.button(reduce, kind) }]);
  }
  const close: AlertAction = { ...position, type: 'close-position', intent: 'close', amountCNS: 0n, label: 'Close position' };
  buttons.push([{ text: 'Close position', data: input.button(close, kind) }]);

  if (kind === 'blocked') {
    const av = input.availability;
    lines.push('', av === undefined || av.actionable ? 'I could not check whether this market can be acted on, so every button here only explains why it will not send.' : `${esc(av.network)} will not take actions on ${esc(a.symbol)} right now: ${esc(av.reason)}. I am still watching it.`);
  }
  buttons.push([BACK_TO_POSITIONS]);
  return { html: lines.join('\n'), buttons };
}

/** Two options that ceil to the same figure are one option. */
function dedupe(actions: readonly AlertAction[]): AlertAction[] {
  const seen = new Set<bigint>();
  return actions.filter((t) => t.amountCNS > 0n && !seen.has(t.amountCNS) && seen.add(t.amountCNS) !== undefined);
}

/** A ceiled top-up as whole AUSD when it is whole, which it is at the default display precision. */
function wholeOf(amountCNS: bigint, market: MarketRiskConfig): string {
  const unit = 10n ** BigInt(market.collateralDecimals);
  if (amountCNS % unit === 0n) return (amountCNS / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return scaledToNumber(amountCNS, market.collateralDecimals).toLocaleString('en-US', { maximumFractionDigits: market.collateralDecimals });
}

// ── the confirmation: the second tap ────────────────────────────────────────

export interface ConfirmInput {
  readonly action: AlertAction;
  readonly market: MarketRiskConfig | undefined;
  readonly assessment: RiskAssessment | undefined;
  readonly free: FreeBalanceReading;
  readonly confirmData: string;
  readonly cancelData: string;
  /** Things to read before confirming; never refusals. */
  readonly notes?: readonly string[];
}

export function confirmScreen(input: ConfirmInput): Screen {
  const { action, market, assessment } = input;
  const name = assessment === undefined ? esc(action.symbol) : positionName(assessment);
  const lines: string[] = [];
  switch (action.type) {
    case 'add-margin': {
      const amount = market === undefined ? `${action.amountCNS} micros of AUSD` : `${wholeOf(action.amountCNS, market)} AUSD`;
      lines.push(`<b>Add ${amount} to ${name}?</b>`);
      if (action.resultingLiquidationPricePNS !== undefined && market !== undefined) {
        lines.push(action.resultingLiquidationPricePNS > 0n ? `Closes at, after: ${formatPricePNS(action.resultingLiquidationPricePNS, market)}` : 'Closes at, after: no closing price left to reach');
      }
      if (action.resultingBufferPct !== undefined) lines.push(`Room to fall, after: ${action.resultingBufferPct < 0 ? 'still past its closing price' : pct(action.resultingBufferPct)}`);
      if (input.free.known) {
        const left = input.free.floorCNS - action.amountCNS;
        lines.push(`Free balance left: ${left < 0n ? 'possibly none — this may be more than you hold' : `at least ${held(left, market?.collateralDecimals)}`}`);
      }
      lines.push('<i>The amount sent is exactly the figure above.</i>');
      break;
    }
    case 'reduce-position': {
      const size = action.sizeLNS === undefined || market === undefined ? '' : ` (${scaledToNumber(action.sizeLNS, market.lotDecimals).toLocaleString('en-US', { maximumFractionDigits: market.lotDecimals })} ${esc(action.symbol)})`;
      lines.push(`<b>Reduce ${name} by ${Math.round(REDUCE_SHARE * 100)}%${size}?</b>`);
      const liq = assessment?.liquidationPricePNS;
      lines.push(
        liq !== undefined && liq > 0n && market !== undefined
          ? `The closing price stays at ${formatPricePNS(liq, market)}: Perpl releases margin in proportion, so a smaller position closes at the same price. It lowers what you can lose.`
          : 'Perpl releases margin in proportion, so the closing price does not move. It lowers what you can lose.',
      );
      lines.push('To move the closing price, add margin instead.');
      break;
    }
    case 'close-position':
      lines.push(`<b>Close ${name}?</b>`);
      lines.push('The whole position closes at the market price. Its margin, after profit or loss, goes back to your free balance.');
      break;
  }
  if (action.positionId === undefined) lines.push('I do not have this position’s venue id, so I cannot address the action to it.');
  for (const note of input.notes ?? []) lines.push(esc(note));
  lines.push('', 'Nothing has been sent yet.');
  return {
    html: lines.join('\n'),
    buttons: [[{ text: '✓ Send it', data: input.confirmData }, { text: 'Cancel', data: input.cancelData }]],
  };
}

/** Shown in place of the confirmation while the action is in flight. */
export function sendingScreen(action: AlertAction): Screen {
  const what = action.type === 'add-margin' ? 'Adding the margin' : action.type === 'reduce-position' ? 'Reducing the position' : 'Closing the position';
  return { html: `${what}… I will check the position itself afterwards, which can take up to a minute. Do not send it again meanwhile.`, buttons: [] };
}

// ── the outcome ─────────────────────────────────────────────────────────────

export interface OutcomeInput {
  readonly action: AlertAction;
  readonly outcome: ExecutionOutcome;
  readonly market: MarketRiskConfig | undefined;
  readonly assessment: RiskAssessment | undefined;
  /** Callback data for "Send again", present only on a reconciled not-applied. */
  readonly retryData?: string;
}

export function outcomeScreen(input: OutcomeInput): Screen {
  const { action, outcome, market } = input;
  const name = input.assessment === undefined ? esc(action.symbol) : positionName(input.assessment);
  // FRESH: the outcome is the record of what happened to their money, and it stays.
  const nav: Button[] = [{ text: '📊 My Positions', route: { to: 'positions' }, fresh: true }, { text: '← Home', route: { to: 'home' }, fresh: true }];
  switch (outcome.kind) {
    case 'applied': {
      const lines: string[] = [];
      if (action.type === 'add-margin' && market !== undefined) {
        lines.push(`✓ <b>Added ${wholeOf(action.amountCNS, market)} AUSD to ${name}</b>`);
        if (action.resultingLiquidationPricePNS !== undefined && action.resultingLiquidationPricePNS > 0n) lines.push(`Closes at now: ${formatPricePNS(action.resultingLiquidationPricePNS, market)}`);
        if (action.resultingBufferPct !== undefined && action.resultingBufferPct >= 0) {
          lines.push(`Room to fall: ${action.fromBufferPct === undefined || action.fromBufferPct < 0 ? '' : `${pct(action.fromBufferPct)} → `}${pct(action.resultingBufferPct)}`);
        }
        lines.push("<i>Confirmed against the position itself, not only the exchange's reply.</i>");
        if (outcome.venueRejected === true) lines.push('<i>The exchange reported a rejection on this one; the margin did apply, and the position is what I checked. Do not send it again.</i>');
      } else {
        lines.push(`✓ <b>${esc(outcome.detail)}</b>`);
      }
      return { html: lines.join('\n'), buttons: [nav] };
    }
    case 'not-applied':
      return {
        html: `<b>Nothing changed.</b>\n${esc(outcome.detail)}`,
        buttons: [...(input.retryData === undefined ? [] : [[{ text: 'Send again', data: input.retryData } as Button]]), nav],
      };
    case 'unknown':
      // NO RETRY HERE. Something may have landed.
      return { html: `<b>Sent, and I cannot tell yet what it did.</b>\n${esc(outcome.detail)}\n\n${esc(outcome.nextStep)}`, buttons: [nav] };
    case 'refused':
      return { html: `<b>Refused before sending.</b> ${esc(outcome.detail)}`, buttons: [nav] };
    case 'not-implemented':
      return { html: `<b>Not sent.</b> ${esc(outcome.detail)}`, buttons: [nav] };
    case 'submitted':
      return { html: `<b>Sent. The outcome is not known yet.</b> ${esc(outcome.detail)}`, buttons: [nav] };
  }
}

// ── settings ────────────────────────────────────────────────────────────────

export function settingsScreen(accountId: number, settings: AccountSettings): Screen {
  const level = warnLevelInfo(settings.warnLevel);
  return {
    html: `⚙️ <b>SETTINGS</b> · account #${accountId}\nEach button shows what it is set to now. Tap to change it.`,
    buttons: [
      [{ text: `⚠️ Warn me at: ${level.label} (${pct(level.firstWarningPct).replace('.0%', '%')})`, route: { to: 'warn-ask' } }],
      [{ text: '← Back', route: { to: 'home' } }],
    ],
  };
}

export function warnAskScreen(current: WarnLevel): Screen {
  return {
    html: '<b>How early should I warn you?</b>\nHow far the price still has to move against you when the first warning arrives. The last warning, at 3%, comes whatever you pick.',
    buttons: [
      ...WARN_LEVELS.map((l): Button[] => [
        { text: `${l.label} · ${pct(l.firstWarningPct).replace('.0%', '%')} — ${l.level === current ? 'currently set' : l.note}`, route: { to: 'warn-set', level: l.index } },
      ]),
      [{ text: '← Back', route: { to: 'settings' } }],
    ],
  };
}

export function disconnectAskScreen(accountId: number): Screen {
  return {
    html: `<b>Disconnect account #${accountId}?</b>\nThis chat stops getting its alerts and buttons, any API key you gave me is deleted, and its session closes — at once. You can connect again any time. Watched wallets stay.`,
    buttons: [[{ text: `🔌 Disconnect account #${accountId}`, route: { to: 'disconnect' } }], [{ text: 'Cancel', route: { to: 'account' } }]],
  };
}

/** The intents that mean "add margin", for callers that branch on it. */
export const TOP_UP_INTENTS: ReadonlySet<AlertActionIntent> = new Set(['clear-danger', 'to-safe', 'custom']);
