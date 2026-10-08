/**
 * BLINDNESS IS ONE STATE PER ACCOUNT, AND IT IS NEWS ONLY AFTER A MINUTE
 * (owner, 8 Oct 2026). The trading socket dropped 43 times in an hour, each
 * back within a second, and each drop sent "price feed is down" / "lost track
 * of your positions" for EVERY position of the account, then a recovery each.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RiskAssessment, RiskChange, RiskState } from '../risk/types.ts';
import { AlertEngine } from './engine.ts';
import { StartupDeliveryGate } from './startupGate.ts';
import { assessOne, CONFIGS, DANGER_ETH, FakeTransport, FIXTURE_BTC, FIXTURE_BTC_MARK, RecordingLog, RecordingLogger } from './testSupport.ts';

function rig(options: { readonly gate?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const inner = new FakeTransport();
  const gateState = { clean: false };
  const gate = new StartupDeliveryGate({ inner, isClean: () => gateState.clean, deadlineMs: 180_000, now: () => clock.now });
  const listeners = new Set<(c: RiskChange) => void>();
  /** What the loop holds now, by account and market: what `snapshot()` returns. */
  const held = new Map<string, RiskAssessment>();
  const engine = new AlertEngine({
    source: {
      onChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
      snapshot: () => [...held.values()],
    },
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
    emit: async (c: RiskChange) => {
      held.set(`${c.assessment.accountId}:${c.assessment.marketId}`, c.assessment);
      for (const l of listeners) l(c);
      await engine.drain();
    },
    /** The loop drops a position that closed: no change is emitted. */
    closes: (c: RiskChange, accountId = 710) => held.delete(`${accountId}:${c.assessment.marketId}`),
    advance: async (ms: number) => {
      const end = clock.now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        clock.now = due.at;
        due.live = false;
        due.fn();
        await engine.drain();
      }
      clock.now = end;
    },
    /** DANGER already told for these, as it would be before any outage; later counts start after it. */
    prime: async (...cs: RiskChange[]) => {
      for (const c of cs) {
        held.set(`${c.assessment.accountId}:${c.assessment.marketId}`, c.assessment);
        for (const l of listeners) l(c);
      }
      await engine.drain();
      inner.sent.length = 0;
    },
    kinds: () => inner.sent.map((s) => s.message.kind),
    texts: () => inner.sent.map((s) => s.message.text),
  };
}

const btc = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change;
const eth = assessOne(DANGER_ETH, 3000).change;
type Blind = Extract<RiskState, 'FEED_DOWN' | 'POSITIONS_UNTRUSTED'>;
const on = (c: RiskChange, accountId: number, state: RiskState, previousState: RiskState | undefined, blind: boolean): RiskChange =>
  ({ ...c, previousState, assessment: { ...c.assessment, accountId, state, previousState, ...(blind ? { heldOnStalePrice: true, topUp: undefined } : {}) } }) as RiskChange;
const dark = (c: RiskChange, state: Blind, previousState: RiskState = 'DANGER', accountId = 710): RiskChange => on(c, accountId, state, previousState, true);
const back = (c: RiskChange, from: RiskState, accountId = 710): RiskChange => on(c, accountId, c.assessment.state, from, false);
const seen = (c: RiskChange, accountId = 710): RiskChange => on(c, accountId, c.assessment.state, undefined, false);

test('NOTHING FOR THE FIRST 60 SECONDS BLIND, and nothing at all when it clears inside them', async () => {
  const r = rig();
  await r.emit(seen(btc));
  await r.emit(seen(eth));
  const told = r.kinds().length;
  await r.emit(dark(btc, 'FEED_DOWN'));
  await r.emit(dark(eth, 'FEED_DOWN'));
  await r.advance(59_000);
  await r.emit(back(btc, 'FEED_DOWN'));
  await r.emit(back(eth, 'FEED_DOWN'));
  await r.advance(120_000);
  assert.equal(r.kinds().length, told, 'under a minute: no outage message, no recovery');
});

test('ONE MESSAGE PER ACCOUNT: two positions blind is one message naming both, and one when the LAST clears', async () => {
  const r = rig();
  await r.prime(seen(btc), seen(eth));
  await r.emit(dark(btc, 'FEED_DOWN'));
  await r.advance(10_000);
  await r.emit(dark(eth, 'FEED_DOWN'));
  await r.advance(50_000);
  assert.deepEqual(r.kinds(), ['feed-down']);
  assert.match(r.texts()[0]!, /lost sight of your positions/);
  assert.match(r.texts()[0]!, /Nothing automatic will run until I can see again/);

  await r.emit(back(btc, 'FEED_DOWN'));
  assert.deepEqual(r.kinds(), ['feed-down'], 'one of two back: still blind, nothing said');
  await r.emit(back(eth, 'FEED_DOWN'));
  assert.deepEqual(r.kinds(), ['feed-down', 'recovered']);
  assert.match(r.texts()[1]!, /I can see your positions again/);
});

