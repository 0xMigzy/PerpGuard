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
 *   POSITION TRUSTWORTHINESS is a THIRD question, asked of the position source
 *   rather than the feed, and it gates evaluation exactly as connection health
 *   does. A price at least carries a timestamp; a position closed a minute ago
 *   looks exactly like one still open, and no field on it reveals the
 *   difference. So when the source says the set is frozen or may be incomplete,
 *   the loop refuses to assess and says THAT, not that the price feed is down.
 *   Getting the cause right matters: the two have different fixes, and naming
 *   the wrong one is a false explanation from a tool whose whole job is to be
 *   believed.
 *
 * `MarketFeed.canAct` is deliberately not reused for the second one: it is the
 * ACTION gate and is permissive about age by design. Evaluation needs a stricter
 * rule, and the two staying separate is the whole point of that design.
 */
import {
  afterAddMargin,
  fromVenuePosition,
  marginToReachBuffer,
  positionMetrics,
  positionsAreUsable,
  priceToPNS,
  type FeedHealth,
  type MarketRiskConfig,
  type NetworkName,
  type PositionSourceStatus,
  type RiskPosition,
  type Unsubscribe,
  type VenuePosition,
} from '@perpguard/shared';
import type { MarketFeed } from '../ingest/marketFeed.ts';
import { nextState } from './state.ts';
import {
  DEFAULT_THRESHOLDS,
  isBlind,
  type BlindState,
  type MarketConfigs,
  type PositionSource,
  type RiskAssessment,
  type RiskChange,
  type RiskState,
  type RiskThresholds,
  type TopUpOption,
  type TopUpOptions,
} from './types.ts';

/**
 * One top-up and where it lands, computed once here so nothing downstream has to.
 *
 * `afterAddMargin` is the same projection the stress and action layers use, so
 * the liquidation price an alert quotes is the one the engine would compute for
 * the position that top-up creates — not an approximation of it.
 */
function topUpOption(
  position: RiskPosition,
  markPricePNS: bigint,
  targetBufferPct: number,
  config: MarketRiskConfig,
): TopUpOption {
  const amountCNS = marginToReachBuffer(position, markPricePNS, targetBufferPct, config);
  const after = afterAddMargin(position, amountCNS, markPricePNS, config);
  return {
    amountCNS,
    targetBufferPct,
    resultingBufferPct: after.metrics.liqBufferPct,
    resultingLiquidationPricePNS: after.metrics.liquidationPricePNS,
  };
}

/**
 * The cheap option and the thorough one.
 *
 * The thresholds are the EXIT ones, not the enter ones: topping up to exactly the
 * boundary you entered at leaves the position one tick from re-entering the state
 * it just left, and an alert that recommends that is an alert that fires again in
 * a minute.
 */
function topUpOptions(
  position: RiskPosition,
  markPricePNS: bigint,
  config: MarketRiskConfig,
  thresholds: RiskThresholds,
): TopUpOptions | undefined {
  // No size, no liquidation price, nothing a top-up could move.
  if (position.lotLNS === 0n) return undefined;
  return {
    clearDanger: topUpOption(position, markPricePNS, thresholds.dangerExitPct, config),
    toSafe: topUpOption(position, markPricePNS, thresholds.watchExitPct, config),
  };
}

export interface RiskLoopOptions {
  /**
   * The ONE network this loop assesses. Checked against the feed at
   * construction and against every position at evaluation.
   */
  readonly network: NetworkName;
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
  readonly #network: NetworkName;
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
    // ONE NETWORK PER RISK LOOP, enforced here rather than left to care. Both
    // networks list BTC, so a testnet position priced off a mainnet mark yields
    // a liquidation price, a buffer percentage and an alert that are all wrong
    // and all completely plausible — nothing about the output would look off.
    if (options.feed.network !== options.network) {
      throw new RangeError(
        `risk loop is for ${options.network} but its market feed is for ` +
          `${options.feed.network}. A position and the mark price it is assessed ` +
          `against must come from the same network; mixing them cannot be detected ` +
          `from the numbers, so it is refused at construction.`,
      );
    }
    this.#network = options.network;
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

