/**
 * The lock, on its own.
 *
 * Small, but it is the only thing standing between a double tap and a second
 * top-up — for the one action that reports failure while applying in full, which
 * is exactly the shape that got a trader's margin committed twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InFlightRegistry } from './inflight.ts';

test('a second claim on one market is refused and names what holds it', () => {
  const registry = new InFlightRegistry({ now: () => 1_000_000 });
  const first = registry.claim(16, 'a');
  assert.ok(first.ok);

  const second = registry.claim(16, 'b');
  assert.equal(second.ok, false);
  assert.ok(!second.ok);
  assert.equal(second.held.idempotencyKey, 'a');
  assert.match(second.reason, /already in flight \(a/);
  // The word matters: a queue would send `b` the moment `a` settled.
  assert.match(second.reason, /Refusing rather than queueing/);
});

test('claims on different markets are independent', () => {
  const registry = new InFlightRegistry({ now: () => 1_000_000 });
  assert.ok(registry.claim(16, 'a').ok);
  assert.ok(registry.claim(20, 'b').ok);
  assert.equal(registry.size, 2);
});

test('releasing lets the next action through', () => {
  const registry = new InFlightRegistry({ now: () => 1_000_000 });
  const first = registry.claim(16, 'a');
  assert.ok(first.ok);
  registry.release(first.lease);
  assert.ok(registry.claim(16, 'b').ok);
});

test('a release only ever frees its own lease', () => {
  // A stale `finally` from an abandoned action must not free the lock a LIVE
  // action is holding — that would leave two actions genuinely in flight with
  // nothing left to notice.
  const clock = { nowMs: 1_000_000 };
  const registry = new InFlightRegistry({ now: () => clock.nowMs, staleAfterMs: 60_000 });
  const abandoned = registry.claim(16, 'old');
  assert.ok(abandoned.ok);
  registry.release(abandoned.lease);

  const live = registry.claim(16, 'new');
  assert.ok(live.ok);
  // The abandoned action's `finally` fires late.
  registry.release(abandoned.lease);
  assert.equal(registry.held(16)?.idempotencyKey, 'new', 'the live lease survives');
  assert.equal(registry.claim(16, 'third').ok, false);
});

test('a lease abandoned by a crashed process eventually stops locking the position out', () => {
  // The backstop, not a timeout for an action. Without it one abandoned lease
  // would lock a position out of every future rescue for the life of the
  // process — and the position needing a top-up would be the one that could not
  // have one.
  const clock = { nowMs: 1_000_000 };
  const registry = new InFlightRegistry({ now: () => clock.nowMs, staleAfterMs: 60_000 });
  assert.ok(registry.claim(16, 'crashed').ok);

  clock.nowMs += 59_999;
  assert.equal(registry.claim(16, 'next').ok, false, 'still held a millisecond short');

  clock.nowMs += 1;
  assert.ok(registry.claim(16, 'next').ok, 'and released at the backstop');
});

test('held() reports the lease for a UI to grey a button out', () => {
  const registry = new InFlightRegistry({ now: () => 1_000_000 });
  assert.equal(registry.held(16), undefined);
  registry.claim(16, 'a');
  assert.equal(registry.held(16)?.marketId, 16);
});
