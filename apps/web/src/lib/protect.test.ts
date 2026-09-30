import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestToLiquidation, meterPosition, stepsFor, tierOf, venueDisagrees } from './protect.ts';

test('the meter puts a negative buffer at zero and a danger buffer inside the red band', () => {
  assert.equal(meterPosition(-0.02, 0.03, 0.08), 0, 'past liquidation has no runway');
  assert.equal(meterPosition(undefined, 0.03, 0.08), 0);
  const danger = meterPosition(0.0266, 0.03, 0.08);
  assert.ok(danger > 0.15 && danger < 0.2, `2.66% sits near the end of the red fifth, got ${danger}`);
  assert.equal(meterPosition(0.03, 0.03, 0.08), 0.2, 'the danger boundary is the band edge');
  assert.equal(meterPosition(0.08, 0.03, 0.08), 0.5);
  assert.equal(meterPosition(0.5, 0.03, 0.08), 1, 'capped');
});

test('closest to liquidation prefers the negative buffer and ignores blind positions', () => {
  const p = (symbol: string, liqBufferPct: number | undefined, state = 'DANGER') => ({ symbol, liqBufferPct, state }) as never;
  assert.equal(closestToLiquidation([p('A', 0.05), p('B', -0.01, 'PAST_LIQUIDATION'), p('C', 0.001, 'FEED_DOWN')])?.symbol, 'B');
  assert.equal(closestToLiquidation([p('C', 0.001, 'FEED_DOWN')]), undefined);
  assert.equal(tierOf('POSITIONS_UNTRUSTED'), 'blind');
});

test('steps are ticked only by what happened, and a timeout reads as no reply, not failure', () => {
  const at = (stage: string, reported?: { status: string; reason?: string }) => ({ stage, reported }) as never;
  assert.deepEqual(stepsFor(undefined).map((s) => s.status), ['pending', 'pending', 'pending']);
  assert.deepEqual(stepsFor(at('sending')).map((s) => s.status), ['active', 'active', 'pending']);
  const rejected = stepsFor(at('reconciling', { status: 'rejected', reason: 'st 7 Failed, sr 32' }));
  assert.deepEqual(rejected.map((s) => s.status), ['done', 'done', 'active']);
  assert.match(rejected[1]!.label, /Venue replied: rejected · st 7 Failed, sr 32/);
  const timeout = stepsFor(at('settled', { status: 'timeout' }));
  assert.equal(timeout[1]!.status, 'failed');
  assert.match(timeout[1]!.label, /No reply/);
  assert.equal(timeout[2]!.status, 'done');
});

test('the venue disagreeing with the position is exactly sr 32 and the dropped-forwarder case', () => {
  const p = (status: string, verdict: string) => ({ outcome: { kind: 'applied', reported: { status }, reconciliation: { verdict } } }) as never;
  assert.equal(venueDisagrees(p('rejected', 'applied')), true);
  assert.equal(venueDisagrees(p('forwarded', 'not-applied')), true);
  assert.equal(venueDisagrees(p('rejected', 'not-applied')), false);
  assert.equal(venueDisagrees(p('confirmed', 'applied')), false);
  assert.equal(venueDisagrees({ outcome: { kind: 'kill-switch' } } as never), false);
});
