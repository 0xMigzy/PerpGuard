/**
 * Pure helpers for the Traders section. No I/O, no React, unit tested.
 */
import type { RoundTrip, TraderDayPoint, TraderRanking, TraderRow, TraderSortKey } from '@perpguard/shared';

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

// ── the Traders page: rankings, search, open-position PnL ───────────────────

/** Which table column a ranking orders by, so the page can mark it. */
export type RankedColumn = 'netPnl' | 'volume' | 'liquidations' | 'netFlow';

export interface RankingInfo {
  readonly key: TraderRanking;
  /** The tab. */
  readonly label: string;
  readonly column: RankedColumn;
  /** One sentence under the tabs: what this list is, and its rule. */
  readonly describe: (floor: number) => string;
  /** What an empty list means for this ranking, in the window. */
  readonly empty: (window: string) => string;
}

/**
 * The five leaderboards, in tab order. The rules themselves live in the
 * backend, which still serves a `spare` ranking; the page no longer offers it,
 * so `?rank=spare` falls back to the default.
 */
export const RANKINGS: readonly RankingInfo[] = [
  {
    key: 'pnl',
    label: 'Top PnL',
    column: 'netPnl',
    describe: (floor) => `Highest Net PnL (after fees and funding), among accounts with at least ${floor} round trips in the window, so one lucky trade cannot top it.`,
    empty: (w) => `No account closed enough round trips ${w} to be ranked.`,
  },
  {
    key: 'losses',
    label: 'Top losses',
    column: 'netPnl',
    describe: (floor) => `Lowest Net PnL (after fees and funding), among accounts with at least ${floor} round trips in the window.`,
    empty: (w) => `No account closed enough round trips ${w} to be ranked.`,
  },
  {
    key: 'volume',
    label: 'Volume',
    column: 'volume',
    describe: () => 'Most traded, by the account\'s own volume (both sides of its fills).',
    empty: (w) => `No account traded ${w}.`,
  },
  {
    key: 'liquidated',
    label: 'Liquidated',
    column: 'liquidations',
    describe: () => 'Most liquidations in the window, with how many the account could have prevented.',
    empty: (w) => `No account was liquidated ${w}.`,
  },
  {
    key: 'flows',
    label: 'Flows',
    column: 'netFlow',
    describe: () => 'Track capital moving into and out of Perpl trader accounts.',
    empty: (w) => `No account deposited or withdrew ${w}.`,
  },
];

export const DEFAULT_RANKING: TraderRanking = 'pnl';

export function rankingInfo(key: TraderRanking): RankingInfo {
  return RANKINGS.find((r) => r.key === key) ?? RANKINGS[0]!;
}

/** The ranking from a `?rank=` value, or the default. */
export function rankingFromQuery(value: string | null | undefined): TraderRanking {
  return RANKINGS.some((r) => r.key === value) ? (value as TraderRanking) : DEFAULT_RANKING;
}

/**
 * What the panel's search box sends: undefined for an empty box, the
 * normalised query for a good one, or the reason a bad one is not sent.
 */
export function searchParam(raw: string): { readonly q: string | undefined } | { readonly invalid: string } {
  if (raw.trim() === '') return { q: undefined };
  const parsed = parseTraderQuery(raw.trim().replace(/^#/, ''));
  switch (parsed.kind) {
    case 'address':
      return { q: parsed.address.toLowerCase() };
    case 'prefix':
      return { q: parsed.prefix.toLowerCase() };
    case 'account':
      return { q: String(parsed.accountId) };
    case 'invalid':
      return { invalid: parsed.reason };
  }
}

/**
 * Unrealised PnL per account, summed over its PRICED open positions in the
 * Risk snapshot. An account the snapshot does not price is absent rather
 * than zero: zero would claim a flat book.
 */
export function unrealisedByAccount(positions: readonly { readonly accountId: number; readonly unrealisedPnlAusd: number }[]): ReadonlyMap<number, { readonly ausd: number; readonly positions: number }> {
  const out = new Map<number, { ausd: number; positions: number }>();
  for (const p of positions) {
    const prev = out.get(p.accountId) ?? { ausd: 0, positions: 0 };
    out.set(p.accountId, { ausd: prev.ausd + p.unrealisedPnlAusd, positions: prev.positions + 1 });
  }
  return out;
}

/** "54% of 1,240" as its two parts, or undefined below the floor. */
export function shareOf(part: number, whole: number, floor: number): number | undefined {
  return whole >= floor && whole > 0 ? part / whole : undefined;
}

// ── CSV export ──────────────────────────────────────────────────────────────

/** The export's columns, in order. Units are in the header, never in a cell. */
export const TRADERS_CSV_HEADER = [
  'rank',
  'account_id',
  'address',
  'net_pnl_ausd',
  'volume_ausd',
  'trades',
  'round_trips',
  'wins',
  'win_rate_pct',
  'liquidations',
  'rescuable_liquidations',
  'ranking',
  'window',
] as const;

function csvField(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The rows of one ranking as CSV, in the backend's order. A field the API did
 * not serve is an EMPTY cell, never a zero: an unrecorded owner has no
 * address, and a win rate withheld below the floor stays withheld.
 */
export function tradersCsv(rows: readonly TraderRow[], ranking: string, window: string): string {
  const lines = [TRADERS_CSV_HEADER.join(',')];
  rows.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        r.accountId,
        r.address === '' ? undefined : r.address,
        r.netPnlAusd,
        r.volumeAusd,
        r.tradeCount,
        r.roundTrips,
        r.wins,
        r.winRate === undefined ? undefined : Number((r.winRate * 100).toFixed(2)),
        r.liquidationCount,
        r.rescuableLiquidationCount,
        ranking,
        window,
      ]
        .map(csvField)
        .join(','),
    );
  });
  return `${lines.join('\r\n')}\r\n`;
}

