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
import type { DailyPoint, ProtocolTreasuryDays, TreasuryScanStatus } from '@perpguard/shared';
import { formatAge, formatCount, formatMoneyExact } from './format.ts';

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

/**
 * What the page says about the rebuild and the scan, from the backend's own
 * reconciliation at ONE block (never this browser's live balance against an
 * index that trails it). `tone` is 'watch' when something needs a reader's eye:
 * a difference outside the known one, a failed scan, or no check yet.
 */
export interface TreasuryLines {
  /** The one line shown by default. A problem is IN it, never behind "details". */
  readonly short: { readonly tone: 'ok' | 'watch'; readonly text: string };
  readonly reconciliation: { readonly tone: 'ok' | 'watch'; readonly text: string } | undefined;
  readonly scan: { readonly tone: 'ok' | 'watch'; readonly text: string };
}

export function treasuryLines(scan: TreasuryScanStatus, nowMs: number): TreasuryLines {
  const r = scan.reconciliation;
  const reconciliation =
    r === undefined
      ? undefined
      : r.withinExpected
        ? {
            tone: 'ok' as const,
            text: `Rebuilt from events, matches the contract at block ${formatCount(r.atBlock)}: ${formatMoneyExact(r.rebuiltAusd)} rebuilt, ${formatMoneyExact(r.contractAusd)} held, ${formatMoneyExact(r.gapAusd)} apart, the known difference since 6 Oct 2026 that no event explains.`,
          }
        : {
            tone: 'watch' as const,
            text: `Rebuilt and contract differ by ${formatMoneyExact(r.gapAusd)} at block ${formatCount(r.atBlock)}, outside the known ${formatMoneyExact(r.expectedGapAusd)} ± ${formatMoneyExact(r.toleranceAusd, 0)}: a movement the rebuild does not explain. ${formatMoneyExact(r.rebuiltAusd)} rebuilt, ${formatMoneyExact(r.contractAusd)} held.`,
          };
  const through = scan.throughBlock === undefined ? 'no block yet' : `block ${formatCount(scan.throughBlock)}`;
  const minutes = Math.round(scan.intervalMs / 60_000);
  const failed = scan.lastError === undefined ? '' : ` The last scan failed ${scan.lastErrorAtMs === undefined ? '' : `${formatAge(nowMs - scan.lastErrorAtMs)} ago `}(${scan.lastError}); it retries every ${minutes} min.`;
  const text =
    scan.scannedAtMs === undefined
      ? `Treasury events scanned through ${through}; the first scan since start-up has not finished.${failed}`
      : `Treasury events scanned through ${through}, ${formatAge(nowMs - scan.scannedAtMs)} ago; rescanned every ${minutes} min.${failed}`;
  const age = scan.scannedAtMs === undefined ? 'first scan running' : `scanned ${formatAge(nowMs - scan.scannedAtMs)} ago`;
  const failedTag = scan.lastError === undefined ? '' : ' · last scan failed';
  const short =
    r === undefined
      ? { tone: 'watch' as const, text: `Rebuilt from events; not yet checked against the contract · ${age}${failedTag}` }
      : r.withinExpected
        ? { tone: scan.lastError === undefined ? ('ok' as const) : ('watch' as const), text: `Matches the contract to within ${formatMoneyExact(Math.abs(r.gapAusd))} · ${age}${failedTag}` }
        : { tone: 'watch' as const, text: `Off the contract by ${formatMoneyExact(r.gapAusd)}, beyond the known ${formatMoneyExact(r.expectedGapAusd)} ± ${formatMoneyExact(r.toleranceAusd, 0)} · ${age}${failedTag}` };
  return { short, reconciliation, scan: { tone: scan.lastError === undefined && scan.scannedAtMs !== undefined ? 'ok' : 'watch', text } };
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
