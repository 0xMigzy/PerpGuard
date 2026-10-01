/**
 * The custom amount: the user picks the number, PerpGuard still tells them what
 * it buys.
 *
 * That sentence is the whole design. A round number with no stated outcome is
 * what this product exists to replace, so there are no 10/100/200 buttons here:
 * an amount typed by hand goes through the SAME risk engine, the SAME line shape
 * and the SAME confirmation screen as the two amounts PerpGuard computed. The
 * only difference is who chose the figure.
 *
 * Everything in this file is pure. No clock except the one injected into
 * {@link PendingAmountStore}, no I/O, no risk maths — the buffer and liquidation
 * price come from the loop's own projection and are formatted here, never
 * derived here.
 *
 * Two rules worth stating before the code:
 *
 *   MONEY IS PARSED IN INTEGERS. `parseAusdAmount` never touches `Number()`. A
 *   typed amount is the one figure in this flow PerpGuard did not compute, and
 *   handing it to a float is how 1000.07 becomes 1000.0699999999999.
 *
 *   NOTHING WE ROUND, NOTHING WE REFUSE ON A GUESS. The computed options CEIL,
 *   because PerpGuard chose their amounts and had to round them for display.
 *   A typed amount is not ours to adjust: one that the collateral cannot
 *   represent exactly is handed back with the increment named, rather than
 *   quietly moved to a figure the user did not type. And the free-balance check
 *   WARNS rather than refuses, because our balance figure is a floor — see
 *   `balance.ts`.
 */
import type { MarketRiskConfig, Side } from '@perpguard/shared';
import type { AlertAction } from '@perpguard/backend/alerts';
import { describeBuffer, formatPricePNS, topUpLine } from '@perpguard/backend/alerts/render';
import type { MarginProjection } from '@perpguard/backend/risk';
import { ACTION_TTL_MS } from './actions.ts';
import type { FreeBalanceReading } from './balance.ts';

// ── the pending prompt ──────────────────────────────────────────────────────

/**
 * One amount prompt awaiting a reply.
 *
 * SCOPED TO A POSITION, not just to a user. The next thing this person types is
 * an amount for THIS market, and a prompt that only remembered "they owe me a
 * number" would apply it to whatever was most recently discussed — which on an
 * account with two positions in trouble is how collateral lands on the wrong one.
 */
export interface PendingAmount {
  /** The app user, as the alerts engine names them. */
  readonly userId: string;
  readonly telegramUserId: number;
  readonly marketId: number;
  readonly symbol: string;
  /** The venue handle the eventual action is addressed to, when we have one. */
  readonly positionId: number | undefined;
  readonly promptedAtMs: number;
}

export interface PendingAmountStoreOptions {
  /**
   * How long the prompt stays open.
   *
   * Defaults to {@link ACTION_TTL_MS}, THE SAME FIFTEEN MINUTES AS AN ACTION
   * TOKEN, and shares the constant rather than repeating the number. The reason
   * is identical: an amount typed against a mark from twenty minutes ago is a
   * wrong number, and a prompt that outlived the mark it was opened against
   * would invite exactly that. Expiring sends the user back to `/positions`,
   * where both the numbers and the prompt are current.
   */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * The open prompts, at most one per Telegram user.
 *
 * ONE PER USER ON PURPOSE. A second tap on "Custom amount" — for the same
 * position or a different one — REPLACES the first rather than queueing beside
 * it, because the reply that follows can only be meant for the most recent
 * question. Two live prompts and one number is an ambiguity with no safe
 * resolution.
 */
export class PendingAmountStore {
  readonly #entries = new Map<number, PendingAmount>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: PendingAmountStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? ACTION_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  put(entry: Omit<PendingAmount, 'promptedAtMs'>): PendingAmount {
    this.#sweep();
    const pending: PendingAmount = { ...entry, promptedAtMs: this.#now() };
    this.#entries.set(entry.telegramUserId, pending);
    return pending;
  }

  /** The open prompt for this user, or undefined if there is none or it expired. */
  get(telegramUserId: number): PendingAmount | undefined {
    this.#sweep();
    return this.#entries.get(telegramUserId);
  }

  delete(telegramUserId: number): void {
    this.#entries.delete(telegramUserId);
  }

  #sweep(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [key, entry] of this.#entries) {
      if (entry.promptedAtMs <= cutoff) this.#entries.delete(key);
    }
  }
}

