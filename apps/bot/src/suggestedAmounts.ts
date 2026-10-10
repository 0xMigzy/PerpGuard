/**
 * THE TOP-UPS AN ALERT AND VIEW POSITION SUGGEST (owner, 10 Oct 2026). Pure.
 *
 * A top-up moves the distance by amount ÷ the position's notional, so a fixed
 * +100 bought 0.1 points on a 93,754 AUSD position and read "2.4% → 2.4%".
 * Every suggestion is therefore sized to a DISTANCE, NOTHING IS SUGGESTED THAT
 * CANNOT BE PAID FOR, and BOTH LAND CLEAR OF THE ALERT LINE:
 *
 *   - THE CLEAR LEVEL is the higher of the alert distance D plus 2 points and
 *     the level at which the alert RE-ARMS (`rearmAt`: D plus a quarter of it,
 *     at least half a point). A top-up that lands between D and the re-arm
 *     level leaves the alert switched off just above the line: the next slide
 *     to liquidation would be silent. At D = 10% that is 12.5%, and until
 *     10 Oct 2026 the buttons aimed at 12% and 10.4%. (A position within two
 *     points of the clear level, or past it, aims at its own distance + 2.)
 *   - THE SMALLER top-up is the smallest whole AUSD the ENGINE says reaches the
 *     clear level (`project`, the same projection the confirmation shows),
 *     rounded UP to two significant figures. THE LARGER is TWICE it, shown
 *     first. So the smaller is half the larger, and both land clear.
 *   - SPENDABLE is the free balance floor minus what is reserved: a Rescue
 *     top-up in flight, and the largest "minimum remaining" among the
 *     account's armed Rescue rules. The larger is never more than 90% of it
 *     (a whole AUSD, rounded down), so something is left for fees and the next
 *     alert; when that cap bites, the smaller stays half of it.
 *   - THE SMALLER IS HIDDEN when it would land short of the clear level (the
 *     cap bit) or buys under 0.3 points. THE LARGER IS STILL OFFERED when the
 *     balance cannot reach the clear level: it is the most that can be added,
 *     and its label says where it lands. If even that buys under half a
 *     point, there are no top-ups: `note` says so in words. (The alert still
 *     offers Custom amount and View / close position.)
 *   - With the free balance unknown, both are at their targets and nothing
 *     can be said about what they leave.
 *
 * A typed Custom amount is NOT capped here: our free figure is a floor, so the
 * trader may go above it, and the confirmation warns first.
 */
import { rearmAt } from '@perpguard/backend/events/warnings';

/** Points above the alert distance the clear level is at least, as a fraction: +2 points. */
export const TARGET_STEP = 0.02;
/** The share of what is spendable the larger top-up may use. */
export const SPEND_SHARE = 0.9;
/** A larger top-up that buys less than this (half a point) is said in words, not offered. */
export const MIN_USEFUL_GAIN = 0.005;
/** The smaller top-up is offered only if it buys at least this (0.3 points). */
export const MIN_SECOND_GAIN = 0.003;
/** Float noise in a projected distance, ignored when judging whether a target is reached. */
const EPSILON = 1e-9;

/**
 * Where a top-up must land to be clear of the alert line `alertFraction`: the higher of the line
 * + 2 points and the alert's own re-arm level. 2.5% -> 4.5%, 5% -> 7%, 10% -> 12.5%, 20% -> 25%.
 */
export function clearLevel(alertFraction: number): number {
  return Math.max(alertFraction + TARGET_STEP, rearmAt(alertFraction * 100) / 100);
}

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
  const clear = clearLevel(input.alertFraction);
  // The clear level, or two points above where it is when that is higher (View position on a position
  // already near or past the clear level): the smaller top-up always buys at least two points.
  const target = Math.max(clear, input.currentBuffer + TARGET_STEP);
  const need = wholeAusdToReach(input, target);
  if (need === undefined) return { amounts: [] };
  const smallerTarget = BigInt(ceilTwoFigures(need)) * input.unitCNS;

  const spendable = spendableCNS(input.freeFloorCNS, input.reservedCNS);
  const priced = (amountCNS: bigint): SuggestedAmount | undefined => {
    const after = input.project(amountCNS);
    return after === undefined ? undefined : { amountCNS, resultingBuffer: after, freeAfterCNS: input.freeFloorCNS === undefined ? undefined : input.freeFloorCNS - amountCNS };
  };

  // THE LARGER: twice the amount that reaches the clear level, or 90% of what can be spent (a whole
  // AUSD, rounded down) when that is less.
  let largerCNS = smallerTarget * 2n;
  if (spendable !== undefined) {
    const cap = ((spendable * BigInt(Math.round(SPEND_SHARE * 100))) / 100n / input.unitCNS) * input.unitCNS;
    if (cap < largerCNS) largerCNS = cap;
  }
  const larger = largerCNS > 0n ? priced(largerCNS) : undefined;
  if (larger === undefined || larger.resultingBuffer - input.currentBuffer < MIN_USEFUL_GAIN) {
    // Nothing worth a button. Said in words only when it is the balance that is short.
    return spendable === undefined ? { amounts: [] } : { amounts: [], note: { spendableCNS: spendable, gain: larger === undefined ? 0 : Math.max(0, larger.resultingBuffer - input.currentBuffer) } };
  }

  // THE SMALLER: half the larger, only if it still lands clear of the line and moves the distance by 0.3 points.
  const smaller = priced(largerCNS / 2n);
  const shown = smaller !== undefined && smaller.amountCNS > 0n && smaller.resultingBuffer >= target - EPSILON && smaller.resultingBuffer - input.currentBuffer >= MIN_SECOND_GAIN - EPSILON;
  return { amounts: shown ? [larger, smaller] : [larger] };
}
