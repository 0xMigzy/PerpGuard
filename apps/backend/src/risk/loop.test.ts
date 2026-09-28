/**
 * The loop, against a driven feed and a driven position source.
 *
 * Everything is injected — clock, feed health, prices, positions — so these run
 * instantly and deterministically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedHealth, MarketRiskConfig, PriceUpdate, VenuePosition } from '@perpguard/shared';
import { MarketFeed } from '../ingest/marketFeed.ts';
import { RiskLoop } from './loop.ts';
import { DEFAULT_THRESHOLDS, type PositionSource, type RiskChange } from './types.ts';

const STALE_MS = 10_000;
const BTC: MarketRiskConfig = {
  marketId: 1,
  symbol: 'BTC',
  priceDecimals: 1,
  lotDecimals: 5,
  collateralDecimals: 6,
  maintenanceMargin: 2500,
  initialMargin: 1500,
};
const ETH: MarketRiskConfig = {
  marketId: 20,
  symbol: 'ETH',
  priceDecimals: 2,
  lotDecimals: 3,
  collateralDecimals: 6,
  maintenanceMargin: 2000,
  initialMargin: 1000,
};
const configs = new Map([
  [1, BTC],
  [20, ETH],
]);

/** 0.5 BTC long, entry 84029.5, margin 2810.33 — the ground-truth fixture. */
const btcLong: VenuePosition = {
  venue: 'perpl',
  network: 'mainnet',
  symbol: 'BTC',
  marketId: 1,
  side: 'long',
  size: 0.5,
  entryPrice: 84029.5,
  markPrice: 84007.3,
  margin: 2810.33,
  marginMode: 'isolated',
  leverage: 15,
  fundingAccrued: 0,
};
/**
 * The fixture position's buffer is 2.66%, which is BELOW the 3% danger
 * threshold — a real 15x BTC position genuinely is in danger territory. For the
 * healthy baseline it needs materially more margin: at 6000 AUSD the
 * liquidation price is 75390.7 and the buffer 10.26%.
 */
const btcSafe: VenuePosition = { ...btcLong, margin: 6000 };

/** 10 ETH short, entry 3000, margin 6000: liquidation at 3450, a 15% buffer. */
const ethShort: VenuePosition = {
  ...btcLong,
  symbol: 'ETH',
  marketId: 20,
  side: 'short',
  size: 10,
  entryPrice: 3000,
  markPrice: 3000,
  margin: 6000,
  leverage: 10,
};

const priceUpdate = (marketId: number, symbol: string, markPrice: number, atMs: number): PriceUpdate => ({
  venue: 'perpl',
  network: 'mainnet',
  symbol,
  marketId,
  markPrice,
  oraclePrice: markPrice,
  midPrice: markPrice,
  bid: markPrice,
  ask: markPrice,
  atBlock: 1,
  atMs,
  receivedAtMs: atMs,
});

class Harness {
  nowMs = 1_000_000;
  health: FeedHealth = { state: 'connected', reconnectAttempt: 0 };
  positions: VenuePosition[] = [];
  readonly feed: MarketFeed;
  readonly loop: RiskLoop;
  readonly changes: RiskChange[] = [];
  readonly #listeners = new Set<(p: readonly VenuePosition[]) => void>();

