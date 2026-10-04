'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { TraderRanking, TraderRow } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAge, formatAusd, formatAusdExact, formatCompact, formatCount, formatPct, formatSignedAusd, shortAddress } from '@/lib/format.ts';
import { inPeriod, periodLabel } from '@/lib/history.ts';
import { useHistoryStart } from '@/lib/useHistory.ts';
import { RANKINGS, pageRange, rankingFromQuery, rankingInfo, searchParam, unrealisedByAccount, type RankedColumn } from '@/lib/traders.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StaleMarker } from '@/components/StaleMarker.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { CopyAddress } from './CopyAddress.tsx';
import { TraderCards } from './TraderCards.tsx';

const POLL_MS = 30_000;
const PAGE = 50;
const SEARCH_DEBOUNCE_MS = 300;

interface Column {
  readonly key: 'account' | RankedColumn | 'roundTrips' | 'winRate' | 'freeBalance' | 'openPositions' | 'lastActive';
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

  const list = usePoll(() => api.traders(t, ranking, PAGE, offset, query), POLL_MS, `traders:${t}:${ranking}:${offset}:${query ?? ''}`);
  const summary = usePoll(() => api.traderSummary(t), POLL_MS, `trader-summary:${t}`);
  const risk = usePoll(() => api.risk(), POLL_MS, 'risk');
  const unrealised = useMemo(() => (risk.data === undefined ? undefined : unrealisedByAccount(risk.data.data.positions)), [risk.data]);

  const data = list.data?.data;
  const start = useHistoryStart();
  const window = data?.window ?? summary.data?.data.window;
  const period = periodLabel(t, start);
  // Day buckets: "24h" is today and yesterday so far, and the column says so.
  const windowed = window === undefined || window.days === undefined ? period : `${formatCount(window.days)} UTC day${window.days === 1 ? '' : 's'}`;
  const floor = data?.minRoundTripsForRatios ?? 10;

  const choose = (next: TraderRanking) => {
    setOffset(0);
    const nextParams = new URLSearchParams(params.toString());
    if (next === 'pnl') nextParams.delete('rank');
    else nextParams.set('rank', next);
    const qs = nextParams.toString();
    router.replace(qs === '' ? pathname : `${pathname}?${qs}`, { scroll: false });
  };

  const columns: readonly Column[] = [
    { key: 'account', label: 'Account', sub: '' },
    { key: 'netPnl', label: 'Net PnL', sub: windowed, title: 'Realised + funding − fees over the window.' },
    { key: 'volume', label: 'Volume', sub: windowed, title: 'The account’s own traded volume.' },
    { key: 'roundTrips', label: 'Round trips', sub: windowed, title: 'Positions taken from open to flat in the window.' },
    { key: 'winRate', label: 'Win rate', sub: windowed, title: `Withheld below ${floor} round trips.` },
    { key: 'liquidations', label: 'Liquidations', sub: windowed, title: 'Count; how many were rescuable underneath. Margin lost and the largest free balance held on hover.' },
    { key: 'freeBalance', label: 'Free balance', sub: 'now', title: 'Spare AUSD in the account now. Isolated margin never reaches for it.' },
    { key: 'openPositions', label: 'Open positions', sub: 'now', title: 'Count, and their combined unrealised PnL at the venue’s marks.' },
    { key: 'lastActive', label: 'Last active', sub: 'now' },
  ];

  const range = data === undefined ? undefined : pageRange(data.offset, data.rows.length, data.total);
  const traders = summary.data?.data.traders;

