'use client';

import { Fragment, useMemo, useState } from 'react';
import { api } from '@/lib/api.ts';
import { formatAge, formatAusdExact, formatCompact, formatCount, formatFundingPct, formatPct, formatPriceAsServed } from '@/lib/format.ts';
import {
  CROWDED_SHARE,
  buildMarketTable,
  defaultDirection,
  filterRows,
  markWindow,
  sortRows,
  upcomingRows,
  type MarketRow,
  type RiskScore,
  type RiskTag,
  type SortDirection,
  type SortKey,
  type StatusFilter,
  type TableRow,
  type UpcomingRow,
} from '@/lib/markets.ts';
import { fundingHeatmap, heatmapGrain, type FundingHeatmap as HeatModel } from '@/lib/funding.ts';
import { periodLabel } from '@/lib/history.ts';
import { useHistoryStart } from '@/lib/useHistory.ts';
import { COLORS } from '@/lib/theme.ts';
import { TIMEFRAME_LABEL, type Timeframe } from '@/lib/timeframe.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { MarketName } from '@/components/TokenIcon.tsx';
import { FundingHeatmap, HeatLegend } from '@/components/charts/FundingHeatmap.tsx';
import { FundingScanner } from './FundingScanner.tsx';
import { StatusPills, useStatusFilter } from './StatusPills.tsx';

const POLL_MS = 30_000;
const DAY_MS = 86_400_000;

const TIER_COLOR: Record<RiskScore['tier'], string> = { safe: COLORS.safe, watch: COLORS.watch, danger: COLORS.danger };
const TAG_CLASS: Record<RiskTag['tone'], string> = { ok: 'bg-safe/12 text-safe', watch: 'bg-watch/12 text-watch', danger: 'bg-danger/12 text-danger' };

