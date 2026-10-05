/**
 * The startup gate and the shutdown sequence, with every clock injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShutdownSequence, waitUntilReady } from './lifecycle.ts';

/** A clock that only moves when something sleeps. */
function fakeClock(startMs = 0): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let nowMs = startMs;
  const slept: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      slept.push(ms);
      nowMs += ms;
    },
    slept,
  };
}

// ── the gate ────────────────────────────────────────────────────────────────

test('a condition already met returns immediately, without sleeping', async () => {
  const clock = fakeClock();
  const outcome = await waitUntilReady({
    isReady: () => true,
    timeoutMs: 20_000,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(outcome, { ready: true, waitedMs: 0, polls: 1 });
  assert.deepEqual(clock.slept, []);
});

test('it polls until the condition becomes true, and reports how long it waited', async () => {
  const clock = fakeClock();
  let polls = 0;
  const outcome = await waitUntilReady({
    isReady: () => (polls += 1) >= 4,
    timeoutMs: 20_000,
    pollMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(outcome.ready, true);
  assert.equal(outcome.polls, 4);
  assert.equal(outcome.waitedMs, 300);
});

test('it gives up rather than blocking, and says so instead of throwing', async () => {
  // A timeout is not a failure: with no position set there is nothing to assess,
  // so starting anyway keeps the feed and /health working.
  const clock = fakeClock();
  const outcome = await waitUntilReady({
    isReady: () => false,
    timeoutMs: 500,
    pollMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(outcome.ready, false);
  assert.equal(outcome.waitedMs, 500);
});

test('the final sleep never overshoots the deadline', async () => {
  const clock = fakeClock();
  await waitUntilReady({
    isReady: () => false,
    timeoutMs: 250,
    pollMs: 100,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(clock.slept, [100, 100, 50]);
});

// ── shutdown ────────────────────────────────────────────────────────────────

test('steps run in the order they were added', async () => {
  const order: string[] = [];
  const sequence = new ShutdownSequence()
    .add('stop the loop', () => void order.push('loop'))
    .add('drain alerts', async () => void order.push('drain'))
    .add('close sockets', () => void order.push('sockets'));

  const results = await sequence.run();
  assert.deepEqual(order, ['loop', 'drain', 'sockets']);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
});

test('an in-flight delivery is awaited before the steps after it run', async () => {
  // A half-sent DANGER alert on restart is worse than a late one.
  const order: string[] = [];
  let resolveDrain: (() => void) | undefined;
  const drained = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });

  const sequence = new ShutdownSequence()
    .add('drain alerts', async () => {
      order.push('drain started');
      await drained;
      order.push('drain finished');
    })
    .add('close sockets', () => void order.push('sockets closed'));

  const run = sequence.run();
  // The socket step must not have run while the drain was outstanding.
  await Promise.resolve();
  assert.deepEqual(order, ['drain started']);

  resolveDrain?.();
  await run;
  assert.deepEqual(order, ['drain started', 'drain finished', 'sockets closed']);
});

test('a failing step is recorded and the rest still run', async () => {
  // A socket that throws on close is no reason to skip draining the queue.
  const order: string[] = [];
  const sequence = new ShutdownSequence()
    .add('close the trading socket', () => {
      throw new Error('socket already gone');
    })
    .add('drain alerts', () => void order.push('drain'));

  const results = await sequence.run();
  assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.error ?? '', /socket already gone/);
  assert.equal(results[1]!.ok, true);
  assert.deepEqual(order, ['drain']);
});

test('a step that never finishes is bounded by the deadline', async () => {
  // A fixed clock: the step's budget is the deadline minus time already spent,
  // and a real clock ticking between the sequence's start and the first step
  // made the budget 19ms about once in twenty runs. The timer itself is real.
  const sequence = new ShutdownSequence({ deadlineMs: 20, now: () => 1_000 })
    .add('wedged socket', () => new Promise<void>(() => {}))
    .add('still runs', () => {});

  const results = await sequence.run();
  assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.error ?? '', /timed out after 20ms/);
  assert.equal(results.length, 2);
});

test('once the budget is spent, later steps are skipped rather than run forever', async () => {
  const clock = fakeClock();
  let ran = false;
  const sequence = new ShutdownSequence({
    deadlineMs: 10,
    now: () => {
      // Two readings per step; the first step consumes the whole budget.
      const t = clock.now();
      void clock.sleep(20);
      return t;
    },
  })
    .add('slow', () => {})
    .add('skipped', () => void (ran = true));

  const results = await sequence.run();
  assert.equal(ran, false);
  assert.match(results[1]!.error ?? '', /budget was already spent/);
});

test('a second signal joins the running shutdown rather than starting another', async () => {
  // Closing the same socket twice, concurrently, is how a clean shutdown turns
  // into a stack trace on the way out.
  let runs = 0;
  const sequence = new ShutdownSequence().add('close once', async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  assert.equal(sequence.started, false);
  const [a, b] = await Promise.all([sequence.run(), sequence.run()]);
  assert.equal(runs, 1);
  assert.equal(sequence.started, true);
  assert.deepEqual(a, b);
});