// ── formatting ─────────────────────────────────────────────────────────────

/**
 * An exact AUSD amount, grouped, with no trailing zeros.
 *
 *   562000000 micros -> "562"        1000500000 -> "1,000.5"      1 -> "0.000001"
 *
 * INTEGER ONLY, like everything else that touches money here: the digits are
 * sliced out of the bigint rather than going through a float, so a large amount
 * cannot come back rounded.
 *
 * Trailing zeros are dropped so the figure reads as the user typed it — "1,000.5"
 * rather than "1,000.500000" — while never showing a precision the amount does
 * not have. It is the exact value either way; only the zeros go.
 */
export function formatCustomAusd(amountCNS: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new RangeError(`decimals must be an integer in 0..30, got ${decimals}`);
  }
  const negative = amountCNS < 0n;
  const digits = (negative ? -amountCNS : amountCNS).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac === '' ? '' : `.${frac}`}`;
}

/** The smallest amount the collateral can represent, as a figure to quote. */
export function smallestIncrement(market: MarketRiskConfig): string {
  return formatCustomAusd(1n, market.collateralDecimals);
}

// ── parsing ────────────────────────────────────────────────────────────────

/**
 * Digits, optionally one decimal point, optionally a leading `+`.
 *
 * NO SCIENTIFIC NOTATION and no currency marks. "1e3" is a number to a
 * programmer and a typo to everyone else, and the cost of guessing wrong is a
 * thousand-fold margin transfer.
 */
const AMOUNT_PATTERN = /^\+?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Micro-digit ceiling, so an amount always fits a Telegram button.
 *
 * `encodeCallback` throws above 64 bytes rather than truncating — correctly, since
 * a truncated payload would decode to a different amount — so an absurd figure has
 * to be turned away HERE, with a sentence, instead of blowing up the handler. 24
 * digits of micros is 10^18 AUSD, comfortably past any real balance and
 * comfortably inside the payload budget.
 */
const MAX_AMOUNT_DIGITS = 24;

export type AmountParseFailure =
  /** Not a number at all. Also what a stray message during a prompt lands on. */
  | 'not-a-number'
  /** A number, but zero or negative. */
  | 'not-positive'
  /** Positive, but below one increment of the collateral. */
  | 'below-increment'
  /** At least one increment, but carrying digits the collateral cannot hold. */
  | 'finer-than-increment'
  /** So large it will not fit in a button. */
  | 'too-large';

export type AmountParse =
  | { readonly ok: true; readonly amountCNS: bigint }
  | { readonly ok: false; readonly code: AmountParseFailure };

/**
 * A typed amount -> AUSD micros, exactly, or a reason it is not one.
 *
 * Commas are stripped before parsing because PerpGuard ITSELF prints grouped
 * figures — "Add 2,662 → buffer 9.0%" — so the most likely custom amount in the
 * world is one copied off our own message. Refusing our own output would be a
 * small, stupid cruelty.
 */
export function parseAusdAmount(input: string, decimals: number): AmountParse {
  const cleaned = input.trim().replace(/,/g, '').replace(/\s+/g, '');
  if (!AMOUNT_PATTERN.test(cleaned)) {
    // "-50" IS a number, and telling someone it is not one answers a question
    // they did not ask. Named for what it is instead.
    const negative = cleaned.startsWith('-') && AMOUNT_PATTERN.test(cleaned.slice(1));
    return { ok: false, code: negative ? 'not-positive' : 'not-a-number' };
  }

  const [wholeRaw = '', fracRaw = ''] = cleaned.replace(/^\+/, '').split('.');
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  // Trailing zeros carry no value, so "0.0000010" is one micro exactly rather
  // than a figure finer than the collateral can hold.
  const frac = fracRaw.replace(/0+$/, '');
  const padded = frac.padEnd(decimals, '0').slice(0, decimals);
  const amountCNS = BigInt(`${whole}${padded}`);

  if (frac.length > decimals) {
    return { ok: false, code: amountCNS === 0n ? 'below-increment' : 'finer-than-increment' };
  }
  if (amountCNS === 0n) return { ok: false, code: 'not-positive' };
  if (amountCNS.toString().length > MAX_AMOUNT_DIGITS) return { ok: false, code: 'too-large' };
  return { ok: true, amountCNS };
}

// ── validation ─────────────────────────────────────────────────────────────

/** Echoed back to the user, bounded so a pasted essay does not become a message. */
function echo(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, ' ');
  return trimmed.length > 40 ? `${trimmed.slice(0, 37)}...` : trimmed;
}

export interface AmountContext {
  readonly market: MarketRiskConfig;
  readonly freeBalance: FreeBalanceReading;
  /** Position value at the mark, for the implausibility check. */
  readonly notionalCNS: bigint;
}

export type AmountVerdict =
  /** Refused. `message` says what is expected, and how to get out. */
  | { readonly ok: false; readonly message: string }
  /**
   * Accepted. `warnings` are things the user should read before confirming and
   * are NOT refusals — they go onto the confirmation screen and the Confirm
   * button is still there.
   */
  | { readonly ok: true; readonly amountCNS: bigint; readonly warnings: readonly string[] };

/** How far past the position's own size an amount has to be to look like a typo. */
export const IMPLAUSIBLE_NOTIONAL_MULTIPLE = 10n;

/**
 * Judge a typed amount.
 *
 * Each refusal has its own sentence, and every sentence says what to do next —
 * a validation message that only says "no" leaves the user holding a prompt they
 * cannot satisfy and cannot escape.
 *
 * NOTHING HERE REFUSES ON THE BALANCE. The floor we hold can understate the real
 * balance, and blocking a legitimate rescue because our own figure was
 * conservative is a worse failure than letting a genuinely short request be
 * rejected by the venue, which knows the true number. Same for an implausibly
 * large amount: it is asked about, not turned away.
 */
export function validateCustomAmount(input: string, context: AmountContext): AmountVerdict {
  const { market, freeBalance, notionalCNS } = context;
  const increment = smallestIncrement(market);
  const parsed = parseAusdAmount(input, market.collateralDecimals);

  if (!parsed.ok) {
    switch (parsed.code) {
      case 'not-a-number':
        return {
          ok: false,
          message:
            `I need a number of AUSD, and “${echo(input)}” is not one. Reply with an amount — ` +
            `250, or 250.5 — and I will show you what it buys. Tap Back on the position to drop this.`,
        };
      case 'not-positive':
        return {
          ok: false,
          message:
            'An amount has to be more than zero: adding nothing buys nothing. Reply with how ' +
            'much AUSD to add, or tap Back on the position to drop it.',
        };
      case 'below-increment':
        return {
          ok: false,
          message:
            `That is smaller than the smallest amount ${market.symbol} collateral can take. ` +
            `The increment is ${increment} AUSD, so reply with at least that, or tap Back on the position to drop it.`,
        };
      case 'finer-than-increment':
        return {
          ok: false,
          message:
            `Collateral is AUSD to ${market.collateralDecimals} decimal places, so the smallest ` +
            `increment is ${increment} AUSD and “${echo(input)}” is finer than that. I will not ` +
            `round it for you — the amount you confirm has to be the amount you typed. Reply ` +
            `with a figure to ${market.collateralDecimals} places, or tap Back on the position to drop it.`,
        };
      case 'too-large':
        return {
          ok: false,
          message:
            `That is a larger number than I can put in a button, and larger than any real ` +
            `balance. Reply with an amount you actually hold, or tap Back on the position to drop it.`,
        };
    }
  }

  const amountCNS = parsed.amountCNS;
  const warnings: string[] = [];

  // THE FLOOR, SAID AS A FLOOR. "At least", never "you have": the venue reports a
  // balance and a locked balance and does not document whether one is inside the
  // other, so this figure is the most that can be asserted, not the amount.
  if (freeBalance.known) {
    if (amountCNS > freeBalance.floorCNS) {
      warnings.push(
        `This may be more than your free balance — I can see at least ` +
          `${formatCustomAusd(freeBalance.floorCNS, market.collateralDecimals)} AUSD available. ` +
          `That is a floor rather than your balance, so I will not stop you: if it is genuinely ` +
          `short the venue rejects it and I will tell you what happened.`,
      );
    }
  } else {
    warnings.push(`I could not check your free balance: ${freeBalance.reason}`);
  }

  if (notionalCNS > 0n && amountCNS > IMPLAUSIBLE_NOTIONAL_MULTIPLE * notionalCNS) {
    warnings.push(
      `That is more than ${IMPLAUSIBLE_NOTIONAL_MULTIPLE}x this position's whole size at the ` +
        `mark (${formatCustomAusd(notionalCNS, market.collateralDecimals)} AUSD). Confirm only ` +
        `if you meant it.`,
    );
  }

  return { ok: true, amountCNS, warnings };
}

