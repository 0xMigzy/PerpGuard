'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { DirectionalExposure, ExposedPosition, MarketExposure, RiskSnapshot } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAge, formatAusd, formatAusdExact, formatCompact, formatCount, formatPct, formatPriceAsServed, formatSignedAusd, formatWhen } from '@/lib/format.ts';
import { chartRungs, directionWord, exposedAt, formatMove, ladderFor, marketLabel, rungAt, sideExposed, wholeDays } from '@/lib/risk.ts';
import { COLORS } from '@/lib/theme.ts';
import { bufferTier } from '@/lib/traders.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { StatTile, StatTileSkeleton } from '@/components/StatTile.tsx';
import { LadderChart } from '@/components/charts/LadderChart.tsx';

const POLL_MS = 30_000;
const DEFAULT_MOVE = -0.1;
const LARGEST = 10;
const TIER_COLOR = { past: COLORS.danger, danger: COLORS.danger, watch: COLORS.watch, safe: COLORS.safe, unknown: COLORS.muted } as const;

/**
 * Risk is a POINT-IN-TIME SNAPSHOT: contract state at one block, so it has no
 * timeframe control and the header carries the block instead. Every figure on
 * the page reads ONE ladder the backend computed: the tiles are its ±5% and
 * ±10% rungs, the slider walks it, the by-market table is the same rungs per
 * market. Nothing here executes anything and nothing here is an account view.
 *
 * ONE DIRECTION PER FIGURE. A fall closes longs, a rise closes shorts, and no
 * single move does both, so every count, notional, share and shortfall here
 * belongs to one signed move. Shares are of ONE-SIDED open interest. Insurance
 * is compared per market only: a fund pays for its own market.
 */
