/**
 * 🔁 The copy replay page's types and small pure helpers. The figures come
 * from `GET /api/analytics/copy/:id?size=` already rounded (a need up, a
 * holding down, a result against the reader): this page never re-rounds money.
 */
export const COPY_SIZE_DEFAULT = 1_000;
export const COPY_SIZE_MIN = 10;
export const COPY_SIZE_MAX = 10_000_000;

export type SkipReason = 'open-at-start' | 'not-listed' | 'no-size' | 'no-entry' | 'too-small' | 'leverage' | 'no-balance' | 'leader-no-equity';

export const SKIP_LABEL: Readonly<Record<SkipReason, string>> = {
  'open-at-start': 'Already open when the window began',
  'not-listed': 'Market no longer open for trading',
  'too-small': 'Too small at this size',
  'no-balance': 'Not enough free balance at the time',
  leverage: "Leverage above Perpl's maximum",
  'no-size': 'No size in the index',
  'no-entry': 'No entry price in the index',
  'leader-no-equity': 'Leader had no equity on record',
};

export interface CopyTrade {
  readonly key: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly status: 'open' | 'closed' | 'forced';
  readonly openedAtMs: number;
  readonly closedAtMs: number | null;
  readonly leader: { readonly size: string; readonly margin: string; readonly resultBeforeFees: string; readonly leverage: number | null };
  readonly copy:
    | { readonly kind: 'copied'; readonly size: string; readonly margin: string; readonly fee: string; readonly result: string | null; readonly resultAusd: number | null; readonly estimate: boolean; readonly scale: number }
    | { readonly kind: 'skipped'; readonly reason: SkipReason; readonly text: string };
}

export interface CopyReplayed {
  readonly kind: 'replayed';
  readonly accountId: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly actingNetwork: string;
  readonly followerStart: string;
  readonly leaderStart: string;
  readonly totals: {
    readonly copied: number;
    readonly skipped: number;
    readonly skippedBy: Readonly<Partial<Record<SkipReason, number>>>;
    readonly notListed: readonly { readonly symbol: string; readonly count: number }[];
    readonly closedResult: string;
    readonly closedResultAusd: number;
    readonly openEstimate: string;
    readonly openEstimateAusd: number;
    readonly fees: string;
    readonly forcedExits: number;
    readonly wins: number;
    readonly losses: number;
    readonly leaderResultOnCopiedBeforeFees: string;
    readonly followerEnd: string;
    readonly lowestFree: string;
  };
  readonly books: { readonly rebuilt: string; readonly onRecord: string; readonly gap: string; readonly reconciled: boolean };
  readonly curve: readonly { readonly atMs: number; readonly equityAusd: number }[];
  readonly trades: readonly CopyTrade[];
}

export interface CopyReplayPayload {
  readonly computedAtMs: number;
  readonly ageMs: number;
  readonly result:
    | CopyReplayed
    | { readonly kind: 'unknown-account'; readonly accountId: number }
    | { readonly kind: 'no-follower-equity'; readonly accountId: number }
    | { readonly kind: 'too-busy'; readonly accountId: number; readonly openedInWindow: number; readonly cap: number; readonly fromMs: number; readonly toMs: number };
}

/** A size from the address bar: whole AUSD within bounds, else the default. */
export function parseCopySize(raw: string | null | undefined): number {
  const n = Number(raw);
  if (raw === null || raw === undefined || raw.trim() === '' || !Number.isFinite(n)) return COPY_SIZE_DEFAULT;
  const whole = Math.floor(n);
  return whole < COPY_SIZE_MIN || whole > COPY_SIZE_MAX ? COPY_SIZE_DEFAULT : whole;
}

/** 30 days, or 7 beside it (owner, 7 Oct 2026). 30 is the default. */
export type CopyDays = 7 | 30;
export const parseCopyDays = (raw: string | null | undefined): CopyDays => (raw === '7' ? 7 : 30);

export function copyHref(accountId: number, size?: number, days: CopyDays = 30): string {
  const q = new URLSearchParams();
  if (size !== undefined && size !== COPY_SIZE_DEFAULT) q.set('size', String(size));
  if (days === 7) q.set('days', '7');
  const s = q.toString();
  return `/copy/${accountId}${s === '' ? '' : `?${s}`}`;
}

/** Which trades a filter shows. */
export type CopyFilter = 'all' | 'copied' | 'skipped';
export function filterTrades(trades: readonly CopyTrade[], filter: CopyFilter): readonly CopyTrade[] {
  if (filter === 'all') return trades;
  return trades.filter((t) => (filter === 'copied' ? t.copy.kind === 'copied' : t.copy.kind === 'skipped'));
}
