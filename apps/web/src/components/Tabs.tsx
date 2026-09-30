'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Overview' },
  { href: '/markets', label: 'Markets' },
  { href: '/liquidations', label: 'Liquidations' },
  { href: '/wallets', label: 'Wallets' },
  { href: '/protect', label: 'Protect' },
  { href: '/alerts', label: 'Alerts' },
] as const;

export function Tabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto pt-2 pb-[10px]" aria-label="Sections">
      {TABS.map((tab) => {
        const active = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`tab whitespace-nowrap rounded-[9px] px-[13px] py-[7px] text-[13.5px] font-semibold no-underline ${
              active ? 'bg-card2 text-text' : 'text-muted hover:text-text'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
