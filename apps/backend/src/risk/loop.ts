/**
 * The risk loop: the only part of the risk stack that touches the outside world.
 *
 * It subscribes to the market feed and to position snapshots, recomputes every
 * open position through the PURE risk engine, runs the PURE state machine, and
 * emits state changes. It sends no messages, knows nothing about Telegram, and
 * places no orders. The alerts layer subscribes to it.
 *
 * Two distinctions from CLAUDE.md are load-bearing here and are kept apart on
 * purpose:
 *
 *   CONNECTION HEALTH gates evaluation entirely. A feed that is not `connected`
 *   means every price we hold is frozen at whatever it was when the connection
 *   died, and age cannot detect that — for the first few seconds a frozen price
 *   looks exactly like a fresh one. So the loop refuses to evaluate and says so.
 *   Absence of a price is not safety.
 *
 *   PRICE AGE is per market and never blocks evaluation. On Perpl a mark price
 *   only changes when it moves, so a market nobody has traded for a minute has a
 *   minute-old price that is the venue's current truth. That is a QUIET MARKET,
 *   not a broken feed. The loop keeps assessing it, shows the age, and refuses
 *   only to publish a NEW severity from it.
 *
 * `MarketFeed.canAct` is deliberately not reused for the second one: it is the
 * ACTION gate and is permissive about age by design. Evaluation needs a stricter
 * rule, and the two staying separate is the whole point of that design.
 */
import {
  fromVenuePosition,
  marginToReachBuffer,
  positionMetrics,
  priceToPNS,
  type FeedHealth,
  type MarketRiskConfig,
  type Unsubscribe,
  type VenuePosition,
} from '@perpguard/shared';
import type { MarketFeed } from '../ingest/marketFeed.ts';
import { nextState } from './state.ts';
import {
  DEFAULT_THRESHOLDS,
  type MarketConfigs,
  type PositionSource,
  type RiskAssessment,
  type RiskChange,
  type RiskState,
  type RiskThresholds,
} from './types.ts';

export interface RiskLoopOptions {
  readonly feed: MarketFeed;
  readonly positions: PositionSource;
  /** Connection health, asked synchronously. Never inferred from price age. */
  readonly feedStatus: () => FeedHealth;
  readonly configs: MarketConfigs;
  readonly thresholds?: Partial<RiskThresholds>;
  /** Injected so dwell time is testable without waiting for it. */
  readonly now?: () => number;
}

interface Tracked {
  /** The live severity, which may be FEED_DOWN. */
  state: RiskState;
  enteredAtMs: number;
  /** The severity held before the feed went down, so the UI keeps a last-known. */
  lastKnownState: RiskState | undefined;
  assessment: RiskAssessment;
}

export class RiskLoop {
  readonly #feed: MarketFeed;
  readonly #positions: PositionSource;
  readonly #feedStatus: () => FeedHealth;
  readonly #configs: MarketConfigs;
  readonly #thresholds: RiskThresholds;
  readonly #now: () => number;

  readonly #tracked = new Map<number, Tracked>();
  readonly #listeners = new Set<(change: RiskChange) => void>();
  #unsubscribe: Unsubscribe | undefined;

  constructor(options: RiskLoopOptions) {
    this.#feed = options.feed;
    this.#positions = options.positions;
    this.#feedStatus = options.feedStatus;
    this.#configs = options.configs;
    this.#thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    this.#now = options.now ?? Date.now;
  }

  get thresholds(): RiskThresholds {
    return this.#thresholds;
  }

