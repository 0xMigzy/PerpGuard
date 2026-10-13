import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, RESCUE_CONFIRM_MS, type RescueFacts } from './decide.ts';
import type { RescueRule } from './store.ts';
import type { RiskAssessment } from '../risk/types.ts';

const AUSD = 1_000_000n;
const NOW = 10_000_000;

const rule = (o: Partial<RescueRule> = {}): RescueRule => ({
  id: 1,
  accountId: 710,
  marketId: 16,
  symbol: 'BTC',
  positionId: 4508933292033,
  triggerPct: 0.03,
  amountCNS: 100n * AUSD,
  maxRescues: 2,
  maxTotalCNS: 200n * AUSD,
  minRemainingCNS: 500n * AUSD,
  cooldownMs: 15 * 60_000,
  rescueCount: 0,
  totalRescuedCNS: 0n,
  enabled: true,
  pausedReason: undefined,
  lastAttemptAtMs: undefined,
  lastNotice: undefined,
  createdAtMs: 0,
  armedBy: 1, armedChat: 1, armedAtMs: 0, armProof: 'test-armed',
  ...o,
});

const at = (buffer: number | undefined, o: Partial<RiskAssessment> = {}): RiskAssessment =>
  ({ marketId: 16, symbol: 'BTC', positionId: 4508933292033, state: 'DANGER', liqBufferPct: buffer, ...o }) as RiskAssessment;

const facts = (o: Partial<RescueFacts> = {}): RescueFacts => ({
  rule: rule(),
  assessment: at(0.025),
  belowSinceMs: NOW - RESCUE_CONFIRM_MS,
  automationStopped: false,
  feedConnected: true,
  openPositionIds: new Set([4508933292033]),
  freeFloorCNS: 9_000n * AUSD,
  nowMs: NOW,
  ...o,
});

test('fires at the trigger once two looks a second apart agree, with the rule amount', () => {
  assert.deepEqual(decide(facts()), { kind: 'fire', amountCNS: 100n * AUSD });
});

test('exactly AT the trigger counts as at or below', () => {
  assert.equal(decide(facts({ assessment: at(0.03) })).kind, 'fire');
});

test('the first look only arms; a look under a second later still only arms', () => {
  assert.equal(decide(facts({ belowSinceMs: undefined })).kind, 'arming');
  assert.equal(decide(facts({ belowSinceMs: NOW - RESCUE_CONFIRM_MS + 1 })).kind, 'arming');
});

test('above the trigger is idle', () => {
  assert.equal(decide(facts({ assessment: at(0.031) })).kind, 'idle');
});

test('past liquidation (a negative buffer) is below any trigger', () => {
  assert.equal(decide(facts({ assessment: at(-0.01, { state: 'PAST_LIQUIDATION' }) })).kind, 'fire');
});

test('KILL SWITCH: automation stopped holds, whatever else is true', () => {
  const d = decide(facts({ automationStopped: true }));
  assert.equal(d.kind, 'hold');
  assert.ok(d.kind === 'hold' && d.reason === 'stopped');
});

test('a feed that is not connected holds: a frozen price decides nothing', () => {
  const d = decide(facts({ feedConnected: false }));
  assert.ok(d.kind === 'hold' && d.reason === 'feed-down');
});

test('a position list that is not fully loaded holds, and never ends the rule on a missing position', () => {
  const d = decide(facts({ openPositionIds: undefined, assessment: undefined }));
  assert.ok(d.kind === 'hold' && d.reason === 'positions-untrusted');
});

test('the position gone from a FULLY LOADED list ends the rule', () => {
  assert.equal(decide(facts({ assessment: undefined, openPositionIds: new Set() })).kind, 'ended');
});

test('a NEW position on the same market ends the rule: it never carries over', () => {
  assert.equal(decide(facts({ assessment: at(0.02, { positionId: 999 }), openPositionIds: new Set([999]) })).kind, 'ended');
});

test('GONE ONLY ON PROOF: open in the list but no risk reading (no price yet after a restart) holds, never ends', () => {
  const d = decide(facts({ assessment: undefined }));
  assert.ok(d.kind === 'hold' && d.reason === 'unassessed', JSON.stringify(d));
});

test('MAX RESCUES spent is exhausted', () => {
  assert.equal(decide(facts({ rule: rule({ rescueCount: 2, totalRescuedCNS: 200n * AUSD, maxTotalCNS: 10_000n * AUSD }) })).kind, 'exhausted');
});

test('MAX TOTAL binds on its own, tighter than count x amount (5 rescues of 500, capped at 1,000)', () => {
  const r = rule({ amountCNS: 500n * AUSD, maxRescues: 5, maxTotalCNS: 1_000n * AUSD });
  assert.equal(decide(facts({ rule: { ...r, rescueCount: 1, totalRescuedCNS: 500n * AUSD } })).kind, 'fire');
  // Two used, 1,000 added: three rescues remain by count, none by total.
  const d = decide(facts({ rule: { ...r, rescueCount: 2, totalRescuedCNS: 1_000n * AUSD } }));
  assert.equal(d.kind, 'exhausted');
});

