'use client';

import { useState } from 'react';
import { api } from '@/lib/api.ts';
import { FILLS_CSV_CAP, FILLS_LIST_CAP, FILLS_STEP, fillsCsv, moreFills, nextFillsLimit } from '@/lib/fills.ts';
import { formatAusd, formatAusdExact, formatCount, formatPriceAsServed, formatWhen } from '@/lib/format.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { MarketName } from '@/components/TokenIcon.tsx';

const POLL_MS = 30_000;

/**
 * Every fill the account took part in, newest first. A fill records the
 * account's role, not its side or action, and only the maker's fee; the tab
 * says so rather than showing columns it cannot fill.
 */
export function FillsPanel({ accountId }: { readonly accountId: number }) {
  const [limit, setLimit] = useState(FILLS_STEP);
  const page = usePoll(() => api.accountFills(accountId, limit), POLL_MS, `fills:${accountId}:${limit}`);
  const fills = page.data?.data.fills;
  const cell = 'num px-[10px] py-[9px] text-right whitespace-nowrap';
  return (
    <>
      <ErrorNote error={page.error} what="Trades" />
      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col" className="text-left">Time (UTC)</th>
              <th scope="col" className="text-left">Market</th>
              <th scope="col" className="text-left" title="Maker: this account's resting order was filled. Taker: this account's order took liquidity.">Role</th>
              <th scope="col" className="text-right">Size</th>
              <th scope="col" className="text-right">Price</th>
              <th scope="col" className="text-right">Notional</th>
              <th scope="col" className="text-right" title="The maker's fee is recorded per fill; the taker's is not.">Maker fee</th>
            </tr>
          </thead>
          <tbody>
            {fills === undefined ? (
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i}>
                  <td colSpan={7}>
                    <Skeleton className="h-[14px] w-full" />
                  </td>
                </tr>
              ))
            ) : fills.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-[12.5px] text-muted">
                  No fill is indexed for this account.
                </td>
              </tr>
            ) : (
              fills.map((f) => (
                <tr key={`${f.id}-${f.role}`}>
                  <td className="num px-[10px] py-[9px] whitespace-nowrap text-muted" title={new Date(f.atMs).toISOString()}>
                    {formatWhen(f.atMs)}
                  </td>
                  <td className="px-[10px] py-[9px] font-semibold whitespace-nowrap">
                    <MarketName symbol={f.market.symbol ?? f.market.indexerName} size={16} />
                  </td>
                  <td className="px-[10px] py-[9px] whitespace-nowrap">{f.role}</td>
                  <td className={cell}>{formatPriceAsServed(f.sizeLots)}</td>
                  <td className={cell}>{f.price === undefined ? <span className="text-muted2">—</span> : formatPriceAsServed(f.price)}</td>
                  <td className={cell}>{formatAusd(f.notionalAusd)}</td>
                  <td className={cell}>{f.makerFeeAusd === undefined ? <span className="text-muted2" title="A taker's fee is not recorded per fill">—</span> : formatAusdExact(f.makerFeeAusd)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-muted2">
        <span className="max-w-[760px]">
          Every fill this account took part in, newest first, in AUSD. A fill records the account&rsquo;s role, not its side or action; side, entry and realised PnL are per
          position, on the Round trips tab. Only the maker&rsquo;s fee is recorded per fill. About 6% of fills have no taker the index could pair within its transaction, so a
          taker&rsquo;s list can miss them.
        </span>
        <span className="flex items-center gap-2">
          {fills !== undefined && moreFills(fills.length, page.data!.data.hasMore) && (
            <button type="button" className="btn" onClick={() => setLimit(nextFillsLimit(limit))}>
              Show more
            </button>
          )}
          {fills !== undefined && fills.length >= FILLS_LIST_CAP && page.data!.data.hasMore && <span>Showing the newest {formatCount(FILLS_LIST_CAP)}; the CSV has more.</span>}
          <ExportFills accountId={accountId} />
        </span>
      </div>
    </>
  );
}

function ExportFills({ accountId }: { readonly accountId: number }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const run = async () => {
    setState('busy');
    try {
      const { fills } = (await api.accountFills(accountId, FILLS_CSV_CAP)).data;
      const url = URL.createObjectURL(new Blob([fillsCsv(accountId, fills)], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `perpguard-account-${accountId}-fills-newest-${fills.length}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState('idle');
    } catch {
      setState('failed');
      setTimeout(() => setState('idle'), 3000);
    }
  };
  return (
    <button type="button" className="btn" onClick={() => void run()} disabled={state === 'busy'} title={`Downloads the newest ${formatCount(FILLS_CSV_CAP)} fills at most`}>
      {state === 'busy' ? 'Preparing…' : state === 'failed' ? 'Export failed, try again' : `CSV (newest ${formatCount(FILLS_CSV_CAP)})`}
    </button>
  );
}
