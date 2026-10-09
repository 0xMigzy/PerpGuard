/**
 * THE AMOUNTS AN ALERT AND VIEW POSITION SUGGEST (owner, 9 Oct 2026). Pure.
 *
 * Until then both offered fixed amounts (+100/+250, +100/+250/+500). A top-up
 * moves the distance by amount ÷ the position's notional, so on a 93,754 AUSD
 * position +100 bought 0.1 points and its button read "2.4% → 2.4%": a button
 * that looked broken. Now each amount is sized to a DISTANCE:
 *
 *   - Targets are the account's alert distance D plus 2 and plus 5 points.
 *     A position already at or past D + 2 (View position, far from the line)
 *     aims at its own distance plus 2 and plus 5 instead, so nothing offers +0.
 *   - Each amount is the smallest whole AUSD the ENGINE says reaches its
 *     target (`project`, the same projection the confirmation shows), rounded
 *     UP to two significant figures. Its label is the engine's distance for the
 *     rounded amount, so it never reads below the target.
 *   - The FIRST is always affordable: when the D + 2 amount is more than the
 *     free balance allows, it becomes MOST of the free balance, 90% of it
 *     rounded down to a whole AUSD, so something is left for fees and the next
 *     alert, and its label says what that amount actually buys. If even that
 *     buys under half a point, there is no button: `note` says so in words.
 *   - The SECOND keeps the D + 5 target and is marked ⚠️ when it is more than
 *     the free balance. Offered, not hidden: the balance read is a floor.
 *   - With the free balance unknown, both targets are offered and nothing is
 *     marked, because nothing can be judged.
 */

/** Points above the base distance, as fractions: +2 and +5 points. */
export const TARGET_STEPS = [0.02, 0.05] as const;
/** The share of the free balance the first amount may use. */
export const FREE_SHARE = 0.9;
/** Float noise in a projected distance, ignored when judging whether a target is reached. */
const EPSILON = 1e-9;
/** A capped amount that buys less than this (half a point) is said in words, not offered. */
export const MIN_USEFUL_GAIN = 0.005;

export interface SuggestInput {
  /** The position's signed distance from liquidation now, as a fraction. */
  readonly currentBuffer: number;
  /** The account's alert distance, as a fraction (5% is 0.05). */
  readonly alertFraction: number;
  /** The free balance floor, in collateral units; undefined when it cannot be read. */
  readonly freeFloorCNS: bigint | undefined;
  /** One whole AUSD in collateral units (10 ** decimals). */
  readonly unitCNS: bigint;
  /** The engine's distance after adding `amountCNS`, or undefined when it cannot price it. */
  readonly project: (amountCNS: bigint) => number | undefined;
}

export interface SuggestedAmount {
  /** Whole AUSD. */
  readonly ausd: number;
  /** The engine's distance after adding it. */
  readonly resultingBuffer: number;
  /** More than the free balance floor. */
  readonly overFree: boolean;
  /** Capped at most of the free balance rather than sized to its target. */
  readonly mostOfFree: boolean;
}

export interface Suggestions {
  readonly amounts: readonly SuggestedAmount[];
  /** Set when the free balance buys almost nothing: the sentence to show instead of a first button. */
  readonly note?: { readonly freeAusd: number; readonly gain: number };
}

/** Rounded UP to two significant figures, whole AUSD: 1,996 -> 2,000; 4,809 -> 4,900; 39 -> 39. */
export function ceilTwoFigures(ausd: number): number {
  if (ausd <= 0) return 0;
  const whole = Math.ceil(ausd - 1e-9);
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
  const [near, far] = TARGET_STEPS;
  const base = input.currentBuffer >= input.alertFraction + near ? input.currentBuffer : input.alertFraction;
  const priced = (ausd: number): number | undefined => input.project(BigInt(ausd) * input.unitCNS);

  const needA = wholeAusdToReach(input, base + near);
  const needB = wholeAusdToReach(input, base + far);
  if (needA === undefined || needB === undefined) return { amounts: [] };
  const targetA = ceilTwoFigures(needA);
  const targetB = ceilTwoFigures(needB);

  const free = input.freeFloorCNS === undefined ? undefined : Number(input.freeFloorCNS / input.unitCNS);
  const amounts: SuggestedAmount[] = [];
  let note: Suggestions['note'];

  if (free !== undefined && targetA > Math.floor(free * FREE_SHARE)) {
    const capped = Math.floor(free * FREE_SHARE);
    const after = capped > 0 ? priced(capped) : undefined;
    if (after === undefined || after - input.currentBuffer < MIN_USEFUL_GAIN) {
      note = { freeAusd: free, gain: after === undefined ? 0 : Math.max(0, after - input.currentBuffer) };
    } else {
      amounts.push({ ausd: capped, resultingBuffer: after, overFree: false, mostOfFree: true });
    }
  } else {
    const after = priced(targetA);
    if (after !== undefined) amounts.push({ ausd: targetA, resultingBuffer: after, overFree: free !== undefined && targetA > free, mostOfFree: false });
  }

  const first = amounts[0]?.ausd ?? 0;
  if (targetB > first) {
    const after = priced(targetB);
    if (after !== undefined) amounts.push({ ausd: targetB, resultingBuffer: after, overFree: free !== undefined && targetB > free, mostOfFree: false });
  }
  return note === undefined ? { amounts } : { amounts, note };
}
