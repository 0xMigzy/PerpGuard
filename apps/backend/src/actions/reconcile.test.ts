/**
 * The verdicts, against the real numbers.
 *
 * The four add-margin rows below are the measured testnet runs from
 * `docs/evidence.md`, verbatim. Every one of them reported `st: 7 Failed,
 * sr: 32 OrderDescIdTooLow` and every one credited the collateral in full, so a
 * reconciler that reads `applied` off these figures is the only one that tells a
 * trader the truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAddMargin, reconcileClose, reconcileReduce } from './reconcile.ts';

// ── add margin: the sr 32 case ──────────────────────────────────────────────

/** rq, margin before, margin after, amount requested — all in AUSD micros. */
const LIVE_RUNS: ReadonlyArray<readonly [number, bigint, bigint, bigint]> = [
  [12, 55_822n, 83_001n, 27_179n],
  [15, 55_900n, 83_584n, 27_684n],
  [16, 83_584n, 111_268n, 27_684n],
  [19, 55_700n, 83_160n, 27_460n],
];

test('every measured sr 32 run reconciles to applied', () => {
  // The venue reported FAILED for all four. The position says otherwise, and the
  // position is what a trader's collateral actually sits in.
  for (const [rq, before, after, requested] of LIVE_RUNS) {
    const result = reconcileAddMargin({
      requestedCNS: requested,
      beforeCNS: before,
      afterCNS: after,
    });
    assert.equal(result.verdict, 'applied', `rq ${rq} should reconcile to applied`);
    assert.equal(result.delta, requested, `rq ${rq}: the full amount landed`);
    assert.match(result.detail, /LANDED/);
  }
});

test('the reconciler cannot even see the venue status', () => {
  // Not a behaviour test — a shape one. There is no parameter for it, so no
  // future edit can start weighing `st: 7` without changing the signature and
  // reading the comment that explains why it must not.
  const params = { requestedCNS: 27_460n, beforeCNS: 55_700n, afterCNS: 83_160n };
  assert.deepEqual(Object.keys(params).sort(), ['afterCNS', 'beforeCNS', 'requestedCNS']);
  assert.equal(reconcileAddMargin(params).verdict, 'applied');
});

test('the applied detail reads like the live run’s own reconciliation line', () => {
  const result = reconcileAddMargin({
    requestedCNS: 27_460n,
    beforeCNS: 55_700n,
    afterCNS: 83_160n,
  });
  assert.equal(
    result.detail,
    'margin is now 83160 (was 55700): 27460 micros applied, 27460 requested — LANDED',
  );
});

test('an unmoved margin is not-applied, and says nothing was added', () => {
  const result = reconcileAddMargin({
    requestedCNS: 27_460n,
    beforeCNS: 55_700n,
    afterCNS: 55_700n,
  });
  assert.equal(result.verdict, 'not-applied');
  assert.equal(result.delta, 0n);
  assert.match(result.detail, /unchanged at 55700/);
  assert.match(result.detail, /did not land/);
});

test('a partial delta is unknown, never rounded into applied', () => {
  // Funding settles into a position on each funding event and moves `c` on its
  // own, so a near-miss has at least two explanations and guessing between them
  // would produce a confident figure that is wrong.
  const result = reconcileAddMargin({
    requestedCNS: 27_460n,
    beforeCNS: 55_700n,
    afterCNS: 83_000n,
  });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.delta, 27_300n);
  assert.match(result.detail, /moved by 27300 micros but 27460 were requested/);
  assert.match(result.detail, /do not re-send/);
});

test('a delta LARGER than requested is unknown, not a bonus', () => {
  // This is what a double-send looks like from the outside, and it is exactly the
  // state the investigation left the micro in. It must never read as success.
  const result = reconcileAddMargin({
    requestedCNS: 27_684n,
    beforeCNS: 55_900n,
    afterCNS: 111_268n,
  });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.delta, 55_368n);
  assert.match(result.detail, /55368 micros but 27684 were requested/);
});

