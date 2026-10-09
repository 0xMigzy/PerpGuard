import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ceilTwoFigures, FREE_SHARE, MIN_USEFUL_GAIN, suggestAmounts, type SuggestInput } from './suggestedAmounts.ts';

const UNIT = 1_000_000n;
/** A top-up moves the distance by amount ÷ notional, as the engine's projection does for margin. */
function position(o: { notional: number; now: number; d: number; free?: number | undefined }): SuggestInput {
  return {
    currentBuffer: o.now,
    alertFraction: o.d,
    freeFloorCNS: o.free === undefined ? undefined : BigInt(Math.round(o.free * 1e6)),
    unitCNS: UNIT,
    project: (amountCNS) => o.now + Number(amountCNS) / 1e6 / o.notional,
  };
}

test('two figures, rounded UP: never a figure that falls short of its target', () => {
  assert.deepEqual([1_996.96, 4_809.6, 38.2, 217.15, 9, 0, 100, 101].map(ceilTwoFigures), [2_000, 4_900, 39, 220, 9, 0, 100, 110]);
});

test("THE OWNER'S BTC LONG (9 Oct 2026): most of the free balance first, the D+5 target second with ⚠️", () => {
  // Measured live on testnet #24: 93,754 AUSD notional, 2.37% from liquidation, alert at 2.5%, 1,088.977 free.
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025, free: 1_088.977 }));
  assert.equal(s.note, undefined);
  assert.equal(s.amounts.length, 2);
  const [first, second] = s.amounts;
  // 4.5% would need 1,997; 90% of 1,088 is 979, which buys 3.4%.
  assert.deepEqual({ ausd: first!.ausd, mostOfFree: first!.mostOfFree, overFree: first!.overFree }, { ausd: 979, mostOfFree: true, overFree: false });
  assert.ok(Math.abs(first!.resultingBuffer - (0.0237 + 979 / 93_754)) < 1e-12);
  assert.deepEqual({ ausd: second!.ausd, mostOfFree: second!.mostOfFree, overFree: second!.overFree }, { ausd: 4_900, mostOfFree: false, overFree: true });
  assert.ok(second!.resultingBuffer >= 0.075);
});

test('the first button NEVER spends the whole free balance: at most 90% of it, rounded down', () => {
  for (const free of [10, 99, 1_088.977, 5_000]) {
    const s = suggestAmounts(position({ notional: 1_000_000, now: 0.02, d: 0.05, free }));
    const first = s.amounts[0];
    if (first?.mostOfFree === true) assert.ok(first.ausd <= Math.floor(free) * FREE_SHARE, `${first.ausd} of ${free}`);
    for (const a of s.amounts.filter((x) => !x.overFree)) assert.ok(a.ausd < free);
  }
});

test('affordable targets: both sized to D+2 and D+5, labels never below their targets, nothing marked', () => {
  // The owner's ETH short: 5,968 notional, 3.86% now, line at 2.5%, so the targets are 4.5% and 7.5%.
  const s = suggestAmounts(position({ notional: 5_968, now: 0.0386, d: 0.025, free: 1_088.977 }));
  assert.deepEqual(s.amounts.map((a) => [a.ausd, a.overFree, a.mostOfFree]), [[39, false, false], [220, false, false]]);
  assert.ok(s.amounts[0]!.resultingBuffer >= 0.045);
  assert.ok(s.amounts[1]!.resultingBuffer >= 0.075);
});

test('the two options are clearly different: at least two points apart after rounding, never the same amount', () => {
  for (const notional of [500, 1_727, 20_000, 93_754, 2_000_000]) {
    const s = suggestAmounts(position({ notional, now: 0.01, d: 0.05, free: 1e9 }));
    assert.equal(s.amounts.length, 2);
    assert.ok(s.amounts[1]!.ausd > s.amounts[0]!.ausd);
    assert.ok(s.amounts[1]!.resultingBuffer - s.amounts[0]!.resultingBuffer >= 0.02, `${notional}`);
  }
});

test('ALMOST NOTHING IS SAID IN WORDS: a free balance that buys under half a point gets no button', () => {
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025, free: 50 }));
  assert.ok(s.note !== undefined);
  assert.equal(s.note.freeAusd, 50);
  assert.ok(s.note.gain < MIN_USEFUL_GAIN);
  // The D+5 target is still offered, marked.
  assert.deepEqual(s.amounts.map((a) => [a.ausd, a.overFree]), [[4_900, true]]);
});

test('free balance unknown: both targets, nothing marked, no note', () => {
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025 }));
  assert.equal(s.note, undefined);
  assert.deepEqual(s.amounts.map((a) => [a.ausd, a.overFree, a.mostOfFree]), [[2_000, false, false], [4_900, false, false]]);
});

test('far from the line (View position): aims at its own distance + 2 and + 5, never offers +0', () => {
  const s = suggestAmounts(position({ notional: 10_000, now: 0.12, d: 0.05, free: 1e6 }));
  assert.deepEqual(s.amounts.map((a) => a.ausd), [200, 500]);
  assert.ok(s.amounts[0]!.resultingBuffer >= 0.14 - 1e-9);
});

test('past liquidation: the targets are still above the line, at what it actually takes', () => {
  const s = suggestAmounts(position({ notional: 10_000, now: -0.01, d: 0.05, free: 1e6 }));
  assert.deepEqual(s.amounts.map((a) => a.ausd), [800, 1_100]);
});

test('nothing it cannot price: no amounts at all', () => {
  const s = suggestAmounts({ ...position({ notional: 10_000, now: 0.02, d: 0.05, free: 1_000 }), project: () => undefined });
  assert.deepEqual(s, { amounts: [] });
});
