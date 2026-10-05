'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import type { DirectionalExposure, ExposedPosition, MarketExposure } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAge, formatAusd, formatAusdExact, formatCompact, formatCount, formatPct, formatPriceAsServed, formatSignedAusd, formatWhen } from '@/lib/format.ts';
import { chartRungs, exposedAt, formatMove, ladderFor, marketLabel, rungAt, sideExposed } from '@/lib/risk.ts';
import { COLORS } from '@/lib/theme.ts';
import { bufferTier } from '@/lib/traders.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { LADDER_COLORS, LadderChart } from '@/components/charts/LadderChart.tsx';
import { MarketName, TokenIcon } from '@/components/TokenIcon.tsx';
import { InfoTip, PANEL, RiskKpis } from './RiskKpis.tsx';

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
  const side = sideExposed(move);
  const selectedSymbol = marketId === undefined ? undefined : (s?.markets.find((m) => m.market.marketId === marketId)?.market.symbol ?? `market ${marketId}`);

  return (
    <>
      <PageHeader
        title="Risk"
        subtitle="Liquidation exposure of every open position, from contract state at the latest indexed block."
        right={
          <div className="flex flex-wrap items-center gap-x-[14px] gap-y-1 text-[11.5px] text-muted2">
            <span>
              Contract state at block <span className="num text-muted">{s?.asOf.indexerBlock === undefined ? '…' : formatCount(s.asOf.indexerBlock)}</span>
            </span>
            {s?.asOf.indexerBlockAtMs !== undefined && (
              <span title={new Date(s.asOf.indexerBlockAtMs).toISOString()}>
                Block time <span className="num text-muted">{formatWhen(s.asOf.indexerBlockAtMs)} UTC</span>
              </span>
            )}
          </div>
        }
      />

      <StaleMarker envelope={poll.data} />
      <ErrorNote error={poll.error} what="The risk snapshot" />

      <RiskKpis s={s} />

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
      <section className="mb-5 grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
        <div className={`${PANEL} px-[18px] py-4`}>
          <div className="flex flex-wrap items-center justify-between gap-[10px]">
            <h2 className="m-0 flex items-center gap-2 text-[15px] font-bold tracking-[-0.01em]">
              Stress test
              <InfoTip align="left" text={(s?.statements ?? []).join(' ')} />
            </h2>
          </div>
          <div className="mt-3">
            <MarketPills markets={s?.markets} selected={marketId} onSelect={setMarketId} />
          </div>
          <div className="mt-4 flex items-center gap-3">
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
          <div className="mt-[10px] text-center text-[13px] text-muted">
            Mark {move < 0 ? 'falls' : move > 0 ? 'rises' : 'moves'} <b className="num text-[15px] text-text">{formatMove(move)}</b>
            {shockedMark !== undefined && (
              <>
                {' '}to <b className="num text-text">{formatPriceAsServed(shockedMark * (1 + move))}</b>
              </>
            )}
            {marketId === undefined && <span> · every market together</span>}
          </div>
          {rung === undefined || scope === undefined ? (
            <Skeleton className="mt-4 h-[120px] w-full" />
          ) : (
            <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-border bg-border sm:grid-cols-3">
              <Stat label="Positions exposed" value={formatCount(rung.positions)} />
              <Stat label="Notional exposed" value={formatCompact(rung.notionalAusd)} />
              <Stat label="Share of open interest" value={scope.openInterestAusd > 0 ? formatPct(rung.notionalAusd / scope.openInterestAusd) : '—'} />
              <Stat
                label="Side exposed"
                value={
                  <span className={`rounded-[4px] px-[6px] py-[2px] text-[10.5px] font-semibold tracking-[0.05em] uppercase ${side === 'long' ? 'bg-safe/12 text-safe' : side === 'short' ? 'bg-danger/12 text-danger' : 'bg-card2 text-muted'}`}>
                    {side === 'both' ? 'already past' : side}
                  </span>
                }
              />
              <Stat
                label="Losses beyond collateral"
                value={<span className={rung.shortfallAusd > 0 ? 'text-danger' : ''}>{formatCompact(rung.shortfallAusd)}</span>}
                title={`${formatCount(rung.shortfallPositions)} positions past their own collateral`}
              />
              <Stat
                label="Insurance covers"
                value={
                  marketId === undefined ? (
                    <span className="text-[12px] font-medium text-muted2">per market only</span>
                  ) : scope.insuranceAusd === undefined ? (
                    <span className="text-[12px] font-medium text-muted2">no reading</span>
                  ) : rung.shortfallAusd === 0 ? (
                    <span className="text-[12px] font-medium text-muted2">nothing to cover</span>
                  ) : (
                    <span className={scope.insuranceAusd / rung.shortfallAusd < 10 ? 'text-danger' : 'text-safe'}>{(scope.insuranceAusd / rung.shortfallAusd).toFixed(1)}×</span>
                  )
                }
              />
            </dl>
          )}
        </div>

        <div className={`${PANEL} px-[18px] py-4`}>
          <div className="flex flex-wrap items-center justify-between gap-[10px]">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Liquidation ladder</h2>
            <span className="text-[13px] font-semibold text-text">{selectedSymbol === undefined ? 'All markets' : <MarketName symbol={selectedSymbol} size={16} />}</span>
          </div>
          <p className="mt-1 mb-2 text-[12px] text-muted">Where liquidations could occur as prices move: notional exposed at each move size.</p>
          <div className="mb-2 flex flex-wrap gap-[14px] text-[12px] text-muted">
            <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: LADDER_COLORS.longs }} />Longs · price falls</span>
            <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: LADDER_COLORS.shorts }} />Shorts · price rises</span>
          </div>
          {chart === undefined ? <Skeleton className="h-[340px] w-full" /> : <LadderChart rungs={chart} highlightSize={Math.abs(move)} />}
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
      <section className="mb-5">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">By market</h2>
          <span className="text-[12.5px] text-muted">A fall (longs) and a rise (shorts) side by side, never added. Losses and cover use each market&rsquo;s worse direction at 10%.</span>
        </div>
        <MarketsTable markets={s?.markets} onSelect={setMarketId} selected={marketId} />
      </section>

      <div className="flex gap-[10px] rounded-[8px] border border-watch/30 bg-watch/8 px-[14px] py-3 text-[12.5px] text-[#E8D7B0]">
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
  const pill = (active: boolean) =>
    `pill inline-flex items-center gap-[5px] rounded-[6px] border px-[8px] py-[4px] text-[11.5px] font-semibold ${active ? 'border-accent bg-accent/15 text-text' : 'border-border bg-transparent text-muted hover:border-border2 hover:text-text'}`;
  return (
    <div className="flex flex-wrap gap-[3px]" role="group" aria-label="Market">
      <button type="button" className={pill(selected === undefined)} aria-pressed={selected === undefined} onClick={() => onSelect(undefined)}>
        All
      </button>
      {(markets ?? []).map((m) => (
        <button key={m.market.marketId} type="button" className={pill(selected === m.market.marketId)} aria-pressed={selected === m.market.marketId} onClick={() => onSelect(m.market.marketId)}>
          <TokenIcon symbol={marketLabel(m)} size={14} />
          {marketLabel(m)}
        </button>
      ))}
    </div>
  );
}

