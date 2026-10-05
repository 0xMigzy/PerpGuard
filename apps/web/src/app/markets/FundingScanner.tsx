'use client';

import { useMemo, useState } from 'react';
import type { FundingVenueId, VenueFundingStatus } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatAge, formatFundingPct } from '@/lib/format.ts';
import type { FundingHeatmap as HeatModel } from '@/lib/funding.ts';
import { formatAprCell, formatInterval, formatPts, SCANNER_VENUES, scannerRows, VENUE_NAME, type ScannerCell, type ScannerMode, type ScannerRow } from '@/lib/fundingScanner.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { MarketName } from '@/components/TokenIcon.tsx';

const POLL_MS = 60_000;

/** Which "current" each column is: three different things, said in the header. */
const CURRENT: Readonly<Record<FundingVenueId | 'perpl', string>> = {
  perpl: 'last applied rate',
  hyperliquid: 'estimate for the hour in progress',
  binance: 'estimate for the next settlement',
};

const SOURCES: Readonly<Record<FundingVenueId, { readonly href: string; readonly text: string }>> = {
  hyperliquid: { href: 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding', text: 'public info API, metaAndAssetCtxs' },
  binance: { href: 'https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price', text: 'USDⓈ-M Futures public API, premiumIndex and fundingInfo, USDT contracts' },
};

/**
 * Funding across venues, below the heatmap. Perpl's APR is the heatmap's own
 * (`HeatRow.aprPct`); the other venues come from the backend, which calls them
 * and caches them. This browser never calls Hyperliquid or Binance.
 */
export function FundingScanner({ heat }: { readonly heat: HeatModel | undefined }) {
  const venues = usePoll(api.venueFunding, POLL_MS, 'venue-funding');
  const [mode, setMode] = useState<ScannerMode>('raw');
  const payload = venues.data?.data;

  const rows = useMemo(() => {
    if (heat === undefined || payload === undefined) return undefined;
    const perpl = heat.rows.map((r) => ({
      marketId: r.marketId,
      symbol: r.symbol,
      ratePct: r.currentRatePct,
      intervalSec: r.cadence?.venueIntervalSec ?? r.cadence?.measuredIntervalSec,
      aprPct: r.aprPct,
    }));
    return scannerRows(perpl, payload, mode);
  }, [heat, payload, mode]);

  const now = Date.now();
  const strip = mode === 'like-for-like';

  return (
    <section className="card mt-4 px-[18px] py-4" aria-label="Funding across venues">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-[10px]">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">
          Funding across venues <span className="ml-1 text-[12.5px] font-medium text-muted">APR now · Perpl markets also listed on Hyperliquid or Binance</span>
        </h2>
      </div>

      {/* ABOVE the numbers on purpose: read top to bottom, this comes first. */}
      <p className="mt-0 mb-3 border-l-2 border-accent pl-[10px] text-[13px] leading-[1.55] text-text">
        Perpl&rsquo;s funding formula has no interest term. Hyperliquid&rsquo;s and Binance&rsquo;s add 0.01% per 8 hours (10.95% a year), so on quiet markets Perpl sits
        about 11 points below both. That gap is structural, not an opportunity.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="button" className="seg" aria-pressed={strip} onClick={() => setMode(strip ? 'raw' : 'like-for-like')}>
          <span aria-hidden className="inline-block w-[12px] text-center">{strip ? '✓' : ''}</span>
          Strip the 0.01%/8h interest term from Hyperliquid and Binance
        </button>
        <span className="text-[12px] text-muted">
          {strip
            ? 'Like-for-like: each Hyperliquid and Binance APR minus its own interest term. Perpl is unchanged; it has none.'
            : 'Raw: what a trader on each venue pays or receives, interest term included.'}
        </span>
      </div>

      <ErrorNote error={venues.error} what="Other venues' funding" />

      {rows === undefined ? (
        venues.error === undefined && <Skeleton className="h-[220px] w-full" />
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-[12.5px] text-muted">No live Perpl market is listed on Hyperliquid or Binance right now, so there is nothing to compare.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <caption className="sr-only">
              Funding APR per market on Perpl, Hyperliquid and Binance, {strip ? 'with the interest term stripped from Hyperliquid and Binance' : 'raw'}, sorted by the size of the spread
            </caption>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-[1] bg-card text-left">
                  Market
                </th>
                <ColumnHead label="Perpl APR" current={CURRENT.perpl} />
                {SCANNER_VENUES.map((v) => (
                  <ColumnHead key={v} label={`${VENUE_NAME[v]} APR`} current={CURRENT[v]} status={payload!.venues[v]} now={now} />
                ))}
                <th scope="col" className="text-right align-bottom">
                  Spread vs best
                  <span className="block text-[10.5px] font-medium tracking-normal normal-case text-muted2">Perpl minus the furthest venue</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.marketId} row={row} strip={strip} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 text-[11.5px] leading-[1.55] text-muted2">
        <b className="font-semibold text-muted">APR</b> is simple: the current rate × settlements a year (Perpl every ~43 min, Hyperliquid hourly, Binance every 4 or 8 hours
        per contract), not compounded, and it assumes the rate holds. Positive: longs pay shorts. Markets are matched by ticker and confirmed by price, within 5%; a venue
        that does not list a market is an empty cell, never 0. Spread is in percentage points, sorted largest first.{' '}
        <b className="font-semibold text-muted">Sources.</b> Perpl: PerpGuard&rsquo;s index of on-chain funding settlements, interval from Perpl&rsquo;s API context.{' '}
        {SCANNER_VENUES.map((v) => (
          <span key={v}>
            {VENUE_NAME[v]}:{' '}
            <a className="underline decoration-border2 underline-offset-2 hover:text-text" href={SOURCES[v].href} target="_blank" rel="noreferrer">
              {SOURCES[v].text}
            </a>
            .{' '}
          </span>
        ))}
        Fetched by PerpGuard&rsquo;s server at most once a minute while someone is reading, never from your browser.
      </div>
    </section>
  );
}

function ColumnHead({ label, current, status, now }: { readonly label: string; readonly current: string; readonly status?: VenueFundingStatus; readonly now?: number }) {
  const age = status?.lastGoodAtMs === undefined || now === undefined ? undefined : formatAge(now - status.lastGoodAtMs);
  return (
    <th scope="col" className="text-right align-bottom">
      {label}
      <span className="block text-[10.5px] font-medium tracking-normal normal-case text-muted2">{current}</span>
      {status !== undefined &&
        (status.state === 'unavailable' ? (
          <span className="block text-[10.5px] font-semibold tracking-normal normal-case text-watch">
            unavailable · {age === undefined ? 'no good reading yet' : `last good figure ${age} ago`}
          </span>
        ) : (
          <span className={`block text-[10.5px] font-medium tracking-normal normal-case ${status.error === undefined ? 'text-muted2' : 'text-watch'}`}>
            as of {age} ago{status.error === undefined ? '' : ' · last refresh failed'}
          </span>
        ))}
    </th>
  );
}

function Row({ row, strip }: { readonly row: ScannerRow; readonly strip: boolean }) {
  const p = row.perpl;
  return (
    <tr>
      <th scope="row" className="sticky left-0 z-[1] bg-card text-left text-[13px] font-semibold tracking-normal normal-case whitespace-nowrap text-text">
        <MarketName symbol={row.symbol} size={18} />
      </th>
      <td className="num text-right whitespace-nowrap">
        {p.aprPct === undefined ? (
          <span className="text-muted2" title="No settlement indexed yet">
            no settlement
          </span>
        ) : (
          <>
            {formatAprCell(p.aprPct)}
            <Sub>{p.ratePct === undefined || p.intervalSec === undefined ? '' : `${formatFundingPct(p.ratePct)} per ${formatInterval(p.intervalSec)}`}</Sub>
          </>
        )}
      </td>
      {SCANNER_VENUES.map((v) => (
        <VenueCell key={v} venue={v} cell={row.venues[v]} strip={strip} />
      ))}
      <td className="num text-right whitespace-nowrap">
        {row.spread === undefined ? (
          <span className="text-muted2">—</span>
        ) : (
          <>
            <span className="font-semibold">{formatPts(row.spread.pts)}</span>
            <Sub>{Math.abs(row.spread.pts) < 0.005 ? 'level with both' : `vs ${VENUE_NAME[row.spread.vs]}`}</Sub>
          </>
        )}
      </td>
    </tr>
  );
}

function VenueCell({ venue, cell: { cell, aprPct }, strip }: { readonly venue: FundingVenueId; readonly cell: ScannerCell; readonly strip: boolean }) {
  const td = 'num text-right whitespace-nowrap';
  switch (cell.kind) {
    case 'not-listed':
      return (
        <td className={td}>
          <span className="text-muted2" title={`${VENUE_NAME[venue]} lists no contract for this market`}>
            not listed
          </span>
        </td>
      );
    case 'different-asset':
      return (
        <td className={td}>
          <span className="text-muted2" title={`${cell.instrument} trades at ${cell.markPrice}, more than 5% from Perpl's mark: the same ticker, a different asset. Not compared.`}>
            different asset
          </span>
        </td>
      );
    case 'unavailable':
      return (
        <td className={td}>
          <span className="text-muted2">unavailable</span>
        </td>
      );
    case 'quote':
      return (
        <td className={td} title={`${cell.instrument}${cell.intervalSource === 'measured' ? ', interval measured from its settlement history' : ''}`}>
          {aprPct === undefined ? <span className="text-muted2">interval unknown</span> : formatAprCell(aprPct)}
          <Sub>
            {formatFundingPct(cell.ratePct)}
            {cell.intervalSec === undefined ? '' : ` per ${formatInterval(cell.intervalSec)}`}
            {strip && aprPct !== undefined && ` · less ${cell.interestAprPct.toFixed(2)} pts interest`}
          </Sub>
        </td>
      );
  }
}

function Sub({ children }: { readonly children: React.ReactNode }) {
  return <span className="block text-[11px] text-muted2">{children}</span>;
}

