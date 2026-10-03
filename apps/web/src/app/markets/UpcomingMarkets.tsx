import type { MarketListing } from '@perpguard/shared';
import { formatAge, formatCount, formatPct, formatPriceAsServed } from '@/lib/format.ts';
import { MarketName } from '@/components/TokenIcon.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';

const DAY_MS = 86_400_000;

function listedOn(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Markets the CHAIN lists that the venue has not opened: never traded, absent from
 * its context. Shown with whatever the contract already holds for them, and with
 * no figure the venue has not published. Their names are the contract's own,
 * because there is no venue ticker yet.
 */
export function UpcomingMarkets({ markets }: { readonly markets: readonly MarketListing[] | undefined }) {
  const cell = 'num px-[10px] py-[10px] text-right whitespace-nowrap';
  return (
    <section className="card mt-4 overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-[10px] px-[18px] pt-4 pb-2">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">
          Not yet trading
          <span className="ml-2 rounded-[4px] bg-watch/12 px-[6px] py-[2.5px] align-[2px] text-[10px] font-semibold tracking-[0.05em] text-watch">UPCOMING</span>
        </h2>
        <span className="text-[12.5px] text-muted">listed on chain, not yet open on Perpl</span>
      </div>
      {markets === undefined ? (
        <div className="px-[18px] pb-4">
          <Skeleton className="h-[120px] w-full" />
        </div>
      ) : markets.length === 0 ? (
        <div className="px-[18px] pb-5 text-[12.5px] text-muted">No market is listed on chain ahead of the venue right now.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-y border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
                  <th scope="col" className="sticky left-0 z-[1] bg-card px-[10px] py-[8px] text-left font-semibold">
                    Market<span className="block text-[10px] font-medium normal-case tracking-normal text-muted2">contract symbol</span>
                  </th>
                  <th scope="col" className="px-[10px] py-[8px] text-right font-semibold">
                    State<span className="block text-[10px] font-medium normal-case tracking-normal text-muted2">on chain</span>
                  </th>
                  <th scope="col" className="px-[10px] py-[8px] text-right font-semibold">
                    Max leverage<span className="block text-[10px] font-medium normal-case tracking-normal text-muted2">initial margin</span>
                  </th>
                  <th scope="col" className="px-[10px] py-[8px] text-right font-semibold">
                    Maint. margin<span className="block text-[10px] font-medium normal-case tracking-normal text-muted2">of notional</span>
                  </th>
                  <th scope="col" className="px-[10px] py-[8px] text-right font-semibold">
                    Max OI<span className="block text-[10px] font-medium normal-case tracking-normal text-muted2">size cap</span>
                  </th>
                  <th scope="col" className="px-[10px] py-[8px] text-right font-semibold">
                    Mark<span className="block text-[10px] font-medium normal-case tracking-normal text-muted2">contract&rsquo;s last</span>
                  </th>
                  <th scope="col" className="px-[10px] py-[8px] text-right font-semibold">
                    Listed<span className="block text-[10px] font-medium normal-case tracking-normal text-muted2">on chain</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {markets.map((m) => (
                  <tr key={m.market.marketId} className="border-b border-border last:border-b-0">
                    <td className="sticky left-0 z-[1] bg-card px-[10px] py-[10px] font-semibold whitespace-nowrap">
                      <MarketName symbol={m.chainSymbol} />
                      <span className="ml-2 text-[11px] font-normal text-muted2">#{m.market.marketId}</span>
                    </td>
                    <td className={`${cell} ${m.paused ? 'text-watch' : 'text-muted'}`}>{m.paused ? 'Paused' : 'Not paused'}</td>
                    <td className={cell}>{m.maxLeverage === undefined ? '—' : `${m.maxLeverage}x`}</td>
                    <td className={cell}>{m.maintenanceMarginRatio === undefined ? '—' : formatPct(m.maintenanceMarginRatio, m.maintenanceMarginRatio * 100 < 10 ? 1 : 0)}</td>
                    <td className={cell}>
                      {formatCount(m.maxOpenInterestSize)} <span className="text-muted2">{m.chainSymbol}</span>
                    </td>
                    <td className={cell} title={m.markAtMs === undefined ? 'no mark update indexed' : `updated ${formatAge(Date.now() - m.markAtMs)} ago`}>
                      {m.markPrice === undefined ? '—' : formatPriceAsServed(m.markPrice)}
                      {m.markAtMs !== undefined && <span className="block text-[11px] text-muted2">{formatAge(Date.now() - m.markAtMs)} ago</span>}
                    </td>
                    <td className={cell}>
                      {listedOn(m.listedAtMs)}
                      <span className="block text-[11px] text-muted2">{formatCount(Math.floor((Date.now() - m.listedAtMs) / DAY_MS))} days ago</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-[18px] py-3 text-[11.5px] text-muted2">
            Parameters are the contract&rsquo;s own and may change before a market opens. None of these has a fill on record; the venue has not published them, so there is
            no volume, funding or exposure to show, and no date they open. A market leaves this list when the venue lists it.
          </div>
        </>
      )}
    </section>
  );
}
