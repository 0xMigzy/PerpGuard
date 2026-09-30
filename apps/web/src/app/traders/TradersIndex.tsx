'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api.ts';
import { formatAusd, formatWhen } from '@/lib/format.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { parseTraderQuery } from '@/lib/traders.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';

const POLL_MS = 30_000;

export function TradersIndex() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const recent = usePoll(() => api.liquidations('7d', 12), POLL_MS, 'traders:recent-liquidations');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseTraderQuery(value);
    if (parsed.kind === 'invalid') {
      setProblem(parsed.reason);
      return;
    }
    router.push(`/traders/${encodeURIComponent(value.trim())}`);
  };

  return (
    <>
      <PageHeader title="Traders" subtitle="Any address or account id on Perpl: performance, open positions with their liquidation price, and liquidation history." />

      <form onSubmit={submit} className="card mb-4 px-[18px] py-4" role="search">
        <label htmlFor="trader-query" className="eyebrow">
          Address or account id
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id="trader-query"
            className="num min-w-0 flex-1 rounded-[9px] border border-border2 bg-page px-3 py-2 text-text outline-none placeholder:text-muted focus:border-accent"
            placeholder="0x… or 4734"
            spellCheck={false}
            autoComplete="off"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setProblem(undefined);
            }}
          />
          <button type="submit" className="btn primary">
            Look up
          </button>
        </div>
        {problem !== undefined && <div className="mt-2 text-[12.5px] text-danger">{problem}.</div>}
        <p className="mt-3 mb-0 max-w-[80ch] text-[12.5px] text-muted">
          Addresses match in any case. Most accounts predate the index and have no owner recorded, so an address may come back{' '}
          <b className="font-semibold text-text">not linked</b>: that is not an empty history, it is &ldquo;cannot see which account is yours&rdquo;. The account id
          always resolves.
        </p>
      </form>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Recently liquidated accounts</h2>
          <span className="text-[12.5px] text-muted">Last 7 days · a place to start</span>
        </div>
        <ErrorNote error={recent.error} what="Recent liquidations" />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {recent.data === undefined
            ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[58px] w-full" />)
            : recent.data.data.map((l) => (
                <Link
                  key={l.id}
                  href={`/traders/${l.accountId}`}
                  className="card flex items-center justify-between gap-3 px-[14px] py-[10px] no-underline hover:bg-card2"
                >
                  <span>
                    <b className="num text-text">#{l.accountId}</b>
                    <span className="ml-2 text-[12px] text-muted">
                      {l.market.symbol ?? `market ${l.market.marketId}`} {l.side} · {formatWhen(l.atMs)}
                    </span>
                  </span>
                  <span className="num text-right text-[12px]">
                    <span className="text-danger">−{formatAusd(l.marginLostAusd, 0)}</span>
                    <span className="ml-2 text-muted">{l.verdict === 'rescuable' ? 'rescuable' : l.verdict === 'unknown' ? 'unjudgeable' : 'not rescuable'}</span>
                  </span>
                </Link>
              ))}
          {recent.data !== undefined && recent.data.data.length === 0 && <div className="text-[12.5px] text-muted">No liquidation in the last 7 days.</div>}
        </div>
      </section>
    </>
  );
}
