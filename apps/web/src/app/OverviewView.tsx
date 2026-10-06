'use client';

import { useMemo } from 'react';
import type { MarketBreakdown } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAge, formatAusdExact, formatCount, formatDayLong, formatMoney, formatPct, formatSignedMoney } from '@/lib/format.ts';
import { deltaOf, deltaVsPrevious, lastDays, stackByMarket } from '@/lib/overview.ts';
import { balanceBefore, rebuiltBalance, treasuryLines } from '@/lib/exchangeBalance.ts';
import { chartWindow } from '@/lib/timeframe.ts';
import { periodLabel } from '@/lib/history.ts';
import { useHistory, useHistoryStart } from '@/lib/useHistory.ts';
import { biggestStep, formatMonth } from '@/lib/growth.ts';
import { GrowthChart } from '@/components/charts/GrowthChart.tsx';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { SkewBar } from '@/components/SkewBar.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { NetFlowChart } from '@/components/charts/NetFlowChart.tsx';
import { DailyBars } from '@/components/charts/DailyBars.tsx';
import { LevelChart, type LevelPoint } from '@/components/charts/LevelChart.tsx';
import { marketName } from '@/lib/markets.ts';
import { ANCHOR_TOLERANCE, oiHistory, type OiHistory } from '@/lib/oiHistory.ts';
import { VolumeByMarketChart } from '@/components/charts/VolumeByMarketChart.tsx';

const POLL_MS = 30_000;

/**
 * Long and short isolated margin across every listed market, with the headcount.
 * Margin, never notional: every long lot has a matching short lot, so notional
 * per side is equal by construction and its skew is always 50/50.
 */
function skewOf(
  markets: readonly MarketBreakdown[] | undefined,
): { readonly long: number; readonly short: number; readonly longs: number; readonly shorts: number; readonly markets: number } | undefined {
  if (markets === undefined) return undefined;
  let long = 0;
  let short = 0;
  let longs = 0;
  let shorts = 0;
  let counted = 0;
  for (const m of markets) {
    if (m.market.symbol === undefined) continue;
    long += m.longMarginAusd;
    short += m.shortMarginAusd;
    longs += m.longPositions;
    shorts += m.shortPositions;
    counted += 1;
  }
  return { long, short, longs, shorts, markets: counted };
}

/**
 * Protocol analytics only: no hero, no pitch. Every figure is derived from
 * indexed events, carries its window, and says when it is a level rather
 * than a windowed sum.
 */