// ── the prompt ─────────────────────────────────────────────────────────────

export interface AmountPromptContext {
  readonly symbol: string;
  /** Named so the prompt says WHICH position. Omitted only when unknown. */
  readonly side: Side | undefined;
  readonly market: MarketRiskConfig;
  readonly freeBalance: FreeBalanceReading;
  /** Signed. Rendered in words, never as a negative percentage. */
  readonly bufferPct: number | undefined;
  readonly liquidationPricePNS: bigint | undefined;
  readonly markPricePNS: bigint;
  readonly notionalCNS: bigint;
  readonly bufferDecimals: number;
}

/** `BTC long`, or just `BTC` when we genuinely do not know the side. */
export function nameOf(symbol: string, side: Side | undefined): string {
  return side === undefined ? symbol : `${symbol} ${side}`;
}

/**
 * What the bot asks for.
 *
 * It restates where the position stands FIRST. The user is about to choose a
 * number, and choosing it against the buffer and liquidation price in front of
 * them is the difference between a custom amount and a guess.
 */
export function renderAmountPrompt(context: AmountPromptContext): string {
  const { market, bufferDecimals } = context;
  const lines = [
    `Custom amount — add margin to ${nameOf(context.symbol, context.side)}`,
    `Now: ${describeBuffer(context.bufferPct, bufferDecimals)}` +
      (context.liquidationPricePNS === undefined
        ? ''
        : `, liquidation ${formatPricePNS(context.liquidationPricePNS, market)}`) +
      `, mark ${formatPricePNS(context.markPricePNS, market)}.`,
    `Position size at the mark: ${formatCustomAusd(context.notionalCNS, market.collateralDecimals)} AUSD.`,
    context.freeBalance.known
      ? `At least ${formatCustomAusd(context.freeBalance.floorCNS, market.collateralDecimals)} AUSD free — ` +
        `a floor, not your balance.`
      : `I could not check your free balance: ${context.freeBalance.reason}`,
    `Reply with an amount in AUSD and I will show you the buffer and liquidation price it buys.`,
    `Smallest increment ${smallestIncrement(market)} AUSD. Tap Back on the position to drop this.`,
    'Nothing has been sent, and nothing will be until you confirm.',
  ];
  return lines.join('\n');
}