/** THE definition of the Risk column: its header tooltip and the caption under the table both say it. */
const CROWDED_RULE = `Crowded long means one side holds more than ${formatPct(CROWDED_SHARE, 0)} of open margin while funding is positive (crowded short: the mirror, with funding negative) — the side paying to stay in, with the most to lose from a move against it. It is a risk signal, not a trade signal. Otherwise the tag is the tier of a composite of volatility, liquidations, crowding and funding; click a row to see its parts.`;

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
  const status = useStatusFilter();
  const period = periodLabel(t, useHistoryStart());
  const mw = markWindow(t);

  const markets = usePoll(() => api.markets(t), POLL_MS, `markets:${t}`);
  const oi = usePoll(api.openInterest, POLL_MS, 'oi');
  const series = usePoll(() => api.seriesByMarket(mw.fetch), POLL_MS, `series-markets:${mw.fetch}`);
  const listings = usePoll(api.listings, POLL_MS, 'market-listings');
  const funding = usePoll(() => api.fundingSeries(t), POLL_MS, `funding-series:${t}`);

  const [sortKey, setSortKey] = useState<SortKey>('volumeAusd');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [expanded, setExpanded] = useState<number | undefined>(undefined);
  const [heatView, setHeatView] = useState<'chart' | 'table'>('chart');

  const live = useMemo(
    () => (markets.data === undefined ? undefined : buildMarketTable(markets.data.data, oi.data?.data.markets, series.data?.data, mw.showDays).rows),
    [markets.data, oi.data, series.data, mw.showDays],
  );
  // Upcoming rows wait for the listings; until then the table is the live markets alone.
  const upcoming = useMemo(() => (listings.data === undefined ? [] : upcomingRows(listings.data.data)), [listings.data]);
  const all = useMemo<readonly TableRow[] | undefined>(() => (live === undefined ? undefined : [...live, ...upcoming]), [live, upcoming]);
  const rows = useMemo(() => (all === undefined ? undefined : sortRows(filterRows(all, status), sortKey, direction)), [all, status, sortKey, direction]);
  const counts = useMemo<Record<StatusFilter, number> | undefined>(
    () => (live === undefined ? undefined : { all: live.length + upcoming.length, live: live.length, upcoming: upcoming.length }),
    [live, upcoming],
  );
  const heat = useMemo(
    () =>
      live === undefined || funding.data === undefined
        ? undefined
        : fundingHeatmap(
            live.map((r) => ({ marketId: r.marketId, symbol: r.symbol, currentRatePct: r.fundingPct })),
            funding.data.data,
            t,
            Date.now(),
          ),
    [live, funding.data, t],
  );

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setDirection(defaultDirection(key));
    }
  };

  const columns: readonly Column[] = [
    { key: 'symbol', label: 'Market', align: 'left' },
    { key: 'status', label: 'Status', sub: 'on Perpl', title: 'LIVE: open on Perpl. UPCOMING: listed on chain, not open yet, never traded; its figures do not exist yet and show as —.' },
    { key: 'markPrice', label: 'Price', sub: 'mark now', title: 'The venue’s mark now; the indexed one when the venue has no reading. For an upcoming market, the contract’s last mark.' },
    { key: 'volumeAusd', label: 'Volume', sub: period, title: 'Traded notional in the window, counted once per match.' },
    { key: 'openInterestNotional', label: 'Open interest', sub: 'level now', title: 'The level, from the venue: size × mark. Not an indexed figure.' },
    { key: 'fundingPct', label: 'Funding', sub: 'last rate, 6 dp', title: 'The last funding rate applied, in percent, to six decimal places: real rates are that small, and four places would round them to zero. Positive means longs pay shorts.' },
    { key: 'longShareOfMargin', label: 'Exposure', sub: 'which side has more money at stake', title: 'The isolated margin open longs and shorts have posted, as a share each. Not notional: on an order book every long lot has a matching short, so notional is always 50/50.' },
    { key: 'risk', label: 'Risk', sub: 'composite', title: CROWDED_RULE },
  ];

  const oiAge = oi.data?.data.asOfMs === undefined ? undefined : formatAge(Date.now() - oi.data.data.asOfMs);
  const feesLabel = live?.[0]?.feesLabel;

  return (
    // Opts this page into the terminal design system (globals.css).
    <div data-ui="terminal">
      <PageHeader title="Markets" subtitle="Live Perpl market data, including prices, OI & funding." right={<TimeframePills />} />

      <StaleMarker envelope={markets.data} />
      <ErrorNote error={markets.error} what="Market breakdown" />
      <ErrorNote error={oi.error} what="Open interest" />
      <ErrorNote error={series.error} what="Mark history" />
      <ErrorNote error={listings.error} what="Markets listed on chain" />

      <div className="mb-[10px]">
        <StatusPills counts={counts} />
      </div>

      <section className="card">
        <div className="overflow-x-auto">
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
                : rows.map((row) => {
                    const open = expanded === row.marketId;
                    const toggle = () => setExpanded(open ? undefined : row.marketId);
                    return (
                      <Fragment key={row.marketId}>
                        {row.status === 'live' ? (
                          <MarketTableRow row={row} expanded={open} onToggle={toggle} />
                        ) : (
                          <UpcomingTableRow row={row} expanded={open} onToggle={toggle} />
                        )}
                        {open &&
                          (row.status === 'live' ? (
                            <RiskBreakdownRow row={row} columns={columns.length} oiAge={oiAge} period={period} />
                          ) : (
                            <ListingDetailRow row={row} columns={columns.length} />
                          ))}
                      </Fragment>
                    );
                  })}
              {rows !== undefined && rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="px-[10px] py-8 text-center text-muted">
                    <div className="text-[14px] font-semibold text-text">
                      {status === 'upcoming' ? 'No market is listed on chain ahead of Perpl right now.' : `No listed market has indexed activity in ${period}.`}
                    </div>
                    <div className="mt-1 text-[12.5px]">{status === 'upcoming' ? 'A market appears here when it is listed on chain, and moves to Live when Perpl opens it.' : 'Widen the window.'}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-[14px] py-3 text-[11.5px] leading-[1.55] text-muted2">
          <b className="font-semibold text-muted">Risk.</b> {CROWDED_RULE}{' '}
          <b className="font-semibold text-muted">Figures.</b> Symbols resolve from the venue context by market id; an upcoming market carries the contract&rsquo;s own
          symbol and none of the venue&rsquo;s figures (—). Volume is indexed over the {period} window; price and open interest are the venue&rsquo;s level
          {oiAge === undefined ? '' : ` as of ${oiAge} ago`}. Exposure is isolated margin per side, not notional, which is 50/50 on every market by construction.
          {feesLabel !== undefined && ` Fees in a row's detail are maker + taker over ${feesLabel}.`}
        </div>
      </section>

      <ErrorNote error={funding.error} what="Funding history" />
      <FundingSection heat={heat} timeframe={t} period={period} liveCount={live?.length} upcomingCount={upcoming.length} view={heatView} onView={setHeatView} />
      <FundingScanner heat={heat} />
    </div>
  );
}

