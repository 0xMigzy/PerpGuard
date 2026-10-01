/**
 * The watch loop: risk for accounts nobody here owns.
 *
 * The owner's loop (`risk/loop.ts`) reads positions off the live trading socket
 * and prices off the live feed, one network, one account. This one reads the
 * positions of ANY mainnet account off the INDEX and prices them with the
 * venue's marks, for whoever asked to watch. Same pure maths, same state
 * machine, same thresholds, same change events — so the alerts layer treats
 * a watched position exactly like an owned one, minus the actions.
 *
 * WHAT IS DIFFERENT IS HOW OLD THE TRUTH IS, and that is carried rather than
 * hidden. The index is some blocks behind the chain; the mark is as old as the
 * venue's last tick. Both ages go onto the assessment as a `WatchedScope`, the
 * message says them in words, and while the indexer is not serving current
 * figures the severity is HELD exactly as it is on a stale price: no
 * all-clear from a position set that may be minutes old. A halted or
 * unreachable index makes every watched position blind, which is reported,
 * never papered over.
 *
 * NO TOP-UPS, EVER. `topUp` is undefined on every assessment here. There is
 * no position id to address an action to and no socket to send it on, and a
 * watcher is not the owner. The renderer and the bot's gate enforce the same
 * rule from their sides.
 *
 * Polled, not pushed: the index has no change feed, and a few hundred profile
 * reads every thirty seconds is what a public tier costs.
 */
import {
  fromVenuePosition,
  marginToReachBuffer,
  positionMetrics,
  priceToPNS,
  type IndexerHealth,
  type MarketOpenInterest,
  type MarketRiskConfig,
  type Unsubscribe,
  type WalletProfile,
} from '@perpguard/shared';
import { nextState } from '../risk/state.ts';
import {
  DEFAULT_THRESHOLDS,
  isBlind,
  type RiskAssessment,
  type RiskChange,
  type RiskState,
  type RiskThresholds,
  type WatchedScope,
} from '../risk/types.ts';

export interface WatchLoopOptions {
  /** Every account anybody is watching, asked on each pass. */
  readonly subscriptions: { accountIds(): readonly number[] };
  /** The index's view of one account. Undefined when it holds nothing for it. */
  readonly profile: (accountId: number) => Promise<WalletProfile | undefined>;
  readonly health: () => Promise<IndexerHealth>;
  /** The venue's marks on the SAME network as the index. */
  readonly marks: () => Promise<readonly MarketOpenInterest[]>;
  readonly configs: () => Promise<ReadonlyMap<number, MarketRiskConfig>>;
  /** A mark older than this is labelled old. Same STALE_MS as the owner's loop. */
  readonly staleMs: number;
  readonly thresholds?: Partial<RiskThresholds>;
  readonly now?: () => number;
  readonly logger?: { info(message: string): void; warn(message: string): void };
}

interface Tracked {
  state: RiskState;
  enteredAtMs: number;
  lastKnownState: RiskState | undefined;
  assessment: RiskAssessment;
}

/** One account as the last pass read it from the index. */
export interface WatchedAccountFacts {
  readonly atMs: number;
  /** False when the index holds nothing for this account at all. */
  readonly found: boolean;
  readonly openPositions: number;
  /** Open positions the loop could not price (no entry price, or a market the venue does not list). */
  readonly unassessable: number;
  readonly freeBalanceAusd: number | undefined;
}

const silent = { info: () => {}, warn: () => {} };

export class WatchLoop {
  readonly #options: WatchLoopOptions;
  readonly #thresholds: RiskThresholds;
  readonly #now: () => number;
  readonly #logger: { info(message: string): void; warn(message: string): void };
  readonly #tracked = new Map<string, Tracked>();
  readonly #listeners = new Set<(change: RiskChange) => void>();
  /** Positions warned about once, so an unassessable one does not log per pass. */
  readonly #skipped = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #lastRunAtMs: number | undefined;
  #lastHealth: IndexerHealth | undefined;
  #lastConfigs: ReadonlyMap<number, MarketRiskConfig> | undefined;
  /** What the last pass found per account, so "no positions" is not "never looked". */
  readonly #accounts = new Map<number, WatchedAccountFacts>();

