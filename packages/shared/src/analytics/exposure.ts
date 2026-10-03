/**
 * Protocol-wide liquidation exposure: every open position under a price shock.
 *
 * PURE. Positions come from the index, marks and margin configs from the venue
 * on the SAME network, insurance balances from the chain; the caller supplies
 * all three and this function has no way to price a mainnet position off a
 * testnet mark. It is the risk engine's own `positionMetrics` applied to a
 * shocked mark, once per position per rung of a fixed ladder — so a tile, the
 * slider and the by-market table all read one array and cannot disagree.
 *
 * A STATIC SHOCK. Each rung jumps the mark by a fraction and asks which
 * positions are then past maintenance. It does not model the path, funding,
 * keeper timing or the book's ability to absorb the close, so every figure
 * here is exposure, never realised loss. "All markets" assumes every market
 * moves together by the same fraction, which is the worst case and not the
 * likely one; the per-market ladders are the same evaluation restricted to one
 * market. Both statements are carried on the payload for the page to print.
 *
 * SHORTFALL is equity below zero at the shocked mark: `deposit + uPnL` gone
 * negative, which is the part of a liquidation the insurance fund would have
 * to absorb. A position liquidated with equity still positive costs its owner
 * margin and the fund nothing.
 */
import { scaledToNumber } from '../units.ts';
import { positionMetrics } from '../risk/metrics.ts';
import { fromVenuePosition, maintenanceMarginRatio, priceToPNS, type MarketRiskConfig } from '../risk/position.ts';
import { shockPricePNS } from '../risk/stress.ts';
import type { Side } from '../venues/types.ts';
import type { MarketInsuranceReading } from '../venues/perpl-insurance.ts';
import type { MarkReading } from './assess.ts';
import type { IndexedOpenPosition, MarketRef } from './types.ts';

/** Signed price moves, −50% to +50% in half-percent steps: 201 rungs. */
export const LADDER_STEP = 0.005;
export const LADDER_MOVES: readonly number[] = Array.from({ length: 201 }, (_, i) => (i - 100) * LADDER_STEP);

/** The two moves the tiles quote. Both are rungs of the ladder, so the tile IS the slider at ±5 and ±10. */
export const TILE_MOVES = [0.05, 0.1] as const;

export interface LadderPoint {
  /** Signed fraction. Negative liquidates longs, positive liquidates shorts. */
  readonly move: number;
  readonly positions: number;
  /** Notional at the CURRENT mark of the positions liquidated by this move. */
  readonly notionalAusd: number;
  /** Their posted margin. */
  readonly marginAusd: number;
  /** Equity below zero at the shocked mark, summed. What the insurance fund would absorb. */
  readonly shortfallAusd: number;
}

/**
 * Exposure to a move of `size` in BOTH adverse directions at once: longs to a
 * fall of `size`, shorts to a rise of `size`. The by-market table's "worse
 * direction" and the tiles' "at risk X%" are both this.
 */
export interface AdverseExposure {
  readonly size: number;
  readonly positions: number;
  readonly notionalAusd: number;
  readonly shortfallAusd: number;
  /** `notionalAusd / total notional`, or undefined when there is none. */
  readonly shareOfNotional: number | undefined;
  /** `insurance / shortfall`; undefined when there is no shortfall to cover or no insurance reading. */
  readonly insuranceCover: number | undefined;
}

export interface ExposedPosition {
  readonly accountId: number;
  readonly market: MarketRef;
  readonly side: Side;
  readonly sizeLots: number;
  readonly notionalAusd: number;
  readonly marginAusd: number;
  readonly leverage: number;
  readonly entryPrice: number;
  readonly markPrice: number;
  /** Undefined only for a zero-lot position, which the index does not hold. */
  readonly liquidationPrice: number | undefined;
  /** SIGNED. Negative is past liquidation, never a small buffer. */
  readonly liqBufferPct: number | undefined;
  readonly unrealisedPnlAusd: number;
  readonly openedAtMs: number;
  /**
   * The least adverse rung that liquidates this position: for a long the
   * HIGHEST move at which it is past maintenance (it is then liquidated at
   * every lower rung too), for a short the LOWEST. Undefined when it survives
   * every rung. A page lists "exposed at move m" as longs with `m <=` this and
   * shorts with `m >=` this, which is exactly the ladder's own count.
   */
  readonly liquidatedFromMove: number | undefined;
}

