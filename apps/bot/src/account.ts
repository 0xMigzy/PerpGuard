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
import { dot, esc, fromLiquidation, held, pct, positionName, shortDistance, signedPnl } from '@perpguard/backend/alerts/plain';
import { isBlind, type RiskAssessment } from '@perpguard/backend/risk';
import { ALERT_DISTANCE_PRESETS, distanceLabel } from '@perpguard/backend/manual/distance';
import type { FreeBalanceReading } from './balance.ts';
import type { Suggestions } from './suggestedAmounts.ts';
import type { ExecutionOutcome } from './actions.ts';
import type { AccountSettings } from './settings.ts';
import type { Button, Screen } from './screens.ts';

const BACK_TO_POSITIONS: Button = { text: '← Back', route: { to: 'positions' } };

/** The line that says the monitor cannot see, or undefined when it can. Never a healthy look while blind. */
export function blindLine(feed: FeedHealth, positions: PositionSourceStatus): string | undefined {
  if (feed.state !== 'connected') return '⚠️ <b>The price feed is down.</b> Every number here is frozen at the moment it dropped, and nothing can be sent until it is back.';
  if (positions.state !== 'live') return `⚠️ <b>I cannot see your positions right now</b> (the list is ${esc(positions.state)}). What is shown may no longer be true.`;
  return undefined;
}

// ── My positions ────────────────────────────────────────────────────────────

export interface PositionsInput {
  readonly accountId: number;
  readonly network?: string | undefined;
  readonly assessments: readonly RiskAssessment[];
  readonly feed: FeedHealth;
  readonly positions: PositionSourceStatus;
  readonly free: FreeBalanceReading;
  readonly configs: ReadonlyMap<number, MarketRiskConfig>;
  /** The account's alert distance, in percent. Undefined leaves the line off. */
  readonly alertPct?: number | undefined;
}

/**
 * 📊 MY POSITIONS (owner, 8 Oct 2026): free balance and the book's unrealised
 * P&L on top, then one button per position, closest to liquidation first, the
 * distance and that position's unrealised P&L on the button. All from the live
 * socket and the loop's last pass: nothing here is a query. A position it
 * cannot see has no P&L to show and is left out of the total, said in words.
 */