  return (
    <>
      <PageHeader
        title="Traders"
        subtitle="Every account the indexer has seen. Search an address, or sort the table."
        right={
          <>
            {traders !== undefined && (
              <span className="chip" title={`${formatCount(traders)} accounts with at least one trade over ${window?.label ?? period}`}>
                {formatCount(traders)} active · {windowed}
              </span>
            )}
            <TimeframePills />
          </>
        }
      />

      <ErrorNote error={summary.error} what="The trader totals" />
      <TraderCards summary={summary.data?.data} risk={risk.data?.data} period={period} />

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
                className={`rounded-[7px] border px-[10px] py-[5px] text-[12.5px] font-semibold whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  r.key === ranking ? 'border-accent bg-accent/15 text-text' : 'border-border2 bg-transparent text-muted hover:text-text'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-col items-end gap-[2px]">
            <label htmlFor="traders-search" className="sr-only">
              Search by address or account id
            </label>
            <input
              id="traders-search"
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search 0x address or account id"
              autoComplete="off"
              spellCheck={false}
              className="w-[260px] max-w-full rounded-[9px] border border-border2 bg-card2 px-[10px] py-[6px] text-[12.5px] text-text outline-none placeholder:text-muted focus:border-accent"
            />
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

        <StaleMarker envelope={list.data} />
        <ErrorNote error={list.error} what="The traders list" />

        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-[13px]">
            <thead>
              <tr className="border-y border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    title={c.title}
                    aria-sort={c.key === info.column ? (ranking === 'losses' ? 'ascending' : 'descending') : undefined}
                    className={`px-[10px] py-[8px] font-semibold whitespace-nowrap align-bottom ${c.key === 'account' ? 'sticky left-0 z-[1] bg-card text-left' : 'text-right'} ${c.key === info.column ? 'text-text' : ''}`}
                  >
                    {c.label}
                    {c.key === info.column && <span className="ml-1" aria-hidden="true">{ranking === 'losses' ? '↑' : '↓'}</span>}
                    {c.sub !== '' && <span className="block text-[10px] font-medium normal-case tracking-normal text-muted2">{c.sub}</span>}
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
                : data.rows.map((row) => (
                    <TraderTableRow key={row.accountId} row={row} floor={data.minRoundTripsForRatios} spareMode={ranking === 'spare'} unrealised={unrealised?.get(row.accountId)} riskLoaded={unrealised !== undefined} />
                  ))}
              {data !== undefined && data.rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="px-[10px] py-8 text-center text-muted">
                    <div className="text-[14px] font-semibold text-text">
                      {data.query !== undefined ? `No account matching ${data.query} is in the ${info.label} list ${inPeriod(t, start)}.` : info.empty(inPeriod(t, start))}
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
            Windowed columns are summed over whole UTC days{window?.days === undefined ? '' : ` (${window.label})`}, because the per-trader record is kept by day. Free
            balance, open positions and last active are the account now. Win rate is withheld below {formatCount(floor)} round trips; the counts stay.
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

function TraderTableRow({
  row,
  floor,
  spareMode,
  unrealised,
  riskLoaded,
}: {
  readonly row: TraderRow;
  readonly floor: number;
  readonly spareMode: boolean;
  readonly unrealised: { readonly ausd: number; readonly positions: number } | undefined;
  readonly riskLoaded: boolean;
}) {
  const cell = 'num px-[10px] py-[9px] text-right whitespace-nowrap align-top';
  const sign = (v: number) => (v > 0 ? 'text-safe' : v < 0 ? 'text-danger' : 'text-muted');
  const lowSample = row.roundTrips < floor;
  const liquidationHover =
    row.liquidationCount === 0
      ? undefined
      : `${formatAusdExact(row.marginLostAusd)} AUSD margin lost` +
        (row.maxSpareHeldAusd === undefined ? '' : ` · up to ${formatAusdExact(row.maxSpareHeldAusd)} AUSD free at a rescuable liquidation`);
  return (
    <tr className="group border-b border-border last:border-b-0 hover:bg-card2">
      <td className="sticky left-0 z-[1] bg-card px-[10px] py-[9px] whitespace-nowrap align-top group-hover:bg-card2">
        <Link href={`/traders/${row.accountId}`} className="num font-semibold text-text no-underline hover:text-accent-hi" title={row.address || `account #${row.accountId}`}>
          {row.address === '' ? `#${row.accountId}` : shortAddress(row.address)}
        </Link>
        {row.address !== '' && <CopyAddress address={row.address} />}
        <span className="block text-[11px] text-muted2">account #{formatCount(row.accountId)}</span>
      </td>
      <td className={`${cell} ${sign(row.netPnlAusd)}`} title={`${formatSignedAusd(row.netPnlAusd)} AUSD`}>
        {formatSignedAusd(row.netPnlAusd, 0)}
      </td>
      <td className={cell} title={`${formatAusdExact(row.volumeAusd)} AUSD · ${formatCount(row.tradeCount)} trades`}>
        {formatCompact(row.volumeAusd)}
      </td>
      <td className={cell}>
        {formatCount(row.roundTrips)}
        {lowSample && <span className="block text-[11px] text-watch">low sample</span>}
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
        {row.liquidationCount > 0 && (
          <span className="block text-[11px] text-watch">
            {formatCount(row.rescuableLiquidationCount)} rescuable
            {spareMode && row.maxSpareHeldAusd !== undefined && ` · held up to ${formatAusd(row.maxSpareHeldAusd, 0)}`}
          </span>
        )}
      </td>
      <td className={cell} title={`${formatAusdExact(row.freeBalanceAusd)} AUSD`}>
        {formatAusd(row.freeBalanceAusd, 0)}
      </td>
      <td className={cell}>
        {formatCount(row.openPositionCount)}
        {row.openPositionCount > 0 &&
          (unrealised !== undefined ? (
            <span className={`block text-[11px] ${sign(unrealised.ausd)}`} title={`${formatSignedAusd(unrealised.ausd)} AUSD unrealised across ${formatCount(unrealised.positions)} priced`}>
              {Math.abs(unrealised.ausd) < 0.5 ? (unrealised.ausd === 0 ? '0' : formatSignedAusd(unrealised.ausd, 2)) : formatSignedAusd(unrealised.ausd, 0)} unrealised
            </span>
          ) : (
            <span className="block text-[11px] text-muted2">{riskLoaded ? 'not priced' : '…'}</span>
          ))}
      </td>
      <td className={`${cell} text-muted`} title={new Date(row.lastActiveAtMs).toISOString()}>
        {formatAge(Date.now() - row.lastActiveAtMs)} ago
      </td>
    </tr>
  );
}
