'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DEFAULT_TIMEFRAME, TIMEFRAMES, TIMEFRAME_LABEL, timeframeFromQuery, type Timeframe } from '@/lib/timeframe.ts';

/**
 * Reads `?t=` so every timeframe is a deep link. ONE CONTROL PER SECTION: the
 * value read here governs every figure on the page, and there are no per-panel
 * pills anywhere.
 */
export function useTimeframe(): Timeframe {
  const params = useSearchParams();
  return timeframeFromQuery(params.get('t'), DEFAULT_TIMEFRAME);
}

/**
 * `labels` renames a pill on a page whose window is not what the shared label
 * says (Traders counts whole UTC days, so its 24H is "2D"). The value, and so
 * the URL and the query, is unchanged.
 */
export function TimeframePills({ labels }: { readonly labels?: Partial<Record<Timeframe, { readonly text: string; readonly title: string }>> } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = timeframeFromQuery(params.get('t'), DEFAULT_TIMEFRAME);
  const select = (t: Timeframe) => {
    const next = new URLSearchParams(params.toString());
    if (t === DEFAULT_TIMEFRAME) next.delete('t');
    else next.set('t', t);
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  };
  return (
    <div className="tf-group inline-flex gap-[2px] rounded-[10px] border border-border2 bg-card p-[3px]" role="group" aria-label="Timeframe">
      {TIMEFRAMES.map((t) => (
        <button
          key={t}
          type="button"
          className={`pill tf-pill rounded-[8px] border-0 px-3 py-[6px] text-[12.5px] font-semibold ${
            t === current ? 'bg-accent-deep text-white' : 'bg-transparent text-muted hover:text-text'
          }`}
          aria-pressed={t === current}
          onClick={() => select(t)}
          title={labels?.[t]?.title}
        >
          {labels?.[t]?.text ?? TIMEFRAME_LABEL[t]}
        </button>
      ))}
    </div>
  );
}