export function RiskView() {
  const poll = usePoll(api.risk, POLL_MS, 'risk');
  const s = poll.data?.data;
  const [marketId, setMarketId] = useState<number | undefined>(undefined);
  const [move, setMove] = useState(DEFAULT_MOVE);

  const scope = useMemo(() => (s === undefined ? undefined : ladderFor(s, marketId)), [s, marketId]);
  const rung = scope === undefined || s === undefined ? undefined : rungAt(scope.ladder, s.moves, move);
  const rows = useMemo(() => (s === undefined ? [] : exposedAt(s.positions, move, marketId)), [s, move, marketId]);
  const chart = useMemo(() => (scope === undefined || s === undefined ? undefined : chartRungs(scope.ladder, s.moves)), [scope, s]);
  const shockedMark = marketId === undefined ? undefined : s?.markets.find((m) => m.market.marketId === marketId)?.markPrice;
  const at5 = s?.atRisk['0.050'];
  const at10 = s?.atRisk['0.100'];
  const backstop = s?.backstop;
  const backstopDays = backstop?.sinceMs === undefined || s === undefined ? undefined : wholeDays(backstop.sinceMs, s.asOf.indexerBlockAtMs ?? s.asOf.generatedAtMs);
  const side = sideExposed(move);

  return (
    <>
      <PageHeader
        title="Risk"
        subtitle="Liquidation exposure of every open position, from contract state at the latest indexed block."
        right={
          <>
            <span className="chip">{s?.asOf.indexerBlock === undefined ? 'Contract state at block …' : `Contract state at block ${formatCount(s.asOf.indexerBlock)}`}</span>
            {s?.asOf.indexerBlockAtMs !== undefined && (
              <span className="chip" title={new Date(s.asOf.indexerBlockAtMs).toISOString()}>
                block time {formatWhen(s.asOf.indexerBlockAtMs)} UTC
              </span>
            )}
          </>
        }
      />

      <StaleMarker envelope={poll.data} />
      <ErrorNote error={poll.error} what="The risk snapshot" />

      {/* ── eight tiles: open interest, each direction on its own, the backstop ── */}
      <section className="mb-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {s === undefined || at5 === undefined || at10 === undefined ? (
          Array.from({ length: 8 }, (_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <StatTile
              label="Open interest · now"
              value={formatCompact(s.totals.openInterestAusd)}
              exact={`${formatAusdExact(s.totals.openInterestAusd)} AUSD at the venue's marks, one side: every long is matched by a short`}
              secondary={
                <>
                  <div>{formatCount(s.counted.priced)} open positions across {formatCount(s.counted.markets)} markets</div>
                  <div>Total position value, both sides: {formatCompact(s.totals.notionalAusd)}</div>
                </>
              }
              sparklineNote={`margin ${formatCompact(s.totals.marginAusd)}: long ${formatCompact(s.totals.longMarginAusd)} · short ${formatCompact(s.totals.shortMarginAusd)}`}
            />
            <DirectionTile d={at10.fall} />
            <DirectionTile d={at10.rise} />
            <StatTile
              label="Losses beyond collateral · 10%"
              value={formatCompact(at10.worse.shortfallAusd)}
              exact={`${formatAusdExact(at10.worse.shortfallAusd)} AUSD of equity below zero at the shocked mark, if every market ${directionWord(at10.worse.move)} 10%`}
              valueColor={at10.worse.shortfallAusd > 0 ? COLORS.danger : undefined}
              secondary={
                <>
                  <div>worst case if every market {directionWord(at10.worse.move)} 10%</div>
                  <div>
                    {at10.worse.shortfallPositions === 0
                      ? 'no position loses more than its own collateral'
                      : `${formatCount(at10.worse.shortfallPositions)} ${at10.worse.shortfallPositions === 1 ? 'position loses more than its' : 'positions lose more than their'} own collateral`}
                  </div>
                </>
              }
              sparklineNote="one direction: a fall and a rise are never added"
            />
            <DirectionTile d={at5.fall} />
            <DirectionTile d={at5.rise} />
            <StatTile
              label="Insurance funds"
              value={s.insurance.totalAusd === undefined ? 'unknown' : formatCompact(s.insurance.totalAusd)}
              exact={s.insurance.totalAusd === undefined ? undefined : `${formatAusdExact(s.insurance.totalAusd)} AUSD, ${formatCount(s.insurance.marketsWithReading)} per-market balances read off the Exchange contract and added together`}
              secondary={
                <>
                  <div>held across {formatCount(s.insurance.marketsWithReading)} markets{s.insurance.marketsWithout === 0 ? '' : ` · ${formatCount(s.insurance.marketsWithout)} without a reading`}</div>
                  <div>
                    {backstop === undefined
                      ? 'draw history not read'
                      : backstop.insuranceCredits === 0 && backstop.badDebtLiquidations === 0
                        ? `never drawn on: 0 insurance credits, 0 bad debt${backstopDays === undefined ? '' : ` in ${formatCount(backstopDays)} days`}*`
                        : `drawn on: ${formatCount(backstop.insuranceCredits)} insurance credits, ${formatCount(backstop.badDebtLiquidations)} with bad debt*`}
                  </div>
                </>
              }
              sparklineNote={s.asOf.insuranceAtMs === undefined ? 'no reading' : `each fund pays only for its own market · as of ${formatAge(Date.now() - s.asOf.insuranceAtMs)} ago`}
            />
            <StatTile
              label="Weakest cover · 10%"
              value={s.weakestCover === undefined ? '—' : `${marketName(s.weakestCover.market)} ${s.weakestCover.cover.toFixed(1)}×`}
              valueColor={s.weakestCover === undefined ? undefined : s.weakestCover.cover < 10 ? COLORS.danger : s.weakestCover.cover < 50 ? COLORS.watch : COLORS.safe}
              exact={
                s.weakestCover === undefined
                  ? undefined
                  : `${marketName(s.weakestCover.market)} insurance ÷ ${formatAusdExact(s.weakestCover.shortfallAusd)} AUSD of losses beyond collateral if it ${directionWord(s.weakestCover.direction === 'fall' ? -1 : 1)} 10%`
              }
              secondary={
                s.weakestCover === undefined
                  ? 'no market has losses beyond collateral at 10%, so there is nothing to cover'
                  : `its fund ÷ its losses beyond collateral if ${marketName(s.weakestCover.market)} ${directionWord(s.weakestCover.direction === 'fall' ? -1 : 1)} 10%`
              }
              sparklineNote="each market against its own worse direction; funds are not pooled"
            />
          </>
        )}
      </section>
      <p className="mt-0 mb-4 text-[11.5px] text-muted2">
        * From our indexer&rsquo;s record of insurance-credit and bad-debt events, not an independent chain read: a direct count from the chain was rate-limited.
      </p>

      {s !== undefined && s.counted.priced === 0 && (
        <div className="card mb-4 px-[18px] py-6 text-center">
          <div className="text-[15px] font-semibold text-text">No open position can be priced right now.</div>
          <div className="mt-1 text-[12.5px] text-muted">
            {s.counted.positions === 0 ? 'The index holds no open position.' : `${formatCount(s.counted.positions)} are open; none has a mark, a margin config and a known entry.`}
            {' '}The ladder below is empty by construction, not by error.
          </div>
        </div>
      )}

      {/* ── stress test and ladder ──────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-center justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Stress test</h2>
            <MarketPills markets={s?.markets} selected={marketId} onSelect={setMarketId} />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="num text-[11.5px] text-muted2">−50%</span>
            <input
              type="range"
              min={-50}
              max={50}
              step={0.5}
              value={Math.round(move * 1000) / 10}
              onChange={(e) => setMove(Number(e.target.value) / 100)}
              aria-label="Price shock"
              className="min-w-0 flex-1"
              style={{ accentColor: COLORS.accent }}
            />
            <span className="num text-[11.5px] text-muted2">+50%</span>
          </div>
          <div className="mt-[10px] text-center text-[13px]">
            Mark moves <b className={`num ${move < 0 ? 'text-danger' : move > 0 ? 'text-safe' : 'text-muted'}`}>{formatMove(move)}</b>
            {shockedMark !== undefined && (
              <>
                {' '}to <b className="num">{formatPriceAsServed(shockedMark * (1 + move))}</b>
              </>
            )}
            {marketId === undefined && <span className="text-muted"> · every market together</span>}
          </div>
          {rung === undefined || scope === undefined ? (
            <Skeleton className="mt-4 h-[120px] w-full" />
          ) : (
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-[9px] text-[12.5px] sm:grid-cols-[auto_1fr_auto_1fr]">
              <dt className="text-muted">Positions exposed</dt>
              <dd className="num m-0 text-right">{formatCount(rung.positions)}</dd>
              <dt className="text-muted">Notional exposed</dt>
              <dd className="num m-0 text-right">{formatCompact(rung.notionalAusd)}</dd>
              <dt className="text-muted">Share of open interest</dt>
              <dd className="num m-0 text-right">{scope.openInterestAusd > 0 ? formatPct(rung.notionalAusd / scope.openInterestAusd) : '—'}</dd>
              <dt className="text-muted">Side exposed</dt>
              <dd className="m-0 text-right">
                <span className={`rounded-[4px] px-[6px] py-[2px] text-[10px] font-semibold tracking-[0.05em] uppercase ${side === 'long' ? 'bg-safe/12 text-safe' : side === 'short' ? 'bg-danger/12 text-danger' : 'bg-card2 text-muted'}`}>
                  {side === 'both' ? 'already past' : side}
                </span>
              </dd>
              <dt className="text-muted">Losses beyond collateral</dt>
              <dd className={`num m-0 text-right ${rung.shortfallAusd > 0 ? 'text-danger' : ''}`} title={`${formatCount(rung.shortfallPositions)} positions`}>{formatCompact(rung.shortfallAusd)}</dd>
              <dt className="text-muted">Insurance covers</dt>
              <dd className="num m-0 text-right">
                {marketId === undefined ? (
                  <span className="text-muted2">per market only</span>
                ) : scope.insuranceAusd === undefined ? (
                  <span className="text-muted2">no reading</span>
                ) : rung.shortfallAusd === 0 ? (
                  <span className="text-muted2">nothing to cover</span>
                ) : (
                  <span className={scope.insuranceAusd / rung.shortfallAusd < 10 ? 'text-danger' : 'text-safe'}>{(scope.insuranceAusd / rung.shortfallAusd).toFixed(1)}×</span>
                )}
              </dd>
            </dl>
          )}
          <div className="mt-4 space-y-[6px] text-[11.5px] text-muted2">
            {(s?.statements ?? []).map((line) => (
              <p key={line} className="m-0 max-w-[70ch]">{line}</p>
            ))}
          </div>
        </div>

        <div className="card px-[18px] py-4">
          <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Liquidation ladder</h2>
            <span className="text-[12.5px] text-muted">{scope?.label ?? '…'} · notional exposed at each move</span>
          </div>
          <div className="mb-2 flex flex-wrap gap-[14px] text-[12px] text-muted">
            <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-full align-[-1px]" style={{ background: COLORS.safe }} />Longs (price down)</span>
            <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-full align-[-1px]" style={{ background: COLORS.danger }} />Shorts (price up)</span>
          </div>
          {chart === undefined ? <Skeleton className="h-[340px] w-full" /> : <LadderChart rungs={chart} />}
        </div>
      </section>

      {/* ── largest exposed ─────────────────────────────────────────────── */}
      <section className="mb-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Largest positions exposed</h2>
          <span className="text-[12.5px] text-muted">
            {scope?.label ?? '…'} at {formatMove(move)} · {rows.length === 0 ? 'none' : `${formatCount(Math.min(LARGEST, rows.length))} largest of ${formatCount(rows.length)}`}
          </span>
        </div>
        <ExposedTable rows={rows.slice(0, LARGEST)} loading={s === undefined} move={move} scopeLabel={scope?.label ?? ''} />
      </section>

      {/* ── by market ───────────────────────────────────────────────────── */}
      <section className="mb-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">By market</h2>
          <span className="text-[12.5px] text-muted">A fall (longs) and a rise (shorts) side by side, never added. Losses and cover use each market&rsquo;s worse direction at 10%.</span>
        </div>
        <MarketsTable markets={s?.markets} onSelect={setMarketId} selected={marketId} />
      </section>

      <div className="flex gap-[10px] rounded-[10px] border border-watch/30 bg-watch/8 px-[14px] py-3 text-[12.5px] text-[#E8D7B0]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={COLORS.watch} strokeWidth="2.2" aria-hidden="true" className="mt-[2px] flex-none">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5v.01" />
        </svg>
        <div>
          Shows what&rsquo;s at risk, not what will be lost. Liquidated positions need buyers. With few buyers they sell lower, deepening losses. We can&rsquo;t see the live order
          book, so that isn&rsquo;t modelled.
        </div>
      </div>

      {s !== undefined && s.counted.unpriced > 0 && (
        <div className="mt-3 text-[11.5px] text-muted2">
          {formatCount(s.counted.unpriced)} of {formatCount(s.counted.positions)} open positions are not in these figures:{' '}
          {Object.entries(s.counted.unpricedReasons).map(([reason, n]) => `${formatCount(n)} because ${reason}`).join('; ')}. Marks as of{' '}
          {s.asOf.marksAtMs === undefined ? 'unknown' : `${formatAge(Date.now() - s.asOf.marksAtMs)} ago`}.
        </div>
      )}
    </>
  );
}