  /** Subscribe to position snapshots and assess what is already there. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#positions.onSnapshot(() => {
      this.evaluate();
    });
    this.evaluate();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  onChange(listener: (change: RiskChange) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Every position's current assessment, for the UI to read between changes. */
  snapshot(): readonly RiskAssessment[] {
    return [...this.#tracked.values()].map((t) => t.assessment);
  }

  /**
   * Recompute every open position and emit whatever changed.
   *
   * Called on each feed or position update. Returns the assessments it produced,
   * which is what the tests read.
   */
  evaluate(): readonly RiskAssessment[] {
    const nowMs = this.#now();
    const health = this.#feedStatus();
    const positions = this.#positions.snapshot();
    const changes: RiskChange[] = [];
    const produced: RiskAssessment[] = [];
    const seen = new Set<number>();

    for (const position of positions) {
      seen.add(position.marketId);
      const assessment =
        health.state === 'connected'
          ? this.#assess(position, health, nowMs)
          : this.#assessFeedDown(position, health, nowMs);
      if (!assessment) continue;
      produced.push(assessment.assessment);
      if (assessment.changed) changes.push(assessment);
    }

    // A position that has gone is no longer our concern.
    for (const marketId of [...this.#tracked.keys()]) {
      if (!seen.has(marketId)) this.#tracked.delete(marketId);
    }

    for (const change of changes) {
      for (const listener of this.#listeners) listener(change);
    }
    return produced;
  }

  /**
   * The feed is down, so every price we hold is frozen and nothing may be
   * computed from it. The last known severity is kept and reported alongside,
   * because a monitor that has gone blind must never look healthy — and must not
   * pretend it knows nothing either.
   */
  #assessFeedDown(
    position: VenuePosition,
    health: FeedHealth,
    nowMs: number,
  ): (RiskChange & { changed: boolean }) | undefined {
    const existing = this.#tracked.get(position.marketId);
    const previousState = existing?.state;
    const lastKnownState =
      existing === undefined
        ? undefined
        : existing.state === 'FEED_DOWN'
          ? existing.lastKnownState
          : existing.state;

    const base = existing?.assessment;
    const assessment: RiskAssessment = {
      marketId: position.marketId,
      symbol: position.symbol,
      state: 'FEED_DOWN',
      previousState,
      lastKnownState,
      // The last numbers we had, kept visible and plainly labelled as frozen.
      liqBufferPct: base?.liqBufferPct,
      liquidationPricePNS: base?.liquidationPricePNS,
      markPricePNS: base?.markPricePNS ?? 0n,
      marginToSafeCNS: base?.marginToSafeCNS ?? 0n,
      marginToSurviveCNS: base?.marginToSurviveCNS ?? 0n,
      metrics: base?.metrics ?? EMPTY_METRICS,
      feed: health.state,
      priceAgeMs: this.#feed.ageMs(position.marketId),
      priceIsOld: true,
      heldOnStalePrice: true,
      reason:
        health.reason ??
        `the price feed is ${health.state}, so every price we hold is frozen and may be wrong`,
      atMs: nowMs,
    };

    const changed = previousState !== 'FEED_DOWN';
    this.#tracked.set(position.marketId, {
      state: 'FEED_DOWN',
      // Re-serve the dwell time on recovery: an outage must not become a
      // shortcut to an all-clear.
      enteredAtMs: nowMs,
      lastKnownState,
      assessment,
    });
    return { assessment, previousState, changed };
  }

  #assess(
    position: VenuePosition,
    health: FeedHealth,
    nowMs: number,
  ): (RiskChange & { changed: boolean }) | undefined {
    const config = this.#configs.get(position.marketId);
    const price = this.#feed.get(position.marketId);
    if (!config || !price) {
      // No config or no price ever seen. Nothing can be said, and saying
      // something anyway is how a monitor starts lying.
      return undefined;
    }

    const risk = fromVenuePosition(position, config);
    const markPricePNS = priceToPNS(price.markPrice, config);
    const metrics = positionMetrics(risk, markPricePNS, config);
    const priceAgeMs = this.#feed.ageMs(position.marketId);
    const priceIsOld = this.#feed.isPriceOld(position.marketId);

    const existing = this.#tracked.get(position.marketId);
    // Resume from the severity held before an outage, never from FEED_DOWN.
    const resumeFrom =
      existing === undefined
        ? undefined
        : existing.state === 'FEED_DOWN'
          ? existing.lastKnownState
          : existing.state;

    const decision = nextState({
      current: resumeFrom,
      enteredAtMs: existing?.enteredAtMs,
      liqBufferPct: metrics.liqBufferPct,
      priceIsOld,
      nowMs,
      thresholds: this.#thresholds,
    });

    const assessment: RiskAssessment = {
      marketId: position.marketId,
      symbol: position.symbol,
      state: decision.state,
      previousState: existing?.state,
      lastKnownState: resumeFrom,
      liqBufferPct: metrics.liqBufferPct,
      liquidationPricePNS: metrics.liquidationPricePNS,
      markPricePNS,
      marginToSafeCNS: marginToReachBuffer(
        risk,
        markPricePNS,
        this.#thresholds.watchExitPct,
        config,
      ),
      marginToSurviveCNS: metrics.marginToSurviveCNS,
      metrics,
      feed: health.state,
      priceAgeMs,
      priceIsOld,
      heldOnStalePrice: decision.heldOnStalePrice,
      reason: decision.reason,
      atMs: nowMs,
    };

    // A change of severity is a change. Coming back from FEED_DOWN to the same
    // severity we went down with is also a change, because the UI has to stop
    // showing the outage.
    const changed = existing?.state !== decision.state;
    this.#tracked.set(position.marketId, {
      state: decision.state,
      enteredAtMs: decision.enteredAtMs,
      lastKnownState: decision.state,
      assessment,
    });
    return { assessment, previousState: existing?.state, changed };
  }
}

/** Placeholder metrics for a position the feed went down on before we saw it. */
const EMPTY_METRICS = {
  notionalCNS: 0n,
  entryNotionalCNS: 0n,
  unrealisedPnlCNS: 0n,
  maintenanceMarginCNS: 0n,
  maintenanceMarginRatio: 0,
  equityCNS: 0n,
  liquidationPricePNS: undefined,
  liqBufferPct: undefined,
  pnlPctOfMargin: undefined,
  isLiquidatable: false,
  marginToSurviveCNS: 0n,
} as const;

export type { MarketRiskConfig };