// ── the action ─────────────────────────────────────────────────────────────

/**
 * The action a validated custom amount becomes.
 *
 * Its `label` is built by {@link topUpLine}, the SAME formatter the two computed
 * options go through, so the confirmation screen that follows is the computed
 * screen with a different number in it. That is the point of the feature: the
 * user picks the amount and still gets it priced.
 *
 * NOTHING IS CEILED. The computed options round up because PerpGuard chose their
 * amounts and had to round them for display; here the figure came from the user
 * and is already exact, so the label and `amountCNS` are the same value rather
 * than one being a rounded rendering of the other.
 */
export function customAction(
  projection: MarginProjection,
  market: MarketRiskConfig,
  positionId: number | undefined,
  bufferDecimals: number,
  fromBufferPct?: number,
): AlertAction {
  return {
    type: 'add-margin',
    intent: 'custom',
    marketId: projection.marketId,
    symbol: projection.symbol,
    positionId,
    amountCNS: projection.amountCNS,
    ...(projection.resultingLiquidationPricePNS === undefined ? {} : { resultingLiquidationPricePNS: projection.resultingLiquidationPricePNS }),
    ...(projection.resultingBufferPct === undefined ? {} : { resultingBufferPct: projection.resultingBufferPct }),
    ...(fromBufferPct === undefined ? {} : { fromBufferPct }),
    label: topUpLine(
      formatCustomAusd(projection.amountCNS, market.collateralDecimals),
      projection.resultingBufferPct,
      projection.resultingLiquidationPricePNS,
      market,
      bufferDecimals,
    ),
  };
}

/** What `/cancel` says when there was a prompt open, and when there was not. */
export const CANCELLED_TEXT =
  'Dropped. Nothing was sent. My positions has current numbers.';
export const NOTHING_TO_CANCEL_TEXT = 'Nothing was pending, so there was nothing to drop.';
