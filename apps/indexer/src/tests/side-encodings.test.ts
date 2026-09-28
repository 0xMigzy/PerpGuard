/**
 * THE TWO SIDE ENCODINGS ARE DIFFERENT ON PURPOSE. DO NOT UNIFY THEM.
 *
 * This repo decodes position side from two sources that disagree:
 *
 *     contract events (`positionType`)   0 = LONG,  1 = SHORT
 *     API wire        (`sd`)             1 = Long,  2 = Short
 *
 * So the value `1` means SHORT on one and LONG on the other. Neither encoding
 * is self-describing, and both were measured rather than assumed —
 * `positionType` over 496 real mainnet round trips, `sd` off a real testnet
 * position whose full ledger reconciles to the micro (docs/evidence.md).
 *
 * `sideOf()` and `sideFromWire()` therefore look like duplicate helpers and
 * are not. Merging them, or pointing either at the other's data, inverts every
 * long and short that passes through. That is the worst bug this product can
 * have: it tells a short trader they are long and to add margin, while the
 * price runs away from them in the direction that liquidates them faster.
 *
 * This file exists solely so that merge fails loudly. If you are here because
 * this test broke while you were tidying up two functions that "do the same
 * thing" — they do not. Put them back.
 *
 * The one thing they must share is intolerance of the unknown: neither may
 * default to a side it did not read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sideFromWire } from "@perpguard/shared";
import { sideOf } from "../lib/scale.ts";

test("the value 1 means opposite sides on the two encodings", () => {
  // API wire: PositionType 1 = Long. Measured — the long we opened on testnet
  // came back with sd: 1.
  assert.equal(sideFromWire(1), "long");

  // Contract events: positionType 1 = SHORT. Measured over 496 mainnet round
  // trips. THE SAME NUMBER, THE OPPOSITE SIDE.
  assert.equal(sideOf(1n), "SHORT");

  // Stated as one assertion so the asymmetry is impossible to read past.
  assert.notEqual(
    sideFromWire(1).toUpperCase(),
    sideOf(1n),
    "sd=1 and positionType=1 must decode to OPPOSITE sides; if this passes " +
      "trivially someone has unified the two encodings",
  );
});

test("the other values line up the same way round", () => {
  // Wire: 2 = Short. Contract: 0 = LONG.
  assert.equal(sideFromWire(2), "short");
  assert.equal(sideOf(0n), "LONG");
});

test("neither decoder invents a side it did not read", () => {
  // The wire's 0 is Unspecified, not Long. Reading it as long is exactly the
  // inversion this file exists to prevent.
  assert.throws(() => sideFromWire(0), /unrecognised position side/);
  assert.throws(() => sideFromWire(3), /unrecognised position side/);
  assert.throws(() => sideFromWire(undefined), /unrecognised position side/);
  assert.throws(() => sideFromWire("long"), /unrecognised position side/);

  // The contract's positionType is documented as 0 or 1 and nothing else.
  assert.throws(() => sideOf(2n), /unrecognised positionType/);
});
