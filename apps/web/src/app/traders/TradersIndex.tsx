'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { TraderRanking, TraderRow } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAusdExact, formatCount, formatMoney, formatPct, formatSignedExact, formatSignedMoney, shortAddress } from '@/lib/format.ts';
import { inWholeDays, periodLabel, wholeDaysLabel, wholeDaysTitle } from '@/lib/history.ts';
import { useHistoryStart } from '@/lib/useHistory.ts';
import { DEFAULT_FLOW_SORT, RANKINGS, nextFlowSort, pageRange, rankingFromQuery, rankingInfo, searchParam, type FlowSort, type RankedColumn } from '@/lib/traders.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { CopyAddress } from './CopyAddress.tsx';
import { ExportCsv } from './ExportCsv.tsx';
import { TraderCards } from './TraderCards.tsx';

const POLL_MS = 30_000;
const PAGE = 50;
const SEARCH_DEBOUNCE_MS = 300;

interface Column {
  readonly key: 'account' | RankedColumn | 'winRate' | 'deposits' | 'withdrawals';
  readonly label: string;
  /** The period the column covers: the window, or "now". */
  readonly sub: string;
  readonly title?: string;
}

/**
 * Every account the indexer has seen trade, ranked and paged BY THE BACKEND:
 * a ranking or a search is a new query, so the top of a list is the top of
 * all of it, never the top of the fifty in hand.
 */
