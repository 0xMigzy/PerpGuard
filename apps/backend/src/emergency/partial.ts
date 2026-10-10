/**
 * 🚪 CLOSE PART OF A POSITION (owner, 10 Oct 2026), the parts that size,
 * estimate and judge. Pure: no I/O, so every rule is a unit test.
 *
 *   - A PERCENTAGE BECOMES WHOLE SIZE UNITS, ROUNDED DOWN. Perpl's minimum
 *     order is one size unit of the market (docs: exchange/minimum-orders;
 *     the minimum order VALUE is 0 on both networks today). An option that
 *     rounds to nothing is not offered; one that would take the whole position
 *     is a full close, which has its own confirmation.
 *   - THE ESTIMATES ARE ESTIMATES: the share of the unrealised P&L the closed
 *     part carries, and the market's taker fee on the value closed, both at
 *     the mark. The fill decides the real figures.
 *   - THE OUTCOME IS READ FROM THE POSITION BEFORE AND AFTER, never from the
 *     receipt alone: smaller by what was asked, smaller by something else,
 *     unchanged, gone, or not seen. A list that is not fully loaded proves
 *     nothing.
 *   - A PARTIAL CLOSE DOES NOT MOVE THE LIQUIDATION PRICE: Perpl releases
 *     margin in proportion (measured: 3 units to 2, `c` 166576 -> 111051), so
 *     nothing here speaks of liquidation distance.
 */
import { notionalCNS, type MarketScale } from '@perpguard/shared';

export type PartialSize =
  | { readonly ok: true; readonly closeLNS: bigint; readonly remainLNS: bigint }
  /** `too-small`: rounds below one size unit. `whole`: it is the whole position, which is a full close. */
  | { readonly ok: false; readonly why: 'too-small' | 'whole' | 'bad-percent' };

/** `pct` of `sizeLNS`, in whole size units, rounded DOWN. `pct` may carry decimals (12.5). */
export function partialLots(sizeLNS: bigint, pct: number): PartialSize {
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { ok: false, why: 'bad-percent' };
  if (pct === 100) return { ok: false, why: 'whole' };
  // Exact to a thousandth of a percent, without a float touching the size.
  const scaled = BigInt(Math.round(pct * 1000));
  const closeLNS = (sizeLNS * scaled) / 100_000n;
  if (closeLNS < 1n) return { ok: false, why: 'too-small' };
  const remainLNS = sizeLNS - closeLNS;
  if (remainLNS < 1n) return { ok: false, why: 'whole' };
  return { ok: true, closeLNS, remainLNS };
}

export interface PartialEstimate {
  /** The closed part's share of the unrealised P&L at the mark. Undefined when the position cannot be priced. */
  readonly realisedCNS: bigint | undefined;
  /** The taker fee on the value closed at the mark, rounded UP. Undefined without a mark or a fee rate. */
  readonly feeCNS: bigint | undefined;
}

export function estimatePartial(input: {
  readonly sizeLNS: bigint;
  readonly closeLNS: bigint;
  readonly unrealisedPnlCNS: bigint | undefined;
  readonly markPricePNS: bigint | undefined;
  readonly scale: MarketScale | undefined;
  /** Parts per million of notional, as the market context states it. */
  readonly takerFeeMicros: number | undefined;
}): PartialEstimate {
  const realisedCNS = input.unrealisedPnlCNS === undefined || input.sizeLNS <= 0n ? undefined : (input.unrealisedPnlCNS * input.closeLNS) / input.sizeLNS;
  let feeCNS: bigint | undefined;
  if (input.markPricePNS !== undefined && input.markPricePNS > 0n && input.scale !== undefined && input.takerFeeMicros !== undefined) {
    const value = notionalCNS(input.markPricePNS, input.closeLNS, input.scale);
    feeCNS = (value * BigInt(input.takerFeeMicros) + 999_999n) / 1_000_000n;
  }
  return { realisedCNS, feeCNS };
}

/** What the exchange's own row said about the reduce: where it filled, how much, and the fee. */
export interface DecreaseFill {
  readonly exitPricePNS: bigint;
  readonly closedLNS: bigint;
  readonly feeCNS: bigint | undefined;
}

/** (exit − entry) × size closed, signed for the side. BEFORE the fee. */
export function realisedFromFill(input: { readonly side: 'long' | 'short'; readonly entryPricePNS: bigint; readonly fill: DecreaseFill; readonly scale: MarketScale }): bigint {
  const delta = input.fill.exitPricePNS - input.entryPricePNS;
  const moved = notionalCNS(delta, input.fill.closedLNS, input.scale);
  return input.side === 'long' ? moved : -moved;
}

export type PartialResult =
  /** The position is smaller. `asAsked` is false when it shrank by a different amount than requested. */
  | { readonly kind: 'reduced'; readonly beforeLNS: bigint; readonly afterLNS: bigint; readonly closedLNS: bigint; readonly asAsked: boolean }
  /** Same size as before: nothing landed that the position shows. */
  | { readonly kind: 'unchanged'; readonly beforeLNS: bigint; readonly why: string }
  /** A fully loaded list no longer has it: it closed entirely (this order, or something else such as a liquidation). */
  | { readonly kind: 'gone'; readonly beforeLNS: bigint }
  /** The list is not loaded, so nothing can be said. */
  | { readonly kind: 'not-seen'; readonly beforeLNS: bigint; readonly why: string };

/**
 * `after`: the position's size in a FULLY LOADED list, `null` when that list has no such position,
 * `undefined` when the list is not loaded. `receipt` only words the "unchanged" case.
 */
export function judgePartial(input: { readonly beforeLNS: bigint; readonly requestedLNS: bigint; readonly after: bigint | null | undefined; readonly receipt: string | undefined }): PartialResult {
  const { beforeLNS, requestedLNS, after } = input;
  if (after === undefined) return { kind: 'not-seen', beforeLNS, why: 'your position list is not loaded right now, so I cannot see what became of it' };
  if (after === null) return { kind: 'gone', beforeLNS };
  if (after < beforeLNS) return { kind: 'reduced', beforeLNS, afterLNS: after, closedLNS: beforeLNS - after, asAsked: beforeLNS - after === requestedLNS };
  return {
    kind: 'unchanged',
    beforeLNS,
    why: input.receipt === undefined ? 'the order did not go out' : `the exchange answered "${input.receipt}" and the position is the same size`,
  };
}
