import Link from 'next/link';
import { Search } from './Search.tsx';
import { StatusDot } from './StatusDot.tsx';
import { Tabs } from './Tabs.tsx';

export function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-page/90 backdrop-blur-[8px]">
      <div className="wrap">
        <div className="flex items-center gap-4 py-[10px]">
          <Link href="/" className="flex flex-none items-center gap-[10px] no-underline" aria-label="PerpGuard home">
            {/* The mark, never recoloured, never without its glow, clear space of half its width. */}
            <img src="/perpguard-logo.svg" alt="" width={28} height={28} className="block" style={{ margin: '0 4px' }} />
            <b className="text-[16px] font-bold tracking-[-0.02em] text-text">
              Perp<span className="text-accent-hi">Guard</span>
            </b>
          </Link>
          <Search />
          <StatusDot />
        </div>
        <Tabs />
      </div>
    </header>
  );
}
