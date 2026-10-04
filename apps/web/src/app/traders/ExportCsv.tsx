'use client';

import { useState } from 'react';
import type { Timeframe, TraderRanking, TraderRow } from '@perpguard/shared';
import { api } from '@/lib/api.ts';
import { formatCount } from '@/lib/format.ts';
import { tradersCsv } from '@/lib/traders.ts';

/** The backend's own page cap for the traders list. */
const EXPORT_PAGE = 200;

/**
 * Downloads the WHOLE of the current ranking for the current window (and
 * search, if one is active), not just the fifty on screen: it pages through
 * the same endpoint the table reads, in the backend's order.
 */
export function ExportCsv({
  timeframe,
  ranking,
  rankingLabel,
  query,
}: {
  readonly timeframe: Timeframe;
  readonly ranking: TraderRanking;
  readonly rankingLabel: string;
  readonly query: string | undefined;
}) {
  const [state, setState] = useState<{ readonly kind: 'idle' } | { readonly kind: 'busy'; readonly got: number; readonly total: number | undefined } | { readonly kind: 'failed' }>({ kind: 'idle' });

  const run = async () => {
    setState({ kind: 'busy', got: 0, total: undefined });
    try {
      const rows: TraderRow[] = [];
      const seen = new Set<number>();
      let total = Infinity;
      let window = '';
      for (let offset = 0; offset < total; offset += EXPORT_PAGE) {
        const page = (await api.traders(timeframe, ranking, EXPORT_PAGE, offset, query)).data;
        total = page.total;
        window = page.window.label;
        // A cache refresh between pages can shift a row; never write one twice.
        for (const r of page.rows) if (!seen.has(r.accountId)) (seen.add(r.accountId), rows.push(r));
        setState({ kind: 'busy', got: rows.length, total });
        if (page.rows.length === 0) break;
      }
      const blob = new Blob([tradersCsv(rows, rankingLabel, window)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `perpguard-traders-${ranking}-${timeframe}${query === undefined ? '' : `-${query}`}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState({ kind: 'idle' });
    } catch {
      setState({ kind: 'failed' });
      setTimeout(() => setState({ kind: 'idle' }), 3000);
    }
  };

  const busy = state.kind === 'busy';
  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      aria-label={`Download the ${rankingLabel} ranking as CSV`}
      title="Every row of this ranking and window, not just this page"
      className="inline-flex h-[30px] shrink-0 items-center gap-[6px] rounded-[9px] border border-border2 bg-card2 px-[10px] text-[12.5px] font-semibold text-muted hover:border-accent hover:text-text disabled:cursor-wait disabled:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" />
      </svg>
      {state.kind === 'busy' ? (state.total === undefined ? 'Preparing…' : `${formatCount(state.got)} of ${formatCount(state.total)}`) : state.kind === 'failed' ? <span className="text-danger">Failed</span> : 'CSV'}
      <span className="sr-only" aria-live="polite">
        {state.kind === 'failed' ? 'Export failed' : ''}
      </span>
    </button>
  );
}
