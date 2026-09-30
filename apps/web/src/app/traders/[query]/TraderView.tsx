'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { AssessedPosition, RoundTrip, WalletProfile } from '@perpguard/shared';
import { ApiError, api } from '@/lib/api.ts';
import {
  formatAge,
  formatAusd,
  formatAusdExact,
  formatCompact,
  formatCount,
  formatDayLong,
  formatDuration,
  formatPct,
  formatPriceAsServed,
  formatSignedAusd,
  formatSignedPct,
  formatWhen,
  shortAddress,
} from '@/lib/format.ts';
import { LIST_CAP, LIST_STEP, mayHaveMore, nextLimit } from '@/lib/liquidations.ts';
import { COLORS } from '@/lib/theme.ts';
import { PERIOD_LABEL } from '@/lib/timeframe.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { bufferTier, cumulativeDays, cumulativePnl, parseTraderQuery, sumDays, winRateOf } from '@/lib/traders.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { TraderDaysChart } from '@/components/charts/TraderDaysChart.tsx';

const POLL_MS = 30_000;

export function TraderView({ query }: { readonly query: string }) {
  const parsed = useMemo(() => parseTraderQuery(query), [query]);
  const t = useTimeframe();
  const period = PERIOD_LABEL[t];

  // One lookup by whatever was typed. An address resolves to a profile or to
  // `not-linked`; an id resolves to a profile or a 404. Both are answers.
  const lookup = usePoll(
    async () => {
      if (parsed.kind === 'address') return api.wallet(parsed.address);
      if (parsed.kind === 'account') {
        const r = await api.account(parsed.accountId);
        return { ...r, data: { kind: 'found' as const, profile: r.data, resolvedBy: 'index' as const } };
      }
      throw new ApiError('', 400, parsed.reason);
    },
    POLL_MS,
    `wallet:${query}`,
  );

  const found = lookup.data?.data.kind === 'found' ? lookup.data.data.profile : undefined;
  const accountId = found?.accountId;
  const [limit, setLimit] = useState(LIST_STEP);
  const positions = usePoll(
    () => (accountId === undefined ? Promise.reject(new Error('no account yet')) : api.accountPositions(accountId)),
    POLL_MS,
    `positions:${accountId ?? '-'}`,
  );
  const trips = usePoll(
    () => (accountId === undefined ? Promise.reject(new Error('no account yet')) : api.roundTrips(accountId, limit)),
    POLL_MS,
    `trips:${accountId ?? '-'}:${limit}`,
  );
  // THE WINDOW: the account's UTC days, straight off the indexer's TraderDay
  // table. The tiles sum them; the chart draws them. Lifetime figures come from
  // the profile and are labelled as lifetime.
  const days = usePoll(
    () => (accountId === undefined ? Promise.reject(new Error('no account yet')) : api.accountDays(accountId, t)),
    POLL_MS,
    `days:${accountId ?? '-'}:${t}`,
  );
  const dayRows = days.data?.data;
  const window = useMemo(() => (dayRows === undefined ? undefined : sumDays(dayRows)), [dayRows]);
  const dayCurve = useMemo(() => (dayRows === undefined ? undefined : cumulativeDays(dayRows)), [dayRows]);
  const windowLabel = t === 'all' ? 'all time' : window === undefined ? period : `${formatCount(window.days)} UTC day${window.days === 1 ? '' : 's'}`;

  // ── the three non-profile outcomes ───────────────────────────────────────
  if (parsed.kind === 'invalid') {
    return (
      <>
        <PageHeader title="Trader" thin={query} subtitle="Profile, open positions and round-trip history for an address or account id." />
        <Outcome title="That is not an address or an account id.">
          {parsed.reason}. <Link href="/traders">Back to the traders list.</Link>
        </Outcome>
      </>
    );
  }
  if (lookup.error instanceof ApiError && lookup.error.status === 404) {
    return (
      <>
        <PageHeader title="Account" thin={`#${query}`} subtitle="Profile, open positions and round-trip history for this account." />
        <Outcome title={`No account ${query} in the index.`}>
          An account id either exists in the index or it does not. <Link href="/traders">Back to the traders list.</Link>
        </Outcome>
      </>
    );
  }
  if (lookup.data?.data.kind === 'not-linked') {
    return (
      <>
        <PageHeader title="Trader" thin={shortAddress(lookup.data.data.address)} subtitle="Profile, open positions and round-trip history for this address." />
        <StaleMarker envelope={lookup.data} />
        <Outcome title={lookup.data.data.accountId === undefined ? 'This address has no account the index or the Exchange can see.' : `This address owns account #${lookup.data.data.accountId}, which has no indexed activity.`}>
          {lookup.data.data.reason}
          {lookup.data.data.accountId !== undefined && (
            <>
              {' '}
              <Link href={`/traders/${lookup.data.data.accountId}`}>Open account #{lookup.data.data.accountId}</Link> to watch for its first trade.
            </>
          )}
        </Outcome>
      </>
    );
  }

  // ── the profile ──────────────────────────────────────────────────────────
  const p = found;
  const resolvedBy = lookup.data?.data.kind === 'found' ? lookup.data.data.resolvedBy : undefined;
  const heading = p === undefined ? (parsed.kind === 'address' ? shortAddress(parsed.address) : `#${parsed.accountId}`) : p.address === '' ? `#${p.accountId}` : shortAddress(p.address);
  const curve = trips.data === undefined ? undefined : cumulativePnl(trips.data.data);
  const rows = trips.data?.data;
  const floor = p?.performance.minRoundTripsForRatios;
  const windowWinRate = window === undefined || floor === undefined ? undefined : winRateOf(window.wins, window.roundTrips, floor);

  return (
    <>
      <PageHeader
        title={p === undefined || p.address === '' ? 'Account' : 'Trader'}
        thin={heading}
        subtitle={
          p === undefined ? (
            // A span, not the div Skeleton: this sits inside the header's <p>.
            <span aria-hidden="true" className="skeleton inline-block h-[14px] w-[320px] align-middle" />
          ) : (
            <>
              Account {p.accountId}
              {p.address !== '' && <> · <span className="num" title={p.address}>{p.address}</span></>}
              {p.firstTradeAtMs !== undefined && <> · first trade {formatDayLong(p.firstTradeAtMs)}</>}
              {' · '}last active {formatAge(Date.now() - p.lastActiveAtMs)} ago · {formatCount(p.performance.roundTrips)} round trips lifetime
              {resolvedBy === 'chain' && ' · owner resolved by the Exchange contract'}
            </>
          )
        }
        right={<TimeframePills />}
      />

      <StaleMarker envelope={lookup.data} />
      <ErrorNote error={lookup.error} what="Trader profile" />

      {/* ── four tiles: the window first, lifetime beside it ────────────── */}
      <ErrorNote error={accountId === undefined ? undefined : days.error} what="The account's daily history" />
      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {p === undefined || window === undefined ? (
          Array.from({ length: 4 }, (_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <StatTile
              label={`Net PnL · ${windowLabel}`}
              value={formatSignedAusd(t === 'all' ? p.netPnlAusd : window.netPnlAusd, 0)}
              exact={t === 'all' ? `${formatSignedAusd(p.netPnlAusd)} AUSD = realised ${formatSignedAusd(p.realisedPnlAusd)} + funding ${formatSignedAusd(p.fundingAusd)} − fees ${formatAusd(p.feesPaidAusd)}` : `${formatSignedAusd(window.netPnlAusd)} AUSD = realised ${formatSignedAusd(window.realisedPnlAusd)} + funding ${formatSignedAusd(window.fundingAusd)} − fees ${formatAusd(window.feesAusd)}`}
              valueColor={(t === 'all' ? p.netPnlAusd : window.netPnlAusd) > 0 ? COLORS.safe : (t === 'all' ? p.netPnlAusd : window.netPnlAusd) < 0 ? COLORS.danger : undefined}
              secondary={
                <>
                  <div>{t === 'all' ? `realised ${formatSignedAusd(p.realisedPnlAusd, 0)} · funding ${formatSignedAusd(p.fundingAusd, 0)} · fees ${formatAusd(p.feesPaidAusd, 0)}` : `lifetime ${formatSignedAusd(p.netPnlAusd, 0)}`}</div>
                  <div>{t === 'all' ? `curve: the last ${formatCount(curve?.length ?? 0)} round trips` : `realised ${formatSignedAusd(window.realisedPnlAusd, 0)} · funding ${formatSignedAusd(window.fundingAusd, 0)} · fees ${formatAusd(window.feesAusd, 0)}`}</div>
                </>
              }
              sparkline={t === 'all' ? (curve !== undefined && curve.length >= 2 ? curve : undefined) : dayCurve !== undefined && dayCurve.length >= 2 ? dayCurve.map((d) => d.cumulativeAusd) : undefined}
              sparklineColor={(t === 'all' ? (curve?.at(-1) ?? 0) : window.netPnlAusd) < 0 ? COLORS.danger : COLORS.safe}
              sparklineNote={t === 'all' ? 'not enough round trips for a curve' : `${formatCount(window.days)} day${window.days === 1 ? '' : 's'} with activity: not enough for a curve`}
            />
            <StatTile
              label={`Volume · ${windowLabel}`}
              value={formatCompact(t === 'all' ? p.volumeAusd : window.volumeAusd)}
              exact={`${formatAusdExact(t === 'all' ? p.volumeAusd : window.volumeAusd)} AUSD notional`}
              secondary={
                <>
                  <div>{formatCount(t === 'all' ? p.tradeCount : window.tradeCount)} trades</div>
                  <div>{t === 'all' ? 'lifetime' : `lifetime ${formatCompact(p.volumeAusd)} · ${formatCount(p.tradeCount)} trades`}</div>
                </>
              }
              sparkline={dayRows !== undefined && dayRows.length >= 2 ? dayRows.map((d) => d.volumeAusd) : undefined}
              sparklineNote={dayRows === undefined ? 'loading the days' : 'one day with activity: not enough for a shape'}
            />
            <StatTile
              label={`Round trips · ${windowLabel}`}
              value={formatCount(t === 'all' ? p.performance.roundTrips : window.roundTrips)}
              secondary={
                <>
                  <div>
                    {t === 'all'
                      ? `${formatCount(p.performance.wins)} wins · ${formatCount(p.performance.losses)} losses`
                      : `${formatCount(window.wins)} wins · ${formatCount(window.losses)} losses`}
                  </div>
                  <div>
                    {(t === 'all' ? p.performance.winRate : windowWinRate) === undefined
                      ? `win rate withheld under ${formatCount(floor ?? 0)} round trips`
                      : `win rate ${formatPct((t === 'all' ? p.performance.winRate : windowWinRate)!)} of ${formatCount(t === 'all' ? p.performance.roundTrips : window.roundTrips)}`}
                  </div>
                </>
              }
              sparkline={dayRows !== undefined && dayRows.length >= 2 ? dayRows.map((d) => d.wins + d.losses) : undefined}
              sparklineNote="a round trip is one position from open to flat"
            />
            <StatTile
              label={`Liquidations · ${windowLabel}`}
              value={formatCount(t === 'all' ? p.rescues.count : window.liquidationCount)}
              exact={`${formatCount(p.rescues.count)} forced exits lifetime, ${formatCount(p.rescues.judgeableCount)} judgeable`}
              valueColor={(t === 'all' ? p.rescues.count : window.liquidationCount) > 0 ? COLORS.danger : undefined}
              secondary={
                <>
                  <div>
                    <b className="font-semibold text-watch">{formatCount(t === 'all' ? p.rescues.rescuableCount : window.rescuableLiquidationCount)} rescuable</b>
                    {t === 'all' && p.rescues.judgeableCount > 0 && ` · ${formatPct(p.rescues.rate ?? 0, 0)} of ${formatCount(p.rescues.judgeableCount)} judgeable`}
                    {t === 'all' && p.rescues.unknownCount > 0 && ` · ${formatCount(p.rescues.unknownCount)} unjudgeable`}
                    {t !== 'all' && ` · lifetime ${formatCount(p.rescues.count)}`}
                  </div>
                  <div>
                    {p.rescues.medianSpareBalanceAusd === undefined
                      ? 'no rescuable case to take a median over'
                      : `median ${formatAusd(p.rescues.medianSpareBalanceAusd)} AUSD sitting free at the time · lifetime`}
                  </div>
                </>
              }
              sparkline={dayRows !== undefined && dayRows.length >= 2 ? dayRows.map((d) => d.liquidationCount) : undefined}
              sparklineColor={COLORS.danger}
              sparklineNote="spare balance that isolated margin never reached for"
            />
          </>
        )}
      </section>

      {/* ── the days ─────────────────────────────────────────────────────── */}
      <section className="card mb-4 px-[18px] py-4">
        <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Daily net PnL</h2>
          <span className="text-[12.5px] text-muted">Per UTC day · {t === 'all' ? 'every indexed day' : period}, from the indexer&rsquo;s per-trader day buckets</span>
        </div>
        {dayCurve === undefined ? (
          <Skeleton className="mt-2 h-[262px] w-full" />
        ) : dayCurve.length === 0 ? (
          <div className="flex h-[200px] flex-col items-center justify-center text-center">
            <div className="text-[14px] font-semibold text-text">No activity in {t === 'all' ? 'the index' : `the last ${period}`}.</div>
            <div className="mt-1 text-[12.5px] text-muted">A day appears here once the account trades, deposits or withdraws on it. Widen the window to see earlier days.</div>
          </div>
        ) : (
          <TraderDaysChart days={dayCurve} />
        )}
      </section>

      {/* ── performance strip: lifetime, and says so ───────────────────── */}
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Performance</h2>
        <span className="text-[12.5px] text-muted">Lifetime, over every indexed round trip. Not windowed.</span>
      </div>
      {p !== undefined && <Performance profile={p} />}

      {/* ── open positions ──────────────────────────────────────────────── */}
      <section className="mb-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Open positions</h2>
          <span className="text-[12.5px] text-muted">
            {positions.data?.data.asOfMs === undefined ? 'mark and liquidation price from the venue' : `marks as of ${formatAge(Date.now() - positions.data.data.asOfMs)} ago · liquidation price from the risk maths`}
          </span>
        </div>
        <ErrorNote error={accountId === undefined ? undefined : positions.error} what="Open positions" />
        <PositionsTable assessed={positions.data?.data.positions} loading={p === undefined || (positions.data === undefined && positions.error === undefined)} fallback={p?.openPositions} />
      </section>

      {/* ── round trips ─────────────────────────────────────────────────── */}
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Round trips</h2>
          <span className="text-[12.5px] text-muted">One position from open to flat, most recent first. A forced exit is a loss whatever the maths.</span>
        </div>
        <ErrorNote error={accountId === undefined ? undefined : trips.error} what="Round trips" />
        <TripsTable rows={rows} />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-muted2">
          <span>Net PnL per round trip is realised + funding − fees over the position&rsquo;s life. Entry is unknown for a position that predates the index.</span>
          {rows !== undefined && mayHaveMore(rows.length, limit) && (
            <button type="button" className="btn" onClick={() => setLimit(nextLimit(limit))}>
              Show more
            </button>
          )}
          {rows !== undefined && rows.length >= LIST_CAP && <span>Showing the most recent {formatCount(LIST_CAP)}.</span>}
        </div>
      </section>
    </>
  );
}

function Outcome({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-border2 bg-card px-[18px] py-4 text-[13px]">
      <b className="text-text">{title}</b> <span className="text-muted">{children}</span>
    </div>
  );
}

function Performance({ profile: p }: { readonly profile: WalletProfile }) {
  const perf = p.performance;
  const cells: readonly { readonly label: string; readonly value: string; readonly color?: string | undefined; readonly title?: string | undefined; readonly sub?: string | undefined }[] = [
    {
      label: 'Win rate',
      value: perf.winRate === undefined ? '—' : formatPct(perf.winRate),
      title: perf.winRate === undefined ? `${formatCount(perf.wins)} wins of ${formatCount(perf.roundTrips)}: withheld under ${formatCount(perf.minRoundTripsForRatios)} round trips` : `${formatCount(perf.wins)} wins · ${formatCount(perf.losses)} losses · of ${formatCount(perf.roundTrips)}`,
      sub: perf.winRate === undefined ? `under ${formatCount(perf.minRoundTripsForRatios)} trips` : `${formatCount(perf.wins)} of ${formatCount(perf.roundTrips)}`,
    },
    {
      label: 'Profit factor',
      value: perf.profitFactor === undefined ? (perf.roundTrips >= perf.minRoundTripsForRatios && perf.losses === 0 && perf.wins > 0 ? 'no losses' : '—') : perf.profitFactor.toFixed(3),
      title: 'gross profit over gross loss',
      sub: perf.roundTrips < perf.minRoundTripsForRatios ? `under ${formatCount(perf.minRoundTripsForRatios)} trips` : undefined,
    },
    { label: 'Max drawdown', value: perf.maxDrawdownAusd === 0 ? '0' : `−${formatAusd(perf.maxDrawdownAusd)}`, color: perf.maxDrawdownAusd > 0 ? COLORS.danger : undefined, title: 'largest peak-to-trough fall in cumulative net PnL' },
    { label: 'Best streak', value: `${formatCount(perf.longestWinStreak)} wins` },
    { label: 'Worst streak', value: `${formatCount(perf.longestLossStreak)} losses` },
    { label: 'Avg hold', value: perf.averageHoldMs === undefined ? '—' : formatDuration(perf.averageHoldMs) },
    { label: 'Best / worst trip', value: `${formatSignedAusd(perf.bestRoundTripAusd, 0)} / ${formatSignedAusd(perf.worstRoundTripAusd, 0)}` },
    {
      label: 'Best / worst market',
      value: `${perf.bestMarket?.market.symbol ?? '—'} / ${perf.worstMarket?.market.symbol ?? '—'}`,
      title:
        perf.bestMarket === undefined || perf.worstMarket === undefined
          ? undefined
          : `${perf.bestMarket.market.symbol}: ${formatSignedAusd(perf.bestMarket.netPnlAusd, 0)} over ${formatCount(perf.bestMarket.roundTrips)} trips · ${perf.worstMarket.market.symbol}: ${formatSignedAusd(perf.worstMarket.netPnlAusd, 0)} over ${formatCount(perf.worstMarket.roundTrips)}`,
    },
  ];
  return (
    <section className="card mb-4 grid grid-cols-2 gap-x-4 gap-y-3 px-[18px] py-[14px] sm:grid-cols-4 lg:grid-cols-8" aria-label="Lifetime performance">
      {cells.map((c) => (
        <div key={c.label} title={c.title}>
          <div className="text-[11px] font-medium tracking-[0.02em] text-muted uppercase">{c.label}</div>
          <div className="num mt-[2px] text-[15px] font-bold tracking-[-0.01em]" style={c.color === undefined ? undefined : { color: c.color }}>
            {c.value}
          </div>
          {c.sub !== undefined && <div className="text-[11px] text-muted2">{c.sub}</div>}
        </div>
      ))}
    </section>
  );
}

const SIDE_BADGE = (side: 'long' | 'short') =>
  `rounded-[6px] px-[7px] py-[2px] text-[10.5px] font-bold uppercase tracking-[0.05em] ${side === 'long' ? 'bg-safe/15 text-safe' : 'bg-danger/15 text-danger'}`;

const TIER_COLOR = { past: COLORS.danger, danger: COLORS.danger, watch: COLORS.watch, safe: COLORS.safe, unknown: COLORS.muted } as const;

const POSITION_COLUMNS = ['Market', 'Side', 'Size', 'Entry', 'Lev', 'Margin', 'Mark', 'uPnL', 'Liquidation', 'Buffer'] as const;

function PositionsTable({
  assessed,
  fallback,
  loading,
}: {
  readonly assessed: readonly AssessedPosition[] | undefined;
  /** The profile's own rows, shown unpriced when the assessment is unavailable. */
  readonly fallback: WalletProfile['openPositions'] | undefined;
  readonly loading: boolean;
}) {
  const rows: readonly AssessedPosition[] | undefined =
    assessed ?? (fallback === undefined ? undefined : fallback.map((position) => ({ position, reason: 'the venue could not be asked for a mark' })));
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
            {POSITION_COLUMNS.map((label, i) => (
              <th key={label} scope="col" className={`px-[10px] py-[9px] font-semibold whitespace-nowrap ${i < 2 ? 'text-left' : 'text-right'} ${i === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows === undefined && loading
            ? Array.from({ length: 3 }, (_, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  {POSITION_COLUMNS.map((label, j) => (
                    <td key={label} className={`px-[10px] py-[10px] ${j === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                      <Skeleton className={`h-[14px] ${j < 2 ? 'w-[50px]' : 'ml-auto w-[64px]'}`} />
                    </td>
                  ))}
                </tr>
              ))
            : (rows ?? []).map((a) => {
                const pos = a.position;
                const tier = bufferTier(a.liqBufferPct);
                const symbol = pos.market.symbol ?? `market ${pos.market.marketId}`;
                return (
                  <tr key={`${pos.market.marketId}-${pos.openedAtMs}`} className="border-b border-border last:border-b-0 hover:bg-card2">
                    <td className="sticky left-0 z-[1] bg-card px-[10px] py-[10px] font-semibold whitespace-nowrap" title={`opened ${formatWhen(pos.openedAtMs)} UTC`}>
                      {symbol}
                    </td>
                    <td className="px-[10px] py-[10px] whitespace-nowrap">
                      <span className={SIDE_BADGE(pos.side)}>{pos.side}</span>
                    </td>
                    <td className={`${cell} text-muted`}>{formatPriceAsServed(pos.sizeLots)}</td>
                    <td className={cell}>{pos.entryPrice === undefined ? <span className="text-muted2">unknown</span> : formatPriceAsServed(pos.entryPrice)}</td>
                    <td className={`${cell} text-muted`}>{pos.leverage}×</td>
                    <td className={cell} title={pos.marginAddedAusd > 0 ? `${formatAusd(pos.marginAddedAusd)} added since open` : undefined}>
                      {formatAusd(pos.marginAusd)}
                    </td>
                    <td className={cell}>{a.markPrice === undefined ? '—' : formatPriceAsServed(a.markPrice)}</td>
                    <td className={`${cell} ${a.unrealisedPnlAusd === undefined ? 'text-muted' : a.unrealisedPnlAusd > 0 ? 'text-safe' : a.unrealisedPnlAusd < 0 ? 'text-danger' : ''}`} title={a.pnlPctOfMargin === undefined ? undefined : `${formatSignedPct(a.pnlPctOfMargin)} of margin`}>
                      {a.unrealisedPnlAusd === undefined ? '—' : formatSignedAusd(a.unrealisedPnlAusd)}
                    </td>
                    <td className={cell}>{a.liquidationPrice === undefined ? '—' : formatPriceAsServed(a.liquidationPrice)}</td>
                    <td className={cell} title={a.reason ?? (a.marginToSurviveAusd !== undefined && a.marginToSurviveAusd > 0 ? `needs ${formatAusd(a.marginToSurviveAusd)} AUSD to get back above maintenance` : undefined)}>
                      {a.reason !== undefined ? (
                        <span className="text-[11.5px] text-muted2">not assessed</span>
                      ) : tier === 'past' ? (
                        <b style={{ color: TIER_COLOR.past }}>past liquidation</b>
                      ) : (
                        <b style={{ color: TIER_COLOR[tier] }}>{formatPct(a.liqBufferPct ?? 0)}</b>
                      )}
                    </td>
                  </tr>
                );
              })}
          {rows !== undefined && rows.length === 0 && (
            <tr>
              <td colSpan={POSITION_COLUMNS.length} className="px-[10px] py-6 text-center text-muted">
                No open position.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {rows !== undefined && rows.some((a) => a.reason !== undefined) && (
        <div className="border-t border-border px-[10px] py-2 text-[11.5px] text-muted2">
          {rows
            .filter((a) => a.reason !== undefined)
            .map((a) => `${a.position.market.symbol ?? `market ${a.position.market.marketId}`}: ${a.reason}`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

const TRIP_COLUMNS = ['Closed (UTC)', 'Market', 'Side', 'Size', 'Entry', 'Hold', 'Net PnL', 'Outcome'] as const;

function TripsTable({ rows }: { readonly rows: readonly RoundTrip[] | undefined }) {
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
            {TRIP_COLUMNS.map((label, i) => (
              <th key={label} scope="col" className={`px-[10px] py-[9px] font-semibold whitespace-nowrap ${i < 3 ? 'text-left' : 'text-right'} ${i === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows === undefined
            ? Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  {TRIP_COLUMNS.map((label, j) => (
                    <td key={label} className={`px-[10px] py-[10px] ${j === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                      <Skeleton className={`h-[14px] ${j < 3 ? 'w-[60px]' : 'ml-auto w-[64px]'}`} />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((r, i) => (
                <tr key={`${r.market.marketId}-${r.openedAtMs}-${r.closedAtMs}-${i}`} className="border-b border-border last:border-b-0 hover:bg-card2">
                  <td className="sticky left-0 z-[1] bg-card px-[10px] py-[10px] whitespace-nowrap text-muted" title={`opened ${formatWhen(r.openedAtMs)} UTC`}>
                    {formatWhen(r.closedAtMs)}
                  </td>
                  <td className="px-[10px] py-[10px] font-semibold whitespace-nowrap">{r.market.symbol ?? `market ${r.market.marketId}`}</td>
                  <td className="px-[10px] py-[10px] whitespace-nowrap">
                    <span className={SIDE_BADGE(r.side)}>{r.side}</span>
                  </td>
                  <td className={`${cell} text-muted`}>{formatPriceAsServed(r.sizeLots)}</td>
                  <td className={cell}>{r.entryPrice === undefined ? <span className="text-muted2">unknown</span> : formatPriceAsServed(r.entryPrice)}</td>
                  <td className={`${cell} text-muted`}>{formatDuration(r.holdMs)}</td>
                  <td className={`${cell} ${r.netPnlAusd > 0 ? 'text-safe' : r.netPnlAusd < 0 ? 'text-danger' : ''}`}>{formatSignedAusd(r.netPnlAusd)}</td>
                  <td className={cell}>
                    {r.wasForcedExit ? (
                      <span className="rounded-[6px] bg-danger/15 px-[7px] py-[2px] text-[11px] font-bold text-danger">forced</span>
                    ) : r.isWin ? (
                      <span className="rounded-[6px] bg-safe/15 px-[7px] py-[2px] text-[11px] font-bold text-safe">win</span>
                    ) : (
                      <span className="rounded-[6px] bg-card2 px-[7px] py-[2px] text-[11px] font-bold text-muted">loss</span>
                    )}
                  </td>
                </tr>
              ))}
          {rows !== undefined && rows.length === 0 && (
            <tr>
              <td colSpan={TRIP_COLUMNS.length} className="px-[10px] py-6 text-center text-muted">
                No completed round trip yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
