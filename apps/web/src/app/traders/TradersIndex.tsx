'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SortDirection, TraderRow, TraderSortKey } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAge, formatAusd, formatAusdExact, formatCompact, formatCount, formatPct, formatSignedAusd, shortAddress } from '@/lib/format.ts';
import { PERIOD_LABEL } from '@/lib/timeframe.ts';
import { defaultTraderDirection, pageRange } from '@/lib/traders.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';

const POLL_MS = 30_000;
const PAGE = 50;

interface Column {
  readonly key: TraderSortKey | 'account';
  readonly label: string;
  /** A second, smaller line under the label: the period the column covers. */
  readonly sub?: string;
  /** Marks the sub-line amber when its period is not the page's timeframe. */
  readonly warn?: boolean;
  readonly title?: string | undefined;
  readonly align?: 'left' | 'right';
}

/**
 * Every account the indexer has seen, sorted and paged BY THE BACKEND. The
 * page never re-sorts a page: a sort is a new query, so the top of "volume
 * desc" is the top of the whole table and not the top of the fifty in hand.
 */
export function TradersIndex() {
  const t = useTimeframe();
  const [sort, setSort] = useState<TraderSortKey>('netPnl');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [offset, setOffset] = useState(0);

  const list = usePoll(() => api.traders(t, sort, direction, PAGE, offset), POLL_MS, `traders:${t}:${sort}:${direction}:${offset}`);
  const data = list.data?.data;
  const window = data?.window;
  // The column sub-label is short; the long form goes in the chip and the note.
  const windowed = window === undefined ? PERIOD_LABEL[t] : window.days === undefined ? 'all time' : `${formatCount(window.days)} UTC day${window.days === 1 ? '' : 's'}`;
  const warn = window !== undefined && !window.honoursTimeframe;
  const floor = data?.minRoundTripsForRatios;

  const sortBy = (key: TraderSortKey) => {
    setOffset(0);
    if (key === sort) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setDirection(defaultTraderDirection(key));
    }
  };

  const columns: readonly Column[] = [
    { key: 'account', label: 'Account', align: 'left' },
    { key: 'netPnl', label: 'Net PnL', sub: windowed, warn, title: 'Realised + funding − fees over the window.' },
    { key: 'volume', label: 'Volume', sub: windowed, warn },
    { key: 'roundTrips', label: 'Round trips', sub: windowed, warn, title: 'Positions taken from open to flat in the window.' },
    { key: 'winRate', label: 'Win rate', sub: windowed, warn, title: floor === undefined ? undefined : `Withheld below ${floor} round trips.` },
    { key: 'liquidations', label: 'Liquidations', sub: windowed, warn },
    { key: 'freeBalance', label: 'Free balance', sub: 'now', title: 'Spare AUSD in the account now. Isolated margin never reaches for it.' },
    { key: 'lastActive', label: 'Last active', sub: 'now' },
  ];

  const range = data === undefined ? undefined : pageRange(data.offset, data.rows.length, data.total);

  return (
    <>
      <PageHeader
        title="Traders"
        subtitle="Every account the indexer has seen. Search an address, or sort the table."
        right={
          <>
            {data !== undefined && <span className="chip" title={data.window.label}>{formatCount(data.total)} active · {windowed}</span>}
            <TimeframePills />
          </>
        }
      />

      <StaleMarker envelope={list.data} />
      <ErrorNote error={list.error} what="The traders list" />

      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
              {columns.map((c) => {
                const sortable = c.key !== 'account';
                const active = c.key === sort;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`px-[10px] py-[8px] font-semibold whitespace-nowrap align-bottom ${c.align === 'left' ? 'sticky left-0 z-[1] bg-card text-left' : 'text-right'}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => sortBy(c.key as TraderSortKey)}
                        title={c.title}
                        className={`cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit uppercase tracking-[0.06em] hover:text-text ${active ? 'text-text' : ''}`}
                      >
                        {c.label}
                        {active && <span className="ml-1">{direction === 'asc' ? '↑' : '↓'}</span>}
                        {c.sub !== undefined && <span className={`block text-[10px] font-medium normal-case tracking-normal ${c.warn ? 'text-watch' : 'text-muted2'}`}>{c.sub}</span>}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data === undefined
              ? Array.from({ length: 10 }, (_, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    {columns.map((c) => (
                      <td key={c.key} className={`px-[10px] py-[10px] ${c.align === 'left' ? 'sticky left-0 z-[1] bg-card' : ''}`}>
                        <Skeleton className={`h-[14px] ${c.key === 'account' ? 'w-[110px]' : 'ml-auto w-[64px]'}`} />
                      </td>
                    ))}
                  </tr>
                ))
              : data.rows.map((row) => <TraderTableRow key={row.accountId} row={row} floor={data.minRoundTripsForRatios} />)}
            {data !== undefined && data.rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-[10px] py-8 text-center text-muted">
                  <div className="text-[14px] font-semibold text-text">No trader was active in {windowed}.</div>
                  <div className="mt-1 text-[12.5px]">Widen the window, or search any address or account id above.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-muted2">
        <span className="max-w-[80ch]">
          {warn && (
            <>
              <b className="font-semibold text-watch">Windowed columns are summed over {window!.label}</b>, because the per-trader table is bucketed by UTC day and has no finer grain.{' '}
            </>
          )}
          Free balance, open positions and last active are the account now, whatever the window. Win rate is withheld below{' '}
          {floor === undefined ? '…' : formatCount(floor)} round trips: the counts are still shown, only the ratio is held back. An account whose owner was never
          recorded is listed by id; searching its address still resolves it through the Exchange contract.
        </span>
        {range !== undefined && data !== undefined && (
          <span className="flex items-center gap-2">
            <span className="num">
              {range.from === 0 ? '0' : `${formatCount(range.from)}–${formatCount(range.to)}`} of {formatCount(range.total)}
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
    </>
  );
}

function TraderTableRow({ row, floor }: { readonly row: TraderRow; readonly floor: number }) {
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  const pnlClass = row.netPnlAusd > 0 ? 'text-safe' : row.netPnlAusd < 0 ? 'text-danger' : 'text-muted';
  const handle = row.address === '' ? `#${row.accountId}` : shortAddress(row.address);
  return (
    <tr className="group border-b border-border last:border-b-0 hover:bg-card2">
      <td className="sticky left-0 z-[1] bg-card px-[10px] py-[10px] whitespace-nowrap group-hover:bg-card2">
        <Link href={`/traders/${row.accountId}`} className="num font-semibold text-text no-underline hover:text-accent-hi" title={row.address === '' ? 'owner not recorded; listed by account id' : row.address}>
          {handle}
        </Link>
        <span className="block text-[11px] text-muted2">account #{formatCount(row.accountId)}{row.openPositionCount > 0 ? ` · ${formatCount(row.openPositionCount)} open` : ''}</span>
      </td>
      <td className={`${cell} ${pnlClass}`} title={`${formatSignedAusd(row.netPnlAusd)} AUSD`}>{formatSignedAusd(row.netPnlAusd, 0)}</td>
      <td className={cell} title={`${formatAusdExact(row.volumeAusd)} AUSD · ${formatCount(row.tradeCount)} trades`}>{formatCompact(row.volumeAusd)}</td>
      <td className={cell}>{formatCount(row.roundTrips)}</td>
      <td className={cell}>
        {row.winRate === undefined ? (
          <span className="text-muted2" title={`${formatCount(row.wins)} wins of ${formatCount(row.roundTrips)}: under ${formatCount(floor)} round trips, so no rate`}>
            —<span className="block text-[11px]">under {formatCount(floor)} round trips</span>
          </span>
        ) : (
          <>
            {formatPct(row.winRate)}
            <span className="block text-[11px] text-muted2">{formatCount(row.wins)} of {formatCount(row.roundTrips)}</span>
          </>
        )}
      </td>
      <td className={cell} title={row.liquidationCount === 0 ? undefined : `${formatCount(row.rescuableLiquidationCount)} of ${formatCount(row.liquidationCount)} rescuable`}>
        {formatCount(row.liquidationCount)}
        {row.liquidationCount > 0 && <span className="block text-[11px] text-watch">{formatCount(row.rescuableLiquidationCount)} rescuable</span>}
      </td>
      <td className={cell} title={`${formatAusdExact(row.freeBalanceAusd)} AUSD`}>{formatAusd(row.freeBalanceAusd, 0)}</td>
      <td className={`${cell} text-muted`} title={new Date(row.lastActiveAtMs).toISOString()}>{formatAge(Date.now() - row.lastActiveAtMs)} ago</td>
    </tr>
  );
}