  constructor(thresholds?: Partial<typeof DEFAULT_THRESHOLDS>) {
    this.feed = new MarketFeed(STALE_MS, () => this.nowMs);
    const source: PositionSource = {
      snapshot: () => this.positions,
      onSnapshot: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
    this.loop = new RiskLoop({
      feed: this.feed,
      positions: source,
      feedStatus: () => this.health,
      configs,
      ...(thresholds ? { thresholds } : {}),
      now: () => this.nowMs,
    });
    this.loop.onChange((c) => this.changes.push(c));
  }

  price(marketId: number, symbol: string, markPrice: number): void {
    this.feed.record(priceUpdate(marketId, symbol, markPrice, this.nowMs));
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  stateOf(marketId: number): string | undefined {
    return this.loop.snapshot().find((a) => a.marketId === marketId)?.state;
  }
}

// ── basics ───────────────────────────────────────────────────────────────────

test('a healthy position assesses as SAFE and carries every number with it', () => {
  const h = new Harness();
  h.positions = [btcSafe];
  h.price(1, 'BTC', 84007.3);
  const [assessment] = h.loop.evaluate();

  assert.equal(assessment!.state, 'SAFE');
  assert.equal(assessment!.symbol, 'BTC');
  assert.ok(Math.abs(assessment!.liqBufferPct! - 0.1026) < 0.0005);
  assert.equal(assessment!.liquidationPricePNS, 753_907n);
  assert.equal(assessment!.markPricePNS, 840_073n);
  assert.equal(assessment!.marginToSurviveCNS, 0n);
  assert.equal(assessment!.marginToSafeCNS, 0n, 'already past the 9% safe threshold');
  assert.equal(assessment!.heldOnStalePrice, false);
  assert.equal(assessment!.priceIsOld, false);
  assert.equal(assessment!.feed, 'connected');
  assert.equal(h.changes.length, 1);
});

test('the ground-truth fixture position is DANGER on these defaults, and says what it would take', () => {
  // A real 0.5 BTC at 15x with a 2.66% buffer. The engine's own numbers, so this
  // is also a check that the loop is genuinely going through it.
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  const [assessment] = h.loop.evaluate();

  assert.equal(assessment!.state, 'DANGER');
  assert.ok(Math.abs(assessment!.liqBufferPct! - 0.0266) < 0.0005);
  assert.equal(assessment!.liquidationPricePNS, 817_701n);
  assert.equal(assessment!.marginToSurviveCNS, 0n, 'not liquidatable yet, just close');
  assert.ok(
    assessment!.marginToSafeCNS > 0n,
    'but it takes real margin to climb from 2.66% back to the 9% safe threshold',
  );
});

test('a position with no price at all is not assessed, rather than assumed safe', () => {
  const h = new Harness();
  h.positions = [btcLong];
  assert.deepEqual(h.loop.evaluate(), []);
  assert.deepEqual(h.loop.snapshot(), []);
  assert.equal(h.changes.length, 0);
});

test('a closed position stops being tracked', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  assert.equal(h.loop.snapshot().length, 1);
  h.positions = [];
  h.loop.evaluate();
  assert.deepEqual(h.loop.snapshot(), []);
});

test('start() subscribes and assesses what is already open', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.start();
  assert.equal(h.changes.length, 1);
  h.loop.stop();
});

// ── the gap move ─────────────────────────────────────────────────────────────

test('a gap move takes a position from SAFE to PAST_LIQUIDATION in one tick', () => {
  const h = new Harness();
  h.positions = [btcSafe];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'SAFE');

  // Straight through WATCH and DANGER, below the 75390.7 liquidation price.
  h.advance(1_000);
  h.price(1, 'BTC', 74000);
  const [assessment] = h.loop.evaluate();

  assert.equal(assessment!.state, 'PAST_LIQUIDATION');
  assert.equal(assessment!.previousState, 'SAFE');
  assert.ok(assessment!.liqBufferPct! < 0, 'a doomed position reports a negative buffer');
  assert.ok(assessment!.marginToSurviveCNS > 0n);
  assert.equal(h.changes.length, 2, 'one for SAFE, one for the gap — no intermediate states');
  assert.deepEqual(
    h.changes.map((c) => c.assessment.state),
    ['SAFE', 'PAST_LIQUIDATION'],
  );
});

// ── feed down ────────────────────────────────────────────────────────────────

test('a disconnected feed refuses to evaluate and says so, keeping the last known state', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000); // ~2.6% buffer, inside DANGER territory
  h.loop.evaluate();
  const before = h.stateOf(1);
  assert.equal(before, 'DANGER');

  h.advance(1_000);
  h.health = { state: 'disconnected', reconnectAttempt: 3, reason: 'socket closed' };
  const [assessment] = h.loop.evaluate();

  assert.equal(assessment!.state, 'FEED_DOWN');
  assert.equal(assessment!.lastKnownState, 'DANGER', 'the last thing we knew stays visible');
  assert.equal(assessment!.heldOnStalePrice, true);
  assert.equal(assessment!.reason, 'socket closed');
  // The last numbers are still there for the UI, not blanked.
  assert.equal(assessment!.liquidationPricePNS, 817_701n);
});