export function TradersIndex() {
  const t = useTimeframe();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const ranking = rankingFromQuery(params.get('rank'));
  const info = rankingInfo(ranking);
  const [offset, setOffset] = useState(0);
  const [flowSort, setFlowSort] = useState<FlowSort>(DEFAULT_FLOW_SORT);
  const flows = ranking === 'flows';
  // Only Flows takes a reader's order; every other ranking's order is fixed by the backend.
  const sortParam = flows ? flowSort : undefined;
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState<string | undefined>(undefined);
  const parsed = searchParam(typed);

  // The search waits for the typing to stop, and only a valid one is sent.
  useEffect(() => {
    const id = setTimeout(() => {
      const next = searchParam(typed);
      // Only when the text changed: a new search starts at the first page.
      if ('q' in next) {
        setQuery(next.q);
        setOffset(0);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typed]);

  const list = usePoll(
    () => api.traders(t, ranking, PAGE, offset, query, sortParam),
    POLL_MS,
    `traders:${t}:${ranking}:${offset}:${query ?? ''}:${sortParam === undefined ? '' : `${sortParam.key}:${sortParam.direction}`}`,
  );
  const summary = usePoll(() => api.traderSummary(t), POLL_MS, `trader-summary:${t}`);
  const oi = usePoll(api.openInterest, POLL_MS, 'oi');

  const data = list.data?.data;
  const start = useHistoryStart();
  const window = data?.window ?? summary.data?.data.window;
  // TWO WINDOWS, ONE VISIBLE LABEL (9 Oct 2026). P&L, round trips and money in and out are summed over
  // WHOLE UTC DAYS: the label says the picked window like its neighbours, and the hover says which days.
  // At 24H, volume, trades and liquidations run over the ROLLING 24 hours, the Overview's window; at 7D
  // and 30D they are whole days too.
  const rolling = periodLabel(t, start);
  const windowed = wholeDaysLabel(t, start);
  const spanNote = window?.days === undefined ? '' : ` Summed over whole UTC days: ${window.label}.`;
  const rollingNote = window?.rollingFromMs === undefined ? undefined : ` Every fill and liquidation in the rolling 24 hours, the Overview's window, not day buckets.`;
  const activity = rollingNote === undefined ? windowed : rolling;
  const activityNote = rollingNote ?? spanNote;
  const floor = data?.minRoundTripsForRatios ?? 10;

  const choose = (next: TraderRanking) => {
    setOffset(0);
    setFlowSort(DEFAULT_FLOW_SORT);
    const nextParams = new URLSearchParams(params.toString());
    if (next === 'pnl') nextParams.delete('rank');
    else nextParams.set('rank', next);
    const qs = nextParams.toString();
    router.replace(qs === '' ? pathname : `${pathname}?${qs}`, { scroll: false });
  };

  const sortFlows = (column: 'netFlow' | 'deposits' | 'withdrawals') => {
    setOffset(0);
    setFlowSort((current) => nextFlowSort(current, column));
  };

  const flowColumns: readonly Column[] = [
    { key: 'account', label: 'Account (one wallet each)', sub: '', title: 'One Perpl account per row. Every account has its own owner wallet and no wallet holds two, so nothing is summed across accounts.' },
    { key: 'deposits', label: 'Deposits', sub: windowed, title: `Deposited into the account over the window, from the indexed deposit events.${spanNote}` },
    { key: 'withdrawals', label: 'Withdrawals', sub: windowed, title: `Withdrawn over the window, from the indexed withdrawal events.${spanNote}` },
    { key: 'netFlow', label: 'Net flow', sub: windowed, title: `Deposits − withdrawals. Never a change in balance, which also moves on PnL, funding, fees and liquidations.${spanNote}` },
  ];

  const tradeColumns: readonly Column[] = [
    { key: 'account', label: 'Account', sub: '' },
    { key: 'netPnl', label: 'Net PnL', sub: windowed, title: `Realised + funding − fees over the window.${spanNote}` },
    { key: 'volume', label: 'Volume', sub: activity, title: `The account’s own traded volume.${activityNote}` },
    { key: 'winRate', label: 'Win rate, before fees', sub: windowed, title: `Round trips won, by realised P&L plus funding BEFORE trading fees: Perpl's index records fees per account per day, not per position. Net PnL includes fees. Withheld below ${floor} round trips.${spanNote}` },
    { key: 'liquidations', label: 'Liquidations', sub: activity, title: `Count; how many were rescuable underneath. Margin lost and the largest free balance held on hover.${activityNote}` },
  ];
  const columns = flows ? flowColumns : tradeColumns;
  /** Which Flows header is the active order, and which way it points. */
  const flowActive = (key: Column['key']): { readonly arrow: string; readonly note?: string } | undefined => {
    if (key === 'netFlow' && flowSort.key === 'netFlowAbs') return { arrow: '↓', note: 'by size' };
    if (key === 'netFlow' && flowSort.key === 'netFlow') return { arrow: flowSort.direction === 'desc' ? '↓' : '↑', note: flowSort.direction === 'desc' ? 'inflows first' : 'outflows first' };
    if ((key === 'deposits' || key === 'withdrawals') && flowSort.key === key) return { arrow: flowSort.direction === 'desc' ? '↓' : '↑' };
    return undefined;
  };

  const range = data === undefined ? undefined : pageRange(data.offset, data.rows.length, data.total);

  return (
    <>
      <PageHeader
        title="Traders"
        subtitle="Every account the indexer has seen. Search an address, or sort the table."
        right={<TimeframePills />}
      />

      <ErrorNote error={summary.error} what="The trader totals" />
      <ErrorNote error={oi.error} what="Open interest" />
      <TraderCards summary={summary.data?.data} openInterest={oi.data?.data} period={rolling} wholeDays={windowed} wholeDaysTitle={wholeDaysTitle(t, start)} />

      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-[14px] py-[10px]">
          <div role="tablist" aria-label="Rank traders by" className="flex flex-wrap gap-[4px]">
            {RANKINGS.map((r) => (
              <button
                key={r.key}
                type="button"
                role="tab"
                aria-selected={r.key === ranking}
                onClick={() => choose(r.key)}
                // The shared segmented control (globals.css .seg): purple only when selected.
                className="seg whitespace-nowrap"
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-col items-end gap-[2px]">
            <label htmlFor="traders-search" className="sr-only">
              Search by address or account id
            </label>
            <div className="flex max-w-full items-center gap-[8px]">
            <input
              id="traders-search"
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search 0x address or account id"
              autoComplete="off"
              spellCheck={false}
              className="w-[260px] min-w-0 max-w-full rounded-[9px] border border-border2 bg-card2 px-[10px] py-[6px] text-[12.5px] text-text outline-none placeholder:text-muted focus:border-accent"
            />
            <ExportCsv timeframe={t} ranking={ranking} rankingLabel={info.label} query={query} sort={sortParam} />
            </div>
            {'invalid' in parsed && <span className="text-[11px] text-watch">{parsed.invalid}</span>}
          </div>
        </div>

        <div className="px-[14px] py-[8px] text-[12px] text-muted">
          {info.describe(floor)}
          {data?.belowFloor !== undefined && data.belowFloor > 0 && (
            <>
              {' '}
              <span className="text-text">
                {formatCount(data.total)} ranked; {formatCount(data.belowFloor)} with fewer than {formatCount(floor)} round trips are not.
              </span>{' '}
              Search finds any account.
            </>
          )}
          {data?.query !== undefined && <span className="text-text"> Showing matches for {data.query}.</span>}
        </div>

        <StaleMarker envelopes={[list.data, summary.data]} />
        <ErrorNote error={list.error} what="The traders list" />

        <div className="overflow-x-auto">
          <table className={`w-full table-fixed border-collapse text-[13px] ${flows ? 'min-w-[520px]' : 'min-w-[600px]'}`}>
            <colgroup>
              {columns.map((c) => (
                <col key={c.key} className={c.key === 'account' ? (flows ? 'w-[34%]' : 'w-[28%]') : flows ? 'w-[22%]' : 'w-[18%]'} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-y border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
                {flows && columns.map((c) => {
                  const active = flowActive(c.key);
                  const sortable = c.key === 'netFlow' || c.key === 'deposits' || c.key === 'withdrawals';
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      title={c.title}
                      aria-sort={active === undefined ? undefined : active.arrow === '↑' ? 'ascending' : 'descending'}
                      className={`px-[10px] py-[8px] font-semibold whitespace-nowrap align-bottom ${c.key === 'account' ? 'sticky left-0 z-[1] bg-card text-left' : 'text-right'} ${active !== undefined ? 'text-text' : ''}`}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          onClick={() => sortFlows(c.key as 'netFlow' | 'deposits' | 'withdrawals')}
                          className="cursor-pointer bg-transparent p-0 font-semibold tracking-[0.06em] text-inherit uppercase hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          {c.label}
                          <span className="ml-1" aria-hidden="true">{active?.arrow ?? '↕'}</span>
                        </button>
                      ) : (
                        c.label
                      )}
                      <span className="block text-[10px] font-medium normal-case tracking-normal whitespace-normal text-muted2">{active?.note ?? c.sub}</span>
                    </th>
                  );
                })}
                {!flows && columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.title}
                    aria-sort={c.key === info.column ? (ranking === 'losses' ? 'ascending' : 'descending') : undefined}
                    className={`px-[10px] py-[8px] font-semibold whitespace-nowrap align-bottom ${c.key === 'account' ? 'sticky left-0 z-[1] bg-card text-left' : 'text-right'} ${c.key === info.column ? 'text-text' : ''}`}
                  >
                    {c.label}
                    {c.key === info.column && <span className="ml-1" aria-hidden="true">{ranking === 'losses' ? '↑' : '↓'}</span>}
                    {c.sub !== '' && <span className="block text-[10px] font-medium normal-case tracking-normal whitespace-normal text-muted2">{c.sub}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data === undefined
                ? list.error === undefined &&
                  Array.from({ length: 10 }, (_, i) => (
                    <tr key={i} className="border-b border-border last:border-b-0">
                      {columns.map((c) => (
                        <td key={c.key} className={`px-[10px] py-[10px] ${c.key === 'account' ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                          <Skeleton className={`h-[14px] ${c.key === 'account' ? 'w-[110px]' : 'ml-auto w-[64px]'}`} />
                        </td>
                      ))}
                    </tr>
                  ))
                : data.rows.map((row) => (flows ? <FlowTableRow key={row.accountId} row={row} /> : <TraderTableRow key={row.accountId} row={row} floor={data.minRoundTripsForRatios} />))}
              {data !== undefined && data.rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="px-[10px] py-8 text-center text-muted">
                    <div className="text-[14px] font-semibold text-text">
                      {data.query !== undefined ? `No account matching ${data.query} is in the ${info.label} list ${inWholeDays(t, start)}.` : info.empty(inWholeDays(t, start))}
                    </div>
                    <div className="mt-1 text-[12.5px]">{data.query !== undefined ? 'Try Volume, which lists every account that traded, or widen the window.' : 'Widen the window, or choose another ranking.'}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-[14px] py-[10px] text-[11.5px] text-muted2">
          <span className="max-w-[80ch]">
            {flows ? (
              <>
                Deposits and withdrawals are the indexed deposit and withdrawal events, summed over whole UTC days{window?.days === undefined ? '' : ` (${window.label})`}. Net flow is
                deposits minus withdrawals, never a change in balance.
              </>
            ) : (
              <>
                Every column is summed over whole UTC days{window?.days === undefined ? '' : ` (${window.label})`}, because the per-trader record is kept by day. Win rate is
                withheld below {formatCount(floor)} round trips; the counts stay.
              </>
            )}
          </span>
          {range !== undefined && data !== undefined && data.total > 0 && (
            <span className="flex items-center gap-2">
              <span className="num">
                {formatCount(range.from)}–{formatCount(range.to)} of {formatCount(range.total)}
              </span>
              <button type="button" className="btn" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - PAGE))}>
                ← Previous
              </button>
              <button type="button" className="btn" disabled={data.offset + data.rows.length >= data.total} onClick={() => setOffset(data.offset + PAGE)}>
                Next →
              </button>
            </span>
          )}
        </div>
      </section>
    </>
  );
}

function TraderTableRow({ row, floor }: { readonly row: TraderRow; readonly floor: number }) {
  const cell = 'num px-[10px] py-[9px] text-right whitespace-nowrap align-top';
  const sign = (v: number) => (v > 0 ? 'text-safe' : v < 0 ? 'text-danger' : 'text-muted');
  const liquidationHover =
    row.liquidationCount === 0
      ? undefined
      : `${formatAusdExact(row.marginLostAusd)} margin lost` +
        (row.maxSpareHeldAusd === undefined ? '' : ` · up to ${formatAusdExact(row.maxSpareHeldAusd)} free at a rescuable liquidation`);
  return (
    <tr className="group border-b border-border last:border-b-0 hover:bg-card2">
      <AccountCell row={row} />
      <td className={`${cell} ${sign(row.netPnlAusd)}`} title={`${formatSignedExact(row.netPnlAusd)}`}>
        {formatSignedMoney(row.netPnlAusd)}
      </td>
      <td className={cell} title={`${formatAusdExact(row.volumeAusd)} · ${formatCount(row.tradeCount)} trades`}>
        {formatMoney(row.volumeAusd)}
      </td>
      <td className={cell}>
        {row.winRate === undefined ? (
          <span className="text-muted2" title={`${formatCount(row.wins)} wins of ${formatCount(row.roundTrips)}: under ${formatCount(floor)} round trips, so no rate`}>
            —<span className="block text-[11px]">under {formatCount(floor)} round trips</span>
          </span>
        ) : (
          <>
            {formatPct(row.winRate)}
            <span className="block text-[11px] text-muted2">
              {formatCount(row.wins)} of {formatCount(row.roundTrips)}
            </span>
          </>
        )}
      </td>
      <td className={cell} title={liquidationHover}>
        {formatCount(row.liquidationCount)}
        {row.liquidationCount > 0 && <span className="block text-[11px] text-watch">{formatCount(row.rescuableLiquidationCount)} rescuable</span>}
      </td>
    </tr>
  );
}

/** The account as every Traders view shows it: short address, copy button, account id under it. */
function AccountCell({ row }: { readonly row: TraderRow }) {
  return (
    <td className="sticky left-0 z-[1] bg-card px-[10px] py-[9px] whitespace-nowrap align-top group-hover:bg-card2">
      <Link href={`/traders/${row.accountId}`} className="num font-semibold text-text no-underline hover:text-accent-hi" title={row.address || `account #${row.accountId}`}>
        {row.address === '' ? `#${row.accountId}` : shortAddress(row.address)}
      </Link>
      {row.address !== '' && <CopyAddress address={row.address} />}
      <span className="block text-[11px] text-muted2">account #{formatCount(row.accountId)}</span>
    </td>
  );
}

/** One account's capital flow over the window. Net flow's colour carries the direction; zero is muted. */
function FlowTableRow({ row }: { readonly row: TraderRow }) {
  const cell = 'num px-[10px] py-[9px] text-right whitespace-nowrap align-top';
  const amount = (ausd: number) => (ausd === 0 ? <span className="text-muted2">$0</span> : formatMoney(ausd));
  const net = row.netFlowAusd;
  return (
    <tr className="group border-b border-border last:border-b-0 hover:bg-card2">
      <AccountCell row={row} />
      <td className={cell} title={`${formatAusdExact(row.depositedAusd)} deposited`}>{amount(row.depositedAusd)}</td>
      <td className={cell} title={`${formatAusdExact(row.withdrawnAusd)} withdrawn`}>{amount(row.withdrawnAusd)}</td>
      <td className={`${cell} font-semibold ${net > 0 ? 'text-safe' : net < 0 ? 'text-danger' : 'text-muted2'}`} title={`${formatSignedExact(net)}`}>
        {net === 0 ? '0' : `${net > 0 ? '+' : '−'}${formatMoney(Math.abs(net))}`}
      </td>
    </tr>
  );
}
