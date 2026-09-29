/**
 * Startup ordering, against the REAL risk loop and the REAL alerts engine.
 *
 * The claim under test is specific: starting the stack before the gate opens
 * produces a burst of false FEED_DOWN alerts, and starting it after the gate
 * does not. Both halves are asserted, because a test that only showed the good
 * case would not show that the gate is doing anything.
 *
 * The scenario is the ordinary one at boot. The trading socket signs in fast —
 * one REST call and one websocket frame — while the market-data socket is still
 * completing its first connect. For that window the position set is live and the
 * feed is not, which is exactly when the loop assesses every position as blind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '../alerts/engine.ts';
import {
  CONFIGS,
  FIXTURE_BTC,
  FIXTURE_BTC_MARK,
  FakeSleep,
  FakeTransport,
  LoopHarness,
  RecordingLog,
  RecordingLogger,
} from '../alerts/testSupport.ts';
import { waitUntilReady } from './lifecycle.ts';

/** A stack mid-boot: positions already live, the price feed still connecting. */
function booting(): {
  readonly harness: LoopHarness;
  readonly engine: AlertEngine;
  readonly transport: FakeTransport;
} {
  const harness = new LoopHarness();
  harness.health = {
    state: 'reconnecting',
    reason: 'the market data socket is still completing its first connect',
    reconnectAttempt: 1,
  };
  harness.positions = [FIXTURE_BTC];
  harness.positionsState = 'live';
  // A price is already held: the feed connected once and is retrying. Age alone
  // cannot tell this from a quiet market, which is why the gate asks the feed.
  harness.price(FIXTURE_BTC.marketId, FIXTURE_BTC.symbol, FIXTURE_BTC_MARK);

  const transport = new FakeTransport();
  const engine = new AlertEngine({
    source: harness.loop,
    configs: CONFIGS,
    transport,
    log: new RecordingLog(),
    userId: 'trader-1',
    sleep: new FakeSleep().sleep,
    logger: new RecordingLogger(),
  });
  return { harness, engine, transport };
}

const kinds = (transport: FakeTransport): string[] =>
  transport.sent.map((sent) => `${sent.message.symbol} ${sent.message.kind}`);

test('starting before the feed is up fires a FEED_DOWN alert about a feed that was merely starting', async () => {
  // This is the burst the gate exists to prevent. Asserting it keeps the gate
  // from being quietly deleted as unnecessary.
  const { harness, engine, transport } = booting();

  engine.start();
  harness.loop.start();
  await engine.drain();

  assert.deepEqual(kinds(transport), ['BTC feed-down']);
});

test('waiting for both halves of the gate produces the real assessment and nothing else', async () => {
  const { harness, engine, transport } = booting();

  // The feed finishes connecting on the third poll, as it would in a real boot.
  let polls = 0;
  const outcome = await waitUntilReady({
    isReady: () => {
      polls += 1;
      if (polls === 3) harness.health = { state: 'connected', reconnectAttempt: 0 };
      return (
        harness.loop.positionsStatus().state === 'live' && harness.health.state === 'connected'
      );
    },
    timeoutMs: 20_000,
    pollMs: 50,
    sleep: async () => {},
  });

  assert.equal(outcome.ready, true);

  engine.start();
  harness.loop.start();
  await engine.drain();

  // One alert, and it is the position's real severity — not a feed complaint.
  assert.deepEqual(kinds(transport), ['BTC danger']);
});

test('the gate waits for the position snapshot too, not just the feed', async () => {
  // Before the snapshot the set is `awaiting-snapshot`, which is not "no
  // positions" and must not be treated as ready.
  const harness = new LoopHarness();
  harness.health = { state: 'connected', reconnectAttempt: 0 };
  harness.positionsState = 'awaiting-snapshot';
  harness.positions = [];

  const outcome = await waitUntilReady({
    isReady: () =>
      harness.loop.positionsStatus().state === 'live' && harness.health.state === 'connected',
    timeoutMs: 300,
    pollMs: 100,
    sleep: async () => {},
    now: (() => {
      let t = 0;
      return () => (t += 100);
    })(),
  });

  assert.equal(outcome.ready, false);
});

test('a stack that never becomes ready still alerts nothing, so giving up is safe', async () => {
  // The timeout path: sign-in never succeeded, so the position set is empty and
  // the loop has nothing to assess. Starting anyway keeps /health working.
  const harness = new LoopHarness();
  harness.health = { state: 'connected', reconnectAttempt: 0 };
  harness.positionsState = 'awaiting-snapshot';
  harness.positions = [];

  const transport = new FakeTransport();
  const engine = new AlertEngine({
    source: harness.loop,
    configs: CONFIGS,
    transport,
    log: new RecordingLog(),
    userId: 'trader-1',
    sleep: new FakeSleep().sleep,
    logger: new RecordingLogger(),
  });

  engine.start();
  harness.loop.start();
  harness.loop.evaluate();
  await engine.drain();

  assert.deepEqual(transport.sent, []);
});

test('once the gate has opened, a feed that really drops does alert', async () => {
  // The gate delays the first assessment; it must not suppress a genuine outage
  // afterwards.
  const { harness, engine, transport } = booting();
  harness.health = { state: 'connected', reconnectAttempt: 0 };

  engine.start();
  harness.loop.start();
  await engine.drain();
  assert.deepEqual(kinds(transport), ['BTC danger']);

  harness.health = {
    state: 'disconnected',
    reason: 'the socket closed with 1006',
    reconnectAttempt: 4,
  };
  harness.advance(1_000);
  harness.loop.evaluate();
  await engine.drain();

  assert.deepEqual(kinds(transport), ['BTC danger', 'BTC feed-down']);
});
