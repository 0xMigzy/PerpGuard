/**
 * The loop, against a driven feed and a driven position source.
 *
 * Everything is injected — clock, feed health, prices, positions — so these run
 * instantly and deterministically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  FeedHealth,
  MarketRiskConfig,
  PositionSourceStatus,
  PriceUpdate,
  VenuePosition,
} from '@perpguard/shared';
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

const liveStatus: PositionSourceStatus = {
  state: 'live',
  lastUpdateMs: 1_000_000,
  ageMs: 0,
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
  /** Position-set health, driven independently of the price feed. */
  positionsState: PositionSourceStatus['state'] = 'live';
  positionsReason: string | undefined;
  positionsUpdatedAtMs: number | undefined = 1_000_000;
  readonly feed: MarketFeed;
  readonly loop: RiskLoop;
  readonly changes: RiskChange[] = [];
  readonly #listeners = new Set<(p: readonly VenuePosition[]) => void>();

  constructor(thresholds?: Partial<typeof DEFAULT_THRESHOLDS>) {
    this.feed = new MarketFeed('mainnet', STALE_MS, () => this.nowMs);
    const source: PositionSource = {
      snapshot: () => this.positions,
      onSnapshot: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
      status: () => ({
        state: this.positionsState,
        ...(this.positionsReason === undefined ? {} : { reason: this.positionsReason }),
        lastUpdateMs: this.positionsUpdatedAtMs,
        ageMs:
          this.positionsUpdatedAtMs === undefined
            ? undefined
            : this.nowMs - this.positionsUpdatedAtMs,
      }),
    };
    this.loop = new RiskLoop({
      network: 'mainnet',
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
  assert.equal(assessment!.topUp?.toSafe.amountCNS, 0n, 'already past the 9% safe threshold');
  assert.equal(assessment!.topUp?.clearDanger.amountCNS, 0n, 'and past the 4% danger exit');
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
    assessment!.topUp!.toSafe.amountCNS > 0n,
    'but it takes real margin to climb from 2.66% back to the 9% safe threshold',
  );

  // Both top-ups, with where each one lands. These are the numbers an alert
  // quotes, so they are pinned exactly rather than to a tolerance.
  const { clearDanger, toSafe } = assessment!.topUp!;
  assert.equal(clearDanger.amountCNS, 561_460_000n, '561.46 AUSD to reach the 4% danger exit');
  assert.equal(clearDanger.resultingLiquidationPricePNS, 806_471n);
  assert.ok(Math.abs(clearDanger.resultingBufferPct! - 0.04) < 1e-4);
  assert.equal(toSafe.amountCNS, 2_661_660_000n, '2661.66 AUSD to reach the 9% safe threshold');
  assert.equal(toSafe.resultingLiquidationPricePNS, 764_467n);
  assert.ok(Math.abs(toSafe.resultingBufferPct! - 0.09) < 1e-4);

  // The cheap option is genuinely cheaper, and genuinely buys less.
  assert.ok(clearDanger.amountCNS < toSafe.amountCNS);
  assert.ok(
    clearDanger.resultingLiquidationPricePNS! > toSafe.resultingLiquidationPricePNS!,
    'a long that tops up less keeps a higher liquidation price',
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

// ── one network per loop ──────────────────────────────────────────────────────
//
// Both networks list BTC. A testnet position priced off a mainnet mark produces
// a liquidation price, a buffer and an alert that are all wrong and all
// completely plausible, so mixing has to be impossible to express rather than
// merely discouraged.

test('a loop cannot be built over a feed for another network', () => {
  const testnetFeed = new MarketFeed('testnet', STALE_MS);
  assert.throws(
    () =>
      new RiskLoop({
        network: 'mainnet',
        feed: testnetFeed,
        positions: { snapshot: () => [], onSnapshot: () => () => {}, status: () => liveStatus },
        feedStatus: () => ({ state: 'connected', reconnectAttempt: 0 }),
        configs,
      }),
    (error: unknown) =>
      error instanceof RangeError && /mainnet but its market feed is for testnet/.test(error.message),
  );
});

test('a feed refuses a price from the wrong network rather than recording it', () => {
  const feed = new MarketFeed('mainnet', STALE_MS);
  assert.throws(
    () => feed.record({ ...priceUpdate(16, 'BTC', 84_000, 1), network: 'testnet' }),
    (error: unknown) =>
      error instanceof RangeError && /refusing a testnet price for BTC/.test(error.message),
  );
  assert.equal(feed.size, 0, 'and nothing was recorded');
});

test('a position from the wrong network halts the loop rather than being assessed', () => {
  const h = new Harness();
  h.price(1, 'BTC', 84_007.3);
  // The same asset, the same symbol, a different network: everything the risk
  // maths reads would be present and wrong.
  h.positions = [{ ...btcSafe, network: 'testnet' }];
  assert.throws(
    () => h.loop.evaluate(),
    (error: unknown) =>
      error instanceof RangeError &&
      /refusing a testnet position in BTC/.test(error.message),
  );
});

// ── positions untrustworthy ──────────────────────────────────────────────────
//
// The THIRD health question, separate from both connection health and price age.
// A price at least carries a timestamp; a position closed a minute ago looks
// exactly like one still open, so the source has to volunteer the answer and the
// loop has to refuse on it.

test('an untrustworthy position set refuses to evaluate, and blames the positions rather than the feed', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER');

  // The socket dropped. The price feed is perfectly healthy.
  h.advance(1_000);
  h.positionsState = 'stale';
  h.positionsReason = 'the trading socket is closed, so the positions we hold are frozen';
  const [assessment] = h.loop.evaluate();

  assert.equal(assessment!.state, 'POSITIONS_UNTRUSTED');
  assert.equal(assessment!.feed, 'connected', 'the price feed was never the problem');
  assert.equal(assessment!.positions, 'stale');
  assert.match(assessment!.reason, /trading socket is closed/);
  assert.doesNotMatch(
    assessment!.reason,
    /price feed/,
    'naming the wrong cause is a false explanation',
  );
  assert.equal(assessment!.lastKnownState, 'DANGER', 'the last thing we knew stays visible');
  assert.equal(assessment!.liquidationPricePNS, 817_701n, 'and its numbers, not blanked');
});

test('an untrustworthy set can never produce an all-clear, whatever the price says', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER');

  // A fresh price arrives showing a huge recovery, while the position set is
  // frozen. The recovery may be real; whether this position still exists is not
  // something we know, so it buys no reassurance.
  h.positionsState = 'stale';
  h.positionsReason = 'a heartbeat sequence gap means a position update may have been missed';
  h.advance(DEFAULT_THRESHOLDS.minDwellMs * 2);
  h.price(1, 'BTC', 95000);
  const [assessment] = h.loop.evaluate();

  assert.equal(assessment!.state, 'POSITIONS_UNTRUSTED');
  assert.equal(
    assessment!.heldOnStalePrice,
    true,
    'the alerts contract must still forbid a reassuring message',
  );
});

test('a position is NOT forgotten while the set cannot be believed', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER');

  // A missed update could remove a position from the set that is in fact still
  // open. Absence is only evidence of closure when the set can be believed.
  h.positionsState = 'stale';
  h.positionsReason = 'a heartbeat sequence gap means a position update may have been missed';
  h.positions = [];
  h.advance(1_000);
  h.loop.evaluate();

  assert.equal(
    h.stateOf(1),
    'POSITIONS_UNTRUSTED',
    'still tracked, and still saying we cannot see it',
  );

  // Once the set is trustworthy again, the same absence IS evidence.
  h.positionsState = 'live';
  h.positionsReason = undefined;
  h.advance(1_000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), undefined, 'now it really is gone');
});

