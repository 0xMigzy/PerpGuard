import Link from 'next/link';
import { Suspense } from 'react';
import { IndexerChip } from './IndexerChip.tsx';
import { Search } from './Search.tsx';
import { Tabs } from './Tabs.tsx';

/** One shell for six sections. The chip is the indexer's block, never a network name. */
export function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-page/90 backdrop-blur-[8px]">
      <div className="wrap">
        <div className="flex items-center gap-4 py-[10px]">
          <Link href="/" className="flex flex-none items-center gap-[7px] no-underline" aria-label="PerpGuard home">
            {/* One lockup: the vector mark a little above the wordmark's cap height
                (Inter 16px caps are ~11.6px), its own 808:888 aspect, never stretched. */}
            <img src="/perpguard-mark.svg" alt="" width={808} height={888} className="block" style={{ height: 14, width: 'auto' }} />
            <b className="text-[16px] font-bold tracking-[-0.02em] text-text">
              Perp<span className="text-accent-hi">Guard</span>
            </b>
          </Link>
          {/* Suspense: the search carries the timeframe from the URL, like the tabs. */}
          <Suspense fallback={<div className="flex-1" aria-hidden="true" />}>
            <Search />
          </Suspense>
          <IndexerChip />
        </div>
        {/* Suspense: the tabs read the URL's search params to carry the timeframe across sections. */}
        <Suspense fallback={<div className="h-[49px]" aria-hidden="true" />}>
          <Tabs />
        </Suspense>
      </div>
    </header>
  );
}
