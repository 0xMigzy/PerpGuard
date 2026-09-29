/**
 * The position source that exists before the socket does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VenuePosition } from '@perpguard/shared';
import type { PositionSource } from '../risk/types.ts';
import { FIXTURE_BTC } from '../alerts/testSupport.ts';
import { DeferredPositionSource } from './deferredPositionSource.ts';

/** A stand-in for PerplPositionSource. */
function fakeSource(positions: readonly VenuePosition[]): PositionSource & {
  emit(next: readonly VenuePosition[]): void;
} {
  let current = positions;
  const listeners = new Set<(p: readonly VenuePosition[]) => void>();
  return {
    snapshot: () => current,
    onSnapshot: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: () => ({ state: 'live', lastUpdateMs: 1_000, ageMs: 5 }),
    emit(next) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

test('before a source is attached it is awaiting-snapshot, never live and never empty-live', () => {
  // "We have not been told" and "you have no positions" must not look alike.
  const deferred = new DeferredPositionSource({ reason: () => 'sign-in failed: 3401' });

  assert.equal(deferred.attached, false);
  assert.deepEqual(deferred.snapshot(), []);
  const status = deferred.status();
  assert.equal(status.state, 'awaiting-snapshot');
  assert.equal(status.reason, 'sign-in failed: 3401');
});

test('the reason is asked fresh each time, so it tracks the session', () => {
  let reason = 'connecting';
  const deferred = new DeferredPositionSource({ reason: () => reason });
  assert.equal(deferred.status().reason, 'connecting');
  reason = 'sign-in failed: 3401';
  assert.equal(deferred.status().reason, 'sign-in failed: 3401');
});

test('attaching hands over the real status and the real positions', () => {
  const deferred = new DeferredPositionSource({ reason: () => 'not yet' });
  deferred.attach(fakeSource([FIXTURE_BTC]));

  assert.equal(deferred.attached, true);
  assert.equal(deferred.status().state, 'live');
  assert.deepEqual(deferred.snapshot(), [FIXTURE_BTC]);
});

test('a subscriber from before the attach is told immediately, not on the next update', () => {
  // The snapshot that prompted the attach may already have arrived; a loop
  // waiting for the next one would sit idle holding nothing.
  const deferred = new DeferredPositionSource({ reason: () => 'not yet' });
  const seen: Array<readonly VenuePosition[]> = [];
  deferred.onSnapshot((positions) => seen.push(positions));

  deferred.attach(fakeSource([FIXTURE_BTC]));

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], [FIXTURE_BTC]);
});

test('later updates from the real source reach subscribers', () => {
  const deferred = new DeferredPositionSource({ reason: () => 'not yet' });
  const source = fakeSource([]);
  deferred.attach(source);

  const seen: Array<readonly VenuePosition[]> = [];
  deferred.onSnapshot((positions) => seen.push(positions));
  source.emit([FIXTURE_BTC]);

  assert.deepEqual(seen, [[FIXTURE_BTC]]);
  assert.deepEqual(deferred.snapshot(), [FIXTURE_BTC]);
});

test('re-attaching detaches the old source, so one update is not delivered twice', () => {
  const deferred = new DeferredPositionSource({ reason: () => 'not yet' });
  const first = fakeSource([]);
  deferred.attach(first);

  const seen: Array<readonly VenuePosition[]> = [];
  deferred.onSnapshot((positions) => seen.push(positions));
  seen.length = 0;

  deferred.attach(fakeSource([]));
  seen.length = 0;
  first.emit([FIXTURE_BTC]);

  assert.deepEqual(seen, []);
});