const EXPOSED_COLUMNS = ['Trader', 'Market', 'Side', 'Notional', 'Leverage', 'Liq. price', 'Distance to liq.', 'uPnL'] as const;

function ExposedTable({ rows, loading, move, scopeLabel }: { readonly rows: readonly ExposedPosition[]; readonly loading: boolean; readonly move: number; readonly scopeLabel: string }) {
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  return (
    <div className={`${PANEL} overflow-x-auto`}>
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
                    <td className="px-[10px] py-[10px] font-semibold whitespace-nowrap">
                      <MarketName symbol={p.market.symbol ?? `market ${p.market.marketId}`} size={16} />
                    </td>
                    <td className="px-[10px] py-[10px] whitespace-nowrap">
                      <span className={`rounded-[4px] px-[6px] py-[2px] text-[10px] font-semibold tracking-[0.05em] uppercase ${p.side === 'long' ? 'bg-safe/12 text-safe' : 'bg-danger/12 text-danger'}`}>{p.side}</span>
                    </td>
                    <td className={cell} title={`${formatPriceAsServed(p.sizeLots)} ${p.market.symbol ?? ''} · margin ${formatAusd(p.marginAusd)} AUSD`}>{formatCompact(p.notionalAusd)}</td>
                    <td className={`${cell} text-muted`}>{p.leverage.toFixed(1)}×</td>
                    <td className={cell}>{p.liquidationPrice === undefined ? '—' : formatPriceAsServed(p.liquidationPrice)}</td>
                    <td className={cell}>
                      {tier === 'past' ? (
                        <b className="text-[13.5px]" style={{ color: TIER_COLOR.past }}>past liquidation</b>
                      ) : (
                        <b className="text-[14px]" style={{ color: TIER_COLOR[tier] }}>{p.liqBufferPct === undefined ? '—' : formatPct(p.liqBufferPct)}</b>
                      )}
                    </td>
                    <td className={`${cell} ${p.unrealisedPnlAusd > 0 ? 'text-safe' : p.unrealisedPnlAusd < 0 ? 'text-danger' : ''}`}>{formatSignedAusd(p.unrealisedPnlAusd, 0)}</td>
                  </tr>
                );
              })}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={EXPOSED_COLUMNS.length} className="px-[10px] py-10 text-center text-muted">
                <div className="mx-auto mb-2 flex h-[28px] w-[28px] items-center justify-center rounded-full border border-border2 text-muted2" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 8h10" /></svg>
                </div>
                <div className="text-[14px] font-semibold text-text">Nothing is liquidated by a {formatMove(move)} move in {scopeLabel}.</div>
                <div className="mx-auto mt-1 max-w-[52ch] text-[12.5px]">Drag the slider further, or pick another market. Distance to liquidation is signed: a negative one is already past it.</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Primary columns first; the advanced ones (from Insurance on) are set back visually, never removed. */