export interface MarketExposure {
  readonly market: MarketRef;
  readonly markPrice: number;
  readonly markAtMs: number;
  readonly maintenanceMarginRatio: number;
  readonly positions: number;
  readonly longs: number;
  readonly shorts: number;
  readonly notionalAusd: number;
  /** Isolated margin per side. Not notional per side: that is equal by construction. */
  readonly longMarginAusd: number;
  readonly shortMarginAusd: number;
  readonly marginAusd: number;
  /** Share of this market's notional held by its five largest positions. */
  readonly topFiveShare: number | undefined;
  /** The insurance fund for this market, or why it is unknown. */
  readonly insuranceAusd: number | undefined;
  readonly insuranceReason?: string;
  readonly ladder: readonly LadderPoint[];
  /** One entry per {@link TILE_MOVES}, keyed by the move as a string, e.g. "0.05". */
  readonly atRisk: Readonly<Record<string, AdverseExposure>>;
}

export interface RiskSnapshot {
  readonly asOf: {
    /** The block the positions came from: the indexer's latest processed block. */
    readonly indexerBlock: number | undefined;
    /** The OLDEST mark used, so the worst market's age is the one shown. */
    readonly marksAtMs: number | undefined;
    readonly insuranceAtMs: number | undefined;
    readonly generatedAtMs: number;
  };
  readonly moves: readonly number[];
  readonly counted: {
    readonly positions: number;
    readonly priced: number;
    /** Positions the snapshot could not price, and why, so the hole is visible. */
    readonly unpriced: number;
    readonly unpricedReasons: Readonly<Record<string, number>>;
    readonly markets: number;
  };
  readonly totals: {
    readonly notionalAusd: number;
    /** Isolated margin per side. Not notional per side: that is equal by construction. */
    readonly longMarginAusd: number;
    readonly shortMarginAusd: number;
    readonly marginAusd: number;
    readonly unrealisedPnlAusd: number;
  };
  readonly insurance: {
    /** Sum over the markets with a reading. Undefined when none has one. */
    readonly totalAusd: number | undefined;
    readonly marketsWithReading: number;
    readonly marketsWithout: number;
  };
  /** Every market moving together. The sum of the per-market ladders. */
  readonly ladder: readonly LadderPoint[];
  readonly atRisk: Readonly<Record<string, AdverseExposure>>;
  /** The market with the smallest insurance-to-shortfall ratio at the 10% move, when any market has a shortfall. */
  readonly weakestCover: { readonly market: MarketRef; readonly cover: number } | undefined;
  readonly markets: readonly MarketExposure[];
  /** Every priced position, so a page can list the largest exposed at any rung. */
  readonly positions: readonly ExposedPosition[];
  readonly statements: readonly string[];
}

export const RISK_STATEMENTS: readonly string[] = [
  'This is a static price shock: each rung jumps the mark by a fraction and counts the positions then past maintenance margin. It does not model the path, funding, keeper timing or whether the book can absorb the close, so every figure is exposure, not realised loss.',
  'All markets assumes every market moves together by the same fraction. That is the worst case, not the likely one; a single market’s ladder is the same evaluation restricted to that market.',
];

export interface ExposureInputs {
  readonly positions: readonly IndexedOpenPosition[];
  readonly configs: ReadonlyMap<number, MarketRiskConfig>;
  readonly marks: ReadonlyMap<number, MarkReading>;
  /** Per market. A market absent here is reported with no insurance reading, never as zero. */
  readonly insurance: ReadonlyMap<number, MarketInsuranceReading | { readonly reason: string }>;
  readonly indexerBlock: number | undefined;
  readonly nowMs: number;
}

const moveKey = (move: number): string => move.toFixed(3);

