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
import { usePoll } from '@/lib/usePoll.ts';
import { bufferTier, cumulativePnl, parseWalletQuery } from '@/lib/wallets.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';

const POLL_MS = 30_000;

export function WalletView({ query }: { readonly query: string }) {
  const parsed = useMemo(() => parseWalletQuery(query), [query]);

  // One lookup by whatever was typed. An address resolves to a profile or to
  // `not-linked`; an id resolves to a profile or a 404. Both are answers.
  const lookup = usePoll(
    async () => {
      if (parsed.kind === 'address') return api.wallet(parsed.address);
      if (parsed.kind === 'account') {
        const r = await api.account(parsed.accountId);
        return { ...r, data: { kind: 'found' as const, profile: r.data } };
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

  // ── the three non-profile outcomes ───────────────────────────────────────
  if (parsed.kind === 'invalid') {
    return (
      <>
        <PageHeader title="Wallet" thin={query} subtitle="Profile, open positions and round-trip history for an address or account id." />
        <Outcome title="That is not an address or an account id.">
          {parsed.reason}. <Link href="/wallets">Back to search.</Link>
        </Outcome>
      </>
    );
  }
  if (lookup.error instanceof ApiError && lookup.error.status === 404) {
    return (
      <>
        <PageHeader title="Account" thin={`#${query}`} subtitle="Profile, open positions and round-trip history for this account." />
        <Outcome title={`No account ${query} in the index.`}>
          An account id either exists in the index or it does not. <Link href="/wallets">Back to search.</Link>
        </Outcome>
      </>
    );
  }
  if (lookup.data?.data.kind === 'not-linked') {
    return (
      <>
        <PageHeader title="Wallet" thin={shortAddress(lookup.data.data.address)} subtitle="Profile, open positions and round-trip history for this address." />
        <StaleMarker envelope={lookup.data} />
        <Outcome title="This address is not linked to an account in the index.">
          {lookup.data.data.reason} If you know the account id, search for that instead: it resolves even when the owner was never recorded.
        </Outcome>
      </>
    );
  }

  // ── the profile ──────────────────────────────────────────────────────────
  const p = found;
  const heading = p === undefined ? (parsed.kind === 'address' ? shortAddress(parsed.address) : `#${parsed.accountId}`) : p.address === '' ? `#${p.accountId}` : shortAddress(p.address);
  const curve = trips.data === undefined ? undefined : cumulativePnl(trips.data.data);
  const rows = trips.data?.data;

  return (
    <>
      <PageHeader
        title={p === undefined || p.address === '' ? 'Account' : 'Wallet'}
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
              {' · '}last active {formatAge(Date.now() - p.lastActiveAtMs)} ago · {formatCount(p.performance.roundTrips)} round trips
            </>
          )
        }
      />

      <StaleMarker envelope={lookup.data} />
      <ErrorNote error={lookup.error} what="Wallet profile" />

      {/* ── three tiles ─────────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {p === undefined ? (
          Array.from({ length: 3 }, (_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <StatTile
              label="Volume · all time"
              value={formatCompact(p.volumeAusd)}
              exact={`${formatAusdExact(p.volumeAusd)} AUSD notional`}
              secondary={`${formatCount(p.tradeCount)} trades · ${formatCount(p.performance.roundTrips)} round trips`}
              sparklineNote="all time: the profile is not windowed"
            />
            <StatTile
              label="Net PnL · all time"
              value={formatSignedAusd(p.netPnlAusd, 0)}
              exact={`${formatSignedAusd(p.netPnlAusd)} AUSD = realised ${formatSignedAusd(p.realisedPnlAusd)} + funding ${formatSignedAusd(p.fundingAusd)} − fees ${formatAusd(p.feesPaidAusd)}`}
              valueColor={p.netPnlAusd > 0 ? COLORS.safe : p.netPnlAusd < 0 ? COLORS.danger : undefined}
              secondary={
                <>
                  <div>
                    realised {formatSignedAusd(p.realisedPnlAusd, 0)} · funding {formatSignedAusd(p.fundingAusd, 0)} · fees {formatAusd(p.feesPaidAusd, 0)}
                  </div>
                  <div>
                    win rate {p.performance.winRate === undefined ? '—' : formatPct(p.performance.winRate)} per round trip
                    {curve !== undefined && curve.length >= 2 && ` · curve: the last ${formatCount(curve.length)} round trips`}
                  </div>
                </>
              }
              sparkline={curve !== undefined && curve.length >= 2 ? curve : undefined}
              sparklineColor={curve !== undefined && (curve.at(-1) ?? 0) < 0 ? COLORS.danger : COLORS.safe}
              sparklineNote={curve === undefined ? 'loading the last round trips' : `last ${formatCount(curve.length)} round trip${curve.length === 1 ? '' : 's'}: not enough for a curve`}
            />
            <StatTile
              label="Liquidations · all time"
              value={formatCount(p.rescues.count)}
              exact={`${formatCount(p.rescues.count)} forced exits, ${formatCount(p.rescues.judgeableCount)} judgeable`}
              secondary={
                <>
                  <div>
                    <b className="font-semibold text-watch">{formatCount(p.rescues.rescuableCount)} rescuable</b>
                    {p.rescues.judgeableCount > 0 && ` · ${formatPct(p.rescues.rate ?? 0, 0)} of ${formatCount(p.rescues.judgeableCount)} judgeable`}
                    {p.rescues.unknownCount > 0 && ` · ${formatCount(p.rescues.unknownCount)} unjudgeable`}
                  </div>
                  <div>
                    {p.rescues.medianSpareBalanceAusd === undefined
                      ? 'no rescuable case to take a median over'
                      : `median ${formatAusd(p.rescues.medianSpareBalanceAusd)} AUSD sitting free at the time`}
                  </div>
                </>
              }
              sparklineNote="spare balance that isolated margin never reached for"
            />
          </>
        )}
      </section>

      {/* ── performance strip ───────────────────────────────────────────── */}
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
  const cells: readonly { readonly label: string; readonly value: string; readonly color?: string | undefined; readonly title?: string | undefined }[] = [
    { label: 'Win rate', value: perf.winRate === undefined ? '—' : formatPct(perf.winRate), title: `${formatCount(perf.wins)} wins · ${formatCount(perf.losses)} losses` },
    { label: 'Profit factor', value: perf.profitFactor === undefined ? (perf.losses === 0 && perf.wins > 0 ? 'no losses' : '—') : perf.profitFactor.toFixed(3), title: 'gross profit over gross loss' },
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
    <section className="card mb-4 grid grid-cols-2 gap-x-4 gap-y-3 px-[18px] py-[14px] sm:grid-cols-4 lg:grid-cols-8">
      {cells.map((c) => (
        <div key={c.label} title={c.title}>
          <div className="text-[11px] font-medium tracking-[0.02em] text-muted uppercase">{c.label}</div>
          <div className="num mt-[2px] text-[15px] font-bold tracking-[-0.01em]" style={c.color === undefined ? undefined : { color: c.color }}>
            {c.value}
          </div>
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