const MARKET_COLUMNS: readonly { readonly label: string; readonly advanced?: boolean; readonly title?: string }[] = [
  { label: 'Market' },
  { label: 'Open interest', title: 'One side, at the mark' },
  { label: 'Positions' },
  { label: 'At risk 5%', title: 'Notional a 5% fall (longs) or a 5% rise (shorts) liquidates, shown separately' },
  { label: 'At risk 10%', title: 'Notional a 10% fall (longs) or a 10% rise (shorts) liquidates, shown separately' },
  { label: 'Beyond collateral 10%', title: "Losses beyond the positions' own collateral in this market's worse direction at 10%" },
  { label: 'Insurance', advanced: true },
  { label: 'Cover', advanced: true, title: "Insurance ÷ losses beyond collateral, this market's worse direction" },
  { label: 'Top 5 share', advanced: true, title: 'Share of total position value held by the five largest positions' },
  { label: 'Maint. margin', advanced: true },
];

/** A table amount: compact from 10K, whole AUSD below, a quiet 0 for nothing. The exact figure is on hover. */
function Amount({ ausd }: { readonly ausd: number }) {
  if (ausd === 0) return <span className="text-muted2">0</span>;
  return <span title={`${formatAusdExact(ausd)} AUSD`}>{Math.abs(ausd) >= 10_000 ? formatCompact(ausd) : formatCount(ausd)}</span>;
}

