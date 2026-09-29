/**
 * Shared scaffolding for the alerts tests.
 *
 * The assessments these tests run on come from THE REAL RISK LOOP over a driven
 * feed, not from hand-written objects. That matters for the render tests in
 * particular: the liquidation prices and top-up amounts in the expected strings
 * are then the engine's own output, so a change to the maths shows up as a
 * changed message rather than as two hand-maintained numbers drifting apart.
 *
 * Three markets with deliberately different `priceDecimals` — BTC 1, ETH 2,
 * MON 6 — because the one bug a formatting layer is most likely to have is a
 * hard-coded decimal count that happens to be right for BTC.
 */
import type {
  MarketRiskConfig,
  FeedHealth,
  PositionSourceStatus,
  PriceUpdate,
  VenuePosition,
} from '@perpguard/shared';
import { MarketFeed } from '../ingest/marketFeed.ts';
import { RiskLoop } from '../risk/loop.ts';
import {
  DEFAULT_THRESHOLDS,
  type MarketConfigs,
  type PositionSource,
  type RiskAssessment,
  type RiskChange,
  type RiskThresholds,
} from '../risk/types.ts';
import type {
  AlertLogEntry,
  AlertMessage,
  AlertTransport,
  DeliveryResult,
} from './types.ts';

export const STALE_MS = 10_000;

/** priceDecimals 1, maintenance_margin 2500 -> ratio 0.04. Real mainnet values. */
export const BTC: MarketRiskConfig = {
  marketId: 1,
  symbol: 'BTC',
  priceDecimals: 1,
  lotDecimals: 5,
  collateralDecimals: 6,
  maintenanceMargin: 2500,
  initialMargin: 1500,
};

/** priceDecimals 2, ratio 0.05. */
export const ETH: MarketRiskConfig = {
  marketId: 20,
  symbol: 'ETH',
  priceDecimals: 2,
  lotDecimals: 3,
  collateralDecimals: 6,
  maintenanceMargin: 2000,
  initialMargin: 1000,
};

/** priceDecimals 6, lotDecimals 0: a sub-cent price in whole lots. */
export const MON: MarketRiskConfig = {
  marketId: 10,
  symbol: 'MON',
  priceDecimals: 6,
  lotDecimals: 0,
  collateralDecimals: 6,
  maintenanceMargin: 2000,
  initialMargin: 1000,
};

export const CONFIGS: MarketConfigs = new Map([
  [BTC.marketId, BTC],
  [ETH.marketId, ETH],
  [MON.marketId, MON],
]);

/**
 * `fixtures/position1.json`: 0.5 BTC long, entry 84029.5, margin 2810.33.
 *
 * The ground-truth position, whose buffer is 2.66% — genuinely DANGER on the
 * default thresholds, which is what makes it the right fixture for an alert.
 */
export const FIXTURE_BTC: VenuePosition = {
  venue: 'perpl',
  network: 'mainnet',
  symbol: 'BTC',
  marketId: BTC.marketId,
  positionId: 4242,
  side: 'long',
  size: 0.5,
  entryPrice: 84029.5,
  margin: 2810.33,
  marginMode: 'isolated',
  leverage: 15,
  fundingAccrued: 0,
};

export const FIXTURE_BTC_MARK = 84007.3;

/** Same position with enough margin to sit above the 9% safe threshold. */
export const SAFE_BTC: VenuePosition = { ...FIXTURE_BTC, margin: 6000 };

/**
 * Margin 4200: a 5.97% buffer, so inside WATCH and clear of both boundaries.
 *
 * Deliberately not near an edge. 5500 would look like a WATCH position and
 * assess as SAFE — its buffer is 9.07%, just over the 9% exit — and a test
 * anchored there proves the opposite of what it claims to.
 */
export const WATCH_BTC: VenuePosition = { ...FIXTURE_BTC, margin: 4200 };

/** 10 ETH SHORT at 3000, margin 2310: a 2.70% buffer, so DANGER. */
export const DANGER_ETH: VenuePosition = {
  venue: 'perpl',
  network: 'mainnet',
  symbol: 'ETH',
  marketId: ETH.marketId,
  positionId: 77,
  side: 'short',
  size: 10,
  entryPrice: 3000,
  margin: 2310,
  marginMode: 'isolated',
  leverage: 10,
  fundingAccrued: 0,
};

/**
 * 10,000 MON long at 0.05, margin 38.8: a 2.76% buffer, so DANGER.
 *
 * The margins here are chosen so both top-ups land on a fraction BELOW .5 —
 * 6.2 and 31.2 AUSD — which is what makes this position prove that amounts are
 * CEILED and not rounded. Rounding would print 6 and 31.
 */
export const DANGER_MON: VenuePosition = {
  venue: 'perpl',
  network: 'mainnet',
  symbol: 'MON',
  marketId: MON.marketId,
  positionId: 9,
  side: 'long',
  size: 10_000,
  entryPrice: 0.05,
  margin: 38.8,
  marginMode: 'isolated',
  leverage: 10,
  fundingAccrued: 0,
};