export function OverviewView() {
  const t = useTimeframe();
  const { fetch: ct, showDays } = chartWindow(t);
  const period = periodLabel(t, useHistoryStart());

  const metrics = usePoll(() => api.metrics(t), POLL_MS, `metrics:${t}`);
  // Since launch, whatever the timeframe: the line under the windowed flow.
  const allTime = usePoll(() => api.metrics('all'), POLL_MS, 'metrics:all:since-launch');
  const history = useHistory();
  const tvl = usePoll(api.tvl, POLL_MS, 'tvl');
  const series = usePoll(() => api.series(ct), POLL_MS, `series:${ct}`);
  const byMarket = usePoll(() => api.seriesByMarket(ct), POLL_MS, `series-markets:${ct}`);
  const oi = usePoll(api.openInterest, POLL_MS, 'oi');
  // Since launch, whatever the window: the exchange balance is a running total from launch.
  const seriesAll = usePoll(() => api.series('all'), POLL_MS, 'series:all:balance');
  const treasury = usePoll(api.protocolTreasuryDays, POLL_MS, 'protocol-treasury-days');
  const markets = usePoll(() => api.markets(t), POLL_MS, `markets:${t}`);
  const health = usePoll(api.indexerHealth, POLL_MS, 'indexer-health');

  const m = metrics.data?.data;
  const days = useMemo(() => (series.data === undefined ? undefined : lastDays(series.data.data, showDays)), [series.data, showDays]);
  const stacked = useMemo(() => (byMarket.data === undefined ? undefined : stackByMarket(byMarket.data.data, 4, 7, showDays)), [byMarket.data, showDays]);
  const tvlReading = tvl.data?.data;
  const tvlNow = tvlReading?.known === true ? tvlReading.totalValueLockedAusd : undefined;
  const balance = useMemo(() => (seriesAll.data === undefined || treasury.data === undefined ? undefined : rebuiltBalance(seriesAll.data.data, treasury.data.data)), [seriesAll.data, treasury.data]);
  const balanceWindow = useMemo(() => (balance === undefined ? undefined : lastDays(balance, showDays)), [balance, showDays]);
  const lines = treasury.data === undefined ? undefined : treasuryLines(treasury.data.data.scan, Date.now());
  const tvlSpark = balanceWindow?.map((d) => d.levelAusd);
  const balancePoints = useMemo<readonly LevelPoint[] | undefined>(
    () =>
      balanceWindow === undefined
        ? undefined
        : [
            // Whole days at their close; today is the live reading instead.
            ...balanceWindow.filter((d) => d.dayMs + DAY_MS <= Date.now() || tvlNow === undefined).map((d) => ({ atMs: d.dayMs, value: d.levelAusd })),
            ...(tvlNow === undefined ? [] : [{ atMs: Math.max(tvlReading?.known === true ? tvlReading.asOfMs : Date.now(), (balanceWindow.at(-1)?.dayMs ?? 0) + 1), value: tvlNow, live: true }]),
          ],
    [balanceWindow, tvlNow, tvlReading],
  );
  const openPositions = markets.data?.data.reduce((sum, mk) => sum + mk.openPositions, 0);
  const skew = skewOf(markets.data?.data);
  const chartNote = t === '24h' ? 'Day buckets: the last 7 UTC days are shown for a 24h window.' : undefined;
  const oiHist = useMemo(() => (byMarket.data === undefined ? undefined : oiHistory(byMarket.data.data, oi.data?.data.markets)), [byMarket.data, oi.data]);
  const oiPoints = useMemo(() => (oiHist === undefined ? undefined : oiLevelPoints(oiHist, showDays, Date.now())), [oiHist, showDays]);
  const marketNames = useMemo(() => new Map((byMarket.data?.data ?? []).map((s) => [s.market.marketId, marketName(s.market)])), [byMarket.data]);
  const block = health.data?.data.latestProcessedBlock;

  return (
    // Opts this page into the terminal design system (globals.css).
    <div data-ui="terminal">
      <PageHeader
        title="Perpl protocol"
        subtitle="Everything below is derived from indexed on-chain events. No account needed."
        right={
          <>
            {block !== undefined && <span className="chip">indexed to block {formatCount(block)}</span>}
            <TimeframePills />
          </>
        }
      />

      <StaleMarker envelope={metrics.data} />
      <ErrorNote error={metrics.error} what="Protocol metrics" />

      {/* ── five tiles ──────────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {m === undefined ? (
          Array.from({ length: 5 }, (_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <StatTile
              label={`Volume · ${period}`}
              value={formatMoney(m.volumeAusd)}
              exact={`${formatAusdExact(m.volumeAusd)}`}
              delta={deltaVsPrevious(m, (p) => p.volumeAusd, m.volumeAusd)}
              secondary={`${formatCount(m.tradeCount)} trades`}
              sparkline={days?.map((d) => d.volumeAusd)}
            />
            <StatTile
              label="Open interest · now"
              value={oi.data === undefined ? '…' : formatMoney(oi.data.data.totalNotional)}
              exact={oi.data === undefined ? undefined : `${formatAusdExact(oi.data.data.totalNotional)}, ${oi.data.data.markets.length} markets`}
              secondary={
                <>
                  <div>{oi.data === undefined ? '…' : `across ${formatCount(oi.data.data.markets.length)} markets`}</div>
                  <div>{openPositions === undefined ? '…' : `${formatCount(openPositions)} open positions in the index`}</div>
                </>
              }
              sparkline={oiPoints?.map((p) => p.value)}
              sparklineNote={oi.data?.data.asOfMs === undefined ? 'no reading yet' : `level from the venue as of ${formatAge(Date.now() - oi.data.data.asOfMs)} ago`}
            />
            <StatTile
              label="Exchange balance · now"
              value={tvlNow === undefined ? (tvl.data === undefined ? '…' : 'unknown') : formatMoney(tvlNow)}
              exact={tvlNow === undefined ? tvlReading?.known === false ? tvlReading.reason : undefined : `${formatAusdExact(tvlNow)}: the Exchange contract's whole AUSD balance, read now. It holds traders' free balances and position margin, and also the per-market insurance funds and protocol balances, so it is not the same as collateral held across accounts.`}
              delta={tvlNow === undefined || treasury.data === undefined ? undefined : deltaOf(tvlNow, balanceBefore(tvlNow, m.collateralFlow.netAusd, treasury.data.data.movements, m.sinceMs))}
              deltaLabel={`in ${period}`}
              secondary="held by the Exchange contract"
              sparkline={tvlSpark}
            />
            <StatTile
              label={`Fees · ${m.fees.days === 0 ? 'no day yet' : `${formatCount(m.fees.days)} UTC day${m.fees.days === 1 ? '' : 's'}`}`}
              labelWarn={t !== 'all'}
              value={formatMoney(m.fees.totalAusd)}
              exact={`${formatAusdExact(m.fees.totalAusd)} over ${m.fees.label}`}
              delta={deltaVsPrevious(m, (p) => p.fees.totalAusd, m.fees.totalAusd)}
              deltaLabel={m.previous === undefined ? 'vs prev' : `vs ${formatCount(m.previous.fees.days)} days before`}
              secondary={`AUSD, maker + taker, over ${m.fees.label} · maker ${formatMoney(m.makerFeesAusd)} exact`}
              sparkline={days?.map((d) => d.feesAusd)}
            />
            <StatTile
              label={`Active traders · ${period}`}
              value={formatCount(m.activeTraders)}
              delta={deltaVsPrevious(m, (p) => p.activeTraders, m.activeTraders)}
              secondary="accounts with ≥1 fill in the window"
              sparkline={days?.map((d) => d.activeTraders)}
            />
          </>
        )}
      </section>

      {/* ── levels through time, and the day's activity ─────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Open interest</h2>
            <span className="text-[12.5px] text-muted">one side · each UTC day&rsquo;s close, then now</span>
          </div>
          <ErrorNote error={byMarket.error} what="Open interest history" />
          {oiPoints === undefined ? (
            <Skeleton className="mt-2 h-[220px] w-full" />
          ) : (
            <LevelChart
              points={oiPoints}
              label="Open interest"
              rows={(p) => topMarkets(p, oiHist!, marketNames)}
            />
          )}
          <div className="mt-2 text-[11.5px] leading-[1.5] text-muted2">
            Each day is every market&rsquo;s open lots × its closing mark. The index runs from the Exchange&rsquo;s deployment block, so its running lot count is the level itself; the last point is the venue&rsquo;s own reading now.
            {oiHist !== undefined && oiHist.mismatches.length > 0 && (
              <span className="mt-1 block text-watch">
                Indexed lots differ from the venue&rsquo;s by more than {formatPct(ANCHOR_TOLERANCE)} on{' '}
                {oiHist.mismatches.map((x) => `${x.symbol} (${x.indexedLots.toLocaleString('en-US')} indexed vs ${x.venueLots === undefined ? 'not listed' : x.venueLots.toLocaleString('en-US')})`).join(', ')}. The history is drawn as indexed.
              </span>
            )}
            {chartNote !== undefined && ` ${chartNote}`}
          </div>
        </div>

        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Exchange balance</h2>
            <span className="text-[12.5px] text-muted">held by the contract · each UTC day&rsquo;s close, then now</span>
          </div>
          <ErrorNote error={seriesAll.error ?? treasury.error} what="Exchange balance history" />
          {balancePoints === undefined ? <Skeleton className="mt-2 h-[220px] w-full" /> : <LevelChart points={balancePoints} label="Exchange balance" />}
          <div className="mt-2 text-[11.5px] leading-[1.5] text-muted2">
            {lines?.reconciliation !== undefined && (
              <span className={`block ${lines.reconciliation.tone === 'watch' ? 'font-semibold text-watch' : 'text-muted'}`}>{lines.reconciliation.text}</span>
            )}
            <span className="block">
              Deposits − withdrawals plus the protocol treasury&rsquo;s own deposits and withdrawals, running since launch; the last point is the contract&rsquo;s balance now.
            </span>
            {lines !== undefined && <span className={`block ${lines.scan.tone === 'watch' ? 'text-watch' : ''}`}>{lines.scan.text}</span>}
            {chartNote !== undefined && ` ${chartNote}`}
          </div>
        </div>
      </section>

      <section className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Fees per day</h2>
            <span className="text-[12.5px] text-muted">maker + taker, per UTC day</span>
          </div>
          <ErrorNote error={series.error} what="Daily fees" />
          {days === undefined ? <Skeleton className="mt-2 h-[160px] w-full" /> : <DailyBars days={days.map((d) => ({ dayMs: d.dayMs, value: d.feesAusd }))} label="Fees" axis="money" format={(v) => `${formatMoney(v)}`} />}
          <div className="mt-2 text-[11.5px] text-muted2">Today is so far.{chartNote !== undefined && ` ${chartNote}`}</div>
        </div>
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Active traders per day</h2>
            <span className="text-[12.5px] text-muted">distinct accounts with a fill, per UTC day</span>
          </div>
          <ErrorNote error={series.error} what="Daily active traders" />
          {days === undefined ? <Skeleton className="mt-2 h-[160px] w-full" /> : <DailyBars days={days.map((d) => ({ dayMs: d.dayMs, value: d.activeTraders }))} label="Active traders" axis="count" format={(v) => formatCount(v)} />}
          <div className="mt-2 text-[11.5px] text-muted2">An account trading three markets counts once. Today is so far.{chartNote !== undefined && ` ${chartNote}`}</div>
        </div>
      </section>

      {/* ── volume, skew, flow ──────────────────────────────────────────── */}
      <GrowthSection />

      <section className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Volume</h2>
            <span className="text-[12.5px] text-muted">per UTC day, by market · line: 7-day average</span>
          </div>
          <ErrorNote error={byMarket.error} what="Volume by market" />
          {stacked === undefined ? <Skeleton className="mt-2 h-[262px] w-full" /> : <VolumeByMarketChart stacked={stacked} />}
          {chartNote !== undefined && <div className="mt-2 text-[11.5px] text-muted2">{chartNote}</div>}
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div className="card px-[18px] py-4">
            <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
              <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Long / short skew</h2>
              <span className="text-[12.5px] text-muted">by isolated margin at risk · now</span>
            </div>
            <ErrorNote error={markets.error} what="The market breakdown" />
            {skew === undefined ? (
              <Skeleton className="mt-3 h-[60px] w-full" />
            ) : skew.long + skew.short === 0 ? (
              <div className="mt-3 text-[12.5px] text-muted">No open position is indexed, so there is no skew to show.</div>
            ) : (
              <SkewBar
                longAusd={skew.long}
                shortAusd={skew.short}
                note={`${formatCount(skew.longs)} long / ${formatCount(skew.shorts)} short positions, across ${formatCount(skew.markets)} markets. Margin, not notional: every long lot has a matching short, so notional is always 50/50.`}
              />
            )}
          </div>

          <div className="card px-[18px] py-4">
            <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
              <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Net capital flow</h2>
              <span className="text-[12.5px] text-muted">{period}</span>
            </div>
            {m === undefined ? (
              <Skeleton className="mt-3 h-[90px] w-full" />
            ) : (
              <FlowSummary deposited={m.collateralFlow.depositedAusd} withdrawn={m.collateralFlow.withdrawnAusd} deposits={m.collateralFlow.depositCount} withdrawals={m.collateralFlow.withdrawalCount} />
            )}
            <SinceLaunchFlow flow={allTime.data?.data.collateralFlow} accounts={history.data?.data.months.reduce((n, mo) => n + mo.newAccounts, 0)} startsAtMs={history.data?.data.startsAtMs} />
          </div>
        </div>
      </section>

      <section className="card px-[18px] py-4">
        <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Net capital flow per day</h2>
          <span className="text-[12.5px] text-muted">Deposits − withdrawals, per UTC day</span>
        </div>
        <ErrorNote error={series.error} what="Daily flows" />
        {days === undefined ? <Skeleton className="mt-2 h-[262px] w-full" /> : <NetFlowChart days={days} />}
        <div className="mt-2 text-[11.5px] text-muted2">
          The Exchange balance is read from the contract; flows are indexed. The two answer different questions and both are shown.
          {chartNote !== undefined && ` ${chartNote}`}
        </div>
      </section>
    </div>
  );
}