test('the next amount is never trimmed to fit the cap: 900 of 1,000 used and a 500 rule is exhausted', () => {
  const r = rule({ amountCNS: 500n * AUSD, maxRescues: 5, maxTotalCNS: 1_000n * AUSD, rescueCount: 1, totalRescuedCNS: 900n * AUSD });
  assert.equal(decide(facts({ rule: r })).kind, 'exhausted');
});

test('cooldown holds until it has passed', () => {
  const d = decide(facts({ rule: rule({ rescueCount: 1, totalRescuedCNS: 100n * AUSD, lastAttemptAtMs: NOW - 60_000 }) }));
  assert.ok(d.kind === 'hold' && d.reason === 'cooldown');
  assert.equal(decide(facts({ rule: rule({ rescueCount: 1, totalRescuedCNS: 100n * AUSD, lastAttemptAtMs: NOW - 15 * 60_000 }) })).kind, 'fire');
});

test('FREE BALANCE: unknown holds; the minimum kept is never spent; exactly at the minimum fires', () => {
  assert.ok((() => { const d = decide(facts({ freeFloorCNS: undefined })); return d.kind === 'hold' && d.reason === 'balance-unknown'; })());
  const low = decide(facts({ freeFloorCNS: 599n * AUSD }));
  assert.ok(low.kind === 'hold' && low.reason === 'balance-low', 'never a scaled-down amount');
  assert.equal(decide(facts({ freeFloorCNS: 600n * AUSD })).kind, 'fire');
});

test("THE ACCOUNT'S FLOOR DECIDES, not the figure the rule stored: 100 lets through what 500 held, and a raised floor holds", () => {
  // The rule stored 500 when it was turned on. 250 free, a 100 top-up.
  const stored500 = decide(facts({ freeFloorCNS: 250n * AUSD }));
  assert.ok(stored500.kind === 'hold' && stored500.reason === 'balance-low', 'with no setting wired, the stored figure applies');
  assert.equal(decide(facts({ freeFloorCNS: 250n * AUSD, minRemainingCNS: 100n * AUSD })).kind, 'fire', '250 - 100 leaves 150, above a floor of 100');
  assert.equal(decide(facts({ freeFloorCNS: 200n * AUSD, minRemainingCNS: 100n * AUSD })).kind, 'fire', 'exactly at the floor fires');
  const one = decide(facts({ freeFloorCNS: 200n * AUSD - 1n, minRemainingCNS: 100n * AUSD }));
  assert.ok(one.kind === 'hold' && one.reason === 'balance-low', 'one micro short holds');
  const raised = decide(facts({ freeFloorCNS: 9_000n * AUSD, minRemainingCNS: 8_950n * AUSD }));
  assert.ok(raised.kind === 'hold' && raised.reason === 'balance-low', 'a floor raised above the stored 500 holds too');
});

test('A FLOOR OF 0 SPENDS THE WHOLE FREE BALANCE AND NOT A MICRO MORE: mainnet #69, 36 AUSD free', () => {
  const r36 = rule({ amountCNS: 36n * AUSD, maxTotalCNS: 72n * AUSD });
  assert.equal(decide(facts({ rule: r36, freeFloorCNS: 36n * AUSD, minRemainingCNS: 0n })).kind, 'fire', 'all 36 may go');
  const short = decide(facts({ rule: r36, freeFloorCNS: 36n * AUSD - 1n, minRemainingCNS: 0n }));
  assert.ok(short.kind === 'hold' && short.reason === 'balance-low', 'never more than is there, never a smaller amount');
  // The default 100 still holds this account, as the 500 did: 36 free is below any top-up plus 100.
  const at100 = decide(facts({ rule: rule({ amountCNS: 10n * AUSD }), freeFloorCNS: 36n * AUSD, minRemainingCNS: 100n * AUSD }));
  assert.ok(at100.kind === 'hold' && at100.reason === 'balance-low');
});

test("A FLOOR OF 0 LIFTS ONLY THE FLOOR: the rule's own ceiling, count, cooldown and the kill switch still bind", () => {
  const zero = { minRemainingCNS: 0n, freeFloorCNS: 9_000n * AUSD };
  assert.equal(decide(facts({ ...zero, rule: rule({ rescueCount: 2 }) })).kind, 'exhausted');
  assert.equal(decide(facts({ ...zero, rule: rule({ totalRescuedCNS: 150n * AUSD }) })).kind, 'exhausted', 'the total already set on the rule');
  const cool = decide(facts({ ...zero, rule: rule({ rescueCount: 1, lastAttemptAtMs: NOW - 60_000 }) }));
  assert.ok(cool.kind === 'hold' && cool.reason === 'cooldown');
  const stopped = decide(facts({ ...zero, automationStopped: true }));
  assert.ok(stopped.kind === 'hold' && stopped.reason === 'stopped');
  const fired = decide(facts(zero));
  assert.ok(fired.kind === 'fire' && fired.amountCNS === 100n * AUSD, 'the amount is the rule amount, never "everything"');
});

test('the kill switch outranks exhaustion: a stopped account is told it is stopped, not handed over', () => {
  const d = decide(facts({ automationStopped: true, rule: rule({ rescueCount: 2 }) }));
  assert.ok(d.kind === 'hold' && d.reason === 'stopped');
});
