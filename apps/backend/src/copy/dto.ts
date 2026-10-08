/**
 * The copy replay as the web page reads it. Money goes out as TEXT, rounded
 * the way the bot rounds it (a need up, a holding down, a result against the
 * reader), so the page and the bot can never disagree about a figure; the
 * curve and the result also go out as numbers, for the chart and nothing else.
 */
import type { ReplayResult, SkipReason } from './replay.ts';
import { ausdText } from './replay.ts';

const sizeText = (units: bigint, decimals: number): string => {
  const p = 10n ** BigInt(decimals);
  const frac = (units % p).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? (units / p).toString() : `${units / p}.${frac}`;
};
const signed = (cns: bigint, d: number): string => (cns > 0n ? `+${ausdText(cns, 'floor', d)}` : ausdText(cns, 'floor', d));
const num = (cns: bigint, d: number): number => Number(cns) / 10 ** d;

export interface CopyReplayDto {
  readonly computedAtMs: number;
  readonly ageMs: number;
  readonly result:
    | { readonly kind: 'unknown-account'; readonly accountId: number }
    | { readonly kind: 'no-follower-equity'; readonly accountId: number }
    | { readonly kind: 'too-busy'; readonly accountId: number; readonly openedInWindow: number; readonly cap: number; readonly fromMs: number; readonly toMs: number }
    | {
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
        /** The leader's balance rebuilt to today against the index's books. */
        readonly books: { readonly rebuilt: string; readonly onRecord: string; readonly gap: string; readonly reconciled: boolean };
        readonly curve: readonly { readonly atMs: number; readonly equityAusd: number }[];
        readonly trades: readonly {
          readonly key: string;
          readonly symbol: string;
          readonly side: 'long' | 'short';
          readonly status: 'open' | 'closed' | 'forced';
          readonly openedAtMs: number;
          readonly closedAtMs: number | null;
          readonly leader: { readonly size: string; readonly margin: string; readonly resultBeforeFees: string; readonly leverage: number | null };
          readonly copy:
            | { readonly kind: 'copied'; readonly size: string; readonly margin: string; readonly fee: string; readonly result: string | null; readonly resultAusd: number | null; readonly estimate: boolean; readonly scale: number; readonly affordScale: number | null }
            | { readonly kind: 'skipped'; readonly reason: SkipReason; readonly text: string };
        }[];
      };
}

export function copyReplayDto(answer: { readonly computedAtMs: number; readonly result: ReplayResult | { readonly kind: 'unknown-account'; readonly accountId: number } }, nowMs: number): CopyReplayDto {
  const base = { computedAtMs: answer.computedAtMs, ageMs: Math.max(0, nowMs - answer.computedAtMs) };
  const r = answer.result;
  if (r.kind !== 'replayed') return { ...base, result: r };
  const d = r.collateralDecimals;
  const t = r.totals;
  return {
    ...base,
    result: {
      kind: 'replayed',
      accountId: r.accountId,
      fromMs: r.fromMs,
      toMs: r.toMs,
      actingNetwork: r.actingNetwork,
      followerStart: ausdText(r.followerStartCNS, 'floor', d),
      leaderStart: ausdText(r.leaderStartCNS, 'floor', d),
      totals: {
        copied: t.copied,
        skipped: t.skipped,
        skippedBy: t.skippedBy,
        notListed: t.notListed,
        closedResult: signed(t.closedResultCNS, d),
        closedResultAusd: num(t.closedResultCNS, d),
        openEstimate: signed(t.openEstimateCNS, d),
        openEstimateAusd: num(t.openEstimateCNS, d),
        fees: ausdText(t.feesCNS, 'ceil', d),
        forcedExits: t.forcedExits,
        wins: t.wins,
        losses: t.losses,
        leaderResultOnCopiedBeforeFees: signed(t.leaderResultOnCopiedCNS, d),
        followerEnd: ausdText(t.followerEndEquityCNS, 'floor', d),
        lowestFree: ausdText(t.lowestFreeCNS, 'floor', d),
      },
      books: {
        rebuilt: ausdText(r.books.rebuiltCNS, 'floor', d),
        onRecord: ausdText(r.books.indexCNS, 'floor', d),
        // The gap's size, rounded up: never smaller than it is.
        gap: ausdText(r.books.gapCNS < 0n ? -r.books.gapCNS : r.books.gapCNS, 'ceil', d),
        reconciled: r.books.reconciled,
      },
      curve: r.curve.map((c) => ({ atMs: c.atMs, equityAusd: num(c.equityCNS, d) })),
      trades: r.trades.map((x) => ({
        key: x.key,
        symbol: x.symbol,
        side: x.side,
        status: x.status,
        openedAtMs: x.openedAtMs,
        closedAtMs: x.closedAtMs ?? null,
        leader: {
          size: sizeText(x.leader.peakLotLNS, x.leader.lotDecimals),
          margin: ausdText(x.leader.peakMarginCNS, 'ceil', d),
          resultBeforeFees: signed(x.leader.netPnlCNS, d),
          leverage: x.leader.leverage ?? null,
        },
        copy:
          x.copy.kind === 'copied'
            ? {
                kind: 'copied',
                size: sizeText(x.copy.sizeUnits, x.copy.sizeDecimals),
                margin: ausdText(x.copy.marginCNS, 'ceil', d),
                fee: ausdText(x.copy.feeCNS, 'ceil', d),
                result: x.copy.resultCNS === undefined ? null : signed(x.copy.resultCNS, d),
                resultAusd: x.copy.resultCNS === undefined ? null : num(x.copy.resultCNS, d),
                estimate: x.copy.estimate,
                scale: x.copy.scale,
                affordScale: x.copy.affordScale ?? null,
              }
            : { kind: 'skipped', reason: x.copy.reason, text: x.copy.text },
      })),
    },
  };
}