/**
 * Net capital flow since launch, fixed whatever the timeframe. The totals are
 * the all-time CollateralFlow sums, which reconcile with the per-account and
 * per-day totals; the account count is every account the index has seen
 * created (each one opened with a deposit).
 */
function SinceLaunchFlow({
  flow,
  accounts,
  startsAtMs,
}: {
  readonly flow: { readonly depositedAusd: number; readonly withdrawnAusd: number; readonly netAusd: number } | undefined;
  readonly accounts: number | undefined;
  readonly startsAtMs: number | undefined;
}) {
  if (flow === undefined || accounts === undefined) return <Skeleton className="mt-3 h-[34px] w-full" />;
  const net = flow.netAusd;
  return (
    <p className="mt-3 mb-0 border-t border-border pt-3 text-[12.5px] text-muted" title={`${formatAusdExact(flow.depositedAusd)} in, ${formatAusdExact(flow.withdrawnAusd)} out, AUSD`}>
      <span className="font-semibold text-text">Since launch{startsAtMs === undefined ? '' : ` (${formatDayLong(startsAtMs)})`}:</span>{' '}
      <span className="num text-text">{formatMoney(flow.depositedAusd)}</span> deposited, <span className="num text-text">{formatMoney(flow.withdrawnAusd)}</span> withdrawn, net{' '}
      <span className={`num font-semibold ${net > 0 ? 'text-safe' : net < 0 ? 'text-danger' : 'text-text'}`}>
        {net >= 0 ? '+' : '−'}
        {formatMoney(Math.abs(net))}
      </span>{' '}
      {net >= 0 ? 'in' : 'out'}, across <span className="num text-text">{formatCount(accounts)}</span> accounts.
    </p>
  );
}

