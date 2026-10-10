import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ceilTwoFigures, MIN_SECOND_GAIN, MIN_USEFUL_GAIN, spendableCNS, suggestAmounts, type SuggestInput } from './suggestedAmounts.ts';

const UNIT = 1_000_000n;
const ausd = (n: number): bigint => BigInt(Math.round(n * 1e6));
/** A top-up moves the distance by amount ÷ notional, as the engine's projection does for margin. */
function position(o: { notional: number; now: number; d: number; free?: number | undefined; reserved?: number }): SuggestInput {
  return {
    currentBuffer: o.now,
    alertFraction: o.d,
    freeFloorCNS: o.free === undefined ? undefined : ausd(o.free),
    ...(o.reserved === undefined ? {} : { reservedCNS: ausd(o.reserved) }),
    unitCNS: UNIT,
    project: (amountCNS) => o.now + Number(amountCNS) / 1e6 / o.notional,
  };
}
const shown = (s: ReturnType<typeof suggestAmounts>) => s.amounts.map((a) => Number(a.amountCNS) / 1e6);

test('two figures, rounded UP: never a figure that falls short of its target', () => {
  assert.deepEqual([1_996.96, 4_809.6, 38.2, 217.15, 9, 0, 100, 101].map(ceilTwoFigures), [2_000, 4_900, 39, 220, 9, 0, 100, 110]);
});

test('SPENDABLE is the free floor less what is reserved, never below zero, unknown when the balance is', () => {
  assert.equal(spendableCNS(ausd(1_088), undefined), ausd(1_088));
  assert.equal(spendableCNS(ausd(1_088), ausd(500)), ausd(588));
  assert.equal(spendableCNS(ausd(300), ausd(500)), 0n);
  assert.equal(spendableCNS(undefined, ausd(500)), undefined);
});

test("THE OWNER'S BTC LONG: the first is 90% of the free balance, the second half of it, and each says what it leaves free", () => {
  // Measured live on testnet #24 (9 Oct 2026): 93,754 AUSD notional, 2.37% from liquidation, alert at 2.5%, 1,088.977 free.
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025, free: 1_088.977 }));
  assert.equal(s.note, undefined);
  // 4.5% would need 2,000; 90% of 1,088.977 is 980.08, a whole 980. Half of it is 490.
  assert.deepEqual(shown(s), [980, 490]);
  assert.equal(s.amounts[0]!.freeAfterCNS, ausd(108.977));
  assert.equal(s.amounts[1]!.freeAfterCNS, ausd(598.977));
  assert.ok(Math.abs(s.amounts[0]!.resultingBuffer - (0.0237 + 980 / 93_754)) < 1e-12);
  assert.ok(s.amounts[1]!.resultingBuffer - 0.0237 >= MIN_SECOND_GAIN, 'the half buys 0.52 points');
});

test('NEVER A TOP-UP THAT CANNOT BE PAID FOR: every amount is within what can be spent, and the first within 90% of it', () => {
  for (const free of [10, 99, 300, 1_088.977, 5_000, 1e9]) {
    for (const reserved of [0, 50, 250]) {
      const s = suggestAmounts(position({ notional: 1_000_000, now: 0.02, d: 0.05, free, reserved }));
      const spendable = Math.max(0, free - reserved);
      for (const a of s.amounts) {
        assert.ok(Number(a.amountCNS) / 1e6 <= spendable * 0.9 + 1e-9, `${Number(a.amountCNS) / 1e6} of ${spendable} (${free} free, ${reserved} reserved)`);
        assert.ok(a.freeAfterCNS! >= ausd(reserved), 'the reserved minimum is never spent');
      }
    }
  }
});

test('THE RESERVED MINIMUM COMES OFF FIRST: a Rescue rule keeping 500 back leaves 588.977 to spend, and 90% of that is offered', () => {
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025, free: 1_088.977, reserved: 500 }));
  // Half of 530 would buy 0.28 points, under the 0.3 threshold, so only the first is offered.
  assert.deepEqual(shown(s), [530]);
  // What it leaves is of the FREE balance, which is what the trader sees: 1,088.977 − 530.
  assert.equal(s.amounts[0]!.freeAfterCNS, ausd(558.977));
});

test('affordable: the first is its target (the line + 2 points, two figures, rounded up) and the second half of it', () => {
  // The owner's ETH short: 5,968 notional, 3.86% now, line at 2.5%, so the target is 4.5%: 38.2 -> 39.
  const s = suggestAmounts(position({ notional: 5_968, now: 0.0386, d: 0.025, free: 1_088.977 }));
  // Half of 39 is 19.5, to the collateral's precision; it buys 0.33 points, so it is shown.
  assert.deepEqual(shown(s), [39, 19.5]);
  assert.ok(s.amounts[0]!.resultingBuffer >= 0.045);
});

test('THE HALF TOP-UP IS HIDDEN UNDER 0.3 POINTS: shown at the threshold, not below it', () => {
  // The first buys 0.6 points, so the half buys exactly 0.3: shown.
  const at = suggestAmounts(position({ notional: 100_000, now: 0.02, d: 0.025, free: 666.67 }));
  assert.deepEqual(shown(at), [600, 300]);
  // The first buys 0.58 points, so the half buys 0.29: hidden, one button.
  const under = suggestAmounts(position({ notional: 100_000, now: 0.02, d: 0.025, free: 645 }));
  assert.deepEqual(shown(under), [580]);
  // A first that reaches its target buys 2 points or more, so its half always clears 0.3.
  const full = suggestAmounts(position({ notional: 100_000, now: 0.02, d: 0.05, free: 1e9 }));
  assert.deepEqual(shown(full), [5_000, 2_500]);
});

test('ALMOST NOTHING IS SAID IN WORDS: a balance that buys under half a point gets no top-ups, and the note says what it would buy', () => {
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025, free: 50 }));
  assert.deepEqual(s.amounts, []);
  assert.ok(s.note !== undefined);
  assert.equal(s.note.spendableCNS, ausd(50));
  assert.ok(s.note.gain > 0 && s.note.gain < MIN_USEFUL_GAIN);
  // Everything reserved: nothing to spend at all.
  const none = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025, free: 400, reserved: 500 }));
  assert.deepEqual(none.amounts, []);
  assert.equal(none.note?.spendableCNS, 0n);
});

test('free balance unknown: the first is its target, the half follows, and nothing is said about what is left', () => {
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025 }));
  assert.equal(s.note, undefined);
  assert.deepEqual(shown(s), [2_000, 1_000]);
  assert.ok(s.amounts.every((a) => a.freeAfterCNS === undefined));
});

test('far from the line (View position): aims at its own distance + 2 points, never offers +0; past liquidation aims above the line', () => {
  const far = suggestAmounts(position({ notional: 10_000, now: 0.12, d: 0.05, free: 1e6 }));
  assert.deepEqual(shown(far), [200, 100]);
  assert.ok(far.amounts[0]!.resultingBuffer >= 0.14 - 1e-9);
  const past = suggestAmounts(position({ notional: 10_000, now: -0.01, d: 0.05, free: 1e6 }));
  assert.deepEqual(shown(past), [800, 400]);
});

test('nothing it cannot price: no amounts at all, and no sentence blaming the balance', () => {
  const s = suggestAmounts({ ...position({ notional: 10_000, now: 0.02, d: 0.05, free: 1_000 }), project: () => undefined });
  assert.deepEqual(s, { amounts: [] });
});
