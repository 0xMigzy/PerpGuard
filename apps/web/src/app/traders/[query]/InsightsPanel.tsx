'use client';

import type { AssessedPosition, WalletProfile } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatCount } from '@/lib/format.ts';
import { walletInsights } from '@/lib/insights.ts';
import { accountSummary } from '@/lib/traders.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';

const POLL_MS = 60_000;

/**
 * Computed insights: fixed rules over indexed facts (lib/insights.ts). Loads on
 * its own after the profile, so a heavy account's facts (a million round trips
 * take ~11 s the first time) never hold the page up.
 */
export function InsightsPanel({ profile, positions }: { readonly profile: WalletProfile; readonly positions: readonly AssessedPosition[] | undefined }) {
  const insights = usePoll(() => api.accountInsights(profile.accountId), POLL_MS, `insights:${profile.accountId}`);
  const data = insights.data?.data;

  let body;
  if (data === undefined) {
    body =
      insights.error === undefined ? (
        <div className="mt-3 space-y-[10px]" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[14px] w-full max-w-[640px]" />
          ))}
        </div>
      ) : null;
  } else {
    const priced = positions ?? profile.openPositions.map((position) => ({ position }));
    const summary = accountSummary(profile, priced);
    const result = walletInsights({
      facts: data.facts,
      baseline: data.baseline,
      floor: profile.performance.minRoundTripsForRatios,
      rescues: profile.rescues,
      bestMarket: profile.performance.bestMarket,
      worstMarket: profile.performance.worstMarket,
      openPositions: (positions ?? []).map((a) => ({ market: a.position.market, side: a.position.side, notionalAusd: a.notionalAusd })),
      equityAusd: summary.equityAusd,
    });
    body =
      result.kind === 'silent' ? (
        <p className="mt-2 mb-0 text-[12.5px] text-muted">
          Insights need {formatCount(result.floor)} round trips, the same floor as the win rate; this account has {formatCount(result.roundTrips)}.
        </p>
      ) : result.insights.length === 0 ? (
        <p className="mt-2 mb-0 text-[12.5px] text-muted">No rule has anything to say about this account yet.</p>
      ) : (
        <dl className="m-0 mt-2">
          {result.insights.map((i) => (
            <div key={i.key} className="grid grid-cols-1 gap-x-4 gap-y-[2px] border-b border-border py-[10px] last:border-b-0 sm:grid-cols-[170px_1fr]">
              <dt className={`text-[12px] font-semibold ${i.tone === 'danger' ? 'text-danger' : 'text-muted'}`}>{i.label}</dt>
              <dd className="m-0">
                <div className="text-[13.5px] text-text">{i.text}</div>
                <div className="mt-[2px] text-[11.5px] text-muted2">{i.detail}</div>
              </dd>
            </div>
          ))}
        </dl>
      );
  }

  return (
    <section className="card mb-4 px-[18px] pt-4 pb-2" aria-label="Insights">
      <div className="flex flex-wrap items-baseline justify-between gap-[10px]">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Insights</h2>
        <span className="text-[12px] text-muted">Computed from indexed trades by fixed rules · not AI-generated</span>
      </div>
      <ErrorNote error={insights.error} what="Insights" />
      {body}
    </section>
  );
}
