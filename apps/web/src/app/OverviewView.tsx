'use client';

import { useMemo } from 'react';
import type { MarketBreakdown } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import {
  formatAge,
  formatAusd,
  formatAusdExact,
  formatCompact,
  formatCount,
  formatPct,
  formatSignedAusd,
} from '@/lib/format.ts';
import { deltaOf, deltaVsPrevious, lastDays, stackByMarket, tvlBefore, tvlHistory } from '@/lib/overview.ts';
import { PERIOD_LABEL, chartWindow } from '@/lib/timeframe.ts';
import { COLORS } from '@/lib/theme.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { NetFlowChart } from '@/components/charts/NetFlowChart.tsx';
import { VolumeByMarketChart } from '@/components/charts/VolumeByMarketChart.tsx';

const POLL_MS = 30_000;

export function OverviewView() {
  const t = useTimeframe();
  const { fetch: ct, showDays } = chartWindow(t);
  const period = PERIOD_LABEL[t];

  const metrics = usePoll(() => api.metrics(t), POLL_MS, `metrics:${t}`);
  const tvl = usePoll(api.tvl, POLL_MS, 'tvl');
  const series = usePoll(() => api.series(ct), POLL_MS, `series:${ct}`);
  const byMarket = usePoll(() => api.seriesByMarket(ct), POLL_MS, `series-markets:${ct}`);
  const oi = usePoll(api.openInterest, POLL_MS, 'oi');
  const markets = usePoll(() => api.markets(t), POLL_MS, `markets:${t}`);

  const m = metrics.data?.data;
  const days = useMemo(() => (series.data === undefined ? undefined : lastDays(series.data.data, showDays)), [series.data, showDays]);
  const stacked = useMemo(
    () => (byMarket.data === undefined ? undefined : stackByMarket(byMarket.data.data, 4, 7, showDays)),
    [byMarket.data, showDays],
  );
  const tvlReading = tvl.data?.data;
  const tvlNow = tvlReading?.known === true ? tvlReading.totalValueLockedAusd : undefined;
  const tvlSpark = useMemo(
    () => (tvlNow === undefined || days === undefined ? undefined : tvlHistory(tvlNow, days).map((p) => p.tvlAusd)),
    [tvlNow, days],
  );
  const openPositions = markets.data?.data.reduce((sum, mk) => sum + mk.openPositions, 0);
  const chartNote = t === '24h' ? 'Day buckets: the last 7 UTC days are shown for a 24h window.' : undefined;

  return (
    <>
      <PageHeader
        title="Perpl protocol"
        subtitle="Everything below is derived from indexed on-chain events. No account needed."
        right={<TimeframePills />}
      />

      <StaleMarker envelope={metrics.data} />
      <ErrorNote error={metrics.error} what="Protocol metrics" />

      {/* ── six tiles ───────────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {m === undefined ? (
          Array.from({ length: 6 }, (_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <StatTile
              label={`Volume · ${period}`}
              value={formatCompact(m.volumeAusd)}
              exact={`${formatAusdExact(m.volumeAusd)} AUSD`}
              delta={deltaVsPrevious(m, (p) => p.volumeAusd, m.volumeAusd)}
              secondary={`${formatCount(m.tradeCount)} trades`}
              sparkline={days?.map((d) => d.volumeAusd)}
            />
            <StatTile
              label="Open interest · now"
              value={oi.data === undefined ? '…' : formatCompact(oi.data.data.totalNotional)}
              exact={oi.data === undefined ? undefined : `${formatAusdExact(oi.data.data.totalNotional)} AUSD, ${oi.data.data.markets.length} markets`}
              secondary={
                <>
                  <div>{openPositions === undefined ? '…' : `${formatCount(openPositions)} open positions`}</div>
                  <div title="The indexer only knows the change since its start block, so the level comes from the venue and has no history to compare against.">
                    level reported by the venue · no history to compare
                  </div>
                </>
              }
              sparklineNote={
                oi.data?.data.asOfMs === undefined ? 'no reading yet' : `as of ${formatAge(Date.now() - oi.data.data.asOfMs)} ago · size × mark, per market`
              }
            />
            <StatTile
              label="TVL · now"
              value={tvlNow === undefined ? (tvl.data === undefined ? '…' : 'unknown') : formatCompact(tvlNow)}
              exact={tvlNow === undefined ? tvlReading?.known === false ? tvlReading.reason : undefined : `${formatAusdExact(tvlNow)} AUSD, read from the Exchange contract`}
              delta={tvlNow === undefined ? undefined : deltaOf(tvlNow, tvlBefore(tvlNow, m.collateralFlow.netAusd))}
              deltaLabel={`in ${period}`}
              secondary={`${formatSignedAusd(m.collateralFlow.netAusd, 0)} net flow · ${period}`}
              sparkline={tvlSpark}
            />
            <StatTile
              label={`Fees · ${m.fees.label}`}
              labelWarn={t !== 'all'}
              value={formatCompact(m.fees.totalAusd)}
              exact={`${formatAusdExact(m.fees.totalAusd)} AUSD over ${m.fees.label}`}
              delta={deltaVsPrevious(m, (p) => p.fees.totalAusd, m.fees.totalAusd)}
              deltaLabel={m.previous === undefined ? 'vs prev' : `vs ${m.previous.fees.label}`}
              secondary={`maker ${formatAusd(m.makerFeesAusd, 0)} exact · taker by day bucket`}
              sparkline={days?.map((d) => d.feesAusd)}
            />
            <StatTile
              label={`Active traders · ${period}`}
              value={formatCount(m.activeTraders)}
              delta={deltaVsPrevious(m, (p) => p.activeTraders, m.activeTraders)}
              secondary="distinct accounts that traded"
              sparkline={days?.map((d) => d.activeTraders)}
            />
            <StatTile
              label={`Liquidations · ${period}`}
              value={formatCompact(m.liquidations.notionalAusd)}
              exact={`${formatAusdExact(m.liquidations.notionalAusd)} AUSD notional liquidated`}
              delta={deltaVsPrevious(m, (p) => p.liquidations.notionalAusd, m.liquidations.notionalAusd)}
              goodDirection="down"
              secondary={`${formatCount(m.liquidations.count)} liquidations · ${formatCount(m.rescues.rescuableCount)} rescuable`}
              sparkline={days?.map((d) => d.liquidationCount)}
              sparklineColor={COLORS.danger}
            />
          </>
        )}
      </section>

      {/* ── charts ──────────────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Trading volume</h2>
            <span className="text-[12.5px] text-muted">Notional by market, per UTC day · line: 7-day average</span>
          </div>
          <ErrorNote error={byMarket.error} what="Volume by market" />
          {stacked === undefined ? <Skeleton className="mt-2 h-[262px] w-full" /> : <VolumeByMarketChart stacked={stacked} />}
          {chartNote !== undefined && <div className="mt-2 text-[11.5px] text-muted2">{chartNote}</div>}
        </div>
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Net capital flow</h2>
            <span className="text-[12.5px] text-muted">Deposits − withdrawals, per UTC day</span>
          </div>
          <ErrorNote error={series.error} what="Daily flows" />
          {days === undefined ? <Skeleton className="mt-2 h-[262px] w-full" /> : <NetFlowChart days={days} />}
          <div className="mt-2 text-[11.5px] text-muted2">
            TVL is read from the Exchange contract; flows are indexed. The two answer different questions and both are shown.
            {chartNote !== undefined && ` ${chartNote}`}
          </div>
        </div>
      </section>
    </>
  );
}
