'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { LiquidationRecord, MarketBreakdown, RescueVerdict } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAusd, formatAusdExact, formatCompact, formatCount, formatPct, formatPriceAsServed, formatWhen } from '@/lib/format.ts';
import { LIST_CAP, LIST_STEP, mayHaveMore, nextLimit, splitLiquidationDays } from '@/lib/liquidations.ts';
import { deltaVsPrevious, lastDays } from '@/lib/overview.ts';
import { chartWindow } from '@/lib/timeframe.ts';
import { inPeriod, periodLabel, windowRange } from '@/lib/history.ts';
import { useHistoryStart } from '@/lib/useHistory.ts';
import { COLORS, OTHER_SERIES } from '@/lib/theme.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { BandBars } from '@/components/BandBars.tsx';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { LiquidationsByDayChart } from '@/components/charts/LiquidationsByDayChart.tsx';

const POLL_MS = 30_000;

const COLUMNS = ['Time (UTC)', 'Account', 'Market', 'Size', 'Margin lost', 'Shortfall', 'Spare held', 'Verdict'] as const;

/**
 * The rescuable finding is the hero; everything under it is its evidence. The
 * rate is ALWAYS over the judgeable denominator, and the unjudgeable count is
 * printed beside it rather than folded into either side.
 */