export function buildRiskSnapshot(inputs: ExposureInputs): RiskSnapshot {
  const unpricedReasons: Record<string, number> = {};
  const skip = (reason: string): void => {
    unpricedReasons[reason] = (unpricedReasons[reason] ?? 0) + 1;
  };

  // ── per market accumulators ───────────────────────────────────────────────
  interface Acc {
    readonly market: MarketRef;
    readonly config: MarketRiskConfig;
    readonly mark: MarkReading;
    readonly ladder: { positions: number; notionalAusd: number; marginAusd: number; shortfallAusd: number }[];
    readonly exposed: ExposedPosition[];
    longs: number;
    shorts: number;
    notionalAusd: number;
    longMarginAusd: number;
    shortMarginAusd: number;
    marginAusd: number;
    unrealisedPnlAusd: number;
  }
  const byMarket = new Map<number, Acc>();
  const marketOrder: number[] = [];

  for (const { accountId, position } of inputs.positions) {
    const id = position.market.marketId;
    const config = inputs.configs.get(id);
    const mark = inputs.marks.get(id);
    if (config === undefined) {
      skip('the venue does not list this market, so its maintenance margin is unknown');
      continue;
    }
    if (mark === undefined) {
      skip('the venue reports no mark for this market');
      continue;
    }
    if (position.entryPrice === undefined) {
      skip('the entry price is unknown: the position was opened before the index starts');
      continue;
    }
    if (position.sizeLots <= 0) {
      skip('the position has no size');
      continue;
    }
    let acc = byMarket.get(id);
    if (acc === undefined) {
      acc = {
        market: position.market,
        config,
        mark,
        ladder: LADDER_MOVES.map(() => ({ positions: 0, notionalAusd: 0, marginAusd: 0, shortfallAusd: 0 })),
        exposed: [],
        longs: 0,
        shorts: 0,
        notionalAusd: 0,
        longMarginAusd: 0,
        shortMarginAusd: 0,
        marginAusd: 0,
        unrealisedPnlAusd: 0,
      };
      byMarket.set(id, acc);
      marketOrder.push(id);
    }

    const risk = fromVenuePosition(
      {
        marketId: id,
        symbol: config.symbol,
        side: position.side,
        size: position.sizeLots,
        entryPrice: position.entryPrice,
        margin: position.marginAusd,
        fundingAccrued: 0,
      },
      config,
    );
    const markPNS = priceToPNS(mark.markPrice, config);
    const ausd = (cns: bigint) => scaledToNumber(cns, config.collateralDecimals);
    const now = positionMetrics(risk, markPNS, config);
    const notionalAusd = ausd(now.notionalCNS);

    acc.notionalAusd += notionalAusd;
    if (position.side === 'long') {
      acc.longs += 1;
      acc.longMarginAusd += position.marginAusd;
    } else {
      acc.shorts += 1;
      acc.shortMarginAusd += position.marginAusd;
    }
    acc.marginAusd += position.marginAusd;
    acc.unrealisedPnlAusd += ausd(now.unrealisedPnlCNS);

    // ONE EVALUATION PER RUNG. Everything below reads these.
    let liquidatedFromMove: number | undefined;
    LADDER_MOVES.forEach((move, i) => {
      const shocked = positionMetrics(risk, shockPricePNS(markPNS, move), config);
      if (!shocked.isLiquidatable) return;
      const rung = acc!.ladder[i]!;
      rung.positions += 1;
      rung.notionalAusd += notionalAusd;
      rung.marginAusd += position.marginAusd;
      if (shocked.equityCNS < 0n) rung.shortfallAusd += ausd(-shocked.equityCNS);
      // Rungs run upward, so for a long the last liquidated rung is the highest
      // move; for a short the first is the lowest.
      if (position.side === 'long') liquidatedFromMove = move;
      else liquidatedFromMove ??= move;
    });

    acc.exposed.push({
      accountId,
      market: position.market,
      side: position.side,
      sizeLots: position.sizeLots,
      notionalAusd,
      marginAusd: position.marginAusd,
      leverage: position.leverage,
      entryPrice: position.entryPrice,
      markPrice: mark.markPrice,
      liquidationPrice: now.liquidationPricePNS === undefined ? undefined : scaledToNumber(now.liquidationPricePNS, config.priceDecimals),
      liqBufferPct: now.liqBufferPct,
      unrealisedPnlAusd: ausd(now.unrealisedPnlCNS),
      openedAtMs: position.openedAtMs,
      liquidatedFromMove,
    });
  }

  // ── fold ──────────────────────────────────────────────────────────────────
  const totalLadder = LADDER_MOVES.map((move) => ({ move, positions: 0, notionalAusd: 0, marginAusd: 0, shortfallAusd: 0 }));
  let totalNotional = 0;
  let totalLong = 0;
  let totalShort = 0;
  let totalMargin = 0;
  let totalUpnl = 0;
  let insuranceTotal: number | undefined;
  let withReading = 0;
  let without = 0;
  const marksAt: number[] = [];
  const insuranceAt: number[] = [];

  const markets: MarketExposure[] = marketOrder.map((id) => {
    const acc = byMarket.get(id)!;
    const notionalAusd = acc.notionalAusd;
    totalNotional += notionalAusd;
    totalLong += acc.longMarginAusd;
    totalShort += acc.shortMarginAusd;
    totalMargin += acc.marginAusd;
    totalUpnl += acc.unrealisedPnlAusd;
    marksAt.push(acc.mark.atMs);

    const ladder: LadderPoint[] = acc.ladder.map((rung, i) => {
      const total = totalLadder[i]!;
      total.positions += rung.positions;
      total.notionalAusd += rung.notionalAusd;
      total.marginAusd += rung.marginAusd;
      total.shortfallAusd += rung.shortfallAusd;
      return { move: LADDER_MOVES[i]!, ...rung };
    });

    const reading = inputs.insurance.get(id);
    let insuranceAusd: number | undefined;
    let insuranceReason: string | undefined;
    if (reading === undefined) {
      insuranceReason = 'no insurance reading for this market';
      without += 1;
    } else if ('reason' in reading) {
      insuranceReason = reading.reason;
      without += 1;
    } else {
      insuranceAusd = scaledToNumber(reading.insuranceBalanceCNS, acc.config.collateralDecimals);
      insuranceTotal = (insuranceTotal ?? 0) + insuranceAusd;
      withReading += 1;
      insuranceAt.push(reading.markAtMs);
    }

    const sizes = acc.exposed.map((p) => p.notionalAusd).sort((a, b) => b - a);
    const topFive = sizes.slice(0, 5).reduce((s, v) => s + v, 0);

    return {
      market: acc.market,
      markPrice: acc.mark.markPrice,
      markAtMs: acc.mark.atMs,
      maintenanceMarginRatio: maintenanceMarginRatio(acc.config),
      positions: acc.exposed.length,
      longs: acc.longs,
      shorts: acc.shorts,
      notionalAusd,
      longMarginAusd: acc.longMarginAusd,
      shortMarginAusd: acc.shortMarginAusd,
      marginAusd: acc.marginAusd,
      topFiveShare: notionalAusd > 0 ? topFive / notionalAusd : undefined,
      insuranceAusd,
      ...(insuranceReason === undefined ? {} : { insuranceReason }),
      ladder,
      atRisk: Object.fromEntries(TILE_MOVES.map((size) => [moveKey(size), adverseAt(ladder, size, notionalAusd, insuranceAusd)])),
    };
  });

  const atRisk = Object.fromEntries(TILE_MOVES.map((size) => [moveKey(size), adverseAt(totalLadder, size, totalNotional, insuranceTotal)]));

  // The weakest cover, at the 10% move, among markets that HAVE a shortfall
  // and a reading. A market with no shortfall has nothing to cover and is not
  // "infinitely covered"; it is simply not in the running.
  let weakest: { market: MarketRef; cover: number } | undefined;
  for (const m of markets) {
    const cover = m.atRisk[moveKey(0.1)]?.insuranceCover;
    if (cover === undefined) continue;
    if (weakest === undefined || cover < weakest.cover) weakest = { market: m.market, cover };
  }

  const priced = markets.reduce((s, m) => s + m.positions, 0);
  return {
    asOf: {
      indexerBlock: inputs.indexerBlock,
      marksAtMs: marksAt.length === 0 ? undefined : Math.min(...marksAt),
      insuranceAtMs: insuranceAt.length === 0 ? undefined : Math.min(...insuranceAt),
      generatedAtMs: inputs.nowMs,
    },
    moves: LADDER_MOVES,
    counted: {
      positions: inputs.positions.length,
      priced,
      unpriced: inputs.positions.length - priced,
      unpricedReasons,
      markets: markets.length,
    },
    totals: {
      notionalAusd: totalNotional,
      longMarginAusd: totalLong,
      shortMarginAusd: totalShort,
      marginAusd: totalMargin,
      unrealisedPnlAusd: totalUpnl,
    },
    insurance: { totalAusd: insuranceTotal, marketsWithReading: withReading, marketsWithout: without },
    ladder: totalLadder,
    atRisk,
    weakestCover: weakest,
    markets,
    positions: markets.flatMap((m) => byMarket.get(m.market.marketId)!.exposed),
    statements: RISK_STATEMENTS,
  };
}

