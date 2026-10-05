'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { STATUS_FILTERS, statusFromQuery, type StatusFilter } from '@/lib/markets.ts';

const LABEL: Record<StatusFilter, string> = { all: 'All', live: 'Live', upcoming: 'Upcoming' };

/** `?status=`, so a filtered table is a deep link. The default, All, stays out of the URL. */
export function useStatusFilter(): StatusFilter {
  return statusFromQuery(useSearchParams().get('status'));
}

/** All | Live | Upcoming, in the timeframe control's look. Filters the table only. */
export function StatusPills({ counts }: { readonly counts: Readonly<Record<StatusFilter, number>> | undefined }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = statusFromQuery(params.get('status'));
  const select = (s: StatusFilter) => {
    const next = new URLSearchParams(params.toString());
    if (s === 'all') next.delete('status');
    else next.set('status', s);
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  };
  return (
    <div className="tf-group inline-flex gap-[2px] rounded-[10px] border border-border2 bg-card p-[3px]" role="group" aria-label="Market status">
      {STATUS_FILTERS.map((s) => (
        <button
          key={s}
          type="button"
          className={`pill tf-pill rounded-[8px] border-0 px-3 py-[6px] text-[12.5px] font-semibold ${s === current ? 'bg-accent-deep text-white' : 'bg-transparent text-muted hover:text-text'}`}
          aria-pressed={s === current}
          onClick={() => select(s)}
        >
          {LABEL[s]}
          {counts !== undefined && <span className={`ml-[6px] num text-[11px] ${s === current ? 'text-white/70' : 'text-muted2'}`}>{counts[s]}</span>}
        </button>
      ))}
    </div>
  );
}
