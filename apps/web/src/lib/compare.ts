/**
 * Compare wallets: up to four accounts side by side. Pure; the page fetches.
 *
 * Every figure is the one the trader profile shows, computed by the profile's
 * own helpers (`sumDays`, `winRateOf`, `accountSummary`), so a wallet reads the
 * same here as on its own page. Ratios are withheld under the backend's floor,
 * exactly as there.
 */
import type { MarketPnl, TraderDayPoint, WalletProfile } from '@perpguard/shared';
import { accountSummary, sumDays, winRateOf } from './traders.ts';

export const MAX_COMPARE = 4;

/** `?a=4886,5201` -> account ids, in order, deduplicated, at most four. Anything else is reported, not guessed. */
export function parseCompareIds(raw: string | null | undefined): { readonly ids: readonly number[]; readonly dropped: readonly string[] } {
  const ids: number[] = [];
  const dropped: string[] = [];
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const n = /^\d{1,9}$/.test(part) ? Number(part) : Number.NaN;
    if (!Number.isSafeInteger(n) || n <= 0) dropped.push(part);
    else if (ids.includes(n)) continue;
    else if (ids.length >= MAX_COMPARE) dropped.push(part);
    else ids.push(n);
  }
  return { ids, dropped };
}

export function compareHref(ids: readonly number[]): string {
  return ids.length === 0 ? '/compare' : `/compare?a=${ids.join(',')}`;
}

export type AddOutcome = { readonly kind: 'added'; readonly ids: readonly number[] } | { readonly kind: 'already' } | { readonly kind: 'full' };

export function withAdded(ids: readonly number[], id: number): AddOutcome {
  if (ids.includes(id)) return { kind: 'already' };
  if (ids.length >= MAX_COMPARE) return { kind: 'full' };
  return { kind: 'added', ids: [...ids, id] };
}

export function withRemoved(ids: readonly number[], id: number): readonly number[] {
  return ids.filter((x) => x !== id);
}

export interface CompareColumn {
  readonly accountId: number;
  readonly address: string;
  /** Free + margin + unrealised, now; undefined while positions are not all priced. */
  readonly equityAusd: number | undefined;
  readonly window: {
    readonly netPnlAusd: number;
    readonly volumeAusd: number;
    readonly roundTrips: number;
    /** Withheld under the floor. */
    readonly winRate: number | undefined;
    readonly liquidations: number;
    readonly rescuableLiquidations: number;
  };
  readonly lifetime: {
    readonly netPnlAusd: number;
    readonly volumeAusd: number;
    readonly roundTrips: number;
    readonly winRate: number | undefined;
    readonly profitFactor: number | undefined;
    readonly maxDrawdownAusd: number;
    readonly longestWinStreak: number;
    readonly longestLossStreak: number;
    readonly averageHoldMs: number | undefined;
    readonly bestMarket: MarketPnl | undefined;
    readonly worstMarket: MarketPnl | undefined;
    readonly liquidations: number;
    /** Over the liquidations that can be judged; `judgeable` is the denominator. */
    readonly rescuableLiquidations: number;
    readonly judgeableLiquidations: number;
  };
  readonly openPositions: number;
  readonly floor: number;
}

export function compareColumn(
  profile: WalletProfile,
  days: readonly TraderDayPoint[],
  positions: readonly { readonly position: { readonly marginAusd: number }; readonly unrealisedPnlAusd?: number | undefined }[] | undefined,
): CompareColumn {
  const floor = profile.performance.minRoundTripsForRatios;
  const w = sumDays(days);
  const priced = positions ?? profile.openPositions.map((position) => ({ position }));
  const summary = accountSummary(profile, priced);
  const perf = profile.performance;
  return {
    accountId: profile.accountId,
    address: profile.address,
    // Unpriced positions (positions not loaded yet) make equity unknown, never a partial sum.
    equityAusd: positions === undefined && profile.openPositions.length > 0 ? undefined : summary.equityAusd,
    window: {
      netPnlAusd: w.netPnlAusd,
      volumeAusd: w.volumeAusd,
      roundTrips: w.roundTrips,
      winRate: winRateOf(w.wins, w.roundTrips, floor),
      liquidations: w.liquidationCount,
      rescuableLiquidations: w.rescuableLiquidationCount,
    },
    lifetime: {
      netPnlAusd: profile.netPnlAusd,
      volumeAusd: profile.volumeAusd,
      roundTrips: perf.roundTrips,
      winRate: perf.winRate,
      profitFactor: perf.profitFactor,
      maxDrawdownAusd: perf.maxDrawdownAusd,
      longestWinStreak: perf.longestWinStreak,
      longestLossStreak: perf.longestLossStreak,
      averageHoldMs: perf.averageHoldMs,
      bestMarket: perf.bestMarket,
      worstMarket: perf.worstMarket,
      liquidations: profile.rescues.count,
      rescuableLiquidations: profile.rescues.rescuableCount,
      judgeableLiquidations: profile.rescues.judgeableCount,
    },
    // From the same read as equity when it has arrived: an active account's positions churn between two calls.
    openPositions: positions?.length ?? profile.openPositions.length,
    floor,
  };
}

export interface AlignedPoint {
  readonly dayMs: number;
  /** Cumulative net PnL since the window opened, per account id. */
  readonly values: Readonly<Record<number, number>>;
}

/**
 * Every wallet's running net PnL on ONE day axis: the union of their days.
 * A day a wallet did not trade adds nothing, so its line holds level; before
 * its first day in the window it sits at 0, where the window began.
 */
export function alignedCumulative(series: readonly { readonly accountId: number; readonly days: readonly TraderDayPoint[] }[]): readonly AlignedPoint[] {
  const axis = [...new Set(series.flatMap((s) => s.days.map((d) => d.dayMs)))].sort((a, b) => a - b);
  const byWallet = series.map((s) => ({ id: s.accountId, net: new Map(s.days.map((d) => [d.dayMs, d.netPnlAusd])) }));
  const running = new Map<number, number>(series.map((s) => [s.accountId, 0]));
  return axis.map((dayMs) => {
    const values: Record<number, number> = {};
    for (const w of byWallet) {
      const next = running.get(w.id)! + (w.net.get(dayMs) ?? 0);
      running.set(w.id, next);
      values[w.id] = next;
    }
    return { dayMs, values };
  });
}

/** The label every wallet carries wherever its colour appears: never the colour alone. */
export function walletLabel(column: { readonly accountId: number; readonly address: string }, short: (a: string) => string): string {
  return column.address === '' ? `#${column.accountId}` : `${short(column.address)} · #${column.accountId}`;
}