  constructor(options: WatchLoopOptions) {
    this.#options = options;
    this.#thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? silent;
  }

  onChange(listener: (change: RiskChange) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Every watched position's current assessment; one account's when asked. */
  snapshot(accountId?: number): readonly RiskAssessment[] {
    return [...this.#tracked.values()]
      .map((t) => t.assessment)
      .filter((a) => accountId === undefined || a.watch?.accountId === accountId);
  }

  get lastRunAtMs(): number | undefined {
    return this.#lastRunAtMs;
  }

  /** The indexer verdict the last pass ran against, for the bot to quote. */
  get lastHealth(): IndexerHealth | undefined {
    return this.#lastHealth;
  }

  /** The venue's market configs the last pass priced with: the SAME network as the marks. */
  get marketConfigs(): ReadonlyMap<number, MarketRiskConfig> | undefined {
    return this.#lastConfigs;
  }

  /**
   * What the last pass learned about one account. Undefined means no pass has
   * read it yet — which is not the same as "no open positions", and the bot
   * says which.
   */
  accountFacts(accountId: number): WatchedAccountFacts | undefined {
    return this.#accounts.get(accountId);
  }

  start(intervalMs: number): void {
    if (this.#timer !== undefined) return;
    void this.evaluate();
    this.#timer = setInterval(() => void this.evaluate(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One pass over every watched account. Never throws; never overlaps itself.
   * Returns the assessments it produced, which is what the tests read.
   */
  async evaluate(): Promise<readonly RiskAssessment[]> {
    if (this.#running) return this.snapshot();
    this.#running = true;
    try {
      return await this.#pass();
    } finally {
      this.#running = false;
      this.#lastRunAtMs = this.#now();
    }
  }

  async #pass(): Promise<readonly RiskAssessment[]> {
    const nowMs = this.#now();
    const accountIds = this.#options.subscriptions.accountIds();
    const produced: RiskAssessment[] = [];
    const changes: RiskChange[] = [];

    let health: IndexerHealth;
    let marks: ReadonlyMap<number, MarketOpenInterest>;
    let configs: ReadonlyMap<number, MarketRiskConfig>;
    try {
      const [h, m, c] = await Promise.all([this.#options.health(), this.#options.marks(), this.#options.configs()]);
      health = h;
      marks = new Map(m.map((reading) => [reading.marketId, reading]));
      configs = c;
      this.#lastConfigs = c;
    } catch (error) {
      // Nothing can be assessed. Every tracked position goes blind, with the cause.
      const reason = `the watch loop could not read the index or the venue: ${describe(error)}`;
      this.#logger.warn(reason);
      for (const [key, tracked] of this.#tracked) {
        const blind = this.#blind(key, tracked.assessment.watch as WatchedScope, tracked.assessment.marketId, tracked.assessment.symbol, 'POSITIONS_UNTRUSTED', reason, nowMs);
        produced.push(blind.assessment);
        if (blind.changed) changes.push(blind);
      }
      this.#emit(changes);
      return produced;
    }
    this.#lastHealth = health;

    // A halted or unknown index is a position set that may be minutes old
    // with nothing in it to say so: blind. Behind-but-moving is served, held.
    const indexUsable = health.state !== 'halted' && health.state !== 'unknown';
    const seen = new Set<string>();

    for (const accountId of accountIds) {
      let profile: WalletProfile | undefined;
      try {
        profile = await this.#options.profile(accountId);
      } catch (error) {
        const reason = `the index could not be read for account ${accountId}: ${describe(error)}`;
        this.#logger.warn(reason);
        for (const [key, tracked] of this.#tracked) {
          if (tracked.assessment.watch?.accountId !== accountId) continue;
          seen.add(key);
          const blind = this.#blind(key, tracked.assessment.watch, tracked.assessment.marketId, tracked.assessment.symbol, 'POSITIONS_UNTRUSTED', reason, nowMs);
          produced.push(blind.assessment);
          if (blind.changed) changes.push(blind);
        }
        continue;
      }
      if (profile === undefined) {
        this.#accounts.set(accountId, { atMs: nowMs, found: false, openPositions: 0, unassessable: 0, freeBalanceAusd: undefined });
        continue;
      }
      this.#accounts.set(accountId, {
        atMs: nowMs,
        found: true,
        openPositions: profile.openPositions.length,
        unassessable: profile.openPositions.filter((p) => p.entryPrice === undefined || !configs.has(p.market.marketId)).length,
        freeBalanceAusd: Number.isFinite(profile.freeBalanceAusd) ? profile.freeBalanceAusd : undefined,
      });

      const scope: WatchedScope = {
        accountId,
        label: labelOf(accountId, profile.address),
        indexerBlock: health.latestProcessedBlock,
        blocksBehind: health.blocksBehind,
        indexerState: health.state,
        ...(Number.isFinite(profile.freeBalanceAusd) ? { freeBalanceCNS: ausdToCNS(profile.freeBalanceAusd) } : {}),
      };

      for (const position of profile.openPositions) {
        const marketId = position.market.marketId;
        const key = `${accountId}:${marketId}`;
        const config = configs.get(marketId);
        const mark = marks.get(marketId);
        const symbol = config?.symbol ?? position.market.symbol ?? `market ${marketId}`;

        if (config === undefined || position.entryPrice === undefined) {
          // Not assessable, and SAID once rather than silently dropped: a
          // position opened before the index starts has no entry price to
          // anchor a liquidation price, and a market the venue does not list
          // has no maintenance margin.
          if (!this.#skipped.has(key)) {
            this.#skipped.add(key);
            this.#logger.info(
              `watch: not assessing ${symbol} for account ${accountId}: ${config === undefined ? 'the venue does not list this market' : 'its entry price predates the index'}`,
            );
          }
          continue;
        }
        seen.add(key);

        if (!indexUsable || mark === undefined) {
          const state: RiskState = !indexUsable ? 'POSITIONS_UNTRUSTED' : 'FEED_DOWN';
          const reason = !indexUsable
            ? (health.reason ?? `the indexer is ${health.state}, so this position may not still be open`)
            : `the venue reports no mark for ${symbol}, so it cannot be valued`;
          const blind = this.#blind(key, scope, marketId, symbol, state, reason, nowMs);
          produced.push(blind.assessment);
          if (blind.changed) changes.push(blind);
          continue;
        }

        const risk = fromVenuePosition(
          {
            marketId,
            symbol: config.symbol,
            side: position.side,
            size: position.sizeLots,
            entryPrice: position.entryPrice,
            margin: position.marginAusd,
            // The index does not carry accrued funding per open position with a
            // known sign; the web's assessment passes zero too and says so.
            fundingAccrued: 0,
          },
          config,
        );
        const markPricePNS = priceToPNS(mark.markPrice, config);
        const metrics = positionMetrics(risk, markPricePNS, config);
        const priceAgeMs = Math.max(0, nowMs - mark.atMs);
        // Old if the mark is old OR the index is not serving current figures:
        // either way the severity may only be held, never softened.
        const priceIsOld = priceAgeMs > this.#options.staleMs || !health.serveAsCurrent;

        const existing = this.#tracked.get(key);
        const resumeFrom = existing === undefined ? undefined : isBlind(existing.state) ? existing.lastKnownState : existing.state;
        const decision = nextState({
          current: resumeFrom,
          enteredAtMs: existing?.enteredAtMs,
          liqBufferPct: metrics.liqBufferPct,
          priceIsOld,
          nowMs,
          thresholds: this.#thresholds,
        });

        // Words for the watcher, never a button: what it would take to climb
        // out of DANGER, by the same function an owner's top-up uses.
        const toClearDangerCNS = risk.lotLNS === 0n ? 0n : marginToReachBuffer(risk, markPricePNS, this.#thresholds.dangerExitPct, config);
        const assessment: RiskAssessment = {
          watch: { ...scope, sizeUnits: position.sizeLots, toClearDangerCNS },
          marketId,
          symbol: config.symbol,
          side: position.side,
          positionId: undefined,
          state: decision.state,
          previousState: existing?.state,
          lastKnownState: resumeFrom,
          liqBufferPct: metrics.liqBufferPct,
          liquidationPricePNS: metrics.liquidationPricePNS,
          markPricePNS,
          topUp: undefined,
          marginToSurviveCNS: metrics.marginToSurviveCNS,
          marginCNS: risk.depositCNS,
          metrics,
          feed: 'connected',
          positions: health.serveAsCurrent ? 'live' : 'stale',
          positionsAgeMs: undefined,
          priceAgeMs,
          priceIsOld,
          heldOnStalePrice: decision.heldOnStalePrice,
          reason: health.serveAsCurrent ? decision.reason : `${decision.reason}; index ${health.blocksBehind} blocks behind`,
          atMs: nowMs,
        };
        const changed = existing?.state !== decision.state;
        this.#tracked.set(key, { state: decision.state, enteredAtMs: decision.enteredAtMs, lastKnownState: decision.state, assessment });
        produced.push(assessment);
        if (changed) changes.push({ assessment, previousState: existing?.state });
      }
    }

    // A position that has gone is no longer watched — but ONLY when the index
    // can be believed. While it cannot, absence proves nothing.
    const watched = new Set(accountIds);
    for (const id of [...this.#accounts.keys()]) if (!watched.has(id)) this.#accounts.delete(id);
    for (const [key, tracked] of [...this.#tracked]) {
      if (seen.has(key)) continue;
      const accountId = tracked.assessment.watch?.accountId;
      if (accountId === undefined || !watched.has(accountId) || indexUsable) {
        this.#tracked.delete(key);
        this.#skipped.delete(key);
        continue;
      }
      const blind = this.#blind(key, tracked.assessment.watch as WatchedScope, tracked.assessment.marketId, tracked.assessment.symbol, 'POSITIONS_UNTRUSTED', health.reason ?? `the indexer is ${health.state}`, nowMs);
      produced.push(blind.assessment);
      if (blind.changed) changes.push(blind);
    }

    this.#emit(changes);
    return produced;
  }

  #blind(
    key: string,
    scope: WatchedScope,
    marketId: number,
    symbol: string,
    state: 'POSITIONS_UNTRUSTED' | 'FEED_DOWN',
    reason: string,
    nowMs: number,
  ): RiskChange & { readonly changed: boolean } {
    const existing = this.#tracked.get(key);
    const lastKnownState = existing === undefined ? undefined : isBlind(existing.state) ? existing.lastKnownState : existing.state;
    const base = existing?.assessment;
    const assessment: RiskAssessment = {
      watch: scope,
      marketId,
      symbol,
      side: base?.side,
      positionId: undefined,
      state,
      previousState: existing?.state,
      lastKnownState,
      liqBufferPct: base?.liqBufferPct,
      liquidationPricePNS: base?.liquidationPricePNS,
      markPricePNS: base?.markPricePNS ?? 0n,
      topUp: undefined,
      marginToSurviveCNS: base?.marginToSurviveCNS ?? 0n,
      metrics: base?.metrics ?? EMPTY_METRICS,
      feed: state === 'FEED_DOWN' ? 'disconnected' : 'connected',
      positions: state === 'POSITIONS_UNTRUSTED' ? 'stale' : 'live',
      positionsAgeMs: undefined,
      priceAgeMs: base?.priceAgeMs,
      priceIsOld: true,
      heldOnStalePrice: true,
      reason,
      atMs: nowMs,
    };
    const changed = existing?.state !== state;
    this.#tracked.set(key, { state, enteredAtMs: nowMs, lastKnownState, assessment });
    return { assessment, previousState: existing?.state, changed };
  }

  #emit(changes: readonly RiskChange[]): void {
    for (const change of changes) for (const listener of this.#listeners) listener(change);
  }
}

/** `#5293 (0xb785…1765)` when the owner is known, `#5293` when it is not. */
export function labelOf(accountId: number, address: string | undefined): string {
  if (address === undefined || address === '') return `#${accountId}`;
  return `#${accountId} (${address.slice(0, 6)}…${address.slice(-4)})`;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

/**
 * Display AUSD back to exact micros. The index serves money as decimal AUSD;
 * every value below ~9 billion AUSD round-trips through a double to the exact
 * micro, so rounding here recovers the integer the index stored rather than
 * approximating one. Collateral is AUSD, 6 decimals.
 */
export function ausdToCNS(ausd: number): bigint {
  return BigInt(Math.round(ausd * 1_000_000));
}