  /** The one network this loop assesses. */
  get network(): NetworkName {
    return this.#network;
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
    const posStatus = this.#positions.status();
    const positions = this.#positions.snapshot();
    const changes: RiskChange[] = [];
    const produced: RiskAssessment[] = [];
    const seen = new Set<number>();

    // Two independent ways of being blind. Either one stops us assessing.
    const positionsUsable = positionsAreUsable(posStatus);
    const feedUsable = health.state === 'connected';

    for (const position of positions) {
      if (position.network !== this.#network) {
        // A position source that starts handing over another network's positions
        // is a wiring bug, and the resulting numbers would look fine. The loop
        // stops rather than assess it.
        throw new RangeError(
          `refusing a ${position.network} position in ${position.symbol} (market ` +
            `${position.marketId}) on a ${this.#network} risk loop. Its mark price ` +
            `would come from a different market of the same name.`,
        );
      }
      seen.add(position.marketId);
      const assessment =
        feedUsable && positionsUsable
          ? this.#assess(position, health, posStatus, nowMs)
          : this.#assessBlind(position, health, posStatus, nowMs);
      if (!assessment) continue;
      produced.push(assessment.assessment);
      if (assessment.changed) changes.push(assessment);
    }

    // A position that has gone is no longer our concern — but ONLY when the set
    // can be believed. While it cannot, absence is not evidence of closure: a
    // missed `mt: 27` looks identical to a position that never existed, and
    // forgetting a position on that basis is how a monitor stops watching the
    // one thing it was asked to watch.
    for (const [marketId, tracked] of [...this.#tracked]) {
      if (seen.has(marketId)) continue;
      if (positionsUsable) {
        this.#tracked.delete(marketId);
        continue;
      }
      // Keep tracking it — and SAY we cannot see it. Leaving its last
      // assessment standing untouched would be worse than dropping it: the UI
      // would go on rendering a severity, with numbers, as though it were
      // current, when we no longer know the position is even open.
      const blind = this.#assessBlind(
        { marketId, symbol: tracked.assessment.symbol },
        health,
        posStatus,
        nowMs,
      );
      if (!blind) continue;
      produced.push(blind.assessment);
      if (blind.changed) changes.push(blind);
    }

    for (const change of changes) {
      for (const listener of this.#listeners) listener(change);
    }
    return produced;
  }

  /** Health of the position set, for the UI to render alongside feed health. */
  positionsStatus(): PositionSourceStatus {
    return this.#positions.status();
  }

  /**
   * We cannot see, so nothing may be computed. The last known severity is kept
   * and reported alongside, because a monitor that has gone blind must never
   * look healthy — and must not pretend it knows nothing either.
   *
   * Covers both blind causes. Which one is reported matters: the states have
   * different fixes, and saying "the price feed is down" when the account socket
   * died would be a confident false explanation.
   *
   * POSITION TRUST LOSES TO NOTHING. When the set cannot be believed we do not
   * know the position is still open, which undercuts everything a price would
   * tell us about it, so it is the state reported even if the feed is also down.
   * The reason names EVERY active cause, so nothing is hidden by that choice.
   */
  #assessBlind(
    position: { readonly marketId: number; readonly symbol: string },
    health: FeedHealth,
    posStatus: PositionSourceStatus,
    nowMs: number,
  ): (RiskChange & { changed: boolean }) | undefined {
    const positionsUsable = positionsAreUsable(posStatus);
    const state: BlindState = positionsUsable ? 'FEED_DOWN' : 'POSITIONS_UNTRUSTED';

    const existing = this.#tracked.get(position.marketId);
    const previousState = existing?.state;
    const lastKnownState =
      existing === undefined
        ? undefined
        : isBlind(existing.state)
          ? existing.lastKnownState
          : existing.state;

    const causes: string[] = [];
    if (!positionsUsable) {
      causes.push(
        posStatus.reason ??
          `the position set is ${posStatus.state}, so this position may not still be open`,
      );
    }
    if (health.state !== 'connected') {
      causes.push(
        health.reason ??
          `the price feed is ${health.state}, so every price we hold is frozen and may be wrong`,
      );
    }

    const base = existing?.assessment;
    const assessment: RiskAssessment = {
      marketId: position.marketId,
      symbol: position.symbol,
      positionId: base?.positionId,
      state,
      previousState,
      lastKnownState,
      // The last numbers we had, kept visible and plainly labelled as frozen.
      liqBufferPct: base?.liqBufferPct,
      liquidationPricePNS: base?.liquidationPricePNS,
      markPricePNS: base?.markPricePNS ?? 0n,
      // NO TOP-UPS WHILE BLIND. An amount is an invitation to act, and the
      // numbers behind this one are frozen: the mark it was computed against may
      // be arbitrarily far from the market, so the buffer it claims to buy is not
      // a claim we can stand behind. The last known severity is still shown —
      // that is a statement about the past, which is honest — but an action is a
      // statement about now.
      topUp: undefined,
      marginToSurviveCNS: base?.marginToSurviveCNS ?? 0n,
      metrics: base?.metrics ?? EMPTY_METRICS,
      feed: health.state,
      positions: posStatus.state,
      positionsAgeMs: posStatus.ageMs,
      priceAgeMs: this.#feed.ageMs(position.marketId),
      // The price may in fact be fresh when only the position set is broken, but
      // the severity is being HELD either way, and the alerts layer reads this
      // flag to know it must not reassure. Marking it true keeps that contract
      // whole rather than leaving a gap for an all-clear to slip through.
      priceIsOld: true,
      heldOnStalePrice: true,
      reason: causes.join('; '),
      atMs: nowMs,
    };

    const changed = previousState !== state;
    this.#tracked.set(position.marketId, {
      state,
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
    posStatus: PositionSourceStatus,
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
    // Resume from the severity held before we went blind, never from the blind
    // state itself.
    const resumeFrom =
      existing === undefined
        ? undefined
        : isBlind(existing.state)
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
      positionId: position.positionId,
      state: decision.state,
      previousState: existing?.state,
      lastKnownState: resumeFrom,
      liqBufferPct: metrics.liqBufferPct,
      liquidationPricePNS: metrics.liquidationPricePNS,
      markPricePNS,
      topUp: topUpOptions(risk, markPricePNS, config, this.#thresholds),
      marginToSurviveCNS: metrics.marginToSurviveCNS,
      metrics,
      feed: health.state,
      positions: posStatus.state,
      positionsAgeMs: posStatus.ageMs,
      priceAgeMs,
      priceIsOld,
      heldOnStalePrice: decision.heldOnStalePrice,
      reason: decision.reason,
      atMs: nowMs,
    };

    // A change of severity is a change. Coming back from a blind state to the
    // same severity we went blind with is also a change, because the UI has to
    // stop showing the outage.
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

/** Placeholder metrics for a position we went blind on before ever assessing it. */
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
