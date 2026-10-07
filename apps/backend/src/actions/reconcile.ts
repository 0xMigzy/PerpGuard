/**
 * What actually happened, decided from the position and nothing else.
 *
 * PURE. Three integers in, a verdict out. No venue status is even a parameter —
 * not because it is uninteresting, but because letting it in would make it
 * possible to weigh it, and the whole finding of the `sr 32` investigation is
 * that for a top-up it carries no information about the outcome at all:
 *
 *   | rq | reported    | margin before -> after | applied | requested |
 *   | 12 | st 7, sr 32 | 0.055822 -> 0.083001   | 27179   | 27179     |
 *   | 15 | st 7, sr 32 | 0.0559   -> 0.083584   | 27684   | 27684     |
 *   | 16 | st 7, sr 32 | 0.083584 -> 0.111268   | 27684   | 27684     |
 *   | 19 | st 7, sr 32 | 0.0557   -> 0.08316    | 27460   | 27460     |
 *
 * Four for four: reported failure, full credit. The request id was the correct
 * `lfr + 1` every time. Rows 15 and 16 are the same top-up sent twice, because
 * the first investigation believed the status and re-sent — which is the bug this
 * file exists to make structurally impossible to repeat.
 *
 * So: the verdict is a function of the delta. A caller that wants to know what
 * the venue claimed reads `ReportedStatus`, which is a different field with a
 * different name for exactly this reason.
 */
import type { Reconciliation, WatchedField } from './types.ts';

/** Render micros or lots for a message without going near a float. */
function plain(value: bigint): string {
  return value.toString();
}

const FIELD_NAME: Readonly<Record<WatchedField, string>> = {
  margin: 'margin',
  size: 'size',
};

/**
 * The position vanished between the send and the look.
 *
 * ALWAYS `unknown`, for either field and whatever was asked. A position that is
 * gone may have been closed by the action, filled out from under it, liquidated
 * or deleveraged, and the four are indistinguishable from its absence. For a
 * close that looks like success and sometimes is — but "the position is gone"
 * and "our close closed it" are different claims, and only one of them is
 * evidenced.
 *
 * The exception is a close that was CONFIRMED by the venue, which the caller
 * resolves separately: see {@link reconcileClose}.
 */
function vanished(field: WatchedField, requested: bigint, before: bigint): Reconciliation {
  return {
    verdict: 'unknown',
    field,
    requested,
    before,
    after: undefined,
    delta: undefined,
    detail:
      `the position is no longer in the set, so its ${FIELD_NAME[field]} cannot be compared ` +
      `against the ${plain(before)} it held before. It may have been closed, filled out, ` +
      `liquidated or deleveraged; none of those can be told apart from its absence. ` +
      `Reconcile against position history before doing anything else, and do not re-send.`,
  };
}

/**
 * Did the top-up land?
 *
 * The rule, in one line: `after - before === requested` is APPLIED, whatever
 * `mt: 24` said.
 *
 * A PARTIAL DELTA IS NEVER ROUNDED INTO APPLIED. Funding settles into a position
 * on each funding event and would move `c` on its own, so a delta that is close
 * but not equal has at least two explanations — a partial credit, or our amount
 * plus an unrelated settlement — and guessing between them would produce a
 * confident figure that is wrong. It reports `unknown` and names both numbers.
 */
export function reconcileAddMargin(params: {
  readonly requestedCNS: bigint;
  readonly beforeCNS: bigint;
  readonly afterCNS: bigint | undefined;
}): Reconciliation {
  const { requestedCNS, beforeCNS, afterCNS } = params;
  if (afterCNS === undefined) return vanished('margin', requestedCNS, beforeCNS);

  const delta = afterCNS - beforeCNS;
  const base = {
    field: 'margin',
    requested: requestedCNS,
    before: beforeCNS,
    after: afterCNS,
    delta,
  } as const;

  if (delta === requestedCNS) {
    return {
      ...base,
      verdict: 'applied',
      detail:
        `margin is now ${plain(afterCNS)} (was ${plain(beforeCNS)}): ${plain(delta)} micros ` +
        `applied, ${plain(requestedCNS)} requested — LANDED`,
    };
  }

  if (delta === 0n) {
    return {
      ...base,
      verdict: 'not-applied',
      detail:
        `margin is unchanged at ${plain(beforeCNS)} and ${plain(requestedCNS)} micros were ` +
        `requested, so the top-up did not land. Nothing was added; the position is exactly ` +
        `as it was.`,
    };
  }

  return {
    ...base,
    verdict: 'unknown',
    detail:
      `margin moved by ${plain(delta)} micros but ${plain(requestedCNS)} were requested ` +
      `(${plain(beforeCNS)} -> ${plain(afterCNS)}). A partial or unrelated change — funding ` +
      `settles into the position too — so this cannot be called applied or not applied. ` +
      `Check the position before acting again, and do not re-send.`,
  };
}

/**
 * Did the reduce take the size off?
 *
 * Size falls toward zero, so the expected delta is NEGATIVE: `before - requested`.
 * A position reduced to nothing may be delivered as size 0 or drop out of the set
 * entirely, and the second is `unknown` here rather than applied — see
 * {@link vanished}.
 */