/** What one column of the heatmap is, in words, for the timeframe in view. */
function grainCaption(heat: HeatModel, timeframe: Timeframe, period: string): string {
  const r = heat.eventsPerColumn;
  const counted = r === undefined ? '' : r.min === r.max ? `, ${formatCount(r.min)} in each whole column` : `, between ${formatCount(r.min)} and ${formatCount(r.max)} in a whole column`;
  const listing = ` A market's first ${heat.grain === 'utc-week' ? 'week' : 'day'} is its listing and averages fewer.`;
  const changed = r !== undefined && r.max > r.min * 1.15 ? ' The range is wide because the cadence changed: Perpl settled about 25 times a day until 23 Jul 2026, about 33 since.' : '';
  switch (heat.grain) {
    case 'settlement':
      return `One column per settlement: the rate as applied. ${formatCount(heat.columns.length)} settlements in ${period}.`;
    case 'utc-day': {
      const fellBack = heatmapGrain(timeframe) === 'settlement';
      return `${fellBack ? `${TIMEFRAME_LABEL[timeframe]} has too many settlements to draw one column each, so it is shown by UTC day. ` : ''}One column per UTC day: the MEAN rate per settlement that day${counted}, not a daily rate. A partial day (cut by the window, or today so far) averages fewer; hover any cell for its count.${listing}${changed}`;
    }
    case 'utc-week':
      return `One column per UTC week, Monday to Sunday: the MEAN rate per settlement that week${counted}, not a weekly rate. The current week is so far; hover any cell for its count.${listing}${changed}`;
  }
}