function MarketsTable({ markets, selected, onSelect }: { readonly markets: readonly MarketExposure[] | undefined; readonly selected: number | undefined; readonly onSelect: (id: number) => void }) {
  const cell = 'num px-[12px] py-[11px] text-right whitespace-nowrap align-top';
  const adv = 'num px-[12px] py-[11px] text-right whitespace-nowrap align-top text-[12.5px] text-muted';
  const firstAdvanced = MARKET_COLUMNS.findIndex((c) => c.advanced === true);
  return (
    <div className={`${PANEL} overflow-x-auto`}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-[11px] tracking-[0.06em] uppercase">
            {MARKET_COLUMNS.map((c, i) => (
              <th
                key={c.label}
                scope="col"
                title={c.title}
                className={`px-[12px] py-[10px] font-semibold whitespace-nowrap ${i === 0 ? 'sticky left-0 z-[1] bg-card text-left' : 'text-right'} ${c.advanced === true ? 'text-muted2' : 'text-muted'} ${i === firstAdvanced ? 'border-l border-border' : ''}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {markets === undefined
            ? Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="border-b border-border last:border-b-0">
                  {MARKET_COLUMNS.map((c, j) => (
                    <td key={c.label} className={`px-[12px] py-[11px] ${j === 0 ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                      <Skeleton className={`h-[14px] ${j === 0 ? 'w-[60px]' : 'ml-auto w-[56px]'}`} />
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
                    <tr
                      key={m.market.marketId}
                      className={`group cursor-pointer border-b border-border last:border-b-0 hover:bg-card2 ${active ? 'bg-card2' : ''}`}
                      onClick={() => onSelect(m.market.marketId)}
                      title="Show this market in the stress test"
                    >
                      <td className={`sticky left-0 z-[1] px-[12px] py-[11px] font-semibold whitespace-nowrap align-top group-hover:bg-card2 ${active ? 'bg-card2' : 'bg-card'}`}>
                        <MarketName symbol={marketLabel(m)} size={16} />
                      </td>
                      <td
                        className={`${cell} font-semibold`}
                        title={`one side · total position value, both sides ${formatCompact(m.notionalAusd)} · margin long ${formatCompact(m.longMarginAusd)} · short ${formatCompact(m.shortMarginAusd)} · mark ${formatPriceAsServed(m.markPrice)}`}
                      >
                        {formatCompact(m.openInterestAusd)}
                      </td>
                      <td className={cell}>
                        {formatCount(m.positions)}
                        <span className="block text-[11px] text-muted2">
                          {formatCount(m.longs)}L · {formatCount(m.shorts)}S
                        </span>
                      </td>
                      <td className={cell}>
                        <SplitCell d={five.fall} />
                        <SplitCell d={five.rise} />
                      </td>
                      <td className={cell}>
                        <SplitCell d={ten.fall} />
                        <SplitCell d={ten.rise} />
                      </td>
                      <td className={cell} title={`${formatCount(ten.worse.shortfallPositions)} positions lose more than their own collateral`}>
                        {m.cover10.shortfallAusd > 0 ? (
                          <>
                            <span className="text-danger">
                              <Amount ausd={m.cover10.shortfallAusd} />
                            </span>
                            <span className="block text-[11px] text-muted2">if it {m.cover10.direction === 'fall' ? 'falls' : 'rises'}</span>
                          </>
                        ) : (
                          <Amount ausd={0} />
                        )}
                      </td>
                      <td className={`${adv} border-l border-border`} title={m.insuranceReason}>
                        {m.insuranceAusd === undefined ? <span className="text-muted2">no reading</span> : <Amount ausd={m.insuranceAusd} />}
                      </td>
                      <td className={adv}>
                        {m.cover10.cover === undefined ? (
                          <span className="text-muted2" title={m.cover10.shortfallAusd === 0 ? 'no losses beyond collateral at 10%' : 'no insurance reading'}>
                            {m.cover10.shortfallAusd === 0 ? 'none needed' : '—'}
                          </span>
                        ) : (
                          <span className={m.cover10.cover < 10 ? 'text-danger' : m.cover10.cover < 50 ? 'text-watch' : 'text-safe'} title={`against the ${m.cover10.direction}`}>
                            {m.cover10.cover >= 1000 ? `${formatCount(m.cover10.cover)}×` : `${m.cover10.cover.toFixed(1)}×`}
                          </span>
                        )}
                      </td>
                      <td className={`${adv} ${m.topFiveShare !== undefined && m.topFiveShare > 0.7 ? 'text-watch' : ''}`}>{m.topFiveShare === undefined ? '—' : formatPct(m.topFiveShare, 0)}</td>
                      <td className={adv}>{formatPct(m.maintenanceMarginRatio, 2)}</td>
                    </tr>
                  );
                })}
          {markets !== undefined && markets.length === 0 && (
            <tr>
              <td colSpan={MARKET_COLUMNS.length} className="px-[12px] py-6 text-center text-muted">
                No market has a priced open position.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


/** One direction inside a table cell: "fall 96K" over "rise 45.7K". Never a sum of the two. */
function SplitCell({ d }: { readonly d: DirectionalExposure }) {
  const fall = d.move < 0;
  return (
    <span className="block leading-[1.5]" title={`${formatCount(d.positions)} ${fall ? 'longs' : 'shorts'}`}>
      <span className="mr-[6px] text-[10.5px] text-muted2">{fall ? 'fall' : 'rise'}</span>
      <Amount ausd={d.notionalAusd} />
    </span>
  );
}

/** One stress-test figure: a muted label over a clear value, in a hairline grid. */
function Stat({ label, value, title }: { readonly label: string; readonly value: ReactNode; readonly title?: string }) {
  return (
    <div className="bg-card px-3 py-[10px]" title={title}>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="num m-0 mt-[3px] text-[15px] font-semibold text-text">{value}</dd>
    </div>
  );
}
