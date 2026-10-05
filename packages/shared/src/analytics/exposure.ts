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
 *
 * ONE DIRECTION AT A TIME, NEVER SUMMED. A fall closes longs and a rise
 * closes shorts, and no single price move does both, so a count, a notional
 * or a shortfall that adds the fall rung to the rise rung describes a world
 * that cannot happen (the page did exactly that until 5 Oct 2026: "255 at risk
 * at 10%" was 165 longs in a fall plus 90 shorts in a rise). Every figure here
 * is one rung, i.e. one signed move.
 *
 * OPEN INTEREST IS ONE SIDE. Every long lot is matched by a short lot, so the
 * summed notional of all positions is twice the open interest. `notionalAusd`
 * keeps that two-sided sum under its own meaning (total position value, both
 * sides); shares are taken of `openInterestAusd`, half of it, which matched
 * the contract's own long open interest and the venue's figure on 5 Oct 2026
 * (docs/notes/risk-verification-2026-10-05.md).
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
  /** How many positions have equity below zero at this rung: they lose more than their own collateral. */
  readonly shortfallPositions: number;
}

/**
 * Exposure to ONE signed move: a fall (`move < 0`) closes longs only, a rise
 * closes shorts only. Shares are of ONE-SIDED open interest.
 */
export interface DirectionalExposure {
  /** Signed fraction: −0.1 is a 10% fall. */
  readonly move: number;
  /** The side this move closes. */
  readonly side: Side;
  readonly positions: number;
  /** Notional at the current mark of the positions this move liquidates. */
  readonly notionalAusd: number;
  /** Losses beyond the positions' own collateral at the shocked mark. */
  readonly shortfallAusd: number;
  /** Positions whose loss passes their own collateral at this move. */
  readonly shortfallPositions: number;
  /** `notionalAusd / openInterestAusd`, or undefined when there is no open interest. */
  readonly shareOfOpenInterest: number | undefined;
}

/** The two directions at one size, side by side and NEVER added together. */
export interface AtRiskPair {
  readonly size: number;
  readonly fall: DirectionalExposure;
  readonly rise: DirectionalExposure;
  /** The direction with the larger shortfall (a tie goes to the fall): the worse single scenario. */
  readonly worse: DirectionalExposure;
}

/**
 * Insurance against ONE market's worse single direction at 10%. Funds are per
 * market and are not pooled, so there is no cross-market ratio anywhere.
 */
export interface MarketCover {
  /** The direction whose shortfall is compared. */
  readonly direction: 'fall' | 'rise';
  readonly shortfallAusd: number;
  /** `insurance / shortfall`; undefined with no shortfall to cover or no insurance reading. */
  readonly cover: number | undefined;
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
  /** Total position value, BOTH sides: twice the open interest. Never call it open interest. */
  readonly notionalAusd: number;
  /** One side: the market's open interest at the mark. */
  readonly openInterestAusd: number;
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
  /** One entry per {@link TILE_MOVES}, keyed by the move as a string, e.g. "0.050". */
  readonly atRisk: Readonly<Record<string, AtRiskPair>>;
  /** Insurance against this market's worse single direction at 10%. */
  readonly cover10: MarketCover;
}

