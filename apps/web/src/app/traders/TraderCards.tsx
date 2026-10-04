'use client';

import type { RiskSnapshot, TraderSummary } from '@perpguard/shared';
import { formatCompact, formatCount, formatPct, formatSignedAusd } from '@/lib/format.ts';
import { shareOf } from '@/lib/traders.ts';
import { COLORS } from '@/lib/theme.ts';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';

/**
 * The five cards. Every period figure comes from the summary, which is the
 * same day buckets as the table below; open positions are now, from the Risk
 * snapshot, and say so. A card whose window holds too few traders says that
 * instead of printing a confident number.
 */
export function TraderCards({
  summary,
  risk,
  period,
}: {
  readonly summary: TraderSummary | undefined;
  readonly risk: RiskSnapshot | undefined;
  readonly period: string;
}) {
  if (summary === undefined) {
    return (
      <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5" aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => (
          <StatTileSkeleton key={i} />
        ))}
      </section>
    );
  }
  const floor = summary.minTradersForDistribution;
  const share = shareOf(summary.profitableTraders, summary.closedTraders, floor);
  const median = summary.medianNetPnlAusd;
  const holders = risk === undefined ? undefined : new Set(risk.positions.map((p) => p.accountId)).size;
  const tooFew = `fewer than ${formatCount(floor)} traders closed a trade in this window`;

  return (
    <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1">
      <StatTile
        label={`Traders · ${period}`}
        value={formatCount(summary.traders)}
        exact={`${formatCount(summary.traders)} accounts with at least one trade`}
        secondary={`${formatCompact(summary.volumeAusd)} AUSD traded, counted once per match`}
      />
      <StatTile
        label={`Profitable traders · ${period}`}
        value={share === undefined ? '—' : formatCount(summary.profitableTraders)}
        secondary={
          share === undefined
            ? tooFew
            : `${formatPct(share, 0)} of ${formatCount(summary.closedTraders)} traders with at least one closed trade`
        }
      />
      <StatTile
        label={`Median PnL · ${period}`}
        value={median === undefined ? '—' : formatSignedAusd(median)}
        valueColor={median === undefined ? undefined : median > 0 ? COLORS.safe : median < 0 ? COLORS.danger : undefined}
        exact={median === undefined ? undefined : `${formatSignedAusd(median)} AUSD after fees and funding. A median, not a mean: a few large accounts cannot move it.`}
        secondary={
          median === undefined
            ? tooFew
            : `AUSD, the middle of ${formatCount(summary.closedTraders)} traders with a closed trade`
        }
      />
      <StatTile
        label={`Liquidations · ${period}`}
        value={formatCount(summary.liquidations)}
        secondary={summary.liquidations === 0 ? 'none in this window' : `${formatCount(summary.rescuableLiquidations)} rescuable: free balance covered the shortfall`}
      />
      <StatTile
        label="Open positions · now"
        value={risk === undefined ? '…' : formatCount(risk.counted.positions)}
        secondary={
          risk === undefined
            ? 'loading'
            : `held by ${formatCount(holders ?? 0)} traders${risk.counted.unpriced > 0 ? ` · ${formatCount(risk.counted.unpriced)} not priced` : ''}`
        }
      />
    </section>
  );
}