test('awaiting the first snapshot is not the same answer as an empty portfolio', () => {
  const h = new Harness();
  h.positionsState = 'awaiting-snapshot';
  h.positionsReason = 'no position snapshot has arrived yet, so we do not know what is open';
  h.positionsUpdatedAtMs = undefined;
  h.price(1, 'BTC', 82000);

  // Nothing is claimed about a set we have not been told.
  assert.deepEqual(h.loop.evaluate(), []);
  assert.equal(h.loop.positionsStatus().state, 'awaiting-snapshot');
  assert.match(h.loop.positionsStatus().reason ?? '', /do not know what is open/);

  // An update that arrives before the snapshot is still not vouched for.
  h.positions = [btcLong];
  const [assessment] = h.loop.evaluate();
  assert.equal(assessment!.state, 'POSITIONS_UNTRUSTED');
  assert.equal(assessment!.positions, 'awaiting-snapshot');
});

test('when both the feed and the positions are gone, the positions win and the reason names both', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();

  h.advance(1_000);
  h.health = { state: 'disconnected', reconnectAttempt: 2, reason: 'market-data socket closed' };
  h.positionsState = 'stale';
  h.positionsReason = 'the trading socket is closed';
  const [assessment] = h.loop.evaluate();

  // Not knowing WHETHER the position is open undercuts anything a price could
  // say about it, so that is the state reported.
  assert.equal(assessment!.state, 'POSITIONS_UNTRUSTED');
  // But nothing is hidden by that choice.
  assert.match(assessment!.reason, /trading socket is closed/);
  assert.match(assessment!.reason, /market-data socket closed/);
});

test('recovering from an untrustworthy set re-serves the dwell time', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER');

  h.positionsState = 'stale';
  h.positionsReason = 'the trading socket is closed';
  h.advance(1_000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'POSITIONS_UNTRUSTED');

  // Back, with a genuinely recovered price: 9.14% buffer, past the 9% exit.
  h.positionsState = 'live';
  h.positionsReason = undefined;
  h.advance(1_000);
  h.price(1, 'BTC', 90000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'DANGER', 'an outage is not a shortcut to an all-clear');

  h.advance(DEFAULT_THRESHOLDS.minDwellMs);
  h.price(1, 'BTC', 90000);
  h.loop.evaluate();
  assert.equal(h.stateOf(1), 'SAFE');
});