export function positionsScreen(input: PositionsInput): Screen {
  const all = ordered(input.assessments);
  const lines = [`📊 <b>MY POSITIONS</b> · ${input.network ?? 'testnet'} #${input.accountId}`];
  const d = collateralDecimalsOf(input.configs);
  const seen = all.filter((a) => !isBlind(a.state));
  const unseen = all.length - seen.length;
  const free = input.free.known ? `Free balance ${held(input.free.floorCNS, d)}` : 'Free balance unknown';
  const unrealised = seen.length === 0 ? undefined : `unrealised ${signedPnl(seen.reduce((sum, a) => sum + a.metrics.unrealisedPnlCNS, 0n), d)}${unseen > 0 ? ` (${unseen} I can't see left out)` : ''}`;
  lines.push(unrealised === undefined ? free : `${free} · ${unrealised}`);
  if (input.alertPct !== undefined) lines.push(`Alerting you at ${distanceLabel(input.alertPct)} from liquidation`);
  // AN EMPTY LIST IS NOT "NO POSITIONS" unless the list is live.
  if (all.length === 0) lines.push('', input.positions.state === 'live' ? 'No open positions.' : "I haven't been told what's open yet, so this may not be empty.");
  const blind = blindLine(input.feed, input.positions);
  if (blind !== undefined) lines.push('', blind);
  const buttons: Button[][] = all.map((a) => [{ text: positionButton(a, input.configs.get(a.marketId)?.collateralDecimals ?? d), route: { to: 'position', marketId: a.marketId } }]);
  buttons.push([{ text: '← Back', route: { to: 'home' } }]);
  return { html: lines.join('\n'), buttons };
}

/** `🔴 BTC long · 2.7% · −84 AUSD`: the unrealised P&L only for a position it can see. */
export function positionButton(a: RiskAssessment, collateralDecimals = 6): string {
  const head = `${bandDot(a)} ${a.symbol}${a.side === undefined ? '' : ` ${a.side}`}`;
  return isBlind(a.state) ? `${head} · can't see` : `${head} · ${shortBuffer(a.liqBufferPct)} · ${signedPnl(a.metrics.unrealisedPnlCNS, collateralDecimals)}`;
}

/** The collateral's decimals, from the market configs (one collateral per venue). */
function collateralDecimalsOf(configs: ReadonlyMap<number, MarketRiskConfig>): number {
  for (const c of configs.values()) return c.collateralDecimals;
  return 6;
}

/** `2.7%`, or `past liquidation`: a signed buffer, never a negative percentage. */
export function shortBuffer(buffer: number | undefined): string {
  return buffer !== undefined && buffer < 0 ? 'past liquidation' : shortDistance(buffer);
}

/** 🔴 danger or past it, 🟡 watch, 🟢 ok, ⚪ can't see. */
export function bandDot(a: Pick<RiskAssessment, 'state'>): string {
  return a.state === 'WATCH' ? '🟡' : dot(a.state);
}


/**
 * The distance an amount buys, for its button: `8.4%`, `17%`. ROUNDED DOWN, so
 * the button never promises more room than the top-up gives (the amount itself
 * is ceiled, which lands it marginally better still). One decimal below 10%:
 * a whole percent there can read BELOW where the position already is (2.7%
 * plus 100 AUSD is 2.9%, and "→ 2%" says it got worse).
 */
export function boughtDistance(buffer: number | undefined): string | undefined {
  if (buffer === undefined) return undefined;
  if (buffer < 0) return 'still past';
  const p = buffer * 100;
  return p >= 10 ? `${Math.floor(p)}%` : `${(Math.floor(p * 10 + 1e-9) / 10).toFixed(1)}%`;
}

/** An amount as it is said on a button: grouped, with no trailing zeros ("979", "489.5", "1,900"). */
function plainAmount(amountCNS: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const frac = (amountCNS % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${(amountCNS / unit).toLocaleString('en-US')}${frac === '' ? '' : `.${frac}`}`;
}

/**
 * A TOP-UP'S BUTTON (owner, 10 Oct 2026): `+979 → 2.9% away · 109 free`. The
 * amount, the distance from liquidation it buys (rounded DOWN), and the free
 * balance it leaves (rounded DOWN to a whole AUSD: money someone holds). No
 * "· free" when the free balance is unknown; "still past liquidation" when
 * even this does not bring it back.
 */
export function amountButton(amountCNS: bigint, decimals: number, resultingBufferPct: number | undefined, freeAfterCNS: bigint | undefined): string {
  const to = boughtDistance(resultingBufferPct);
  const distance = to === undefined ? '' : to === 'still past' ? ' → still past liquidation' : ` → ${to} away`;
  const unit = 10n ** BigInt(decimals);
  const free = freeAfterCNS === undefined || freeAfterCNS < 0n ? '' : ` · ${freeAfterCNS > 0n && freeAfterCNS < unit ? 'under 1' : (freeAfterCNS / unit).toLocaleString('en-US')} free`;
  return `+${plainAmount(amountCNS, decimals)}${distance}${free}`;
}

/**
 * The one sentence beside the top-ups (`suggestedAmounts.ts`), shared by the
 * alert and View position: when what can be spent buys almost nothing, no
 * top-up is offered and this says why.
 */
export function suggestionLines(s: Suggestions, decimals: number): string[] {
  if (s.note === undefined) return [];
  if (s.note.spendableCNS <= 0n) return ['There is nothing free to add right now, so I\u2019m not offering a top-up.'];
  const points = s.note.gain * 100;
  return [`The ${held(s.note.spendableCNS, decimals)} you can spend would move it ${points < 0.1 ? 'less than 0.1 points' : `only ${(Math.floor(points * 10) / 10).toFixed(1)} points`}, so I\u2019m not offering a top-up.`];
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
  /** The suggested amounts (`suggestedAmounts.ts`), each with its action button's data and the distance it buys. */
  readonly amounts: ReadonlyArray<{ readonly amountCNS: bigint; readonly data: string; readonly resultingBufferPct: number | undefined; readonly freeAfterCNS: bigint | undefined }>;
  /** The words beside them (`suggestionLines`). */
  readonly amountLines: readonly string[];
  /** Why no amount could be priced, when none could. */
  readonly unpricedReason?: string | undefined;
  readonly customData: string;
}

/**
 * 📊 VIEW POSITION (owner, 8 Oct 2026): distance, margin and liquidation
 * price, free balance, and the amounts to add, each showing the distance it
 * buys. Every amount is an ACTION token: its tap opens the confirmation and
 * nothing sends on it. Under them, 🚪 Close position (owner, 8 Oct 2026): a
 * navigation tap to its own confirmation (size, price, what it realises), the
 * kill switch's verified close behind it. Reduce is not offered.
 */
export function positionScreen(input: PositionInput): Screen {
  const { assessment: a, market } = input;
  const d = market.collateralDecimals;
  const back: Button = { text: '← Back', route: { to: 'positions' } };
  const blind = blindLine(input.feed, input.positions);
  const lines = [`${bandDot(a)} <b>${positionName(a)} · ${isBlind(a.state) ? "can't see right now" : fromLiquidation(a.liqBufferPct)}</b>`];
  if (!isBlind(a.state)) {
    const liq = a.liquidationPricePNS;
    lines.push(`Margin ${a.marginCNS === undefined ? '—' : held(a.marginCNS, d)} · ${liq !== undefined && liq > 0n ? `liquidation at ${formatPricePNS(liq, market)}` : 'no liquidation price'}`);
  }
  const freeText = input.free.known ? `Free balance ${held(input.free.floorCNS, d)}` : `Free balance unknown: ${esc(input.free.reason)}`;
  lines.push(isBlind(a.state) ? freeText : `${freeText} · unrealised ${signedPnl(a.metrics.unrealisedPnlCNS, d)}`);

  if (blind !== undefined || isBlind(a.state)) {
    // NO ACTIONS WHILE BLIND: a top-up against a frozen price is exactly what the feed rule forbids.
    lines.push('', blind ?? "⚠️ I can't see this position right now, so I won't offer to add to it.");
    return { html: lines.join('\n'), buttons: [[{ text: '↻ Look again', route: { to: 'position', marketId: a.marketId } }], [back]] };
  }

  // One amount to a row (a "most of free" label is long), then 🎛 Custom amount, 🚪 Close position, ← Back.
  // Offered, not hidden: the balance read is a floor, and refusing a real rescue on our own conservative number costs a position.
  const buttons: Button[][] = input.amounts.map((p) => [{ text: amountButton(p.amountCNS, d, p.resultingBufferPct, p.freeAfterCNS), data: p.data }]);
  buttons.push([{ text: '🎛 Custom amount', data: input.customData }]);
  buttons.push([{ text: '🚪 Close position', route: { to: 'close-pos', marketId: a.marketId } }]);
  buttons.push([back]);
  if (input.amountLines.length > 0) lines.push('', ...input.amountLines);
  if (input.unpricedReason !== undefined && input.amounts.length === 0) lines.push('', `I can't price an amount right now: ${esc(input.unpricedReason)}`);
  const av = input.availability;
  if (av === undefined || !av.actionable) {
    lines.push('', av === undefined ? "I couldn't check whether this market takes orders, so these buttons only explain why they won't send." : `${esc(av.network)} isn't taking orders on ${esc(a.symbol)} right now: ${esc(av.reason)}. I'm still watching it.`);
  }
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
  /** Held back from the free balance: Rescue in flight and the largest armed "minimum remaining". */
  readonly reservedCNS?: bigint | undefined;
}

/**
 * THE SECOND TAP. Before and after for margin, liquidation price, distance
 * and free balance; the liquidation figures only when the engine projected
 * them (live feed, live position). Nothing has been sent when this shows.
 */
export function confirmScreen(input: ConfirmInput): Screen {
  const { action, market, assessment } = input;
  const name = assessment === undefined ? esc(action.symbol) : positionName(assessment);
  const d = market?.collateralDecimals;
  const lines: string[] = [];
  let overSpendable = false;
  if (action.type === 'add-margin') {
    const amount = market === undefined ? `${action.amountCNS} micros of AUSD` : `${wholeOf(action.amountCNS, market)} AUSD`;
    lines.push(`⚠️ <b>Add ${amount} to ${name}?</b>`, '');
    if (assessment?.marginCNS !== undefined) lines.push(`Margin: ${held(assessment.marginCNS, d)} → ${held(assessment.marginCNS + action.amountCNS, d)}`);
    if (action.resultingBufferPct !== undefined && action.resultingLiquidationPricePNS !== undefined && market !== undefined) {
      const before = assessment?.liquidationPricePNS;
      lines.push(
        action.resultingLiquidationPricePNS > 0n
          ? `Liquidation price: ${before !== undefined && before > 0n ? `${formatPricePNS(before, market)} → ` : ''}${formatPricePNS(action.resultingLiquidationPricePNS, market)}`
          : 'Liquidation price: none left to reach',
      );
      const was = assessment?.liqBufferPct;
      // ROUNDED DOWN, by the button's own formatter (owner, 9 Oct 2026): the button and the confirmation never disagree.
      lines.push(`Distance: ${was === undefined ? '' : `${was < 0 ? 'past liquidation' : pct(was)} → `}<b>${action.resultingBufferPct < 0 ? 'still past liquidation' : boughtDistance(action.resultingBufferPct)}</b>`);
    }
    if (input.free.known) {
      const left = input.free.floorCNS - action.amountCNS;
      // MORE THAN WE CAN SEE AS FREE (owner, 10 Oct 2026): only a typed Custom amount gets here, since no top-up
      // button is above it. Warned, never refused: our figure is a floor, and the trader may know better.
      const spendable = input.free.floorCNS - (input.reservedCNS ?? 0n);
      overSpendable = action.amountCNS > spendable;
      lines.push(
        overSpendable
          ? `⚠️ That's more than the ${held(spendable > 0n ? spendable : 0n, d)} we can see as free — Perpl may reject it. Send anyway?`
          : `Free balance: ${held(input.free.floorCNS, d)} → ${held(left, d)}`,
      );
    } else {
      lines.push(`Free balance: unknown (${esc(input.free.reason)})`);
    }
    lines.push('', "<i>I send exactly this amount, then check the position itself — not just the exchange's reply — and tell you what happened.</i>");
  } else {
    lines.push(`<b>${esc(action.label)} · ${name}?</b>`);
  }
  if (action.positionId === undefined) lines.push("I don't have this position's id from the exchange, so I can't send anything to it.");
  // The custom flow's own balance note is the same warning in older words: the line above says it once, in the owner's.
  for (const note of input.notes ?? []) if (!(note.startsWith('This may be more than your free balance') && input.free.known)) lines.push(esc(note));
  lines.push('', 'Nothing has been sent yet.');
  return {
    html: lines.join('\n'),
    buttons: [[{ text: overSpendable ? '✅ Send anyway' : '✅ Confirm', data: input.confirmData }, { text: 'Cancel', data: input.cancelData }]],
  };
}

/** Shown in place of the confirmation while the action is in flight. */
export function sendingScreen(action: AlertAction): Screen {
  const what = action.type === 'add-margin' ? 'Adding the margin' : action.type === 'reduce-position' ? 'Reducing the position' : 'Closing the position';
  return { html: `${what}… I'll check the position itself afterwards, which can take up to a minute. Don't send it again meanwhile.`, buttons: [] };
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
  const nav: Button[] = [{ text: '📊 My positions', route: { to: 'positions' }, fresh: true }, { text: '🏠 Menu', route: { to: 'home' }, fresh: true }];
  switch (outcome.kind) {
    case 'applied': {
      const lines: string[] = [];
      if (action.type === 'add-margin' && market !== undefined) {
        lines.push(`✓ <b>Added ${wholeOf(action.amountCNS, market)} AUSD to ${name}</b>`);
        if (action.resultingLiquidationPricePNS !== undefined && action.resultingLiquidationPricePNS > 0n) lines.push(`Liquidation price now ${formatPricePNS(action.resultingLiquidationPricePNS, market)}`);
        if (action.resultingBufferPct !== undefined && action.resultingBufferPct >= 0) {
          lines.push(`${action.fromBufferPct === undefined || action.fromBufferPct < 0 ? '' : `${pct(action.fromBufferPct)} → `}${pct(action.resultingBufferPct)} from liquidation`);
        }
        if (outcome.venueRejected === true) {
          // THE sr 32 CASE (owner's wording, 6 Oct 2026): never "failed", never "rejection".
          // What happened, how it was checked, and the one thing not to do.
          lines.push(
            '',
            "The exchange's own report disagreed with what actually happened.",
            'The margin applied — I checked the position itself, not the receipt.',
            '<b>Do not send it again.</b>',
          );
        } else {
          lines.push("<i>Confirmed against the position itself, not only the exchange's reply.</i>");
        }
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
      return { html: `${esc(outcome.detail)} <b>${esc(outcome.nextStep)}</b>`, buttons: [nav] };
    case 'refused':
      return { html: `<b>Refused before sending.</b> ${esc(outcome.detail)}`, buttons: [nav] };
    case 'not-implemented':
      return { html: `<b>Not sent.</b> ${esc(outcome.detail)}`, buttons: [nav] };
    case 'submitted':
      return { html: `<b>Sent. The outcome is not known yet.</b> ${esc(outcome.detail)}`, buttons: [nav] };
  }
}

// ── settings ────────────────────────────────────────────────────────────────

export function settingsScreen(accountId: number, settings: AccountSettings, network?: string): Screen {
  return {
    html: `⚙️ <b>SETTINGS</b> · ${network ?? 'testnet'} #${accountId}`,
    buttons: [
      [{ text: `🔔 Alert me at: ${distanceLabel(settings.alertPct)} from liquidation`, route: { to: 'warn-ask' } }],
      [{ text: '← Back', route: { to: 'home' } }],
    ],
  };
}

/**
 * THE ALERT DISTANCE (Part 2): one number. At it, each position gets one
 * message with its distance and your free balance and the amounts to add;
 * a position with AUTO top-up armed is topped up there instead.
 */
export function warnAskScreen(currentPct: number): Screen {
  return {
    html: [
      '🔔 <b>Alert me at what distance from liquidation?</b>',
      "When a position gets this close, I message you once with amounts to add. Nothing is added unless you tap one and confirm.",
      'Rescue, when you turn it on for a position, acts at this same distance.',
    ].join('\n'),
    buttons: [
      ALERT_DISTANCE_PRESETS.map((p, i): Button => ({ text: `${p === currentPct ? '✅ ' : ''}${p}%`, route: { to: 'warn-set', level: i } })),
      [{ text: `🎛 Custom distance${(ALERT_DISTANCE_PRESETS as readonly number[]).includes(currentPct) ? '' : ` (now ${distanceLabel(currentPct)})`}`, route: { to: 'alert-custom' } }],
      [{ text: '← Back', route: { to: 'settings' } }],
    ],
  };
}

/** What a Disconnect would remove, read from the records at tap time. */
export interface DisconnectTarget {
  readonly accountId: number;
  /** Linked: this chat gets the account's alerts with buttons. False: only a wallet proof is held. */
  readonly linked: boolean;
  /** An API key is stored for this person. */
  readonly hasKey: boolean;
  /** The wallet that proved the account, when one did. */
  readonly walletAddress?: string;
}

/** Says exactly what goes: each clause only when it is true. */
export function disconnectAskScreen(target: DisconnectTarget): Screen {
  const wallet = target.walletAddress === undefined ? undefined : `${target.walletAddress.slice(0, 6)}…${target.walletAddress.slice(-4)}`;
  const removes: string[] = [];
  if (target.linked) removes.push("You'll stop getting its alerts here.");
  if (wallet !== undefined) removes.push(`I'll forget that your wallet <code>${wallet}</code> proved it.`);
  // ONLY OUR COPY (8 Oct 2026): the key itself stays on the person's Perpl profile until they remove it there.
  removes.push(target.hasKey ? "I'll delete my copy of your API key. The key itself stays on your Perpl profile until you remove it there." : 'No API key is stored for it, so there is none to delete.');
  return {
    html: [`🔌 <b>Disconnect #${target.accountId}?</b>`, ...removes, 'Wallets you watch stay. You can connect again any time.'].join('\n'),
    buttons: [[{ text: `🔌 Disconnect #${target.accountId}`, route: { to: 'disconnect' } }], [{ text: 'Cancel', route: { to: 'account' } }]],
  };
}

/** The intents that mean "add margin", for callers that branch on it. */
export const TOP_UP_INTENTS: ReadonlySet<AlertActionIntent> = new Set(['clear-danger', 'to-safe', 'custom']);
