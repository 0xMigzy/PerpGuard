/**
 * Pure helpers for the Risk section. No I/O, no React, and NO RISK MATHS:
 * every rung, buffer and shortfall arrived from the backend's one ladder.
 * These only pick rungs out of it and decide what to draw.
 */
import type { ExposedPosition, LadderPoint, MarketExposure, RiskSnapshot } from '@perpguard/shared';

/** The rungs the ladder chart draws, as positive sizes. Each is a rung of the server's grid. */
export const CHART_SIZES: readonly number[] = [0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5];

/**
 * Which ladder the page reads: every market together, or one. `insuranceAusd`
 * is set for ONE market only: a fund pays for its own market, so there is no
 * all-markets cover ratio to draw.
 */
export function ladderFor(snapshot: RiskSnapshot, marketId: number | undefined): { readonly ladder: readonly LadderPoint[]; readonly openInterestAusd: number; readonly insuranceAusd: number | undefined; readonly label: string } {
  if (marketId === undefined) {
    return { ladder: snapshot.ladder, openInterestAusd: snapshot.totals.openInterestAusd, insuranceAusd: undefined, label: 'All markets' };
  }
  const m = snapshot.markets.find((x) => x.market.marketId === marketId);
  if (m === undefined) return { ladder: [], openInterestAusd: 0, insuranceAusd: undefined, label: `market ${marketId}` };
  return { ladder: m.ladder, openInterestAusd: m.openInterestAusd, insuranceAusd: m.insuranceAusd, label: m.market.symbol ?? m.market.indexerName };
}

/** "falls" / "rises" for a signed move. */
export function directionWord(move: number): 'falls' | 'rises' {
  return move < 0 ? 'falls' : 'rises';
}

/** Whole days between two instants, for "never drawn on in N days". */
export function wholeDays(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000));
}

/** The rung for a signed move, by index into the fixed grid. Undefined off the grid. */
export function rungAt(ladder: readonly LadderPoint[], moves: readonly number[], move: number): LadderPoint | undefined {
  const i = moves.findIndex((m) => Math.abs(m - move) < 1e-9);
  return i < 0 ? undefined : ladder[i];
}

export interface ChartRung {
  readonly size: number;
  readonly longsAusd: number;
  readonly shortsAusd: number;
  readonly longs: number;
  readonly shorts: number;
}

/** Longs at −size and shorts at +size, one row per chart size. */
export function chartRungs(ladder: readonly LadderPoint[], moves: readonly number[]): readonly ChartRung[] {
  return CHART_SIZES.map((size) => {
    const down = rungAt(ladder, moves, -size);
    const up = rungAt(ladder, moves, size);
    return { size, longsAusd: down?.notionalAusd ?? 0, shortsAusd: up?.notionalAusd ?? 0, longs: down?.positions ?? 0, shorts: up?.positions ?? 0 };
  });
}

/**
 * The positions a signed move liquidates, largest first: longs when the move
 * is down, shorts when it is up, and at zero whatever is already past. Uses
 * the rung the backend recorded per position, so this list and the ladder's
 * count are the same selection.
 */
export function exposedAt(positions: readonly ExposedPosition[], move: number, marketId: number | undefined): readonly ExposedPosition[] {
  return positions
    .filter((p) => marketId === undefined || p.market.marketId === marketId)
    .filter((p) => {
      if (p.liquidatedFromMove === undefined) return false;
      if (move < 0) return p.side === 'long' && move <= p.liquidatedFromMove + 1e-9;
      if (move > 0) return p.side === 'short' && move >= p.liquidatedFromMove - 1e-9;
      return p.side === 'long' ? p.liquidatedFromMove >= -1e-9 : p.liquidatedFromMove <= 1e-9;
    })
    .sort((a, b) => b.notionalAusd - a.notionalAusd);
}

/** Which side a signed move hurts. */
export function sideExposed(move: number): 'long' | 'short' | 'both' {
  return move < 0 ? 'long' : move > 0 ? 'short' : 'both';
}

/** The market with the smallest cover among those that have one, for the tile's caption. */
export function marketLabel(m: MarketExposure): string {
  return m.market.symbol ?? `market ${m.market.marketId}`;
}

/** A signed move as "−10%" / "+2.5%". */
export function formatMove(move: number): string {
  const pct = Math.round(move * 1000) / 10;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct)}%`;
}