test('an untrustworthy set does not re-emit POSITIONS_UNTRUSTED on every tick', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  h.positionsState = 'stale';
  h.positionsReason = 'the trading socket is closed';
  for (let i = 0; i < 5; i += 1) {
    h.advance(1_000);
    h.loop.evaluate();
  }
  const events = h.changes.filter((c) => c.assessment.state === 'POSITIONS_UNTRUSTED');
  assert.equal(events.length, 1);
});

test('coming back from POSITIONS_UNTRUSTED emits a change even at the same severity', () => {
  // The UI has to stop showing the outage, which it only hears about on a change.
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();
  h.positionsState = 'stale';
  h.positionsReason = 'the trading socket is closed';
  h.advance(1_000);
  h.loop.evaluate();

  const before = h.changes.length;
  h.positionsState = 'live';
  h.positionsReason = undefined;
  h.advance(1_000);
  h.price(1, 'BTC', 82000);
  h.loop.evaluate();

  assert.equal(h.changes.length, before + 1);
  assert.equal(h.changes.at(-1)!.assessment.state, 'DANGER');
  assert.equal(h.changes.at(-1)!.previousState, 'POSITIONS_UNTRUSTED');
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

// ── projecting a caller-chosen amount ────────────────────────────────────────

test('a custom amount is projected through the same engine as the offered top-ups', () => {
  // The bot offers a third top-up whose amount the user types. It has to be
  // priced HERE, by the engine, rather than approximated by whoever asked.
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  const [assessment] = h.loop.evaluate();

  // Ask for exactly the clear-danger amount and the projection must agree with
  // the option the loop already computed, to the last integer.
  const option = assessment!.topUp!.clearDanger;
  const projected = h.loop.projectAddMargin(1, option.amountCNS);
  assert.ok(projected.ok);
  assert.equal(projected.projection.resultingBufferPct, option.resultingBufferPct);
  assert.equal(
    projected.projection.resultingLiquidationPricePNS,
    option.resultingLiquidationPricePNS,
  );
  assert.equal(projected.projection.amountCNS, option.amountCNS);
  assert.equal(projected.projection.side, 'long');
  assert.equal(projected.projection.symbol, 'BTC');
  assert.equal(projected.projection.markPricePNS, 840_073n);
});

test('a projection carries the notional, which no top-up option does', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  const [assessment] = h.loop.evaluate();

  const projected = h.loop.projectAddMargin(1, 1_000_000_000n);
  assert.ok(projected.ok);
  // Adding margin does not change exposure, so the notional is the position's own.
  assert.equal(projected.projection.notionalCNS, assessment!.metrics.notionalCNS);
});

test('adding more margin always moves the liquidation price further away', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();

  let previous: bigint | undefined;
  for (const amount of [0n, 1n, 1_000_000n, 1_000_000_000n, 5_000_000_000n]) {
    const projected = h.loop.projectAddMargin(1, amount);
    assert.ok(projected.ok);
    const liq = projected.projection.resultingLiquidationPricePNS!;
    // A long is liquidated from below, so more margin means a LOWER price.
    if (previous !== undefined) assert.ok(liq <= previous, `${amount}: ${liq} > ${previous}`);
    previous = liq;
  }
});

test('projecting refuses while blind, for the same reason a blind assessment has no top-ups', () => {
  // Every price we hold is frozen at whatever it was when the feed died, so a
  // buffer computed from one is a promise about a market we cannot see.
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  assert.equal(h.loop.projectAddMargin(1, 1_000_000_000n).ok, true);

  h.health = { state: 'disconnected', reason: 'socket closed', reconnectAttempt: 3 };
  h.loop.evaluate();

  const projected = h.loop.projectAddMargin(1, 1_000_000_000n);
  assert.equal(projected.ok, false);
  assert.ok(!projected.ok);
  assert.match(projected.reason, /cannot currently see BTC/);
  assert.match(projected.reason, /socket closed/);
});

test('projecting refuses while the position set cannot be trusted', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();

  h.positionsState = 'stale';
  h.positionsReason = 'the account socket closed';
  h.loop.evaluate();

  const projected = h.loop.projectAddMargin(1, 1_000_000_000n);
  assert.ok(!projected.ok);
  assert.match(projected.reason, /the account socket closed/);
});

test('a projection is available again as soon as we can see', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  h.health = { state: 'disconnected', reconnectAttempt: 1 };
  h.loop.evaluate();
  assert.equal(h.loop.projectAddMargin(1, 1n).ok, false);

  h.health = { state: 'connected', reconnectAttempt: 0 };
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  assert.equal(h.loop.projectAddMargin(1, 1n).ok, true);
});

test('projecting an untracked market says so rather than answering with nothing', () => {
  const h = new Harness();
  const projected = h.loop.projectAddMargin(20, 1_000_000_000n);
  assert.ok(!projected.ok);
  assert.match(projected.reason, /not tracking a position on market 20/);
});

test('a negative amount is refused rather than projected', () => {
  const h = new Harness();
  h.positions = [btcLong];
  h.price(1, 'BTC', 84007.3);
  h.loop.evaluate();
  const projected = h.loop.projectAddMargin(1, -1n);
  assert.ok(!projected.ok);
  assert.match(projected.reason, /cannot be negative/);
});
