'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { LiquidationRecord, RescueVerdict } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAusd, formatAusdExact, formatCompact, formatCount, formatPct, formatPriceAsServed, formatWhen } from '@/lib/format.ts';
import { LIST_CAP, LIST_STEP, mayHaveMore, nextLimit, splitLiquidationDays } from '@/lib/liquidations.ts';
import { deltaVsPrevious, lastDays } from '@/lib/overview.ts';
import { PERIOD_LABEL, chartWindow } from '@/lib/timeframe.ts';
import { COLORS } from '@/lib/theme.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { LiquidationsByDayChart } from '@/components/charts/LiquidationsByDayChart.tsx';

const POLL_MS = 30_000;

const COLUMNS = ['Time (UTC)', 'Market', 'Side', 'Size', 'Notional', 'Margin lost', 'Free balance at the time', 'Needed to survive', 'Rescuable'] as const;

export function LiquidationsView() {
  const t = useTimeframe();
  const period = PERIOD_LABEL[t];
  const { fetch: ct, showDays } = chartWindow(t);
  const [limit, setLimit] = useState(LIST_STEP);

  const metrics = usePoll(() => api.metrics(t), POLL_MS, `metrics:${t}`);
  const series = usePoll(() => api.series(ct), POLL_MS, `series:${ct}`);
  const list = usePoll(() => api.liquidations(t, limit), POLL_MS, `liquidations:${t}:${limit}`);

  const m = metrics.data?.data;
  const days = useMemo(() => (series.data === undefined ? undefined : splitLiquidationDays(lastDays(series.data.data, showDays))), [series.data, showDays]);
  const rows = list.data?.data;
  const chartNote = t === '24h' ? 'Day buckets: the last 7 UTC days are shown for a 24h window.' : undefined;

  return (
    <>
      <PageHeader
        title="Liquidations"
        subtitle="Forced closes from exchange events — and how many of them the trader had the balance to prevent."
        right={<TimeframePills />}
      />

      <StaleMarker envelope={metrics.data} />
      <ErrorNote error={metrics.error} what="Liquidation totals" />

      {/* ── three tiles ─────────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {m === undefined ? (
          Array.from({ length: 3 }, (_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <StatTile
              label={`Liquidated · ${period}`}
              value={formatCompact(m.liquidations.notionalAusd)}
              exact={`${formatAusdExact(m.liquidations.notionalAusd)} AUSD notional`}
              delta={deltaVsPrevious(m, (p) => p.liquidations.notionalAusd, m.liquidations.notionalAusd)}
              goodDirection="down"
              secondary={`${formatCount(m.liquidations.count)} liquidations · ${formatAusd(m.liquidations.marginLostAusd, 0)} AUSD margin lost`}
              sparkline={days?.map((d) => d.total)}
              sparklineColor={COLORS.danger}
            />
            <StatTile
              label={`Rescuable · ${period}`}
              value={m.rescues.judgeableCount === 0 ? '0' : `${formatCount(m.rescues.rescuableCount)} · ${formatPct(m.rescues.rate ?? 0)}`}
              exact={`${formatCount(m.rescues.rescuableCount)} of ${formatCount(m.rescues.judgeableCount)} judgeable liquidations`}
              valueColor={COLORS.watch}
              delta={deltaVsPrevious(m, (p) => p.rescues.rescuableCount, m.rescues.rescuableCount)}
              goodDirection="down"
              secondary={
                m.rescues.judgeableCount === 0
                  ? 'nothing in this window can be judged yet'
                  : `of ${formatCount(m.rescues.judgeableCount)} judgeable · ${formatCount(m.rescues.unknownCount)} unjudgeable excluded`
              }
              sparkline={days?.map((d) => d.rescuable)}
              sparklineColor={COLORS.watch}
            />
            <StatTile
              label="Spare balance at liquidation"
              value={formatCompact(m.rescues.spareBalanceAusd)}
              exact={`${formatAusdExact(m.rescues.spareBalanceAusd)} AUSD free across all ${formatCount(m.rescues.count)} liquidations`}
              secondary={
                <>
                  <div>AUSD sitting free across all {formatCount(m.rescues.count)}</div>
                  <div>
                    median {m.rescues.medianSpareBalanceAusd === undefined ? '—' : formatAusd(m.rescues.medianSpareBalanceAusd)} over the rescuable
                    cases
                  </div>
                </>
              }
              sparklineNote="isolated margin never reached for any of it"
            />
          </>
        )}
      </section>

      {/* ── per day ─────────────────────────────────────────────────────── */}
      <section className="card mb-4 px-[18px] py-4">
        <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Liquidations per day</h2>
          <span className="text-[12.5px] text-muted">Split by whether the account could have survived</span>
        </div>
        <ErrorNote error={series.error} what="Daily liquidations" />
        {days === undefined ? <Skeleton className="mt-2 h-[262px] w-full" /> : <LiquidationsByDayChart days={days} />}
        <div className="mt-2 text-[11.5px] text-muted2">
          Day buckets carry no per-day unjudgeable count, so the grey series holds both the liquidations judged not rescuable and the ones that
          cannot be judged.{chartNote !== undefined && ` ${chartNote}`}
        </div>
      </section>

      {/* ── the list ────────────────────────────────────────────────────── */}
      <ErrorNote error={list.error} what="Liquidation list" />
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
              {COLUMNS.map((label, i) => (
                <th key={label} scope="col" className={`px-[10px] py-[9px] font-semibold whitespace-nowrap ${i < 3 ? 'text-left' : 'text-right'} ${i === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows === undefined
              ? Array.from({ length: 8 }, (_, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    {COLUMNS.map((label, j) => (
                      <td key={label} className={`px-[10px] py-[10px] ${j === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                        <Skeleton className={`h-[14px] ${j < 3 ? 'w-[70px]' : 'ml-auto w-[70px]'}`} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => <LiquidationRow key={row.id} row={row} />)}
            {rows !== undefined && rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-[10px] py-6 text-center text-muted">
                  No liquidation in the {period} window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-muted2">
        <span>
          {m !== undefined && m.rescues.unknownCount > 0 && (
            <>
              The rate excludes {formatCount(m.rescues.unknownCount)} case{m.rescues.unknownCount === 1 ? '' : 's'} where the position predates the
              index, so the pre-liquidation state cannot be established. They are neither counted as rescuable nor as unavoidable.{' '}
            </>
          )}
          Free balance is the account&rsquo;s spare AUSD the instant before; needed to survive is the top-up that would have kept the position above
          maintenance margin.
        </span>
        {rows !== undefined && mayHaveMore(rows.length, limit) && (
          <button type="button" className="btn" onClick={() => setLimit(nextLimit(limit))}>
            Show more
          </button>
        )}
        {rows !== undefined && rows.length >= LIST_CAP && <span>Showing the most recent {formatCount(LIST_CAP)}; narrow the timeframe for the rest.</span>}
      </div>
    </>
  );
}

const VERDICT: Record<RescueVerdict, { readonly text: string; readonly className: string; readonly title: string }> = {
  rescuable: { text: 'yes', className: 'bg-watch/15 text-watch', title: 'The free balance covered the top-up that would have kept the position open.' },
  'not-rescuable': { text: 'no', className: 'bg-card2 text-muted', title: 'The free balance did not cover the top-up needed.' },
  unknown: { text: 'unknown', className: 'bg-card2 text-muted2', title: 'The position was opened before the index starts, so this cannot be judged.' },
};

function LiquidationRow({ row }: { readonly row: LiquidationRecord }) {
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  const verdict = VERDICT[row.verdict];
  const symbol = row.market.symbol ?? `market ${row.market.marketId}`;
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-card2">
      <td className="sticky left-0 z-[1] bg-card px-[10px] py-[10px] whitespace-nowrap text-muted" title={new Date(row.atMs).toISOString()}>
        {formatWhen(row.atMs)}
      </td>
      <td className="px-[10px] py-[10px] font-semibold whitespace-nowrap" title={row.market.symbol === undefined ? `${row.market.indexerName}: not listed by the venue` : undefined}>
        {symbol}
        <Link href={`/traders/${row.accountId}`} className="ml-2 text-[11px] font-medium text-muted2 no-underline hover:text-text" title="This account's profile">
          #{row.accountId}
        </Link>
      </td>
      <td className="px-[10px] py-[10px] whitespace-nowrap">
        <span className={`rounded-[6px] px-[7px] py-[2px] text-[10.5px] font-bold uppercase tracking-[0.05em] ${row.side === 'long' ? 'bg-safe/15 text-safe' : 'bg-danger/15 text-danger'}`}>
          {row.side}
        </span>
        {!row.isFull && <span className="ml-1 text-[10.5px] text-muted2">partial</span>}
      </td>
      <td className={`${cell} text-muted`} title={row.execPrice === undefined ? undefined : `closed at ${formatPriceAsServed(row.execPrice)}`}>
        {formatPriceAsServed(row.sizeLots)} {row.market.symbol ?? ''}
      </td>
      <td className={cell} title={`${formatAusdExact(row.notionalAusd)} AUSD`}>{formatAusd(row.notionalAusd)}</td>
      <td className={`${cell} text-danger`} title={row.badDebtAusd > 0 ? `${formatAusdExact(row.badDebtAusd)} AUSD bad debt` : undefined}>
        {formatAusd(row.marginLostAusd)}
      </td>
      <td className={cell} title={`${formatAusdExact(row.freeBalanceBeforeAusd)} AUSD`}>{formatAusd(row.freeBalanceBeforeAusd)}</td>
      <td className={`${cell} ${row.marginToSurviveAusd === undefined ? 'text-muted2' : ''}`} title={row.marginToSurviveAusd === undefined ? undefined : `${formatAusdExact(row.marginToSurviveAusd)} AUSD`}>
        {row.marginToSurviveAusd === undefined ? 'unknown' : formatAusd(row.marginToSurviveAusd)}
      </td>
      <td className={`${cell}`}>
        <span className={`rounded-[6px] px-[7px] py-[2px] text-[11px] font-bold ${verdict.className}`} title={verdict.title}>
          {verdict.text}
        </span>
      </td>
    </tr>
  );
}
