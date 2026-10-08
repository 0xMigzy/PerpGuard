'use client';

import type { TraderSummary } from '@perpguard/shared';
import type { OpenInterestPayload } from '@/lib/api.ts';
import { formatAge, formatAusdExact, formatCount, formatMoney, formatPct } from '@/lib/format.ts';
import { shareOf } from '@/lib/traders.ts';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';

/**
 * The four cards. Every period figure comes from the summary, which is the
 * same day buckets as the table below; open interest is the venue's level
 * now, the same reading Overview and Markets show. A card whose window holds
 * too few traders says that instead of printing a confident number.
 */
export function TraderCards({
  summary,
  openInterest,
  period,
  wholeDays,
}: {
  readonly summary: TraderSummary | undefined;
  readonly openInterest: OpenInterestPayload | undefined;
  /** The rolling window's label: the trader count, volume and liquidations are the Overview's own queries. */
  readonly period: string;
  /** The whole-UTC-day label: profitable traders are summed from day buckets. */
  readonly wholeDays: string;
}) {
  if (summary === undefined) {
    return (
      <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <StatTileSkeleton key={i} />
        ))}
      </section>
    );
  }
  const floor = summary.minTradersForDistribution;
  const share = shareOf(summary.profitableTraders, summary.closedTraders, floor);
  const tooFew = `fewer than ${formatCount(floor)} traders closed a trade in this window`;

  return (
    <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label={`Traders · ${period}`}
        value={formatCount(summary.traders)}
        exact={`${formatCount(summary.traders)} accounts with at least one fill in the rolling window: the Overview's own figure, by the same query`}
        secondary={`${formatMoney(summary.volumeAusd)} traded, counted once per match`}
      />
      <StatTile
        label={`Profitable traders · ${wholeDays}`}
        value={share === undefined ? '—' : formatCount(summary.profitableTraders)}
        exact={
          share === undefined
            ? undefined
            : `${formatCount(summary.profitableTraders)} of ${formatCount(summary.closedTraders)} traders with at least one closed trade ended the window with Net PnL above zero, after fees and funding.`
        }
        secondary={share === undefined ? tooFew : `${formatPct(share, 0)} of ${formatCount(summary.closedTraders)} traders profitable after fees`}
      />
      <StatTile
        label={`Liquidations · ${period}`}
        value={formatCount(summary.liquidations)}
        exact={summary.liquidations === 0 ? undefined : 'Rescuable: the trader\u2019s free balance would have covered the top-up that kept the position above maintenance margin.'}
        secondary={summary.liquidations === 0 ? 'none in this window' : `${formatCount(summary.rescuableLiquidations)} rescuable`}
      />
      <StatTile
        label="Open interest · now"
        value={openInterest === undefined ? '…' : formatMoney(openInterest.totalNotional)}
        exact={
          openInterest === undefined
            ? undefined
            : `${formatAusdExact(openInterest.totalNotional)} across ${formatCount(openInterest.markets.length)} markets, size × mark from the venue${
                openInterest.asOfMs === undefined ? '' : `, as of ${formatAge(Date.now() - openInterest.asOfMs)} ago`
              }`
        }
        secondary="Current Perpl OI"
      />
    </section>
  );
}
