'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { isTimeframe } from '@/lib/timeframe.ts';

/**
 * The six sections, in funnel order: protocol-wide at the top, the alert
 * product at the bottom. Nothing here is gated.
 */
export const SECTIONS = [
  { href: '/', label: 'Overview', timeframed: true },
  { href: '/markets', label: 'Markets', timeframed: true },
  { href: '/traders', label: 'Traders', timeframed: true },
  { href: '/liquidations', label: 'Liquidations', timeframed: true },
  { href: '/risk', label: 'Risk', timeframed: false },
  { href: '/alerts', label: 'Alerts', timeframed: false },
] as const;

export function Tabs() {
  const pathname = usePathname();
  const params = useSearchParams();
  // The selected window follows the reader between the timeframed sections,
  // so 7D on Overview is still 7D on Markets. Risk and Alerts have no window.
  const t = params.get('t');
  const carry = isTimeframe(t) ? `?t=${t}` : '';
  return (
    <nav className="flex gap-1 overflow-x-auto pt-2 pb-[10px]" aria-label="Sections" role="tablist">
      {SECTIONS.map((tab) => {
        const active = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.timeframed ? `${tab.href}${carry}` : tab.href}
            role="tab"
            aria-selected={active}
            aria-current={active ? 'page' : undefined}
            className={`tab whitespace-nowrap rounded-[9px] px-[13px] py-[7px] text-[13.5px] font-semibold no-underline ${
              active ? 'bg-card2 text-text shadow-[inset_0_0_0_1px_#262A38]' : 'text-muted hover:text-text'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