export interface RiskSnapshot {
  readonly asOf: {
    /** The block the positions came from: the indexer's latest processed block. */
    readonly indexerBlock: number | undefined;
    /** The OLDEST mark used, so the worst market's age is the one shown. */
    readonly marksAtMs: number | undefined;
    readonly insuranceAtMs: number | undefined;
    /** The timestamp of `indexerBlock`, from the chain. Undefined when it could not be read. */
    readonly indexerBlockAtMs: number | undefined;
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
    /** Total position value, BOTH sides: twice the open interest. Never call it open interest. */
    readonly notionalAusd: number;
    /** One side: the protocol's open interest at the marks. */
    readonly openInterestAusd: number;
    /** Isolated margin per side. Not notional per side: that is equal by construction. */
    readonly longMarginAusd: number;
    readonly shortMarginAusd: number;
    readonly marginAusd: number;
    readonly unrealisedPnlAusd: number;
  };
  readonly insurance: {
    /**
     * Sum of the per-market fund balances: how much money the funds hold. A
     * total, never a cover ratio: a fund only pays for its own market.
     */
    readonly totalAusd: number | undefined;
    readonly marketsWithReading: number;
    readonly marketsWithout: number;
  };
  /** Whether the funds have ever been drawn on, from the index. Undefined when not read. */
  readonly backstop: BackstopHistory | undefined;
  /** Every market moving together. The sum of the per-market ladders. */
  readonly ladder: readonly LadderPoint[];
  readonly atRisk: Readonly<Record<string, AtRiskPair>>;
  /**
   * The market with the smallest insurance-to-shortfall ratio, each market
   * against its OWN worse single direction at 10%, when any market has a
   * shortfall and a reading.
   */
  readonly weakestCover: { readonly market: MarketRef; readonly cover: number; readonly direction: 'fall' | 'rise'; readonly shortfallAusd: number } | undefined;
  readonly markets: readonly MarketExposure[];
  /** Every priced position, so a page can list the largest exposed at any rung. */
  readonly positions: readonly ExposedPosition[];
  readonly statements: readonly string[];
}

export const RISK_STATEMENTS: readonly string[] = [
  'This is a static price shock: each rung jumps the mark by a fraction and counts the positions then past maintenance margin. It does not model the path, funding, keeper timing or whether the book can absorb the close, so every figure is exposure, not realised loss.',
  'All markets assumes every market moves together by the same fraction. That is the worst case, not the likely one; a single market’s ladder is the same evaluation restricted to that market.',
];

/**
 * Whether the backstop has ever been used, read from the index: liquidations
 * the insurance fund topped up, and liquidations that left bad debt.
 */
export interface BackstopHistory {
  readonly liquidations: number;
  readonly insuranceCredits: number;
  readonly insuranceCreditedAusd: number;
  readonly badDebtLiquidations: number;
  readonly badDebtAusd: number;
  /** Where the index's history starts, so "never" says over how long. */
  readonly sinceMs: number | undefined;
}

