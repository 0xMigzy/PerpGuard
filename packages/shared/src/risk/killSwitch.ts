/**
 * Kill switch maths.
 *
 * Two pure functions, and nothing else. Arming, confirming and firing live in
 * the actions layer: this file only answers "what would a kill switch do, and
 * has the condition to offer one been met". It reads no prices, keeps no state
 * and triggers nothing.
 *
 * The ordering is the point. Closes go out nearest-to-liquidation first, because
 * that is the position that may not survive long enough to be second.
 */
import { positionMetrics, type PositionMetrics } from './metrics.ts';
import type { MarketRiskConfig, RiskPosition } from './position.ts';

export interface KillSwitchLine {
  readonly position: RiskPosition;
  readonly markPricePNS: bigint;
  /** Signed, and undefined for a zero-lot position. See PositionMetrics. */
  readonly liqBufferPct: number | undefined;
  /** What closing this position at the mark would realise, gain or loss. */
  readonly realisedPnlCNS: bigint;
  readonly metrics: PositionMetrics;
}

export interface KillSwitchPlan {
  /** Positions in the order the closes should be fired: most urgent first. */
  readonly ordered: readonly RiskPosition[];
  /** The same order, with the numbers to show the user before they confirm. */
  readonly perPosition: readonly KillSwitchLine[];
  /** Total realised if every position is closed at its mark right now. */
  readonly projectedRealisedPnlCNS: bigint;
}

/**
 * Urgency order: smallest liquidation buffer first.
 *
 * A position with no buffer figure at all — no size, so no liquidation price —
 * sorts last: there is nothing urgent about it. Ties break on market id and then
 * symbol so the order is total and the same every time, which matters when the
 * output drives a sequence of real orders.
 */
function byUrgency(a: KillSwitchLine, b: KillSwitchLine): number {
  const left = a.liqBufferPct;
  const right = b.liqBufferPct;
  if (left === undefined && right === undefined) return tieBreak(a, b);
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (left !== right) return left - right;
  return tieBreak(a, b);
}

const tieBreak = (a: KillSwitchLine, b: KillSwitchLine): number =>
  a.position.marketId - b.position.marketId ||
  a.position.symbol.localeCompare(b.position.symbol);

export function killSwitchPlan(
  positions: readonly RiskPosition[],
  markPrices: ReadonlyMap<number, bigint>,
  configs: ReadonlyMap<number, MarketRiskConfig>,
): KillSwitchPlan {
  const lines: KillSwitchLine[] = positions.map((position) => {
    const config = configs.get(position.marketId);
    const markPricePNS = markPrices.get(position.marketId);
    if (!config || markPricePNS === undefined) {
      throw new RangeError(
        `no ${config ? 'mark price' : 'market config'} supplied for market ${position.marketId}`,
      );
    }
    const metrics = positionMetrics(position, markPricePNS, config);
    return {
      position,
      markPricePNS,
      liqBufferPct: metrics.liqBufferPct,
      // Closing at the mark realises exactly what is currently unrealised.
      realisedPnlCNS: metrics.unrealisedPnlCNS,
      metrics,
    };
  });

  const perPosition = [...lines].sort(byUrgency);
  return {
    ordered: perPosition.map((line) => line.position),
    perPosition,
    projectedRealisedPnlCNS: perPosition.reduce((sum, line) => sum + line.realisedPnlCNS, 0n),
  };
}

export type KillSwitchThreshold =
  /** Fire when any position's liquidation buffer falls below this fraction. */
  | { readonly kind: 'worstBufferBelow'; readonly bufferPct: number }
  /** Fire when unrealised losses across the book exceed this many AUSD micros. */
  | { readonly kind: 'accountLossBeyond'; readonly lossCNS: bigint };

export interface TriggerEvaluation {
  readonly met: boolean;
  readonly threshold: KillSwitchThreshold;
  /** The positions responsible, most responsible first. Empty when not met. */
  readonly causedBy: readonly RiskPosition[];
  readonly worstBufferPct: number | undefined;
  readonly totalUnrealisedPnlCNS: bigint;
}

/**
 * Has the condition to offer a kill switch been met?
 *
 * A pure predicate. It decides nothing and does nothing: the actions layer takes
 * this answer, shows the user the plan, and waits to be told. Nothing here ever
 * triggers a trade.
 */
export function triggerCondition(
  positions: readonly RiskPosition[],
  markPrices: ReadonlyMap<number, bigint>,
  configs: ReadonlyMap<number, MarketRiskConfig>,
  threshold: KillSwitchThreshold,
): TriggerEvaluation {
  const plan = killSwitchPlan(positions, markPrices, configs);
  const buffers = plan.perPosition
    .map((line) => line.liqBufferPct)
    .filter((b): b is number => b !== undefined);
  const worstBufferPct = buffers.length > 0 ? Math.min(...buffers) : undefined;
  const totalUnrealisedPnlCNS = plan.projectedRealisedPnlCNS;

  if (threshold.kind === 'worstBufferBelow') {
    if (!Number.isFinite(threshold.bufferPct)) {
      throw new RangeError(`bufferPct must be finite, got ${threshold.bufferPct}`);
    }
    const causedBy = plan.perPosition
      .filter((line) => line.liqBufferPct !== undefined && line.liqBufferPct < threshold.bufferPct)
      .map((line) => line.position);
    return {
      met: causedBy.length > 0,
      threshold,
      causedBy,
      worstBufferPct,
      totalUnrealisedPnlCNS,
    };
  }

  if (threshold.lossCNS < 0n) {
    throw new RangeError(`lossCNS is a magnitude and must not be negative, got ${threshold.lossCNS}`);
  }
  const met = -totalUnrealisedPnlCNS >= threshold.lossCNS && threshold.lossCNS > 0n;
  const causedBy = met
    ? plan.perPosition
        .filter((line) => line.realisedPnlCNS < 0n)
        .sort((a, b) => (a.realisedPnlCNS < b.realisedPnlCNS ? -1 : 1))
        .map((line) => line.position)
    : [];
  return { met, threshold, causedBy, worstBufferPct, totalUnrealisedPnlCNS };
}
