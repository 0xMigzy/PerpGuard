/**
 * The Exchange's AUSD balance over time, REBUILT FROM EVENTS. Pure.
 *
 * Only two things move AUSD across the contract's edge: collateral deposits and
 * withdrawals (indexed), and the protocol treasury's own deposits and
 * withdrawals (scanned off the chain's logs). Their running total since launch
 * is the balance. Measured 6 Oct 2026 at block 110,989,971: 3,838,349.21
 * rebuilt against the contract's 3,838,376.91, 27.70 AUSD apart.
 *
 * Built FORWARD from launch, never backward from today: walking back from the
 * live balance pinned every unindexed movement onto launch day, and at the All
 * window the line started 178.6K below zero.
 */
import type { DailyPoint, ProtocolTreasuryDays } from '@perpguard/shared';

export interface BalanceDay {
  readonly dayMs: number;
  /** The rebuilt balance at the day's close. */
  readonly levelAusd: number;
  readonly collateralNetAusd: number;
  readonly treasuryNetAusd: number;
}

/** Daily collateral flows since launch + treasury days -> the running balance, oldest first. */
export function rebuiltBalance(days: readonly Pick<DailyPoint, 'dayMs' | 'netFlowAusd'>[], treasury: ProtocolTreasuryDays): readonly BalanceDay[] {
  const collateral = new Map(days.map((d) => [d.dayMs, d.netFlowAusd]));
  const treasuryBy = new Map(treasury.days.map((d) => [d.dayMs, d.inAusd - d.outAusd]));
  const axis = [...new Set([...collateral.keys(), ...treasuryBy.keys()])].sort((a, b) => a - b);
  let level = 0;
  return axis.map((dayMs) => {
    const c = collateral.get(dayMs) ?? 0;
    const t = treasuryBy.get(dayMs) ?? 0;
    level += c + t;
    return { dayMs, levelAusd: level, collateralNetAusd: c, treasuryNetAusd: t };
  });
}

/** Within this share of the contract's balance, the rebuild is said to match it. */
export const MATCH_TOLERANCE = 0.0001;

export interface BalanceCheck {
  readonly rebuiltAusd: number;
  readonly contractAusd: number;
  /** contract − rebuilt. */
  readonly gapAusd: number;
  readonly matches: boolean;
}

export function balanceCheck(rebuiltAusd: number, contractAusd: number): BalanceCheck {
  const gapAusd = contractAusd - rebuiltAusd;
  return { rebuiltAusd, contractAusd, gapAusd, matches: Math.abs(gapAusd) <= Math.abs(contractAusd) * MATCH_TOLERANCE };
}

/**
 * The balance at the START of a rolling window, from the live reading: now,
 * less the window's collateral flow, less the treasury movements inside it.
 * The treasury part is why this exists: the old tile left it out.
 */
export function balanceBefore(contractNowAusd: number, windowCollateralNetAusd: number, movements: ProtocolTreasuryDays['movements'], sinceMs: number | undefined): number {
  const treasury = movements.filter((m) => sinceMs === undefined || m.atMs >= sinceMs).reduce((s, m) => s + m.ausd, 0);
  return contractNowAusd - windowCollateralNetAusd - treasury;
}