/**
 * An OPEN: did a position appear on the market? Its size is the evidence.
 *
 * Nothing appeared and the venue said it refused: NOT APPLIED, certain. Nothing
 * appeared and the venue did not say so (a timeout, a throw, a fill report with
 * no position): UNKNOWN, because it may still land, and a copier that called
 * that "not opened" could open it twice.
 */
export function reconcileOpen(params: { readonly requestedLNS: bigint; readonly afterLNS: bigint | undefined; readonly venueRefused: boolean }): Reconciliation {
  const { requestedLNS, afterLNS } = params;
  if (afterLNS !== undefined && afterLNS > 0n) {
    return {
      verdict: 'applied',
      field: 'size',
      requested: requestedLNS,
      before: 0n,
      after: afterLNS,
      delta: afterLNS,
      detail: afterLNS >= requestedLNS ? `a position of ${afterLNS} size units opened` : `a position opened PARTLY: ${afterLNS} of ${requestedLNS} size units`,
    };
  }
  if (params.venueRefused) {
    return { verdict: 'not-applied', field: 'size', requested: requestedLNS, before: 0n, after: undefined, delta: undefined, detail: 'no position appeared, and the venue reported the order did not fill' };
  }
  return {
    verdict: 'unknown',
    field: 'size',
    requested: requestedLNS,
    before: 0n,
    after: undefined,
    delta: undefined,
    detail: 'no position appeared in the wait, and the venue did not say it refused the order: it may still land',
  };
}

export function reconcileReduce(params: {
  readonly requestedLNS: bigint;
  readonly beforeLNS: bigint;
  readonly afterLNS: bigint | undefined;
}): Reconciliation {
  const { requestedLNS, beforeLNS, afterLNS } = params;
  if (afterLNS === undefined) return vanished('size', requestedLNS, beforeLNS);

  const delta = afterLNS - beforeLNS;
  const closed = -delta;
  const base = {
    field: 'size',
    requested: requestedLNS,
    before: beforeLNS,
    after: afterLNS,
    delta,
  } as const;

  if (closed === requestedLNS) {
    return {
      ...base,
      verdict: 'applied',
      detail:
        `size is now ${plain(afterLNS)} (was ${plain(beforeLNS)}): ${plain(closed)} lots ` +
        `closed, ${plain(requestedLNS)} requested — LANDED`,
    };
  }

  if (closed === 0n) {
    return {
      ...base,
      verdict: 'not-applied',
      detail:
        `size is unchanged at ${plain(beforeLNS)} and ${plain(requestedLNS)} lots were ` +
        `requested, so the reduce did not land.`,
    };
  }

  // A PARTIAL FILL IS A REAL OUTCOME HERE, unlike for a top-up: an
  // ImmediateOrCancel close takes what the book offers and cancels the rest. It
  // is still `unknown` as far as "did what we asked happen" goes, and the numbers
  // say exactly how far it got.
  return {
    ...base,
    verdict: 'unknown',
    detail:
      `${plain(closed)} lots closed of ${plain(requestedLNS)} requested ` +
      `(${plain(beforeLNS)} -> ${plain(afterLNS)}). A partial fill leaves the rest open: the ` +
      `position is smaller but not by what was asked. Re-read the position before deciding ` +
      `anything, and do not re-send this request.`,
  };
}

/**
 * Did the close flatten the position?
 *
 * `venueConfirmed` is the one place in this layer where the venue's word is used,
 * and it is used narrowly: for a close, `st: 4 Filled` on `mt: 24` plus a position
 * that has left the set is two independent pieces of evidence agreeing, which is
 * enough. Absence ALONE is not, because a liquidation looks identical — and a
 * kill switch reporting "closed" for a position the venue liquidated out from
 * under it would be the tool taking credit for the disaster it was meant to
 * prevent.
 */
export function reconcileClose(params: {
  readonly beforeLNS: bigint;
  readonly afterLNS: bigint | undefined;
  readonly venueConfirmed: boolean;
}): Reconciliation {
  const { beforeLNS, afterLNS, venueConfirmed } = params;

  if (afterLNS === undefined) {
    if (venueConfirmed) {
      return {
        verdict: 'applied',
        field: 'size',
        requested: beforeLNS,
        before: beforeLNS,
        after: 0n,
        delta: -beforeLNS,
        detail:
          `the position has left the set and the venue confirmed the close, so all ` +
          `${plain(beforeLNS)} lots are closed — LANDED`,
      };
    }
    return vanished('size', beforeLNS, beforeLNS);
  }

  if (afterLNS === 0n) {
    return {
      verdict: 'applied',
      field: 'size',
      requested: beforeLNS,
      before: beforeLNS,
      after: 0n,
      delta: -beforeLNS,
      detail: `size is 0 (was ${plain(beforeLNS)}): the position is flat — LANDED`,
    };
  }

  return reconcileReduce({ requestedLNS: beforeLNS, beforeLNS, afterLNS });
}