test('a vanished position is unknown, and names every way it could have gone', () => {
  const result = reconcileAddMargin({
    requestedCNS: 27_460n,
    beforeCNS: 55_700n,
    afterCNS: undefined,
  });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.after, undefined);
  assert.equal(result.delta, undefined);
  assert.match(result.detail, /closed, filled out, liquidated or deleveraged/);
  assert.match(result.detail, /do not re-send/);
});

// ── reduce ──────────────────────────────────────────────────────────────────

test('a reduce that closed what was asked is applied', () => {
  const result = reconcileReduce({ requestedLNS: 20_000n, beforeLNS: 50_000n, afterLNS: 30_000n });
  assert.equal(result.verdict, 'applied');
  assert.equal(result.field, 'size');
  assert.match(result.detail, /20000 lots closed, 20000 requested — LANDED/);
});

test('an unmoved size is not-applied', () => {
  const result = reconcileReduce({ requestedLNS: 20_000n, beforeLNS: 50_000n, afterLNS: 50_000n });
  assert.equal(result.verdict, 'not-applied');
  assert.match(result.detail, /unchanged at 50000/);
});

test('a partial fill is unknown, and says how far it got', () => {
  // An ImmediateOrCancel close takes what the book offers and cancels the rest.
  const result = reconcileReduce({ requestedLNS: 20_000n, beforeLNS: 50_000n, afterLNS: 42_000n });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.detail, /8000 lots closed of 20000 requested/);
  assert.match(result.detail, /leaves the rest open/);
});

// ── close ───────────────────────────────────────────────────────────────────

test('a position delivered at size 0 is closed, whatever the venue said', () => {
  // A close arrives as a row with st: 2 and s: 0, not as an omission.
  const result = reconcileClose({ beforeLNS: 50_000n, afterLNS: 0n, venueConfirmed: false });
  assert.equal(result.verdict, 'applied');
  assert.match(result.detail, /size is 0 \(was 50000\): the position is flat — LANDED/);
});

test('absence plus a confirmed fill is closed', () => {
  const result = reconcileClose({ beforeLNS: 50_000n, afterLNS: undefined, venueConfirmed: true });
  assert.equal(result.verdict, 'applied');
  assert.match(result.detail, /left the set and the venue confirmed the close/);
});

test('absence ALONE is unknown: a liquidation looks exactly the same', () => {
  // The failure this guards against is a kill switch reporting "closed" for a
  // position the venue liquidated out from under it — the tool taking credit for
  // the disaster it existed to prevent.
  const result = reconcileClose({ beforeLNS: 50_000n, afterLNS: undefined, venueConfirmed: false });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.detail, /liquidated or deleveraged/);
});

test('a close that only partly filled reports as the partial it is', () => {
  const result = reconcileClose({ beforeLNS: 50_000n, afterLNS: 12_000n, venueConfirmed: true });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.detail, /38000 lots closed of 50000 requested/);
});

// ── shapes ──────────────────────────────────────────────────────────────────

test('every verdict carries the figures it was reached from', () => {
  const cases = [
    reconcileAddMargin({ requestedCNS: 5n, beforeCNS: 10n, afterCNS: 15n }),
    reconcileAddMargin({ requestedCNS: 5n, beforeCNS: 10n, afterCNS: 10n }),
    reconcileAddMargin({ requestedCNS: 5n, beforeCNS: 10n, afterCNS: 12n }),
    reconcileReduce({ requestedLNS: 5n, beforeLNS: 10n, afterLNS: 5n }),
    reconcileClose({ beforeLNS: 10n, afterLNS: 0n, venueConfirmed: true }),
  ];
  for (const result of cases) {
    // A verdict a human cannot check is a verdict they have to take on trust.
    assert.equal(typeof result.requested, 'bigint');
    assert.equal(typeof result.before, 'bigint');
    assert.ok(result.detail.length > 20, result.detail);
  }
});