function MarketPills({ markets, selected, onSelect }: { readonly markets: readonly MarketExposure[] | undefined; readonly selected: number | undefined; readonly onSelect: (id: number | undefined) => void }) {
  const pill = (active: boolean) => `pill rounded-[6px] border px-[9px] py-[4px] text-[11.5px] ${active ? 'border-border2 bg-card2 text-text' : 'border-transparent bg-transparent text-muted hover:text-text'}`;
  return (
    <div className="flex flex-wrap gap-[3px]" role="group" aria-label="Market">
      <button type="button" className={pill(selected === undefined)} aria-pressed={selected === undefined} onClick={() => onSelect(undefined)}>
        All
      </button>
      {(markets ?? []).map((m) => (
        <button key={m.market.marketId} type="button" className={pill(selected === m.market.marketId)} aria-pressed={selected === m.market.marketId} onClick={() => onSelect(m.market.marketId)}>
          {marketLabel(m)}
        </button>
      ))}
    </div>
  );
}

const EXPOSED_COLUMNS = ['Trader', 'Market', 'Side', 'Notional', 'Leverage', 'Liq. price', 'Liq. distance', 'uPnL'] as const;

function ExposedTable({ rows, loading, move, scopeLabel }: { readonly rows: readonly ExposedPosition[]; readonly loading: boolean; readonly move: number; readonly scopeLabel: string }) {
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
            {EXPOSED_COLUMNS.map((label, i) => (
              <th key={label} scope="col" className={`px-[10px] py-[9px] font-semibold whitespace-nowrap ${i < 3 ? 'text-left' : 'text-right'} ${i === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 5 }, (_, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  {EXPOSED_COLUMNS.map((label, j) => (
                    <td key={label} className={`px-[10px] py-[10px] ${j === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                      <Skeleton className={`h-[14px] ${j < 3 ? 'w-[70px]' : 'ml-auto w-[64px]'}`} />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((p) => {
                const tier = bufferTier(p.liqBufferPct);
                return (
                  <tr key={`${p.accountId}-${p.market.marketId}-${p.openedAtMs}`} className="border-b border-border last:border-b-0 hover:bg-card2">
                    <td className="sticky left-0 z-[1] bg-card px-[10px] py-[10px] whitespace-nowrap">
                      <Link href={`/traders/${p.accountId}`} className="num font-semibold text-text no-underline hover:text-accent-hi">
                        #{p.accountId}
                      </Link>
                    </td>
                    <td className="px-[10px] py-[10px] font-semibold whitespace-nowrap">{p.market.symbol ?? `market ${p.market.marketId}`}</td>
                    <td className="px-[10px] py-[10px] whitespace-nowrap">
                      <span className={`rounded-[4px] px-[6px] py-[2px] text-[10px] font-semibold tracking-[0.05em] uppercase ${p.side === 'long' ? 'bg-safe/12 text-safe' : 'bg-danger/12 text-danger'}`}>{p.side}</span>
                    </td>
                    <td className={cell} title={`${formatPriceAsServed(p.sizeLots)} ${p.market.symbol ?? ''} · margin ${formatAusd(p.marginAusd)} AUSD`}>{formatCompact(p.notionalAusd)}</td>
                    <td className={`${cell} text-muted`}>{p.leverage.toFixed(1)}×</td>
                    <td className={cell}>{p.liquidationPrice === undefined ? '—' : formatPriceAsServed(p.liquidationPrice)}</td>
                    <td className={cell}>
                      {tier === 'past' ? <b style={{ color: TIER_COLOR.past }}>past liquidation</b> : <b style={{ color: TIER_COLOR[tier] }}>{p.liqBufferPct === undefined ? '—' : formatPct(p.liqBufferPct)}</b>}
                    </td>
                    <td className={`${cell} ${p.unrealisedPnlAusd > 0 ? 'text-safe' : p.unrealisedPnlAusd < 0 ? 'text-danger' : ''}`}>{formatSignedAusd(p.unrealisedPnlAusd, 0)}</td>
                  </tr>
                );
              })}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={EXPOSED_COLUMNS.length} className="px-[10px] py-8 text-center text-muted">
                <div className="text-[14px] font-semibold text-text">No position is liquidated by a {formatMove(move)} move in {scopeLabel}.</div>
                <div className="mt-1 text-[12.5px]">Drag the slider further, or pick another market. Liq. distance is signed: a negative one is already past liquidation.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const MARKET_COLUMNS = ['Market', 'Open interest', 'Positions', 'At risk 5%', 'At risk 10%', 'Beyond collateral 10%', 'Insurance', 'Cover', 'Top 5 share', 'Maint. margin'] as const;

function MarketsTable({ markets, selected, onSelect }: { readonly markets: readonly MarketExposure[] | undefined; readonly selected: number | undefined; readonly onSelect: (id: number) => void }) {
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  return (
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
            {MARKET_COLUMNS.map((label, i) => (
              <th key={label} scope="col" className={`px-[10px] py-[9px] font-semibold whitespace-nowrap ${i === 0 ? 'sticky left-0 z-[1] bg-card text-left' : 'text-right'}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {markets === undefined
            ? Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  {MARKET_COLUMNS.map((label, j) => (
                    <td key={label} className={`px-[10px] py-[10px] ${j === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                      <Skeleton className={`h-[14px] ${j === 0 ? 'w-[50px]' : 'ml-auto w-[64px]'}`} />
                    </td>
                  ))}
                </tr>
              ))
            : [...markets]
                .sort((a, b) => b.openInterestAusd - a.openInterestAusd)
                .map((m) => {
                  const five = m.atRisk['0.050']!;
                  const ten = m.atRisk['0.100']!;
                  const active = selected === m.market.marketId;
                  return (
                    <tr key={m.market.marketId} className={`cursor-pointer border-b border-border last:border-b-0 hover:bg-card2 ${active ? 'bg-card2' : ''}`} onClick={() => onSelect(m.market.marketId)} title="Show this market in the stress test">
                      <td className={`sticky left-0 z-[1] px-[10px] py-[10px] font-semibold whitespace-nowrap ${active ? 'bg-card2' : 'bg-card'}`}>{marketLabel(m)}</td>
                      <td className={cell} title={`one side · total position value, both sides ${formatCompact(m.notionalAusd)} · margin long ${formatCompact(m.longMarginAusd)} · short ${formatCompact(m.shortMarginAusd)} · mark ${formatPriceAsServed(m.markPrice)}`}>{formatCompact(m.openInterestAusd)}</td>
                      <td className={cell}>
                        {formatCount(m.positions)}
                        <span className="block text-[11px] text-muted2">{formatCount(m.longs)}L · {formatCount(m.shorts)}S</span>
                      </td>
                      <td className={cell}>
                        <SplitCell d={five.fall} />
                        <SplitCell d={five.rise} />
                      </td>
                      <td className={cell}>
                        <SplitCell d={ten.fall} />
                        <SplitCell d={ten.rise} />
                      </td>
                      <td className={`${cell} ${m.cover10.shortfallAusd > 0 ? 'text-danger' : 'text-muted'}`} title={`${formatCount(ten.worse.shortfallPositions)} positions lose more than their own collateral`}>
                        {formatCompact(m.cover10.shortfallAusd)}
                        {m.cover10.shortfallAusd > 0 && <span className="block text-[11px] text-muted2">if it {m.cover10.direction === 'fall' ? 'falls' : 'rises'}</span>}
                      </td>
                      <td className={cell} title={m.insuranceReason}>{m.insuranceAusd === undefined ? <span className="text-muted2">no reading</span> : formatCompact(m.insuranceAusd)}</td>
                      <td className={cell}>
                        {m.cover10.cover === undefined ? (
                          <span className="text-muted2" title={m.cover10.shortfallAusd === 0 ? 'no losses beyond collateral at 10%' : 'no insurance reading'}>{m.cover10.shortfallAusd === 0 ? 'none needed' : '—'}</span>
                        ) : (
                          <span className={m.cover10.cover < 10 ? 'text-danger' : m.cover10.cover < 50 ? 'text-watch' : 'text-safe'} title={`against the ${m.cover10.direction}`}>{m.cover10.cover.toFixed(1)}×</span>
                        )}
                      </td>
                      <td className={`${cell} ${m.topFiveShare !== undefined && m.topFiveShare > 0.7 ? 'text-watch' : ''}`}>{m.topFiveShare === undefined ? '—' : formatPct(m.topFiveShare, 0)}</td>
                      <td className={`${cell} text-muted`}>{formatPct(m.maintenanceMarginRatio, 2)}</td>
                    </tr>
                  );
                })}
          {markets !== undefined && markets.length === 0 && (
            <tr>
              <td colSpan={MARKET_COLUMNS.length} className="px-[10px] py-6 text-center text-muted">No market has a priced open position.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function marketName(market: MarketExposure['market']): string {
  return market.symbol ?? `market ${market.marketId}`;
}

/**
 * One direction as a tile: a fall closes longs, a rise closes shorts, and the
 * tile says which in words. Never a sum of the two.
 */
function DirectionTile({ d }: { readonly d: DirectionalExposure }) {
  const size = `${Math.round(Math.abs(d.move) * 100)}%`;
  const fall = d.move < 0;
  return (
    <StatTile
      label={`If prices ${fall ? 'fall' : 'rise'} ${size}`}
      value={formatCompact(d.notionalAusd)}
      exact={`${formatAusdExact(d.notionalAusd)} AUSD of ${fall ? 'long' : 'short'} positions liquidated, at today's marks`}
      secondary={
        <>
          <div>
            {formatCount(d.positions)} positions · {d.shareOfOpenInterest === undefined ? 'no open interest' : `${formatPct(d.shareOfOpenInterest)} of open interest`}
          </div>
          <div>{fall ? 'a fall closes longs' : 'a rise closes shorts'}</div>
        </>
      }
      sparklineNote={
        d.shortfallPositions === 0
          ? 'none loses more than its own collateral'
          : `${formatCount(d.shortfallPositions)} ${d.shortfallPositions === 1 ? 'loses' : 'lose'} more than ${d.shortfallPositions === 1 ? 'its' : 'their'} own collateral: ${formatCompact(d.shortfallAusd)}`
      }
    />
  );
}

/** One direction inside a table cell: "fall 191.4K" over "rise 64.6K". */
function SplitCell({ d }: { readonly d: DirectionalExposure }) {
  const fall = d.move < 0;
  return (
    <span className="block" title={`${formatCount(d.positions)} ${fall ? 'longs' : 'shorts'}`}>
      <span className="mr-1 text-[10.5px] text-muted2">{fall ? 'fall' : 'rise'}</span>
      {formatCompact(d.notionalAusd)}
    </span>
  );
}
