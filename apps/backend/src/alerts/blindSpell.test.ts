/**
 * BLINDNESS IS ONE STATE, AND IT IS NEWS ONLY AFTER A MINUTE (owner, 8 Oct
 * 2026). The trading socket dropped 43 times in an hour, each back within a
 * second, and each drop sent "price feed is down" / "lost track of your
 * positions" for every position, then a recovery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RiskChange, RiskState } from '../risk/types.ts';
import { AlertEngine } from './engine.ts';
import { StartupDeliveryGate } from './startupGate.ts';
import { assessOne, CONFIGS, FakeTransport, FIXTURE_BTC, FIXTURE_BTC_MARK, RecordingLog, RecordingLogger } from './testSupport.ts';

function rig(options: { readonly gate?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const inner = new FakeTransport();
  const gateState = { clean: false };
  const gate = new StartupDeliveryGate({ inner, isClean: () => gateState.clean, deadlineMs: 180_000, now: () => clock.now });
  const listeners = new Set<(c: RiskChange) => void>();
  const engine = new AlertEngine({
    source: { onChange: (l) => { listeners.add(l); return () => listeners.delete(l); } },
    configs: CONFIGS,
    transport: options.gate === true ? gate : inner,
    log: new RecordingLog(),
    logger: new RecordingLogger(),
    userId: 'owner',
    now: () => clock.now,
    sleep: async () => {},
    schedule: (fn, ms) => {
      const t = { at: clock.now + ms, fn, live: true };
      timers.push(t);
      return () => { t.live = false; };
    },
  });
  engine.start();
  return {
    engine, inner, gate, gateState,
    emit: async (c: RiskChange) => { for (const l of listeners) l(c); await engine.drain(); },
    advance: async (ms: number) => {
      clock.now += ms;
      for (const t of timers) if (t.live && t.at <= clock.now) { t.live = false; t.fn(); }
      await engine.drain();
    },
    kinds: () => inner.sent.map((s) => s.message.kind),
  };
}

const base = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change;
const blind = (state: Extract<RiskState, 'FEED_DOWN' | 'POSITIONS_UNTRUSTED'>, previousState: RiskState = 'DANGER'): RiskChange =>
  ({ ...base, previousState, assessment: { ...base.assessment, state, previousState, heldOnStalePrice: true, topUp: undefined } }) as RiskChange;
const back = (from: RiskState): RiskChange =>
  ({ ...base, previousState: from, assessment: { ...base.assessment, previousState: from } }) as RiskChange;

test('NOTHING FOR THE FIRST 60 SECONDS BLIND, and nothing at all when it clears inside them', async () => {
  const r = rig();
  await r.emit(base); // DANGER, told
  await r.emit(blind('FEED_DOWN'));
  await r.advance(59_000);
  assert.deepEqual(r.kinds(), ['danger']);
  await r.emit(back('FEED_DOWN'));
  await r.advance(120_000);
  assert.deepEqual(r.kinds(), ['danger'], 'under a minute: no outage message, no recovery');
});

test('ONE STATE: FEED_DOWN <-> POSITIONS_UNTRUSTED is never a message, and does not restart the minute', async () => {
  const r = rig();
  await r.emit(blind('FEED_DOWN'));
  await r.advance(20_000);
  await r.emit(blind('POSITIONS_UNTRUSTED', 'FEED_DOWN'));
  await r.advance(20_000);
  await r.emit(blind('FEED_DOWN', 'POSITIONS_UNTRUSTED'));
  assert.deepEqual(r.kinds(), []);
  await r.advance(20_000);
  assert.deepEqual(r.kinds(), ['feed-down'], 'one message at 60 s from the FIRST blind sight, naming the latest cause');
});

test('ONE MESSAGE AFTER 60 SECONDS, then nothing until it clears, then ONE when it clears', async () => {
  const r = rig();
  await r.emit(blind('POSITIONS_UNTRUSTED'));
  await r.advance(60_000);
  assert.deepEqual(r.kinds(), ['positions-untrusted']);
  for (let i = 0; i < 5; i++) {
    await r.emit(blind(i % 2 === 0 ? 'FEED_DOWN' : 'POSITIONS_UNTRUSTED'));
    await r.advance(60_000);
  }
  assert.deepEqual(r.kinds(), ['positions-untrusted'], 'five more minutes blind, flapping between causes: still one');
  await r.emit(back('FEED_DOWN'));
  assert.deepEqual(r.kinds(), ['positions-untrusted', 'recovered']);
  assert.match(r.inner.sent[1]!.message.text, /I can see it again/);
  assert.doesNotMatch(r.inner.sent[1]!.message.text, /Back above the safe threshold/, 'it came back in DANGER: never call that safe');
});

test('a NEW blind spell after a clear gets its own minute', async () => {
  const r = rig();
  await r.emit(blind('FEED_DOWN'));
  await r.advance(60_000);
  await r.emit(back('FEED_DOWN'));
  await r.emit(blind('FEED_DOWN'));
  await r.advance(30_000);
  assert.deepEqual(r.kinds(), ['feed-down', 'recovered']);
  await r.advance(30_000);
  assert.deepEqual(r.kinds(), ['feed-down', 'recovered', 'feed-down']);
});

test('NOTHING IN THE FIRST 60 SECONDS AFTER A RESTART: boot blindness that clears in time is silent', async () => {
  const r = rig({ gate: true });
  // Boot: everything blind while the socket signs in.
  await r.emit(blind('POSITIONS_UNTRUSTED', 'POSITIONS_UNTRUSTED'));
  await r.advance(5_000);
  r.gateState.clean = true;
  await r.emit(back('POSITIONS_UNTRUSTED'));
  r.gate.check();
  await r.advance(120_000);
  // A real severity seen for the first time after boot is still delivered, as
  // the gate always has; what is pinned here is that blindness is not news.
  assert.deepEqual(r.kinds().filter((k) => k === 'feed-down' || k === 'positions-untrusted' || k === 'recovered'), []);
});

test('a position that comes back WORSE still gets its real alert, whatever the minute', async () => {
  const r = rig();
  await r.emit(blind('FEED_DOWN', 'WATCH'));
  await r.advance(10_000);
  const past = { ...base, previousState: 'FEED_DOWN', assessment: { ...base.assessment, state: 'PAST_LIQUIDATION', previousState: 'FEED_DOWN' } } as RiskChange;
  await r.emit(past);
  assert.deepEqual(r.kinds(), ['past-liquidation']);
});