function FundingSection({
  heat,
  timeframe,
  period,
  liveCount,
  upcomingCount,
  view,
  onView,
}: {
  readonly heat: HeatModel | undefined;
  readonly timeframe: Timeframe;
  readonly period: string;
  readonly liveCount: number | undefined;
  readonly upcomingCount: number;
  readonly view: 'chart' | 'table';
  readonly onView: (v: 'chart' | 'table') => void;
}) {
  const cadence = heat?.cadence;
  const minutes = cadence?.measuredIntervalSec === undefined ? undefined : Math.round(cadence.measuredIntervalSec / 60);
  // From the measured gap, not the last-24h count: 24 h / 2,587 s is 33.4, so the count alternates 33 and 34.
  const perDay = cadence?.measuredIntervalSec === undefined ? undefined : Math.round(86_400 / cadence.measuredIntervalSec);
  return (
    <section className="card mt-4 px-[18px] py-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-[10px]">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">
          Funding <span className="ml-1 text-[12.5px] font-medium text-muted">{period} · live markets only</span>
        </h2>
        <div className="tf-group inline-flex gap-[2px] rounded-[9px] border border-border2 bg-card p-[2px]" role="group" aria-label="Funding view">
          {(['chart', 'table'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => onView(v)}
              className={`pill tf-pill rounded-[7px] border-0 px-[10px] py-[4px] text-[12px] font-semibold ${view === v ? 'bg-accent-deep text-white' : 'bg-transparent text-muted hover:text-text'}`}
            >
              {v === 'chart' ? 'Heatmap' : 'Table'}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 text-[12px] leading-[1.55] text-muted">
        Every live market in the table above has a row here{liveCount === undefined ? '' : ` (${formatCount(liveCount)})`}.
        {upcomingCount > 0 && ` The ${formatCount(upcomingCount)} upcoming market${upcomingCount === 1 ? ' is' : 's are'} in the table but never here: not open yet, so nobody can hold a position to pay or receive funding.`}{' '}
        {cadence !== undefined && minutes !== undefined && perDay !== undefined && (
          <>
            Funding settles <b className="font-semibold text-text">every ~{minutes} min, about {perDay} times a day</b>, not hourly: measured as the mean gap between
            settlements over each market&rsquo;s last 24 hours ({formatCount(Math.round(cadence.measuredIntervalSec!))} s
            {cadence.venueIntervalSec === undefined ? '' : `; the venue states ${formatCount(cadence.venueIntervalSec)} s`}). A 24-hour window holds {Math.floor(86_400 / cadence.measuredIntervalSec!)} or{' '}
            {Math.ceil(86_400 / cadence.measuredIntervalSec!)} of them.
          </>
        )}
      </div>

      {heat === undefined ? (
        <Skeleton className="h-[260px] w-full" />
      ) : heat.columns.length === 0 ? (
        <div className="py-6 text-center text-[12.5px] text-muted">No funding settlement was indexed in {period}. Every live market&rsquo;s row would be empty.</div>
      ) : (
        <>
          <div className="mb-3 text-[12px] text-muted">{grainCaption(heat, timeframe, period)}</div>
          <FundingHeatmap model={heat} view={view} />
          <div className="mt-3 flex flex-col gap-2">
            {view === 'chart' && <HeatLegend />}
            <div className="text-[11.5px] leading-[1.55] text-muted2">
              <b className="font-semibold text-muted">APR</b> on the right is annualised from the CURRENT rate (the table&rsquo;s Funding column) × settlements a year: simple, not
              compounded, and it assumes the rate holds. A snapshot of right now, not a forecast; rates flip sign settlement to settlement. Hover a cell for the market, the
              period and the rate to six decimal places, or switch to Table for every figure as text. Positive: longs pay shorts (Perpl docs). An AUSD total across traders
              needs each side&rsquo;s open interest at every settlement, which the index does not keep, so it is not estimated.
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function MarketTableRow({ row, expanded, onToggle }: { readonly row: MarketRow; readonly expanded: boolean; readonly onToggle: () => void }) {
  const fundingClass = row.fundingPct === undefined ? 'text-muted' : row.fundingPct > 0 ? 'text-safe' : row.fundingPct < 0 ? 'text-danger' : 'text-muted';
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  // The symbol stays pinned while the table scrolls sideways on a phone; it paints
  // its own background so the cells sliding under it never show through.
  const pinned = expanded ? 'bg-card2' : 'bg-card group-hover:bg-card2';
  const share = row.longShareOfMargin;
  const barColor = share === undefined ? COLORS.muted : share > CROWDED_SHARE ? COLORS.watch : 1 - share > CROWDED_SHARE ? COLORS.danger : COLORS.safe;
  return (
    <tr className={`group cursor-pointer border-b border-border last:border-b-0 hover:bg-card2 ${expanded ? 'bg-card2' : ''}`} onClick={onToggle} aria-expanded={expanded}>
      <td className={`sticky left-0 z-[1] px-[10px] py-[10px] font-semibold whitespace-nowrap ${pinned}`}>
        <MarketName symbol={row.symbol} />
      </td>
      <td className={cell}>
        <StatusBadge status="live" />
      </td>
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
      <td
        className={cell}
        title={
          share === undefined
            ? 'no open margin'
            : `${formatPct(share, 0)} long · ${formatPct(1 - share, 0)} short\nmargin long ${formatAusdExact(row.longMarginAusd)} AUSD · short ${formatAusdExact(row.shortMarginAusd)} AUSD`
        }
      >
        {share === undefined ? (
          <span className="text-muted">no positions</span>
        ) : (
          <>
            <span className="inline-flex items-center justify-end gap-2">
              {share >= 0.5 ? `${formatPct(share, 0)} long` : `${formatPct(1 - share, 0)} short`}
              <span className="inline-block h-[5px] w-[52px] overflow-hidden rounded-full bg-border2" aria-hidden="true">
                <i className="block h-full" style={{ width: `${share * 100}%`, background: barColor }} />
              </span>
            </span>
            <span className="block text-[11px] text-muted2">
              {formatCount(row.longPositions)} long / {formatCount(row.shortPositions)} short positions
            </span>
          </>
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

/** LIVE in a quiet green, UPCOMING muted: the status is a fact, not an alarm. */
function StatusBadge({ status }: { readonly status: TableRow['status'] }) {
  return status === 'live' ? (
    <span className="rounded-[4px] bg-safe/10 px-[6px] py-[2.5px] text-[10px] font-semibold tracking-[0.05em] text-safe/90">LIVE</span>
  ) : (
    <span className="rounded-[4px] bg-border2 px-[6px] py-[2.5px] text-[10px] font-semibold tracking-[0.05em] text-muted">UPCOMING</span>
  );
}

/**
 * A market listed on chain that Perpl has not opened: its contract symbol, the
 * contract's last mark (labelled as such), and "—" for every figure the venue has
 * not produced. "—" is not zero: nothing has traded, so there is nothing to count.
 */
function UpcomingTableRow({ row, expanded, onToggle }: { readonly row: UpcomingRow; readonly expanded: boolean; readonly onToggle: () => void }) {
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  const none = <span className="text-muted2" title="not open yet: no figure exists">—</span>;
  const pinned = expanded ? 'bg-card2' : 'bg-card group-hover:bg-card2';
  const markAt = row.listing.markAtMs;
  return (
    <tr className={`group cursor-pointer border-b border-border last:border-b-0 hover:bg-card2 ${expanded ? 'bg-card2' : ''}`} onClick={onToggle} aria-expanded={expanded}>
      <td className={`sticky left-0 z-[1] px-[10px] py-[10px] font-semibold whitespace-nowrap text-muted ${pinned}`}>
        <MarketName symbol={row.symbol} />
        <span className="ml-2 text-[11px] font-normal text-muted2">#{row.marketId}</span>
      </td>
      <td className={cell}>
        <StatusBadge status="upcoming" />
      </td>
      <td className={`${cell} text-muted`} title={markAt === undefined ? 'no mark update indexed' : `the contract's last mark, set ${formatAge(Date.now() - markAt)} ago; not a venue price`}>
        {row.markPrice === undefined ? '—' : formatPriceAsServed(row.markPrice)}
        <span className="block text-[11px] text-muted2">contract mark</span>
      </td>
      <td className={cell}>{none}</td>
      <td className={cell}>{none}</td>
      <td className={cell}>{none}</td>
      <td className={cell}>{none}</td>
      <td className={cell}>{none}</td>
    </tr>
  );
}

/** What the contract already holds for a market that has not opened. Parameters may change before it does. */
function ListingDetailRow({ row, columns }: { readonly row: UpcomingRow; readonly columns: number }) {
  const l = row.listing;
  const listed = new Date(l.listedAtMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const facts: readonly [string, string][] = [
    ['State on chain', l.paused ? 'Paused' : 'Not paused'],
    ['Max leverage', l.maxLeverage === undefined ? '—' : `${l.maxLeverage}x`],
    ['Maint. margin', l.maintenanceMarginRatio === undefined ? '—' : formatPct(l.maintenanceMarginRatio, l.maintenanceMarginRatio * 100 < 10 ? 1 : 0)],
    ['Max OI', `${formatCount(l.maxOpenInterestSize)} ${row.symbol}`],
    ['Listed on chain', `${listed} · ${formatCount(Math.floor((Date.now() - l.listedAtMs) / DAY_MS))} days ago`],
  ];
  return (
    <tr className="border-b border-border bg-card2/60 last:border-b-0">
      <td colSpan={columns} className="px-[10px] py-3">
        <div className="mb-2 text-[12px] text-muted">
          <b className="text-text">{row.symbol}</b> (market #{row.marketId}) is listed on chain and has never traded. These are the contract&rsquo;s own parameters and may change
          before it opens; Perpl has not published a date.
        </div>
        <div className="grid gap-x-6 gap-y-2 text-[12px] sm:grid-cols-3 lg:grid-cols-5">
          {facts.map(([k, v]) => (
            <div key={k}>
              <div className="text-[11px] text-muted2">{k}</div>
              <div className={`num font-semibold ${k === 'State on chain' && l.paused ? 'text-watch' : 'text-text'}`}>{v}</div>
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}