test('a feed that goes down and comes back resumes from the severity it left on', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER');

  h.health = { state: 'reconnecting', reconnectAttempt: 1 };
  h.advance(1_000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'FEED_DOWN');

  // Back up, and the market has recovered a long way: at 90000 the buffer is
  // 9.14%, comfortably past the 9% exit threshold.
  h.health = { state: 'connected', reconnectAttempt: 0 };
  h.advance(1_000);
  h.price(1, 'BTC', 90000);
  h.loop.evaluate();

  // The outage must not become a shortcut to an all-clear: dwell is re-served
  // from the moment of recovery, so this is still DANGER.
  assert.equal(h.stateOf(1), 'DANGER');
  h.advance(DEFAULT_THRESHOLDS.minDwellMs);
  h.price(1, 'BTC', 90000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'SAFE', 'and only softens once the dwell has been served');
});

test('a feed outage does not emit a second FEED_DOWN on every tick', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  h.health = { state: 'disconnected', reconnectAttempt: 1 };
  for (let i = 0; i < 5; i += 1) {
    h.advance(1_000);
    h.loop.evaluate();
  }
  const feedDownEvents = h.changes.filter((c) => c.assessment.state === 'FEED_DOWN');
  assert.equal(feedDownEvents.length, 1);
});

// ── one market quiet, others live ────────────────────────────────────────────

test('a quiet market holds while a live one keeps transitioning normally', () => {
  const h = new Harness();
  h.positions = [btcLong, ethShort];
  h.price(1, 'BTC', 82000); // BTC into DANGER
  h.price(20, 'ETH', 3000); // ETH healthy
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER');
  assert.equal(h.stateOf(20), 'SAFE');

  // BTC goes quiet. ETH keeps ticking, and moves against the short.
  h.advance(STALE_MS + 1);
  h.price(20, 'ETH', 3400); // the short is now 1.47% from its 3450 liquidation
  const produced = h.loop.evaluate();

  const btc = produced.find((a) => a.marketId === 1)!;
  const eth = produced.find((a) => a.marketId === 20)!;

  assert.equal(btc.priceIsOld, true);
  assert.equal(btc.heldOnStalePrice, true);
  assert.equal(btc.state, 'DANGER', 'the quiet market holds');
  assert.equal(btc.feed, 'connected', 'and is NOT reported as a broken feed');
  assert.ok(btc.priceAgeMs! > STALE_MS);

  assert.equal(eth.priceIsOld, false);
  assert.equal(eth.heldOnStalePrice, false);
  assert.equal(eth.state, 'DANGER', 'the live market transitions as usual');
});

test('NEVER an all-clear from a stale price: a DANGER position whose market goes quiet stays in DANGER', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER');
  const changesAfterDanger = h.changes.length;

  // The market goes quiet and stays quiet for a day. The last price we hold
  // happens to be a recovered one, which is exactly the trap: acting on it
  // would tell the trader they are fine on data a day old.
  h.advance(STALE_MS + 1);
  h.feed.record(priceUpdate(1, 'BTC', 90000, h.nowMs - (STALE_MS + 1)));

  for (const step of [1_000, 60_000, 3_600_000, 86_400_000]) {
    h.advance(step);
    const [assessment] = h.loop.evaluate();
    assert.equal(assessment!.state, 'DANGER', `still DANGER after another ${step}ms`);
    assert.equal(assessment!.heldOnStalePrice, true);
  }
  assert.equal(
    h.changes.length,
    changesAfterDanger,
    'and not one recovery event was emitted, however long it sat there',
  );
});

test('a quiet market resumes normal transitions the moment a fresh price arrives', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();
  h.advance(STALE_MS + 1);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER');

  h.advance(DEFAULT_THRESHOLDS.minDwellMs);
  h.price(1, 'BTC', 90000); // fresh, and recovered well past the exit threshold
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'SAFE');
});

// ── flapping, end to end ─────────────────────────────────────────────────────

test('a price series oscillating across the boundary emits one alert, not one per tick', () => {
  const h = new Harness();
  h.positions = [btcLong];
  // Prices either side of the 3% buffer boundary (liq is 81770).
  const series = [84300, 84200, 84310, 84205, 84295, 84215, 84300, 84200];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  const baseline = h.changes.length;

  for (const price of series) {
    h.advance(DEFAULT_THRESHOLDS.minDwellMs * 2);
    h.price(1, 'BTC', price);
    h.loop.evaluate();
  }
  const transitions = h.changes.length - baseline;
  assert.ok(
    transitions <= 1,
    `expected at most one transition across the boundary, got ${transitions}: ` +
      h.changes.slice(baseline).map((c) => c.assessment.state).join(' -> '),
  );
});