/**
 * The rung for a signed move. Rungs are on a fixed grid, so this is an index,
 * not a search; a move off the grid is a caller error and throws.
 */
export function rungIndex(move: number): number {
  const i = Math.round(move / LADDER_STEP) + 100;
  if (i < 0 || i >= LADDER_MOVES.length || Math.abs(LADDER_MOVES[i]! - move) > 1e-9) {
    throw new RangeError(`${move} is not a rung of the ladder (−0.5..0.5 in steps of ${LADDER_STEP})`);
  }
  return i;
}

/**
 * Both adverse directions at `size`, read off the ladder: the fall that takes
 * the longs plus the rise that takes the shorts. A long cannot be liquidated by
 * a rise, so the two rungs count disjoint positions and the sum is exact.
 */
export function adverseAt(ladder: readonly LadderPoint[], size: number, totalNotionalAusd: number, insuranceAusd: number | undefined): AdverseExposure {
  const down = ladder[rungIndex(-size)]!;
  const up = ladder[rungIndex(size)]!;
  const notionalAusd = down.notionalAusd + up.notionalAusd;
  const shortfallAusd = down.shortfallAusd + up.shortfallAusd;
  return {
    size,
    positions: down.positions + up.positions,
    notionalAusd,
    shortfallAusd,
    shareOfNotional: totalNotionalAusd > 0 ? notionalAusd / totalNotionalAusd : undefined,
    insuranceCover: insuranceAusd === undefined || shortfallAusd <= 0 ? undefined : insuranceAusd / shortfallAusd,
  };
}
