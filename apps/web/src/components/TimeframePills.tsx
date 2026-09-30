'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TIMEFRAMES, TIMEFRAME_LABEL, timeframeFromQuery, type Timeframe } from '@/lib/timeframe.ts';

/** Reads and writes `?t=` so every timeframe is a deep link. */
export function useTimeframe(fallback: Timeframe): Timeframe {
  const params = useSearchParams();
  return timeframeFromQuery(params.get('t'), fallback);
}

export function TimeframePills({ fallback }: { readonly fallback: Timeframe }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = timeframeFromQuery(params.get('t'), fallback);
  const select = (t: Timeframe) => {
    const next = new URLSearchParams(params.toString());
    if (t === fallback) next.delete('t');
    else next.set('t', t);
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  };
  return (
    <div className="inline-flex gap-[2px] rounded-[10px] border border-border2 bg-card p-[3px]" role="group" aria-label="Timeframe">
      {TIMEFRAMES.map((t) => (
        <button
          key={t}
          type="button"
          className={`pill rounded-[8px] border-0 bg-transparent px-3 py-[6px] text-[12.5px] font-semibold ${
            t === current ? 'bg-card2 text-text shadow-[inset_0_0_0_1px_#262A38]' : 'text-muted hover:text-text'
          }`}
          aria-pressed={t === current}
          onClick={() => select(t)}
        >
          {TIMEFRAME_LABEL[t]}
        </button>
      ))}
    </div>
  );
}