// ── Flows ───────────────────────────────────────────────────────────────────

/** The orders the Flows view offers. The backend accepts exactly these for `ranking=flows`. */
export type FlowSort = { readonly key: 'netFlowAbs' | 'netFlow' | 'deposits' | 'withdrawals'; readonly direction: 'asc' | 'desc' };

export const DEFAULT_FLOW_SORT: FlowSort = { key: 'netFlowAbs', direction: 'desc' };

/**
 * The next order when a Flows header is clicked. Net flow cycles through
 * size (largest either way), largest inflows, largest outflows; a deposits or
 * withdrawals header starts largest-first and flips on a second click.
 */
export function nextFlowSort(current: FlowSort, column: 'netFlow' | 'deposits' | 'withdrawals'): FlowSort {
  if (column === 'netFlow') {
    if (current.key === 'netFlowAbs') return { key: 'netFlow', direction: 'desc' };
    if (current.key === 'netFlow' && current.direction === 'desc') return { key: 'netFlow', direction: 'asc' };
    return DEFAULT_FLOW_SORT;
  }
  if (current.key === column) return { key: column, direction: current.direction === 'desc' ? 'asc' : 'desc' };
  return { key: column, direction: 'desc' };
}

/**
 * The Flows rows as CSV, in the backend's order. Amounts are the API's AUSD
 * figures; an unrecorded owner is an empty address, never a made-up one.
 */
export function flowsCsv(rows: readonly TraderRow[]): string {
  const lines = ['Account,Account ID,Deposits (AUSD),Withdrawals (AUSD),Net Flow (AUSD)'];
  for (const r of rows) lines.push([r.address === '' ? undefined : r.address, r.accountId, r.depositedAusd, r.withdrawnAusd, r.netFlowAusd].map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// ── Account summary ─────────────────────────────────────────────────────────

/** One account's money, now: what is free, what backs positions, what they would realise. */
export interface AccountSummary {
  readonly freeAusd: number;
  readonly marginAusd: number;
  /** Over PRICED positions only; see `unpriced`. */
  readonly unrealisedAusd: number;
  /** `free + margin + unrealised`, or undefined while any open position is unpriced: a partial sum is not equity. */
  readonly equityAusd: number | undefined;
  readonly positions: number;
  readonly unpriced: number;
  readonly depositedAusd: number;
  readonly withdrawnAusd: number;
  /** `deposited - withdrawn`: positive is net in, negative net out. */
  readonly netInAusd: number;
  /** `equity - netIn`: how far the account is up (+) or down (−) on what was put in. Undefined with equity. */
  readonly sinceFirstDepositAusd: number | undefined;
}

/** To whole cents, so the strip's arithmetic adds up exactly as printed. */
const cents = (ausd: number): number => Math.round(ausd * 100) / 100;

/**
 * The account summary from the profile and its priced positions. Every input
 * is rounded to the cent FIRST and equity is the sum of those, so
 * "free + margin + unrealised = equity" holds to the cent on screen. Funding
 * is not accrued between settlements (the contract settles it into the
 * position), so nothing is added for it.
 */
export function accountSummary(
  profile: { readonly freeBalanceAusd: number; readonly depositedAusd: number; readonly withdrawnAusd: number },
  positions: readonly { readonly position: { readonly marginAusd: number }; readonly unrealisedPnlAusd?: number | undefined }[],
): AccountSummary {
  const freeAusd = cents(profile.freeBalanceAusd);
  let margin = 0;
  let unrealised = 0;
  let unpriced = 0;
  for (const p of positions) {
    margin += cents(p.position.marginAusd);
    if (p.unrealisedPnlAusd === undefined) unpriced += 1;
    else unrealised += cents(p.unrealisedPnlAusd);
  }
  const marginAusd = cents(margin);
  const unrealisedAusd = cents(unrealised);
  const equityAusd = unpriced > 0 ? undefined : cents(freeAusd + marginAusd + unrealisedAusd);
  const depositedAusd = cents(profile.depositedAusd);
  const withdrawnAusd = cents(profile.withdrawnAusd);
  const netInAusd = cents(depositedAusd - withdrawnAusd);
  return {
    freeAusd,
    marginAusd,
    unrealisedAusd,
    equityAusd,
    positions: positions.length,
    unpriced,
    depositedAusd,
    withdrawnAusd,
    netInAusd,
    sinceFirstDepositAusd: equityAusd === undefined ? undefined : cents(equityAusd - netInAusd),
  };
}
