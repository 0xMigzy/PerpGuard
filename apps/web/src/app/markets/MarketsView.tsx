'use client';

import { Fragment, useMemo, useState } from 'react';
import { api } from '@/lib/api.ts';
import { formatAge, formatAusdExact, formatCompact, formatCount, formatFundingPct, formatPct, formatPriceAsServed, formatSignedPct } from '@/lib/format.ts';
import { buildMarketTable, defaultDirection, markWindow, sortRows, type MarketRow, type RiskScore, type SortDirection, type SortKey } from '@/lib/markets.ts';
import { PERIOD_LABEL } from '@/lib/timeframe.ts';
import { COLORS } from '@/lib/theme.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';

const POLL_MS = 30_000;

const TIER_COLOR: Record<RiskScore['tier'], string> = { safe: COLORS.safe, watch: COLORS.watch, danger: COLORS.danger };

interface Column {
  readonly key: SortKey;
  readonly label: string;
  /** Marks the header amber when its period is not the page's timeframe. */
  readonly warn?: boolean;
  readonly title?: string;
  readonly align?: 'left' | 'right';
}

export function MarketsView() {
  const t = useTimeframe('24h');
  const period = PERIOD_LABEL[t];
  const mw = markWindow(t);

  const markets = usePoll(() => api.markets(t), POLL_MS, `markets:${t}`);
  const oi = usePoll(api.openInterest, POLL_MS, 'oi');
  const series = usePoll(() => api.seriesByMarket(mw.fetch), POLL_MS, `series-markets:${mw.fetch}`);

  const [sortKey, setSortKey] = useState<SortKey>('volumeAusd');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [expanded, setExpanded] = useState<number | undefined>(undefined);

  const table = useMemo(
    () => (markets.data === undefined ? undefined : buildMarketTable(markets.data.data, oi.data?.data.markets, series.data?.data, mw.showDays)),
    [markets.data, oi.data, series.data, mw.showDays],
  );
  const rows = useMemo(() => (table === undefined ? undefined : sortRows(table.rows, sortKey, direction)), [table, sortKey, direction]);

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setDirection(defaultDirection(key));
    }
  };

  const columns: readonly Column[] = [
    { key: 'symbol', label: 'Market', align: 'left' },
    { key: 'markPrice', label: 'Mark', title: 'The venue’s mark now; the indexed one when the venue has no reading.' },
    { key: 'change', label: `Change · ${mw.label}`, warn: mw.warn, title: 'Mark now against the open of the first UTC day bucket in the window.' },
    { key: 'volumeAusd', label: `Volume · ${period}` },
    { key: 'tradeCount', label: 'Trades' },
    { key: 'openInterestNotional', label: 'Open interest', title: 'The level, from the venue: size × mark. Not an indexed figure.' },
    { key: 'longShare', label: 'Long / short', title: 'Share of open positions that are long. Counted in positions, not notional.' },
    { key: 'fundingPct', label: 'Funding', title: 'The last funding rate applied in the window, in percent.' },
    { key: 'liquidationCount', label: `Liqs · ${period}`, title: 'Liquidations in the window, and how many the trader’s free AUSD would have prevented.' },
    { key: 'risk', label: 'Risk', title: 'A composite of volatility, liquidations, crowding and funding. Click a row to see the parts.' },
  ];

  const oiAge = oi.data?.data.asOfMs === undefined ? undefined : formatAge(Date.now() - oi.data.data.asOfMs);

  return (
    <>
      <PageHeader
        title="Markets"
        subtitle="Every live Perpl market: mark, open interest, funding, liquidations, and a risk score you can decompose."
        right={<TimeframePills fallback="24h" />}
      />

      <StaleMarker envelope={markets.data} />
      <ErrorNote error={markets.error} what="Market breakdown" />
      <ErrorNote error={oi.error} what="Open interest" />
      <ErrorNote error={series.error} what="Mark history" />

      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
              {columns.map((c) => {
                const active = c.key === sortKey;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`px-[14px] py-[10px] font-semibold whitespace-nowrap ${c.align === 'left' ? 'text-left' : 'text-right'}`}
                  >
                    <button
                      type="button"
                      onClick={() => sortBy(c.key)}
                      title={c.title}
                      className={`cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit uppercase tracking-[0.06em] hover:text-text ${
                        active ? 'text-text' : c.warn ? 'text-watch' : ''
                      }`}
                    >
                      {c.label}
                      {active && <span className="ml-1">{direction === 'asc' ? '↑' : '↓'}</span>}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows === undefined
              ? Array.from({ length: 8 }, (_, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    {columns.map((c) => (
                      <td key={c.key} className="px-[14px] py-[11px]">
                        <Skeleton className={`h-[14px] ${c.key === 'symbol' ? 'w-[60px]' : 'ml-auto w-[70px]'}`} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <Fragment key={row.marketId}>
                    <MarketTableRow row={row} expanded={expanded === row.marketId} onToggle={() => setExpanded(expanded === row.marketId ? undefined : row.marketId)} />
                    {expanded === row.marketId && <RiskBreakdownRow row={row} columns={columns.length} oiAge={oiAge} />}
                  </Fragment>
                ))}
            {rows !== undefined && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-[14px] py-6 text-center text-muted">
                  No market the venue lists has indexed activity in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-[11.5px] text-muted2">
        Symbols resolve from the venue context by market id.{' '}
        {table !== undefined && table.excluded.length > 0 && (
          <>
            {table.excluded.length === 1 ? 'One market' : `${table.excluded.length} markets`} indexed on chain but not listed by the venue{' '}
            ({table.excluded.map((m) => `${m.marketId} · ${m.indexerName}`).join(', ')}) {table.excluded.length === 1 ? 'is' : 'are'} excluded.{' '}
          </>
        )}
        Volume, trades and liquidations are indexed over the {period} window; mark and open interest are the venue&rsquo;s level
        {oiAge === undefined ? '' : ` as of ${oiAge} ago`}. Change and low–high are read from UTC day buckets ({mw.label}). Funding is shown to 6dp because real values are that small.
      </div>
    </>
  );
}

function MarketTableRow({ row, expanded, onToggle }: { readonly row: MarketRow; readonly expanded: boolean; readonly onToggle: () => void }) {
  const changeClass = row.change === undefined ? 'text-muted' : row.change > 0 ? 'text-safe' : row.change < 0 ? 'text-danger' : 'text-muted';
  const fundingClass = row.fundingPct === undefined ? 'text-muted' : row.fundingPct > 0 ? 'text-safe' : row.fundingPct < 0 ? 'text-danger' : 'text-muted';
  const longPct = row.longShare === undefined ? undefined : Math.round(row.longShare * 100);
  const cell = 'num px-[14px] py-[11px] text-right whitespace-nowrap';
  return (
    <tr
      className={`cursor-pointer border-b border-border last:border-b-0 hover:bg-card2 ${expanded ? 'bg-card2' : ''}`}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <td className="px-[14px] py-[11px] font-semibold whitespace-nowrap">{row.symbol}</td>
      <td className={cell} title={row.markPrice === undefined ? 'no mark known' : undefined}>
        {row.markPrice === undefined ? '—' : formatPriceAsServed(row.markPrice)}
      </td>
      <td className={`${cell} ${changeClass}`}>
        <div>{row.change === undefined ? '—' : formatSignedPct(row.change, 2)}</div>
        <div className="text-[11px] text-muted2">
          {row.low === undefined || row.high === undefined ? 'no range' : `${formatPriceAsServed(row.low)} – ${formatPriceAsServed(row.high)}`}
        </div>
      </td>
      <td className={cell} title={`${formatAusdExact(row.volumeAusd)} AUSD · fees ${formatAusdExact(row.feesAusd)} AUSD`}>
        {formatCompact(row.volumeAusd)}
      </td>
      <td className={cell}>{formatCount(row.tradeCount)}</td>
      <td
        className={cell}
        title={
          row.openInterestNotional === undefined
            ? 'the venue has no reading for this market'
            : `${formatAusdExact(row.openInterestNotional)} AUSD · ${formatPriceAsServed(row.openInterestSize ?? 0)} ${row.symbol}`
        }
      >
        {row.openInterestNotional === undefined ? <span className="text-muted">no reading</span> : formatCompact(row.openInterestNotional)}
      </td>
      <td className={cell} title={`${formatCount(row.longPositions)} long · ${formatCount(row.shortPositions)} short · ${formatCount(row.openPositions)} open`}>
        {longPct === undefined ? (
          <span className="text-muted">no positions</span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-[6px] w-[64px] overflow-hidden rounded-full bg-danger/50" aria-hidden="true">
              <i className="block h-full bg-safe" style={{ width: `${longPct}%` }} />
            </span>
            {longPct}% L
          </span>
        )}
      </td>
      <td className={`${cell} ${fundingClass}`}>{row.fundingPct === undefined ? '—' : formatFundingPct(row.fundingPct)}</td>
      <td className={cell} title={row.liquidationCount === 0 ? undefined : `${formatCount(row.rescuableLiquidationCount)} of ${formatCount(row.liquidationCount)} rescuable`}>
        {formatCount(row.liquidationCount)}
        {row.liquidationCount > 0 && <span className="ml-1 text-[11px] text-muted">· {formatCount(row.rescuableLiquidationCount)} rescuable</span>}
      </td>
      <td className={cell}>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-[6px] w-[56px] overflow-hidden rounded-full bg-border2" aria-hidden="true">
            <i className="block h-full" style={{ width: `${row.risk.score}%`, background: TIER_COLOR[row.risk.tier] }} />
          </span>
          <b style={{ color: TIER_COLOR[row.risk.tier] }}>{row.risk.score}</b>
        </span>
      </td>
    </tr>
  );
}

/** The score, taken apart: each input, its normalised value, its weight and the points it adds. */
function RiskBreakdownRow({ row, columns, oiAge }: { readonly row: MarketRow; readonly columns: number; readonly oiAge: string | undefined }) {
  return (
    <tr className="border-b border-border bg-card2/60 last:border-b-0">
      <td colSpan={columns} className="px-[14px] py-3">
        <div className="mb-2 text-[12px] text-muted">
          <b className="text-text">{row.symbol} risk {row.risk.score}</b> = Σ value × weight × 100. Each value is the input against its ceiling, capped at 1.
          {oiAge !== undefined && ` Mark and open interest as of ${oiAge} ago.`}
        </div>
        <div className="grid gap-x-6 gap-y-2 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
          {row.risk.components.map((c) => (
            <div key={c.key}>
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{c.label}</span>
                <span className="num text-muted">
                  {formatPct(c.value, 0)} × {c.weight} = <b className="text-text">{c.points.toFixed(1)}</b>
                </span>
              </div>
              <span className="mt-1 block h-[5px] w-full overflow-hidden rounded-full bg-border2" aria-hidden="true">
                <i className="block h-full" style={{ width: `${c.value * 100}%`, background: TIER_COLOR[row.risk.tier] }} />
              </span>
              <div className="mt-1 text-[11.5px] text-muted2">{c.detail}</div>
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}