export interface ExposureInputs {
  readonly positions: readonly IndexedOpenPosition[];
  readonly configs: ReadonlyMap<number, MarketRiskConfig>;
  readonly marks: ReadonlyMap<number, MarkReading>;
  /** Per market. A market absent here is reported with no insurance reading, never as zero. */
  readonly insurance: ReadonlyMap<number, MarketInsuranceReading | { readonly reason: string }>;
  readonly indexerBlock: number | undefined;
  readonly indexerBlockAtMs?: number | undefined;
  readonly backstop?: BackstopHistory | undefined;
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
    readonly ladder: { positions: number; notionalAusd: number; marginAusd: number; shortfallAusd: number; shortfallPositions: number }[];
    readonly exposed: ExposedPosition[];
    longs: number;
    shorts: number;
    notionalAusd: number;
    longNotionalAusd: number;
    shortNotionalAusd: number;
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
        ladder: LADDER_MOVES.map(() => ({ positions: 0, notionalAusd: 0, marginAusd: 0, shortfallAusd: 0, shortfallPositions: 0 })),
        exposed: [],
        longs: 0,
        shorts: 0,
        notionalAusd: 0,
        longNotionalAusd: 0,
        shortNotionalAusd: 0,
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
        // KNOWN GAP, LEFT ON PURPOSE (5 Oct 2026). The docs' formula subtracts
        // C_Funding, which the contract carries per position as `premiumPnlCNS`;
        // the index does not, so it is zero here. Measured on chain across the
        // 255 positions a 10% move liquidated: |premiumPnl| summed to 494 AUSD
        // and moved the 10% shortfall from 5,872.91 to 5,895.40. Its sign
        // convention is unconfirmed. See docs/notes/risk-verification-2026-10-05.md.
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
      acc.longNotionalAusd += notionalAusd;
      acc.longMarginAusd += position.marginAusd;
    } else {
      acc.shorts += 1;
      acc.shortNotionalAusd += notionalAusd;
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
      if (shocked.equityCNS < 0n) {
        rung.shortfallAusd += ausd(-shocked.equityCNS);
        rung.shortfallPositions += 1;
      }
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
  const totalLadder = LADDER_MOVES.map((move) => ({ move, positions: 0, notionalAusd: 0, marginAusd: 0, shortfallAusd: 0, shortfallPositions: 0 }));
  let totalNotional = 0;
  let totalOpenInterest = 0;
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
    // One side. Equal by construction on an order book; the mean of the two
    // keeps the figure honest if the index were ever caught mid-update.
    const openInterestAusd = (acc.longNotionalAusd + acc.shortNotionalAusd) / 2;
    totalNotional += notionalAusd;
    totalOpenInterest += openInterestAusd;
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
      total.shortfallPositions += rung.shortfallPositions;
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

    const atRisk = Object.fromEntries(TILE_MOVES.map((size) => [moveKey(size), atRiskPair(ladder, size, openInterestAusd)]));
    const ten = atRisk[moveKey(0.1)]!;
    const worse10 = ten.worse;
    const cover10: MarketCover = {
      direction: worse10.move < 0 ? 'fall' : 'rise',
      shortfallAusd: worse10.shortfallAusd,
      cover: insuranceAusd === undefined || worse10.shortfallAusd <= 0 ? undefined : insuranceAusd / worse10.shortfallAusd,
    };

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
      openInterestAusd,
      longMarginAusd: acc.longMarginAusd,
      shortMarginAusd: acc.shortMarginAusd,
      marginAusd: acc.marginAusd,
      topFiveShare: notionalAusd > 0 ? topFive / notionalAusd : undefined,
      insuranceAusd,
      ...(insuranceReason === undefined ? {} : { insuranceReason }),
      ladder,
      atRisk,
      cover10,
    };
  });

  const atRisk = Object.fromEntries(TILE_MOVES.map((size) => [moveKey(size), atRiskPair(totalLadder, size, totalOpenInterest)]));

  // The weakest cover among markets that HAVE a shortfall and a reading, each
  // against its own worse direction. A market with no shortfall has nothing
  // to cover and is not "infinitely covered"; it is simply not in the running.
  let weakest: RiskSnapshot['weakestCover'];
  for (const m of markets) {
    const { cover, direction, shortfallAusd } = m.cover10;
    if (cover === undefined) continue;
    if (weakest === undefined || cover < weakest.cover) weakest = { market: m.market, cover, direction, shortfallAusd };
  }

  const priced = markets.reduce((s, m) => s + m.positions, 0);
  return {
    asOf: {
      indexerBlock: inputs.indexerBlock,
      marksAtMs: marksAt.length === 0 ? undefined : Math.min(...marksAt),
      insuranceAtMs: insuranceAt.length === 0 ? undefined : Math.min(...insuranceAt),
      indexerBlockAtMs: inputs.indexerBlockAtMs,
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
      openInterestAusd: totalOpenInterest,
      longMarginAusd: totalLong,
      shortMarginAusd: totalShort,
      marginAusd: totalMargin,
      unrealisedPnlAusd: totalUpnl,
    },
    insurance: { totalAusd: insuranceTotal, marketsWithReading: withReading, marketsWithout: without },
    backstop: inputs.backstop,
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

/** One signed move, read off the ladder. Its share is of ONE-SIDED open interest. */
export function directionalAt(ladder: readonly LadderPoint[], move: number, openInterestAusd: number): DirectionalExposure {
  const rung = ladder[rungIndex(move)]!;
  return {
    move,
    side: move < 0 ? 'long' : 'short',
    positions: rung.positions,
    notionalAusd: rung.notionalAusd,
    shortfallAusd: rung.shortfallAusd,
    shortfallPositions: rung.shortfallPositions,
    shareOfOpenInterest: openInterestAusd > 0 ? rung.notionalAusd / openInterestAusd : undefined,
  };
}

/**
 * A fall of `size` and a rise of `size`, side by side. Deliberately no sum:
 * the two are alternative worlds, and a total of both is a move that cannot
 * happen.
 */
export function atRiskPair(ladder: readonly LadderPoint[], size: number, openInterestAusd: number): AtRiskPair {
  const fall = directionalAt(ladder, -size, openInterestAusd);
  const rise = directionalAt(ladder, size, openInterestAusd);
  return { size, fall, rise, worse: rise.shortfallAusd > fall.shortfallAusd ? rise : fall };
}
