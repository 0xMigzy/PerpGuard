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

test('the kill switch outranks exhaustion: a stopped account is told it is stopped, not handed over', () => {
  const d = decide(facts({ automationStopped: true, rule: rule({ rescueCount: 2 }) }));
  assert.ok(d.kind === 'hold' && d.reason === 'stopped');
});
