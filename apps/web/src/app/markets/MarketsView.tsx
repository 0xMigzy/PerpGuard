'use client';

import { Fragment, useMemo, useState } from 'react';
import { api } from '@/lib/api.ts';
import { formatAge, formatAusdExact, formatCompact, formatCount, formatFundingPct, formatPct, formatPriceAsServed } from '@/lib/format.ts';
import { CROWDED_SHARE, buildMarketTable, defaultDirection, markWindow, sortRows, type MarketRow, type RiskScore, type RiskTag, type SortDirection, type SortKey } from '@/lib/markets.ts';
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
const TAG_CLASS: Record<RiskTag['tone'], string> = { ok: 'bg-safe/12 text-safe', watch: 'bg-watch/12 text-watch', danger: 'bg-danger/12 text-danger' };

interface Column {
  readonly key: SortKey;
  readonly label: string;
  /** A second, smaller line under the label: the period the column covers. */
  readonly sub?: string;
  /** Marks the sub-line amber when its period is not the page's timeframe. */
  readonly warn?: boolean;
  readonly title?: string;
  readonly align?: 'left' | 'right';
}

export function MarketsView() {
  const t = useTimeframe();
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
    { key: 'markPrice', label: 'Price', sub: 'mark now', title: 'The venue’s mark now; the indexed one when the venue has no reading.' },
    { key: 'volumeAusd', label: 'Volume', sub: period, title: 'Traded notional in the window, counted once per match.' },
    { key: 'openInterestNotional', label: 'Open interest', sub: 'level now', title: 'The level, from the venue: size × mark. Not an indexed figure.' },
    { key: 'fundingPct', label: 'Funding', sub: 'last rate', title: 'The last funding rate applied, in percent, to six places because real values are that small.' },
    { key: 'longShareOfNotional', label: 'Skew', sub: 'long share', title: 'Long share of open notional at the indexed mark. Over 70% on one side with funding paying that side is crowded.' },
    { key: 'risk', label: 'Risk', sub: 'composite', title: 'Crowded when one side dominates and pays funding; otherwise the tier of a composite of volatility, liquidations, crowding and funding. Click a row to see the parts.' },
  ];

  const oiAge = oi.data?.data.asOfMs === undefined ? undefined : formatAge(Date.now() - oi.data.data.asOfMs);
  const feesLabel = table?.rows[0]?.feesLabel;

  return (
    <>
      <PageHeader
        title="Markets"
        subtitle="Every market the venue lists. Funding is shown at six decimal places, because four rounds real values to zero."
        right={
          <>
            {rows !== undefined && <span className="chip">{formatCount(rows.length)} markets</span>}
            <TimeframePills />
          </>
        }
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
                    className={`px-[10px] py-[8px] font-semibold whitespace-nowrap align-bottom ${c.align === 'left' ? 'sticky left-0 z-[1] bg-card text-left' : 'text-right'}`}
                  >
                    <button
                      type="button"
                      onClick={() => sortBy(c.key)}
                      title={c.title}
                      className={`cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit uppercase tracking-[0.06em] hover:text-text ${active ? 'text-text' : ''}`}
                    >
                      {c.label}
                      {active && <span className="ml-1">{direction === 'asc' ? '↑' : '↓'}</span>}
                      {c.sub !== undefined && <span className={`block text-[10px] font-medium normal-case tracking-normal ${c.warn ? 'text-watch' : 'text-muted2'}`}>{c.sub}</span>}
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
                      <td key={c.key} className={`px-[10px] py-[10px] ${c.align === 'left' ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                        <Skeleton className={`h-[14px] ${c.key === 'symbol' ? 'w-[60px]' : 'ml-auto w-[70px]'}`} />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <Fragment key={row.marketId}>
                    <MarketTableRow row={row} expanded={expanded === row.marketId} onToggle={() => setExpanded(expanded === row.marketId ? undefined : row.marketId)} />
                    {expanded === row.marketId && <RiskBreakdownRow row={row} columns={columns.length} oiAge={oiAge} period={period} />}
                  </Fragment>
                ))}
            {rows !== undefined && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-[10px] py-8 text-center text-muted">
                  <div className="text-[14px] font-semibold text-text">No listed market has indexed activity in {period}.</div>
                  <div className="mt-1 text-[12.5px]">Widen the window. A market the venue does not list is excluded and named below.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex gap-[10px] rounded-[10px] border border-accent/30 bg-accent/8 px-[14px] py-3 text-[12.5px] text-[#CFC6F0]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={COLORS.accentHi} strokeWidth="2.2" aria-hidden="true" className="mt-[2px] flex-none">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5v.01" />
        </svg>
        <div>
          <b className="font-semibold">Crowded long</b> means one side holds more than {formatPct(CROWDED_SHARE, 0)} of open notional while funding is positive — the side paying to stay
          in, with the most to lose from a move against it. It is a risk signal, not a trade signal. Otherwise the tag is the tier of a composite score; click a row to see its parts.
        </div>
      </div>

      <div className="mt-3 text-[11.5px] text-muted2">
        Symbols resolve from the venue context by market id.{' '}
        {table !== undefined && table.excluded.length > 0 && (
          <>
            {table.excluded.length === 1 ? 'One market' : `${table.excluded.length} markets`} indexed on chain but not listed by the venue{' '}
            ({table.excluded.map((m) => `${m.marketId} · ${m.indexerName}`).join(', ')}) {table.excluded.length === 1 ? 'is' : 'are'} excluded.{' '}
          </>
        )}
        Volume is indexed over the {period} window; price and open interest are the venue&rsquo;s level{oiAge === undefined ? '' : ` as of ${oiAge} ago`}. Skew is size × indexed mark per side.
        {feesLabel !== undefined && ` Fees in a row's detail are maker + taker over ${feesLabel}, the same definition as the Overview tile.`}
      </div>
    </>
  );
}