test('ONE STATE: FEED_DOWN <-> POSITIONS_UNTRUSTED is never a message, and does not restart the minute', async () => {
  const r = rig();
  await r.emit(dark(btc, 'FEED_DOWN'));
  await r.advance(20_000);
  await r.emit(dark(btc, 'POSITIONS_UNTRUSTED', 'FEED_DOWN'));
  await r.emit(dark(eth, 'POSITIONS_UNTRUSTED'));
  await r.advance(20_000);
  await r.emit(dark(btc, 'FEED_DOWN', 'POSITIONS_UNTRUSTED'));
  assert.deepEqual(r.kinds(), []);
  await r.advance(20_000);
  assert.deepEqual(r.kinds(), ['feed-down'], 'one message at 60 s from the FIRST blind sight, naming the latest cause');
});

test('NOTHING MORE UNTIL IT CLEARS: five minutes of flapping causes after the message is still one message', async () => {
  const r = rig();
  await r.emit(dark(btc, 'POSITIONS_UNTRUSTED'));
  await r.emit(dark(eth, 'POSITIONS_UNTRUSTED'));
  await r.advance(60_000);
  for (let i = 0; i < 10; i++) {
    await r.emit(dark(i % 2 === 0 ? btc : eth, i % 3 === 0 ? 'FEED_DOWN' : 'POSITIONS_UNTRUSTED'));
    await r.advance(30_000);
  }
  assert.deepEqual(r.kinds(), ['positions-untrusted']);
});

test('A POSITION THAT CLOSES WHILE BLIND does not keep the spell open forever: the re-read clears it', async () => {
  const r = rig();
  await r.prime(seen(btc), seen(eth));
  await r.emit(dark(btc, 'FEED_DOWN'));
  await r.emit(dark(eth, 'FEED_DOWN'));
  await r.advance(60_000);
  await r.emit(back(btc, 'FEED_DOWN'));
  r.closes(eth); // the loop drops it; no change follows
  await r.advance(15_000);
  assert.deepEqual(r.kinds(), ['feed-down', 'recovered']);
  // And the next drop is news again, after its own minute.
  await r.emit(dark(btc, 'FEED_DOWN'));
  await r.advance(60_000);
  assert.deepEqual(r.kinds(), ['feed-down', 'recovered', 'feed-down']);
});

test('TWO ACCOUNTS ARE TWO SPELLS: one message each, cleared independently', async () => {
  const r = rig();
  await r.prime(seen(btc, 710), seen(btc, 24));
  await r.emit(dark(btc, 'FEED_DOWN', 'DANGER', 710));
  await r.emit(dark(btc, 'FEED_DOWN', 'DANGER', 24));
  await r.advance(60_000);
  const accounts = () => r.inner.sent.map((s) => `${s.message.kind} #${s.message.accountId}`);
  assert.deepEqual(accounts(), ['feed-down #710', 'feed-down #24']);
  await r.emit(back(btc, 'FEED_DOWN', 24));
  assert.deepEqual(accounts().slice(2), ['recovered #24']);
});

test('NOTHING IN THE FIRST 60 SECONDS AFTER A RESTART: boot blindness that clears in time is silent', async () => {
  const r = rig({ gate: true });
  await r.emit(dark(btc, 'POSITIONS_UNTRUSTED', 'POSITIONS_UNTRUSTED'));
  await r.emit(dark(eth, 'POSITIONS_UNTRUSTED', 'POSITIONS_UNTRUSTED'));
  await r.advance(5_000);
  r.gateState.clean = true;
  await r.emit(back(btc, 'POSITIONS_UNTRUSTED'));
  await r.emit(back(eth, 'POSITIONS_UNTRUSTED'));
  r.gate.check();
  await r.advance(120_000);
  // A real severity seen for the first time after boot is still delivered, as
  // the gate always has; what is pinned here is that blindness is not news.
  assert.deepEqual(r.kinds().filter((k) => k === 'feed-down' || k === 'positions-untrusted' || k === 'recovered'), []);
});

test('a position that comes back WORSE still gets its real alert, whatever the minute', async () => {
  const r = rig();
  await r.emit(dark(btc, 'FEED_DOWN', 'WATCH'));
  await r.advance(10_000);
  await r.emit(on(btc, 710, 'PAST_LIQUIDATION', 'FEED_DOWN', false));
  assert.deepEqual(r.kinds(), ['past-liquidation']);
});
