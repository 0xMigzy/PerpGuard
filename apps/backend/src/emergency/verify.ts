/**
 * 🚪 CLOSE EVERYTHING, the parts that judge. Pure: no I/O, so every rule the
 * owner set (7 Oct 2026) is a unit test.
 *
 *   - THE OUTCOME IS READ FROM THE POSITION LIST AFTERWARDS, NEVER FROM A
 *     RECEIPT. The `sr 32` lesson: the receipt can lie, the position cannot.
 *   - Per position: CLOSED (with what it filled at, when the closing row said),
 *     PARTLY CLOSED (with what remains), STILL OPEN (with why), or NOT SEEN.
 *   - A POSITION THE BOT CANNOT SEE IS NAMED AS NOT SEEN, NEVER AS CLOSED. A
 *     list that is not fully loaded proves nothing about anything in it.
 *   - `complete` is true only when every position is evidenced closed. Calling
 *     a run done with something still open is the one message that would
 *     destroy trust.
 */
import type { ActionOutcome } from '../actions/types.ts';

/** One open position, as the fully loaded list showed it. Sizes are exact lots. */
export interface OpenPosition {
  readonly marketId: number;
  readonly symbol: string;
  readonly positionId: number;
  readonly side: 'long' | 'short';
  readonly sizeLNS: bigint;
  /** Lot decimals of the market, for saying the size in base units. */
  readonly lotDecimals: number;
  /** At the mark, from the risk loop. Undefined when the position cannot be priced right now. */
  readonly unrealisedPnlCNS: bigint | undefined;
}

export interface Preview {
  readonly positions: readonly OpenPosition[];
  /** The sum over positions whose P&L is known. */
  readonly totalPnlCNS: bigint;
  /** Positions whose P&L could not be priced, so the total leaves them out. */
  readonly unpriced: readonly string[];
}

export function buildPreview(positions: readonly OpenPosition[]): Preview {
  let total = 0n;
  const unpriced: string[] = [];
  for (const p of positions) {
    if (p.unrealisedPnlCNS === undefined) unpriced.push(p.symbol);
    else total += p.unrealisedPnlCNS;
  }
  return { positions, totalPnlCNS: total, unpriced };
}

export type PositionResult =
  | { readonly kind: 'closed'; readonly position: OpenPosition; readonly exitPrice: number | undefined }
  | { readonly kind: 'partial'; readonly position: OpenPosition; readonly closedLNS: bigint; readonly remainingLNS: bigint; readonly why: string }
  | { readonly kind: 'still-open'; readonly position: OpenPosition; readonly why: string }
  | { readonly kind: 'not-seen'; readonly position: OpenPosition; readonly why: string };

export interface Verified {
  readonly results: readonly PositionResult[];
  readonly complete: boolean;
}

/**
 * Judges each requested position by the list AFTER the closes.
 *
 * `after` undefined: the list is not fully loaded now, so every position is
 * NOT SEEN, whatever any receipt said. `outcomes` is consulted only to say WHY
 * a position is still open; it never decides that something closed.
 */
export function verifyCloses(
  requested: readonly OpenPosition[],
  after: readonly OpenPosition[] | undefined,
  outcomes: ReadonlyMap<number, ActionOutcome | undefined>,
  exitPrice: (p: OpenPosition) => number | undefined,
): Verified {
  const results: PositionResult[] = requested.map((p): PositionResult => {
    if (after === undefined) {
      return { kind: 'not-seen', position: p, why: 'I cannot see your positions right now, so I cannot say whether it closed. Check it on Perpl.' };
    }
    const now = after.find((x) => x.positionId === p.positionId);
    if (now === undefined) return { kind: 'closed', position: p, exitPrice: exitPrice(p) };
    const why = whyStillOpen(outcomes.get(p.positionId));
    if (now.sizeLNS < p.sizeLNS) return { kind: 'partial', position: p, closedLNS: p.sizeLNS - now.sizeLNS, remainingLNS: now.sizeLNS, why };
    return { kind: 'still-open', position: p, why };
  });
  return { results, complete: results.every((r) => r.kind === 'closed') };
}

/** Why a close did not (fully) happen, from what the attempt reported. Words only; never a verdict. */
export function whyStillOpen(outcome: ActionOutcome | undefined): string {
  if (outcome === undefined) return 'no close was sent for it';
  switch (outcome.kind) {
    case 'refused':
      return `the close was not sent: ${outcome.detail}`;
    case 'not-applied':
      return 'the close was sent, but the exchange did not fill it (not enough on the other side, or it expired)';
    case 'unknown':
      return 'the close was sent and I could not confirm what happened to it';
    case 'applied':
      return 'the close reported a fill, but the position is still there';
  }
}