function MarketTableRow({ row, expanded, onToggle }: { readonly row: MarketRow; readonly expanded: boolean; readonly onToggle: () => void }) {
  const fundingClass = row.fundingPct === undefined ? 'text-muted' : row.fundingPct > 0 ? 'text-safe' : row.fundingPct < 0 ? 'text-danger' : 'text-muted';
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  // The symbol stays pinned while the table scrolls sideways on a phone; it paints
  // its own background so the cells sliding under it never show through.
  const pinned = expanded ? 'bg-card2' : 'bg-card group-hover:bg-card2';
  const share = row.longShareOfNotional;
  const barColor = share === undefined ? COLORS.muted : share > CROWDED_SHARE ? COLORS.watch : 1 - share > CROWDED_SHARE ? COLORS.danger : COLORS.safe;
  return (
    <tr className={`group cursor-pointer border-b border-border last:border-b-0 hover:bg-card2 ${expanded ? 'bg-card2' : ''}`} onClick={onToggle} aria-expanded={expanded}>
      <td className={`sticky left-0 z-[1] px-[10px] py-[10px] font-semibold whitespace-nowrap ${pinned}`}>{row.symbol}</td>
      <td className={cell} title={row.markPrice === undefined ? 'no mark known' : row.change === undefined ? undefined : `${formatPct(row.change, 2)} over ${row.low === undefined || row.high === undefined ? 'the window' : `${formatPriceAsServed(row.low)} – ${formatPriceAsServed(row.high)}`}`}>
        {row.markPrice === undefined ? '—' : formatPriceAsServed(row.markPrice)}
      </td>
      <td className={cell} title={`${formatAusdExact(row.volumeAusd)} AUSD · ${formatCount(row.tradeCount)} trades · fees ${formatAusdExact(row.feesAusd)} AUSD over ${row.feesLabel}`}>
        {formatCompact(row.volumeAusd)}
        <span className="block text-[11px] text-muted2">{formatCount(row.tradeCount)} trades</span>
      </td>
      <td className={cell} title={row.openInterestNotional === undefined ? 'the venue has no reading for this market' : `${formatAusdExact(row.openInterestNotional)} AUSD · ${formatPriceAsServed(row.openInterestSize ?? 0)} ${row.symbol}`}>
        {row.openInterestNotional === undefined ? <span className="text-muted">no reading</span> : formatCompact(row.openInterestNotional)}
      </td>
      <td className={`${cell} ${fundingClass}`}>{row.fundingPct === undefined ? <span className="text-muted2">no event</span> : formatFundingPct(row.fundingPct)}</td>
      <td className={cell} title={share === undefined ? 'no open notional' : `long ${formatCompact(row.longNotionalAusd ?? 0)} · short ${formatCompact(row.shortNotionalAusd ?? 0)} · ${formatCount(row.longPositions)}L / ${formatCount(row.shortPositions)}S positions`}>
        {share === undefined ? (
          <span className="text-muted">no positions</span>
        ) : (
          <span className="inline-flex items-center justify-end gap-2">
            {formatPct(share)}
            <span className="inline-block h-[5px] w-[52px] overflow-hidden rounded-full bg-border2" aria-hidden="true">
              <i className="block h-full" style={{ width: `${share * 100}%`, background: barColor }} />
            </span>
          </span>
        )}
      </td>
      <td className={cell} title={row.tag.detail}>
        <span className={`rounded-[4px] px-[6px] py-[2.5px] text-[10px] font-semibold tracking-[0.05em] ${TAG_CLASS[row.tag.tone]}`}>{row.tag.label}</span>
        <b className="ml-2 num" style={{ color: TIER_COLOR[row.risk.tier] }}>{row.risk.score}</b>
      </td>
    </tr>
  );
}

/** The score, taken apart: each input, its normalised value, its weight and the points it adds. */
function RiskBreakdownRow({ row, columns, oiAge, period }: { readonly row: MarketRow; readonly columns: number; readonly oiAge: string | undefined; readonly period: string }) {
  return (
    <tr className="border-b border-border bg-card2/60 last:border-b-0">
      <td colSpan={columns} className="px-[10px] py-3">
        <div className="mb-2 text-[12px] text-muted">
          <b className="text-text">{row.symbol} risk {row.risk.score}</b> = Σ value × weight × 100. Each value is the input against its ceiling, capped at 1.
          {oiAge !== undefined && ` Mark and open interest as of ${oiAge} ago.`}
          {` Liquidations in ${period}: ${formatCount(row.liquidationCount)}${row.liquidationCount > 0 ? `, ${formatCount(row.rescuableLiquidationCount)} rescuable` : ''}.`}
          {` Fees ${formatCompact(row.feesAusd)} maker + taker over ${row.feesLabel}.`}
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
