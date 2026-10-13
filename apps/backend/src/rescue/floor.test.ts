import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RESCUE_FLOOR_AUSD, heldBackCNS, isRescueFloor, parseRescueFloor, rescueFloorCNS, rescueFloorLabel, RESCUE_FLOOR_PRESETS_AUSD } from './floor.ts';
import { balanceLow, renderRescue, type RescueNotice } from './render.ts';
import type { RescueRule } from './store.ts';
import type { RiskAssessment } from '../risk/types.ts';

const AUSD = 1_000_000n;

test('THE DEFAULT IS 100 AUSD (it was 500 until 13 Oct 2026), and 0 is offered', () => {
  assert.equal(DEFAULT_RESCUE_FLOOR_AUSD, 100);
  assert.ok((RESCUE_FLOOR_PRESETS_AUSD as readonly number[]).includes(0));
  assert.ok((RESCUE_FLOOR_PRESETS_AUSD as readonly number[]).includes(DEFAULT_RESCUE_FLOOR_AUSD));
});

test('ANY WHOLE AMOUNT FROM 0 UPWARD: 0 is a value, not "unset"; negatives, decimals and words are refused', () => {
  assert.deepEqual(parseRescueFloor('0'), { ausd: 0 });
  assert.deepEqual(parseRescueFloor(' 36 '), { ausd: 36 });
  assert.deepEqual(parseRescueFloor('1,500 AUSD'), { ausd: 1_500 });
  for (const bad of ['-1', '12.5', '', 'none', '1e3', '999999999']) assert.ok('error' in parseRescueFloor(bad), bad);
  assert.ok(isRescueFloor(0) && isRescueFloor(7) && !isRescueFloor(-1) && !isRescueFloor(1.5) && !isRescueFloor(Number.NaN) && !isRescueFloor(undefined));
});

test("in the collateral's own decimals, never assumed to be 6", () => {
  assert.equal(rescueFloorCNS(100, 6), 100n * AUSD);
  assert.equal(rescueFloorCNS(100, 18), 100n * 10n ** 18n);
  assert.equal(rescueFloorCNS(0, 6), 0n);
  assert.equal(rescueFloorLabel(1_500), '1,500 AUSD');
});

test('ONE-TAP TOP-UPS: the floor is held back from the suggestions ONLY while a Rescue rule is armed', () => {
  assert.equal(heldBackCNS({ anyRuleArmed: false, floorCNS: 100n * AUSD, inFlightCNS: 0n }), 0n, 'nothing armed, nothing held: the floor never limits the person');
  assert.equal(heldBackCNS({ anyRuleArmed: true, floorCNS: 100n * AUSD, inFlightCNS: 0n }), 100n * AUSD);
  assert.equal(heldBackCNS({ anyRuleArmed: true, floorCNS: 0n, inFlightCNS: 0n }), 0n, 'a floor of 0 holds nothing back, armed or not');
  assert.equal(heldBackCNS({ anyRuleArmed: true, floorCNS: 0n, inFlightCNS: 25n * AUSD }), 25n * AUSD, 'a top-up on its way is still held');
});

const rule = { id: 1, accountId: 69, marketId: 16, symbol: 'BTC', positionId: 1, triggerPct: 0.05, amountCNS: 100n * AUSD, maxRescues: 2, maxTotalCNS: 200n * AUSD, minRemainingCNS: 500n * AUSD, cooldownMs: 900_000, rescueCount: 0, totalRescuedCNS: 0n, enabled: true, pausedReason: undefined, lastAttemptAtMs: undefined, lastNotice: undefined, createdAtMs: 0 } as RescueRule;
const held = (minRemainingCNS: bigint | undefined): RescueNotice => ({ kind: 'held', rule, reason: 'balance-low', detail: 'x', assessment: { liqBufferPct: 0.027 } as RiskAssessment, minRemainingCNS });

test("THE DECLINE QUOTES THE PERSON'S OWN FIGURE, never a fixed one, and never the figure the rule stored when it was turned on", () => {
  const at36 = renderRescue(held(36n * AUSD), 6).html;
  assert.match(at36, /Nothing was sent: adding 100 AUSD would take your free balance below the 36 AUSD you chose to keep\./);
  assert.match(at36, /Change that amount under ⚙️ Settings, or add margin yourself/);
  assert.ok(!at36.includes('500'), 'the rule stored 500 when it was turned on; it is not what the message says');
  const at250 = renderRescue(held(250n * AUSD), 6).html;
  assert.match(at250, /below the 250 AUSD you chose to keep/);
  assert.ok(!/\b(100|500) AUSD you chose/.test(at250));
});

test('THE DECLINE AT A FLOOR OF 0 names no floor: the balance does not cover one top-up, and nothing smaller is sent', () => {
  const html = renderRescue(held(0n), 6).html;
  assert.match(html, /Nothing was sent: your free balance doesn't cover the 100 AUSD top-up, and Rescue waits rather than send less\./);
  assert.ok(!/you chose to keep|below/.test(html));
  assert.deepEqual(balanceLow(25n, 0n, String, String).length, 2);
});

test('a hold decided with no setting wired (a tool, an old test) still quotes the rule, never nothing', () => {
  assert.match(renderRescue(held(undefined), 6).html, /below the 500 AUSD you chose to keep/);
});