export function LiquidationsView() {
  const t = useTimeframe();
  const start = useHistoryStart();
  const period = periodLabel(t, start);
  const within = inPeriod(t, start);
  const { fetch: ct, showDays } = chartWindow(t);
  const [limit, setLimit] = useState(LIST_STEP);

  const metrics = usePoll(() => api.metrics(t), POLL_MS, `metrics:${t}`);
  const summary = usePoll(() => api.liquidationSummary(t), POLL_MS, `liq-summary:${t}`);
  const markets = usePoll(() => api.markets(t), POLL_MS, `markets:${t}`);
  const series = usePoll(() => api.series(ct), POLL_MS, `series:${ct}`);
  const list = usePoll(() => api.liquidations(t, limit), POLL_MS, `liquidations:${t}:${limit}`);

  const m = metrics.data?.data;
  const r = m?.rescues;
  const s = summary.data?.data;
  const days = useMemo(() => (series.data === undefined ? undefined : splitLiquidationDays(lastDays(series.data.data, showDays))), [series.data, showDays]);
  const rows = list.data?.data;
  const chartNote = t === '24h' ? 'Day buckets: the last 7 UTC days are shown for a 24h window.' : undefined;
  const notRescuable = r === undefined ? undefined : r.judgeableCount - r.rescuableCount;

  return (
    <>
      <PageHeader
        title="Liquidations"
        subtitle="Every liquidation in the window, and whether the trader could have stopped it."
        right={<TimeframePills />}
      />

      <StaleMarker envelope={metrics.data} />
      <ErrorNote error={metrics.error} what="Liquidation totals" />

      {/* ── the finding ─────────────────────────────────────────────────── */}
      <section className="mb-4 flex flex-wrap items-center gap-[30px] rounded-[14px] border border-accent/35 bg-gradient-to-br from-accent/14 to-cyan/6 px-6 py-[22px]">
        {r === undefined ? (
          <>
            <Skeleton className="h-[64px] w-[180px]" />
            <Skeleton className="h-[64px] flex-1" />
          </>
        ) : r.judgeableCount === 0 ? (
          <div>
            <div className="eyebrow">The finding</div>
            <div className="num my-[6px] text-[46px] font-semibold leading-none tracking-[-0.03em] text-accent-hi">—</div>
            <p className="m-0 max-w-[52ch] text-[13px] text-[#C9C4E4]">
              {r.count === 0
                ? `No liquidation ${within}. The finding needs one to judge; widen the window to see it.`
                : `${formatCount(r.count)} liquidation${r.count === 1 ? '' : 's'} in the window, none of which can be judged: every one is of a position opened before the index starts.`}
            </p>
          </div>
        ) : (
          <>
            <div>
              <div className="eyebrow">The finding</div>
              <div className="num my-[6px] text-[46px] font-semibold leading-none tracking-[-0.03em] text-accent-hi">{formatPct(r.rate ?? 0)}</div>
            </div>
            <div className="min-w-0 flex-1 basis-[300px]">
              <p className="m-0 max-w-[60ch] text-[13px] text-[#C9C4E4]">
                <b className="font-semibold text-text">
                  {formatCount(r.rescuableCount)} of {formatCount(r.judgeableCount)} judgeable liquidations {within} could have been prevented.
                </b>{' '}
                The trader was holding enough free AUSD at that moment to cover the shortfall — but Perpl uses isolated margin, so that balance never moves on its own.
                They were liquidated with the money to survive sitting in the same account.
              </p>
              <p className="mt-[10px] mb-0 text-[12.5px] text-text/85">
                <span className="eyebrow mr-2">Window</span>
                <span className="num">{windowRange(m?.sinceMs, m?.untilMs ?? Date.now(), start)}</span>
                {' · '}
                {formatCount(r.judgeableCount)} judgeable of {formatCount(r.count)} liquidations. A rate over a different window is a different number.
              </p>
              <p className="mt-[6px] mb-0 text-[13px] text-muted">
                {r.unknownCount === 0
                  ? 'Every liquidation in the window could be judged.'
                  : `${formatCount(r.unknownCount)} liquidation${r.unknownCount === 1 ? ' was' : 's were'} excluded because the position was opened before the index starts, so the account's state at that block cannot be established. Excluded from the denominator, never counted as failures.`}
              </p>
            </div>
          </>
        )}
      </section>

      {/* ── four tiles ──────────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {m === undefined || r === undefined ? (
          Array.from({ length: 4 }, (_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <StatTile
              label={`Liquidations · ${period}`}
              value={formatCount(m.liquidations.count)}
              exact={`${formatAusdExact(m.liquidations.notionalAusd)} AUSD notional liquidated`}
              delta={deltaVsPrevious(m, (p) => p.liquidations.count, m.liquidations.count)}
              goodDirection="down"
              secondary={`${formatCount(r.judgeableCount)} judgeable · ${formatCount(r.unknownCount)} excluded · ${formatCompact(m.liquidations.notionalAusd)} notional`}
              sparkline={days?.map((d) => d.total)}
              sparklineColor={COLORS.danger}
            />
            <StatTile
              label={`Rescuable · ${period}`}
              value={formatCount(r.rescuableCount)}
              exact={`${formatCount(r.rescuableCount)} of ${formatCount(r.judgeableCount)} judgeable liquidations`}
              valueColor={COLORS.accentHi}
              delta={deltaVsPrevious(m, (p) => p.rescues.rescuableCount, r.rescuableCount)}
              goodDirection="down"
              secondary={r.judgeableCount === 0 ? 'nothing in this window can be judged' : `${formatPct(r.rate ?? 0)} of the ${formatCount(r.judgeableCount)} judgeable`}
              sparkline={days?.map((d) => d.rescuable)}
              sparklineColor={COLORS.accentHi}
            />
            <StatTile
              label="Spare balance held"
              value={formatCompact(r.spareBalanceAusd)}
              exact={`${formatAusdExact(r.spareBalanceAusd)} AUSD free across all ${formatCount(r.count)} liquidations`}
              secondary={
                <>
                  <div>AUSD sitting free at the moment of liquidation, summed over {formatCount(r.count)}</div>
                  <div>{r.medianSpareBalanceAusd === undefined ? 'no rescuable case to take a median over' : `median ${formatAusd(r.medianSpareBalanceAusd)} over the ${formatCount(r.rescuableCount)} rescuable`}</div>
                </>
              }
              sparklineNote="isolated margin never reached for any of it"
            />
            <StatTile
              label="Median shortfall"
              value={s === undefined ? '…' : s.medianShortfallAusd === undefined ? '—' : formatAusd(s.medianShortfallAusd)}
              exact={s?.medianShortfallAusd === undefined ? undefined : `${formatAusdExact(s.medianShortfallAusd)} AUSD`}
              secondary={
                s === undefined ? (
                  'loading'
                ) : (
                  <>
                    <div>AUSD needed to survive · median across the {formatCount(r.rescuableCount)} rescuable</div>
                    <div>{s.medianShortfallAllAusd === undefined ? 'no judgeable case' : `${formatAusd(s.medianShortfallAllAusd)} across all ${formatCount(r.judgeableCount)} judgeable`}</div>
                  </>
                )
              }
              sparklineNote="the top-up that would have kept the position above maintenance"
            />
          </>
        )}
      </section>

      {/* ── by market, and the verdict ──────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">By market</h2>
            <span className="text-[12.5px] text-muted">{r === undefined ? '' : `${formatCount(r.count)} liquidations in ${period}`}</span>
          </div>
          <ErrorNote error={markets.error} what="The market breakdown" />
          {markets.data === undefined ? <Skeleton className="mt-3 h-[180px] w-full" /> : <MarketBars markets={markets.data.data} />}
        </div>
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Could it have been stopped?</h2>
            <span className="text-[12.5px] text-muted">three answers, not two</span>
          </div>
          {r === undefined ? (
            <Skeleton className="mt-3 h-[150px] w-full" />
          ) : r.count === 0 ? (
            <div className="mt-3 text-[12.5px] text-muted">No liquidation in this window.</div>
          ) : (
            <>
              <div className="mt-3 flex h-[30px] overflow-hidden rounded-[7px]" role="img" aria-label={`${formatCount(r.rescuableCount)} rescuable, ${formatCount(notRescuable ?? 0)} not, ${formatCount(r.unknownCount)} unjudgeable`}>
                <div className="bg-gradient-to-r from-accent-deep to-accent-hi" style={{ width: `${(r.rescuableCount / r.count) * 100}%` }} />
                <div style={{ width: `${((notRescuable ?? 0) / r.count) * 100}%`, background: OTHER_SERIES }} />
                <div className="border border-border2" style={{ width: `${(r.unknownCount / r.count) * 100}%` }} />
              </div>
              <div className="mt-2 flex justify-between text-[12px] text-muted">
                <span>Rescuable <b className="num font-semibold text-text">{formatCount(r.rescuableCount)}</b></span>
                <span>Not <b className="num font-semibold text-text">{formatCount(notRescuable ?? 0)}</b></span>
              </div>
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-[7px] text-[12.5px]">
                <dt className="text-muted">Spare ≥ shortfall</dt>
                <dd className="num m-0 text-right text-accent-hi">{formatCount(r.rescuableCount)}</dd>
                <dt className="text-muted">Spare &lt; shortfall</dt>
                <dd className="num m-0 text-right">{formatCount(notRescuable ?? 0)}</dd>
                <dt className="text-muted">Balance unknown at block</dt>
                <dd className="num m-0 text-right text-muted2">{formatCount(r.unknownCount)}</dd>
              </dl>
            </>
          )}
        </div>
      </section>

      {/* ── by size, and by spare balance ───────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">By size</h2>
            <span className="text-[12.5px] text-muted">notional taken, AUSD</span>
          </div>
          <ErrorNote error={summary.error} what="The liquidation bands" />
          {s === undefined ? <Skeleton className="mt-3 h-[150px] w-full" /> : <BandBars bands={s.bySize} unit="AUSD notional" />}
        </div>
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">By spare balance</h2>
            <span className="text-[12.5px] text-muted">free AUSD held at that moment</span>
          </div>
          {s === undefined ? <Skeleton className="mt-3 h-[150px] w-full" /> : <BandBars bands={s.bySpareBalance} unit="AUSD free" />}
          <div className="mt-2 text-[11.5px] text-muted2">
            Any balance above zero is not the finding: dust counts. A liquidation is rescuable only when the spare balance covered the shortfall.
          </div>
        </div>
      </section>

      {/* ── per day ─────────────────────────────────────────────────────── */}
      <section className="card mb-4 px-[18px] py-4">
        <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Per day</h2>
          <span className="text-[12.5px] text-muted">Split by whether the account could have survived</span>
        </div>
        <ErrorNote error={series.error} what="Daily liquidations" />
        {days === undefined ? <Skeleton className="mt-2 h-[262px] w-full" /> : <LiquidationsByDayChart days={days} />}
        <div className="mt-2 text-[11.5px] text-muted2">
          Day buckets carry no per-day unjudgeable count, so the grey series holds both the liquidations judged not rescuable and the ones that cannot be judged.
          {chartNote !== undefined && ` ${chartNote}`}
        </div>
      </section>

      {/* ── the feed ────────────────────────────────────────────────────── */}
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
                <td colSpan={COLUMNS.length} className="px-[10px] py-8 text-center text-muted">
                  <div className="text-[14px] font-semibold text-text">No liquidation {within}.</div>
                  <div className="mt-1 text-[12.5px]">That is a quiet window, not an empty index. Widen it to see earlier ones.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-muted2">
        <span className="max-w-[90ch]">
          Spare held is the account&rsquo;s free AUSD the instant before; shortfall is the top-up that would have kept the position above maintenance margin.
          A verdict is rescuable when spare covered shortfall, not when spare was merely above zero.
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

/** Liquidations per market in the window, rescuable share filled, counted at the end. */
function MarketBars({ markets }: { readonly markets: readonly MarketBreakdown[] }) {
  const rows = markets
    .filter((m) => m.liquidationCount > 0)
    .map((m) => ({ symbol: m.market.symbol ?? `market ${m.market.marketId}`, count: m.liquidationCount, rescuable: m.rescuableLiquidationCount }))
    .sort((a, b) => b.count - a.count);
  if (rows.length === 0) return <div className="mt-3 text-[12.5px] text-muted">No market had a liquidation in this window.</div>;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-[7px] text-[12px]">
      {rows.map((r) => (
        <MarketBarRow key={r.symbol} symbol={r.symbol} count={r.count} rescuable={r.rescuable} max={max} />
      ))}
    </div>
  );
}

function MarketBarRow({ symbol, count, rescuable, max }: { readonly symbol: string; readonly count: number; readonly rescuable: number; readonly max: number }) {
  return (
    <>
      <span className="font-semibold">{symbol}</span>
      <span className="flex h-[16px] w-full overflow-hidden rounded-[4px] bg-border" role="img" aria-label={`${symbol}: ${formatCount(count)} liquidations, ${formatCount(rescuable)} rescuable`}>
        <i className="block h-full" style={{ width: `${(rescuable / max) * 100}%`, background: COLORS.accentHi }} />
        <i className="block h-full" style={{ width: `${((count - rescuable) / max) * 100}%`, background: OTHER_SERIES }} />
      </span>
      <span className="num whitespace-nowrap text-right">
        {formatCount(count)}
        <span className="ml-1 text-[11px] text-muted2">{formatCount(rescuable)} rescuable</span>
      </span>
    </>
  );
}

const VERDICT: Record<RescueVerdict, { readonly text: string; readonly className: string; readonly title: string }> = {
  rescuable: { text: 'Rescuable', className: 'bg-accent/15 text-accent-hi', title: 'The free balance covered the top-up that would have kept the position open.' },
  'not-rescuable': { text: 'Not rescuable', className: 'bg-card2 text-muted', title: 'The free balance did not cover the top-up needed.' },
  unknown: { text: 'Excluded', className: 'bg-card2 text-muted2', title: 'The position was opened before the index starts, so this cannot be judged.' },
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
      <td className="px-[10px] py-[10px] whitespace-nowrap">
        <Link href={`/traders/${row.accountId}`} className="num font-semibold text-text no-underline hover:text-accent-hi" title="This account's profile">
          #{row.accountId}
        </Link>
      </td>
      <td className="px-[10px] py-[10px] whitespace-nowrap" title={row.market.symbol === undefined ? `${row.market.indexerName}: not listed by the venue` : undefined}>
        <span className="font-semibold">{symbol}</span>
        <span className={`ml-2 rounded-[4px] px-[5px] py-[1.5px] text-[10px] font-semibold tracking-[0.05em] uppercase ${row.side === 'long' ? 'bg-safe/12 text-safe' : 'bg-danger/12 text-danger'}`}>{row.side}</span>
        {!row.isFull && <span className="ml-1 text-[10.5px] text-muted2">partial</span>}
      </td>
      <td className={`${cell} text-muted`} title={`${formatAusdExact(row.notionalAusd)} AUSD notional${row.execPrice === undefined ? '' : ` · closed at ${formatPriceAsServed(row.execPrice)}`}`}>
        {formatPriceAsServed(row.sizeLots)} {row.market.symbol ?? ''}
        <span className="block text-[11px] text-muted2">{formatCompact(row.notionalAusd)} notional</span>
      </td>
      <td className={`${cell} text-danger`} title={row.badDebtAusd > 0 ? `${formatAusdExact(row.badDebtAusd)} AUSD bad debt` : undefined}>−{formatAusd(row.marginLostAusd)}</td>
      <td className={`${cell} ${row.marginToSurviveAusd === undefined ? 'text-muted2' : ''}`} title={row.marginToSurviveAusd === undefined ? undefined : `${formatAusdExact(row.marginToSurviveAusd)} AUSD`}>
        {row.marginToSurviveAusd === undefined ? 'unknown' : formatAusd(row.marginToSurviveAusd)}
      </td>
      <td className={cell} title={`${formatAusdExact(row.freeBalanceBeforeAusd)} AUSD`}>{formatAusd(row.freeBalanceBeforeAusd)}</td>
      <td className={cell}>
        <span className={`rounded-[4px] px-[6px] py-[2.5px] text-[10px] font-semibold tracking-[0.05em] ${verdict.className}`} title={verdict.title}>
          {verdict.text}
        </span>
      </td>
    </tr>
  );
}
