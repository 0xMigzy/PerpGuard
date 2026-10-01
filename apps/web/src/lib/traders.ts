/**
 * Pure helpers for the Traders section. No I/O, no React, unit tested.
 */
import type { RoundTrip, TraderDayPoint, TraderSortKey } from '@perpguard/shared';

/** What a search box was given: an address, an account id, or neither. */
export type TraderQuery =
  | { readonly kind: 'address'; readonly address: string }
  | { readonly kind: 'account'; readonly accountId: number }
  /** Part of an address: `0x` plus 3 to 39 hex characters, as typed. */
  | { readonly kind: 'prefix'; readonly prefix: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/** The fewest hex characters a partial address may have. Mirrors the backend's floor. */
export const MIN_PREFIX_HEX = 3;

/**
 * Addresses are accepted IN ANY CASE (CLAUDE.md): a block explorer hands the
 * user a checksummed one and the backend compares case-insensitively. A bare
 * run of digits is an account id, which is the handle that works when the
 * owner was never recorded. Part of an address — with or without its `0x` —
 * is a prefix search over recorded owners. Anything else is refused with a
 * reason rather than sent as a lookup that could only come back empty.
 */
export function parseTraderQuery(raw: string): TraderQuery {
  const q = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { kind: 'address', address: q };
  if (/^\d{1,12}$/.test(q)) return { kind: 'account', accountId: Number(q) };
  // Hex with at least one letter cannot be an account id. With a 0x it is a
  // prefix as typed; without one, it is the same prefix with its 0x restored.
  const hex = /^(0x)?([0-9a-fA-F]+)$/i.exec(q);
  if (hex !== null) {
    const body = hex[2]!;
    if (body.length === 40 && hex[1] === undefined) return { kind: 'address', address: `0x${body}` };
    if (body.length >= MIN_PREFIX_HEX && body.length < 40) return { kind: 'prefix', prefix: `0x${body}` };
    if (body.length < MIN_PREFIX_HEX) return { kind: 'invalid', reason: `a partial address needs at least ${MIN_PREFIX_HEX} hex characters after 0x` };
    return { kind: 'invalid', reason: 'an address is 0x followed by 40 hex characters' };
  }
  if (/^0x/i.test(q)) return { kind: 'invalid', reason: 'an address is 0x followed by hex characters only' };
  return { kind: 'invalid', reason: 'enter a 0x address, part of one, or a numeric account id' };
}

/**
 * Cumulative net PnL over round trips, OLDEST FIRST, for a sparkline.
 *
 * The API serves round trips most recent first, so the list is reversed here.
 * The curve is only over the trips loaded, and it starts at zero, so it reads
 * as "how the last N went", never as the account's lifetime.
 */
export function cumulativePnl(roundTrips: readonly RoundTrip[]): readonly number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = roundTrips.length - 1; i >= 0; i -= 1) {
    total += roundTrips[i]!.netPnlAusd;
    out.push(total);
  }
  return out;
}

/** The buffer as a UI verdict. Negative is PAST liquidation, not a small buffer. */
export function bufferTier(liqBufferPct: number | undefined): 'past' | 'danger' | 'watch' | 'safe' | 'unknown' {
  if (liqBufferPct === undefined) return 'unknown';
  if (liqBufferPct < 0) return 'past';
  if (liqBufferPct < 0.03) return 'danger';
  if (liqBufferPct < 0.08) return 'watch';
  return 'safe';
}

/** One trader's days folded into window totals. Every figure keeps its count. */
export interface DayTotals {
  readonly days: number;
  readonly netPnlAusd: number;
  readonly realisedPnlAusd: number;
  readonly fundingAusd: number;
  readonly feesAusd: number;
  readonly volumeAusd: number;
  readonly tradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly roundTrips: number;
  readonly liquidationCount: number;
  readonly rescuableLiquidationCount: number;
  readonly depositedAusd: number;
  readonly withdrawnAusd: number;
}

export function sumDays(days: readonly TraderDayPoint[]): DayTotals {
  const t = {
    days: days.length, netPnlAusd: 0, realisedPnlAusd: 0, fundingAusd: 0, feesAusd: 0, volumeAusd: 0, tradeCount: 0,
    wins: 0, losses: 0, roundTrips: 0, liquidationCount: 0, rescuableLiquidationCount: 0, depositedAusd: 0, withdrawnAusd: 0,
  };
  for (const d of days) {
    t.netPnlAusd += d.netPnlAusd;
    t.realisedPnlAusd += d.realisedPnlAusd;
    t.fundingAusd += d.fundingAusd;
    t.feesAusd += d.feesAusd;
    t.volumeAusd += d.volumeAusd;
    t.tradeCount += d.tradeCount;
    t.wins += d.wins;
    t.losses += d.losses;
    t.roundTrips += d.wins + d.losses;
    t.liquidationCount += d.liquidationCount;
    t.rescuableLiquidationCount += d.rescuableLiquidationCount;
    t.depositedAusd += d.depositedAusd;
    t.withdrawnAusd += d.withdrawnAusd;
  }
  return t;
}

/**
 * A win rate, or undefined under the floor.
 *
 * The floor is the backend's, passed in rather than repeated here, so the
 * page cannot compute a ratio the API would have withheld.
 */
export function winRateOf(wins: number, roundTrips: number, minRoundTrips: number): number | undefined {
  if (roundTrips < minRoundTrips || roundTrips === 0) return undefined;
  return wins / roundTrips;
}

/** Days -> points with the running net PnL alongside each day's own. */
export function cumulativeDays(days: readonly TraderDayPoint[]): readonly { readonly dayMs: number; readonly netPnlAusd: number; readonly cumulativeAusd: number; readonly volumeAusd: number; readonly endFreeBalanceAusd: number }[] {
  let running = 0;
  return days.map((d) => {
    running += d.netPnlAusd;
    return { dayMs: d.dayMs, netPnlAusd: d.netPnlAusd, cumulativeAusd: running, volumeAusd: d.volumeAusd, endFreeBalanceAusd: d.endFreeBalanceAusd };
  });
}

/** The direction a list column starts in when first clicked: figures high-first. */
export function defaultTraderDirection(key: TraderSortKey): 'asc' | 'desc' {
  return key === 'lastActive' ? 'desc' : 'desc';
}

/** "1–50 of 1,478" for the pager. */
export function pageRange(offset: number, shown: number, total: number): { readonly from: number; readonly to: number; readonly total: number } {
  if (shown === 0) return { from: 0, to: 0, total };
  return { from: offset + 1, to: offset + shown, total };
}
