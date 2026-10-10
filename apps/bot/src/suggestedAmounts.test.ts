import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rearmAt } from '@perpguard/backend/events/warnings';
import { ceilTwoFigures, clearLevel, MIN_USEFUL_GAIN, spendableCNS, suggestAmounts, type SuggestInput } from './suggestedAmounts.ts';

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

test('THE CLEAR LEVEL is the higher of the line + 2 points and where the alert re-arms: 2.5% -> 4.5%, 5% -> 7%, 10% -> 12.5%, 20% -> 25%', () => {
  const pct = (d: number): number => Math.round(clearLevel(d / 100) * 100_000) / 1_000;
  assert.deepEqual([2.5, 5, 8, 10, 20].map(pct), [4.5, 7, 10, 12.5, 25]);
  // Never below the alert's own re-arm level, whatever the line: a top-up that lands clear re-arms the alert.
  for (const d of [0.5, 1, 2, 3, 5, 8, 10, 15, 20]) assert.ok(clearLevel(d / 100) >= rearmAt(d) / 100 - 1e-12, `${d}%`);
});

test('BOTH LAND CLEAR OF THE ALERT LINE (owner, 10 Oct 2026): at a 10% line the smaller reaches 12.5%, where the alert re-arms, and the larger is twice it', () => {
  // #710's SOL long on 10 Oct: about 1,100 AUSD notional, 8.9% from liquidation, line at 10%. Until then: +34 -> 12% and +17 -> 10.4%.
  const s = suggestAmounts(position({ notional: 1_100, now: 0.089, d: 0.1, free: 9_458 }));
  assert.deepEqual(shown(s), [80, 40]);
  const [larger, smaller] = s.amounts;
  assert.ok(smaller!.resultingBuffer >= 0.125, `the smaller lands at ${smaller!.resultingBuffer}`);
  assert.ok(larger!.resultingBuffer > smaller!.resultingBuffer);
  assert.equal(smaller!.amountCNS * 2n, larger!.amountCNS, 'the smaller is half the larger');
});

test('whatever the line and the position, a smaller top-up that is shown has landed at or past the clear level', () => {
  for (const d of [0.02, 0.025, 0.05, 0.08, 0.1, 0.2]) {
    for (const now of [-0.01, 0, d / 2, d - 0.001, d]) {
      for (const notional of [600, 5_968, 93_754, 2_000_000]) {
        for (const free of [200, 5_000, 1e9, undefined]) {
          const s = suggestAmounts(position({ notional, now, d, free }));
          if (s.amounts.length === 2) assert.ok(s.amounts[1]!.resultingBuffer >= clearLevel(d) - 1e-9, `${d} ${now} ${notional} ${free}`);
        }
      }
    }
  }
});

test("THE OWNER'S BTC LONG: the balance cannot reach the clear level, so ONE top-up, 90% of the free balance, and it says what it leaves", () => {
  // Measured live on testnet #24 (9 Oct 2026): 93,754 AUSD notional, 2.37% from liquidation, alert at 2.5%, 1,088.977 free.
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025, free: 1_088.977 }));
  assert.equal(s.note, undefined);
  // 4.5% would need 2,000 and twice that is 4,000; 90% of 1,088.977 is a whole 980. Its half (490) would land at 2.9%, short of 4.5%: hidden.
  assert.deepEqual(shown(s), [980]);
  assert.equal(s.amounts[0]!.freeAfterCNS, ausd(108.977));
  assert.ok(Math.abs(s.amounts[0]!.resultingBuffer - (0.0237 + 980 / 93_754)) < 1e-12);
});

test('NEVER A TOP-UP THAT CANNOT BE PAID FOR: every amount is within 90% of what can be spent, and the reserved minimum is never touched', () => {
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
  assert.deepEqual(shown(s), [530]);
  // What it leaves is of the FREE balance, which is what the trader sees: 1,088.977 − 530.
  assert.equal(s.amounts[0]!.freeAfterCNS, ausd(558.977));
});

test('affordable: the smaller lands clear and buys at least two points (two figures, rounded up); the larger is twice it, shown first', () => {
  // The owner's ETH short: 5,968 notional, 3.86% now, line at 2.5%, clear at 4.5%. It is within two points of
  // the clear level, so the smaller aims two points above where it is (5.86%): 119.4 -> 120, and 240.
  const s = suggestAmounts(position({ notional: 5_968, now: 0.0386, d: 0.025, free: 1_088.977 }));
  assert.deepEqual(shown(s), [240, 120]);
  assert.ok(s.amounts[1]!.resultingBuffer >= 0.0586 - 1e-9);
  // At the line itself the smaller is exactly the clear level: 2.5% -> 4.5% needs 119.36 -> 120 on this position too.
  const atLine = suggestAmounts(position({ notional: 100_000, now: 0.025, d: 0.025, free: 1e9 }));
  assert.deepEqual(shown(atLine), [4_000, 2_000]);
});

test('THE SMALLER IS HIDDEN WHEN THE CAP LEAVES IT SHORT OF THE CLEAR LEVEL: the larger, capped, still lands clear and is offered alone', () => {
  // 7% needs 5,000 and twice that is 10,000. 8,000 free caps the larger at 7,200 (9.2%, clear); its half lands at 5.6%.
  const s = suggestAmounts(position({ notional: 100_000, now: 0.02, d: 0.05, free: 8_000 }));
  assert.deepEqual(shown(s), [7_200]);
  assert.ok(s.amounts[0]!.resultingBuffer >= clearLevel(0.05));
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

test('free balance unknown: both at their targets, and nothing is said about what is left', () => {
  const s = suggestAmounts(position({ notional: 93_754, now: 0.0237, d: 0.025 }));
  assert.equal(s.note, undefined);
  assert.deepEqual(shown(s), [4_000, 2_000]);
  assert.ok(s.amounts.every((a) => a.freeAfterCNS === undefined));
});

test('View position on a position near or past the clear level aims at its own distance + 2 points, never a trivial amount; past liquidation aims at the clear level', () => {
  // 12% with a 5% line (clear 7%): two points above where it is.
  const far = suggestAmounts(position({ notional: 10_000, now: 0.12, d: 0.05, free: 1e6 }));
  assert.deepEqual(shown(far), [400, 200]);
  assert.ok(far.amounts[1]!.resultingBuffer >= 0.14 - 1e-9);
  // 6.9%, just under the 7% clear level: still two points, not the 10 AUSD that 0.1 points costs.
  const near = suggestAmounts(position({ notional: 10_000, now: 0.069, d: 0.05, free: 1e6 }));
  assert.deepEqual(shown(near), [400, 200]);
  assert.equal(near.note, undefined);
  const past = suggestAmounts(position({ notional: 10_000, now: -0.01, d: 0.05, free: 1e6 }));
  assert.deepEqual(shown(past), [1_600, 800]);
});

test('nothing it cannot price: no amounts at all, and no sentence blaming the balance', () => {
  const s = suggestAmounts({ ...position({ notional: 10_000, now: 0.02, d: 0.05, free: 1_000 }), project: () => undefined });
  assert.deepEqual(s, { amounts: [] });
});
