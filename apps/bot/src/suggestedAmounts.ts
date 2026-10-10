/**
 * THE TOP-UPS AN ALERT AND VIEW POSITION SUGGEST (owner, 10 Oct 2026). Pure.
 *
 * A top-up moves the distance by amount ÷ the position's notional, so a fixed
 * +100 bought 0.1 points on a 93,754 AUSD position and read "2.4% → 2.4%".
 * Every suggestion is therefore sized to a DISTANCE, and since 10 Oct 2026
 * NOTHING IS SUGGESTED THAT CANNOT BE PAID FOR:
 *
 *   - SPENDABLE is the free balance floor minus what is reserved: a Rescue
 *     top-up in flight, and the largest "minimum remaining" among the
 *     account's armed Rescue rules. With nothing armed it is the free balance.
 *   - THE FIRST aims at the account's alert distance D plus 2 points (a
 *     position already at or past D + 2 aims at its own distance plus 2): the
 *     smallest whole AUSD the ENGINE says reaches it (`project`, the same
 *     projection the confirmation shows), rounded UP to two significant
 *     figures, and never more than 90% of what is spendable, rounded down to a
 *     whole AUSD, so something is left for fees and the next alert.
 *   - THE SECOND is HALF THE FIRST, to the collateral's precision, and is
 *     offered only if it moves the distance by at least 0.3 points; a smaller
 *     step is not worth a button.
 *   - If even the first buys under half a point, there are no top-ups:
 *     `note` says so in words. (The alert still offers Custom amount and
 *     View / close position.)
 *   - With the free balance unknown, the first is its target and nothing can
 *     be said about what it leaves.
 *
 * A typed Custom amount is NOT capped here: our free figure is a floor, so the
 * trader may go above it, and the confirmation warns first.
 */

/** Points above the base distance the first top-up aims at, as a fraction: +2 points. */
export const TARGET_STEP = 0.02;
/** The share of what is spendable the first top-up may use. */
export const SPEND_SHARE = 0.9;
/** A first top-up that buys less than this (half a point) is said in words, not offered. */
export const MIN_USEFUL_GAIN = 0.005;
/** The second top-up is offered only if it buys at least this (0.3 points). */
export const MIN_SECOND_GAIN = 0.003;
/** Float noise in a projected distance, ignored when judging whether a target is reached. */
const EPSILON = 1e-9;

export interface SuggestInput {
  /** The position's signed distance from liquidation now, as a fraction. */
  readonly currentBuffer: number;
  /** The account's alert distance, as a fraction (5% is 0.05). */
  readonly alertFraction: number;
  /** The free balance floor, in collateral units; undefined when it cannot be read. */
  readonly freeFloorCNS: bigint | undefined;
  /** What is held back from it: Rescue in flight, plus the largest armed "minimum remaining". */
  readonly reservedCNS?: bigint;
  /** One whole AUSD in collateral units (10 ** decimals). */
  readonly unitCNS: bigint;
  /** The engine's distance after adding `amountCNS`, or undefined when it cannot price it. */
  readonly project: (amountCNS: bigint) => number | undefined;
}

export interface SuggestedAmount {
  readonly amountCNS: bigint;
  /** The engine's distance after adding it. */
  readonly resultingBuffer: number;
  /** The free balance floor less this amount. Undefined when the free balance is unknown. */
  readonly freeAfterCNS: bigint | undefined;
}

export interface Suggestions {
  /** At most two, the larger first. Never more than can be spent. */
  readonly amounts: readonly SuggestedAmount[];
  /** Set when what can be spent buys almost nothing: the sentence shown instead of top-ups. */
  readonly note?: { readonly spendableCNS: bigint; readonly gain: number };
}

/** What can be spent: the free floor less what is reserved, never below zero. Undefined when the free balance is unknown. */
export function spendableCNS(freeFloorCNS: bigint | undefined, reservedCNS: bigint | undefined): bigint | undefined {
  if (freeFloorCNS === undefined) return undefined;
  const left = freeFloorCNS - (reservedCNS ?? 0n);
  return left > 0n ? left : 0n;
}

/** Rounded UP to two significant figures, whole AUSD: 1,996 -> 2,000; 4,809 -> 4,900; 39 -> 39. */
export function ceilTwoFigures(ausd: number): number {
  if (ausd <= 0) return 0;
  const whole = Math.ceil(ausd - EPSILON);
  const digits = Math.floor(Math.log10(whole)) + 1;
  const step = 10 ** Math.max(0, digits - 2);
  return Math.ceil(whole / step) * step;
}

/** The smallest whole AUSD whose projected distance reaches `target`; undefined if it cannot be priced or reached. */
function wholeAusdToReach(input: SuggestInput, target: number): number | undefined {
  const at = (ausd: number): number | undefined => input.project(BigInt(ausd) * input.unitCNS);
  let hi = 1;
  for (;;) {
    const b = at(hi);
    if (b === undefined) return undefined;
    if (b >= target - EPSILON) break;
    if (hi > 1e12) return undefined;
    hi *= 2;
  }
  let lo = 0; // at(lo) is short of target, at(hi) reaches it
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const b = at(mid);
    if (b === undefined) return undefined;
    if (b >= target - EPSILON) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function suggestAmounts(input: SuggestInput): Suggestions {
  const base = input.currentBuffer >= input.alertFraction + TARGET_STEP ? input.currentBuffer : input.alertFraction;
  const need = wholeAusdToReach(input, base + TARGET_STEP);
  if (need === undefined) return { amounts: [] };
  const target = BigInt(ceilTwoFigures(need)) * input.unitCNS;

  const spendable = spendableCNS(input.freeFloorCNS, input.reservedCNS);
  const priced = (amountCNS: bigint): SuggestedAmount | undefined => {
    const after = input.project(amountCNS);
    return after === undefined ? undefined : { amountCNS, resultingBuffer: after, freeAfterCNS: input.freeFloorCNS === undefined ? undefined : input.freeFloorCNS - amountCNS };
  };

  // THE FIRST: its target, or 90% of what can be spent (a whole AUSD, rounded down) when that is less.
  let firstCNS = target;
  if (spendable !== undefined) {
    const cap = ((spendable * BigInt(Math.round(SPEND_SHARE * 100))) / 100n / input.unitCNS) * input.unitCNS;
    if (cap < firstCNS) firstCNS = cap;
  }
  const first = firstCNS > 0n ? priced(firstCNS) : undefined;
  if (first === undefined || first.resultingBuffer - input.currentBuffer < MIN_USEFUL_GAIN) {
    // Nothing worth a button. Said in words only when it is the balance that is short.
    return spendable === undefined ? { amounts: [] } : { amounts: [], note: { spendableCNS: spendable, gain: first === undefined ? 0 : Math.max(0, first.resultingBuffer - input.currentBuffer) } };
  }

  // THE SECOND: half the first, only if it still moves the distance by 0.3 points.
  const second = priced(firstCNS / 2n);
  const amounts = second !== undefined && second.amountCNS > 0n && second.resultingBuffer - input.currentBuffer >= MIN_SECOND_GAIN - EPSILON ? [first, second] : [first];
  return { amounts };
}