/** Deposits, withdrawals and the net, with how much of the gross flow came in. Every figure keeps its count. */
function FlowSummary({ deposited, withdrawn, deposits, withdrawals }: { readonly deposited: number; readonly withdrawn: number; readonly deposits: number; readonly withdrawals: number }) {
  const net = deposited - withdrawn;
  const gross = deposited + withdrawn;
  const inbound = gross > 0 ? deposited / gross : undefined;
  if (gross === 0) return <div className="mt-3 text-[12.5px] text-muted">No deposit or withdrawal in this window.</div>;
  return (
    <div className="mt-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-[6px] text-[12.5px]">
        <dt className="text-muted">Deposits</dt>
        <dd className="num m-0 text-right text-safe" title={`${formatCount(deposits)} deposits`}>{formatSignedMoney(deposited)}</dd>
        <dt className="text-muted">Withdrawals</dt>
        <dd className="num m-0 text-right text-danger" title={`${formatCount(withdrawals)} withdrawals`}>{formatSignedMoney(-withdrawn)}</dd>
        <dt className="font-semibold text-text">Net {net >= 0 ? 'inflow' : 'outflow'}</dt>
        <dd className={`num m-0 text-right font-semibold ${net > 0 ? 'text-safe' : net < 0 ? 'text-danger' : ''}`}>{formatSignedMoney(net)}</dd>
      </dl>
      <div className="mt-3 h-[5px] overflow-hidden rounded-full bg-border" aria-hidden="true">
        <i className="block h-full bg-safe" style={{ width: `${(inbound ?? 0) * 100}%` }} />
      </div>
      <div className="mt-[6px] text-[11.5px] text-muted2">
        {inbound === undefined ? '' : `${formatPct(inbound)} of gross flow was inbound · ${formatCount(deposits)} deposits, ${formatCount(withdrawals)} withdrawals`}
      </div>
    </div>
  );
}