const priceUpdate = (
  marketId: number,
  symbol: string,
  markPrice: number,
  atMs: number,
): PriceUpdate => ({
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

/**
 * The risk loop with its clock, feed health, prices and positions all driven.
 *
 * Mirrors the harness in `risk/loop.test.ts`. Kept here rather than exported from
 * there so the alerts tests do not depend on another test file's internals.
 */
export class LoopHarness {
  nowMs = 1_000_000;
  health: FeedHealth = { state: 'connected', reconnectAttempt: 0 };
  positions: VenuePosition[] = [];
  positionsState: PositionSourceStatus['state'] = 'live';
  positionsReason: string | undefined;
  positionsUpdatedAtMs: number | undefined = 1_000_000;

  readonly feed: MarketFeed;
  readonly loop: RiskLoop;
  readonly changes: RiskChange[] = [];

  constructor(thresholds?: Partial<RiskThresholds>) {
    this.feed = new MarketFeed('mainnet', STALE_MS, () => this.nowMs);
    const source: PositionSource = {
      snapshot: () => this.positions,
      onSnapshot: () => () => {},
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
      configs: CONFIGS,
      ...(thresholds ? { thresholds } : {}),
      now: () => this.nowMs,
    });
    this.loop.onChange((change) => this.changes.push(change));
  }

  price(marketId: number, symbol: string, markPrice: number): this {
    this.feed.record(priceUpdate(marketId, symbol, markPrice, this.nowMs));
    return this;
  }

  advance(ms: number): this {
    this.nowMs += ms;
    return this;
  }

  evaluate(): readonly RiskAssessment[] {
    return this.loop.evaluate();
  }

  /** The most recent change for one market, which is what `decide` consumes. */
  changeFor(marketId: number): RiskChange {
    const found = [...this.changes].reverse().find((c) => c.assessment.marketId === marketId);
    if (found === undefined) throw new Error(`no risk change recorded for market ${marketId}`);
    return found;
  }

  /** The last change of any market. */
  lastChange(): RiskChange {
    const found = this.changes.at(-1);
    if (found === undefined) throw new Error('no risk changes recorded');
    return found;
  }
}

/** One assessed position, straight through the real loop. */
export function assessOne(
  position: VenuePosition,
  markPrice: number,
  options: { readonly thresholds?: Partial<RiskThresholds>; readonly ageMs?: number } = {},
): { readonly harness: LoopHarness; readonly change: RiskChange } {
  const harness = new LoopHarness(options.thresholds);
  harness.positions = [position];
  harness.price(position.marketId, position.symbol, markPrice);
  if (options.ageMs !== undefined) harness.advance(options.ageMs);
  harness.evaluate();
  return { harness, change: harness.changeFor(position.marketId) };
}

/**
 * A `RiskChange` with fields overridden.
 *
 * Used for ONE thing: building states the loop does not currently produce, so the
 * invariants that defend against a future loop producing them can be tested. The
 * stale-price hard gate is exactly that case — today's state machine refuses to
 * soften on an old price, so a SAFE assessment with `heldOnStalePrice` set cannot
 * be reached through the loop. The assertion exists for the refactor that changes
 * that, so the test has to construct it directly.
 */
export function withOverrides(
  change: RiskChange,
  patch: Partial<RiskAssessment>,
): RiskChange {
  // The cast is the point of the helper: it deliberately builds a shape the
  // producing code would not.
  const assessment = { ...change.assessment, ...patch } as RiskAssessment;
  return { assessment, previousState: change.previousState };
}

/** A transport whose result can be programmed per attempt. */
export class FakeTransport implements AlertTransport {
  readonly sent: Array<{ readonly userId: string; readonly message: AlertMessage }> = [];
  /** Consumed one per attempt. When empty, sends succeed. */
  readonly scripted: DeliveryResult[] = [];
  /** Thrown instead of returning, once per queued error. */
  readonly throwOnAttempt = new Set<number>();
  attempts = 0;

  script(...results: readonly DeliveryResult[]): this {
    this.scripted.push(...results);
    return this;
  }

  async send(userId: string, message: AlertMessage): Promise<DeliveryResult> {
    this.attempts += 1;
    if (this.throwOnAttempt.has(this.attempts)) {
      throw new Error(`transport blew up on attempt ${this.attempts}`);
    }
    const scripted = this.scripted.shift();
    if (scripted !== undefined && !scripted.ok) return scripted;
    this.sent.push({ userId, message });
    return scripted ?? { ok: true };
  }
}

/** An AlertLog that records, and can be made to fail. */
export class RecordingLog {
  readonly rows: AlertLogEntry[] = [];
  failWith: Error | undefined;

  async record(entry: AlertLogEntry): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith;
    this.rows.push(entry);
  }
}

/** Collects the engine's error, warn and info lines. */
export class RecordingLogger {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly infos: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  info(message: string): void {
    this.infos.push(message);
  }
}

/** Backoff sleeps, recorded instead of waited. */
export class FakeSleep {
  readonly slept: number[] = [];

  readonly sleep = async (ms: number): Promise<void> => {
    this.slept.push(ms);
  };
}

export { DEFAULT_THRESHOLDS };