/**
 * The protocol's growth, every UTC month since the Exchange was deployed.
 * Deliberately OUTSIDE the page's timeframe: it always runs from the first
 * month, and its label says so, so it cannot be read as "30 days".
 */
function GrowthSection() {
  const history = useHistory();
  const h = history.data?.data;
  const step = h === undefined ? undefined : biggestStep(h.months, h.startsAtMs);
  const total = h?.months.reduce((sum, m) => sum + m.trades, 0);
  return (
    <section className="card mb-4 px-[18px] py-4">
      <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Trades per month, since launch</h2>
        <span className="text-[12.5px] text-muted">
          {h?.startsAtMs === undefined ? 'all indexed history' : `every UTC month since ${formatDayLong(h.startsAtMs)} · not affected by the timeframe`}
        </span>
      </div>
      <ErrorNote error={history.error} what="The growth curve" />
      {h === undefined ? (
        <Skeleton className="mt-2 h-[260px] w-full" />
      ) : h.months.length === 0 ? (
        <div className="mt-3 text-[12.5px] text-muted">No trade is indexed yet, so there is no curve to draw.</div>
      ) : (
        <>
          {step !== undefined && step.factor >= 2 && (
            <p className="m-0 mt-1 max-w-[70ch] text-[13px] text-[#C9C4E4]">
              <b className="font-semibold text-text">{formatMonth(step.to.monthMs)} was the step change:</b>{' '}
              {formatCount(step.to.trades)} trades against {formatCount(step.from.trades)} in {formatMonth(step.from.monthMs)}, {Math.round(step.factor)}× in one month.
            </p>
          )}
          <GrowthChart months={h.months} />
          <div className="mt-2 text-[11.5px] text-muted2">
            One trade is one maker fill. {total === undefined ? '' : `${formatCount(total)} in all. `}
            {h.months.some((m) => m.partial) ? 'The faint bar is the month still running. ' : ''}{h.startsAtMs === undefined ? '' : `${formatMonth(h.startsAtMs)} starts at launch, ${formatDayLong(h.startsAtMs)}, so it is not a whole month either.`}
          </div>
          <details className="mt-2 text-[12px] text-muted">
            <summary className="cursor-pointer">The numbers</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="num w-full text-left">
                <thead>
                  <tr className="text-muted2">
                    <th className="py-1 pr-4 font-medium">Month</th>
                    <th className="py-1 pr-4 text-right font-medium">Trades</th>
                    <th className="py-1 pr-4 text-right font-medium">Volume</th>
                    <th className="py-1 text-right font-medium">New accounts</th>
                  </tr>
                </thead>
                <tbody>
                  {h.months.map((m) => (
                    <tr key={m.monthMs} className="border-t border-border text-text">
                      <td className="py-1 pr-4">{formatMonth(m.monthMs)}{m.partial ? ' (so far)' : ''}</td>
                      <td className="py-1 pr-4 text-right">{formatCount(m.trades)}</td>
                      <td className="py-1 pr-4 text-right">{formatMoney(m.volumeAusd)}</td>
                      <td className="py-1 text-right">{formatCount(m.newAccounts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

const DAY_MS = 86_400_000;

/**
 * The OI line: whole UTC days at their close, then the venue's reading now.
 * Today's partial bucket is dropped in favour of the live point, so the line
 * never shows half a day as a close.
 */
function oiLevelPoints(h: OiHistory, showDays: number | undefined, nowMs: number): readonly LevelPoint[] {
  const whole = h.days.filter((d) => d.dayMs + DAY_MS <= nowMs || h.now === undefined);
  const days = lastDays(whole, showDays === undefined ? undefined : showDays - 1).map((d) => ({ atMs: d.dayMs, value: d.totalAusd }));
  return h.now === undefined ? days : [...days, { atMs: Math.max(h.now.atMs, (days.at(-1)?.atMs ?? 0) + 1), value: h.now.totalAusd, live: true }];
}

/** A day's three largest markets, for the tooltip. */
function topMarkets(p: LevelPoint, h: OiHistory, names: ReadonlyMap<number, string>) {
  if (p.live === true) return [];
  const day = h.days.find((d) => d.dayMs === p.atMs);
  if (day === undefined) return [];
  return Object.entries(day.byMarket)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([id, v]) => ({ label: names.get(Number(id)) ?? `market ${id}`, value: formatMoney(v), muted: true }));
}

