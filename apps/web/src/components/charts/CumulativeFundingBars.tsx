import type { FundingPanels } from '@/lib/funding.ts';
import { formatCount, formatFundingPct } from '@/lib/format.ts';
import { COLORS } from '@/lib/theme.ts';
import { MarketName } from '@/components/TokenIcon.tsx';

const PAID: Record<'longs' | 'shorts' | 'neither', string> = {
  longs: 'longs paid shorts',
  shorts: 'shorts paid longs',
  neither: 'no net funding',
};

/**
 * Who has been paying to hold: the sum of every rate applied in the window, one
 * diverging bar per market from a shared zero. Right is longs paying (the
 * site's long colour), left is shorts paying (its short colour), and the words
 * say it too, so the reading never rests on colour alone. Plain HTML, so each row
 * is a hover target and the phone layout is a list, not a squeezed chart.
 */
export function CumulativeFundingBars({ panels }: { readonly panels: FundingPanels }) {
  const max = panels.maxAbsCumulativePct;
  return (
    <ul className="m-0 list-none p-0">
      <li className="grid grid-cols-[92px_1fr] gap-x-3 pb-2 text-[11px] text-muted2 sm:grid-cols-[110px_1fr_190px]" aria-hidden="true">
        <span />
        <span className="flex justify-between">
          <span>← shorts paid</span>
          <span>longs paid →</span>
        </span>
        <span className="hidden sm:block" />
      </li>
      {panels.byCumulative.map((m) => {
        const width = max === 0 ? 0 : (Math.abs(m.cumulativeRatePct) / max) * 50;
        const right = m.cumulativeRatePct > 0;
        return (
          <li
            key={m.marketId}
            className="grid grid-cols-[92px_1fr] items-center gap-x-3 border-t border-border py-[7px] text-[12.5px] hover:bg-card2 sm:grid-cols-[110px_1fr_190px]"
            title={`${m.symbol}: ${formatFundingPct(m.cumulativeRatePct)} over ${formatCount(m.eventCount)} funding events. ${PAID[m.payer]}.`}
          >
            <span className="font-semibold">
              <MarketName symbol={m.symbol} size={18} />
            </span>
            <span className="relative h-[12px]" role="img" aria-label={`${formatFundingPct(m.cumulativeRatePct)}, ${PAID[m.payer]}`}>
              <i className="absolute top-[-3px] bottom-[-3px] left-1/2 w-px" style={{ background: COLORS.border2 }} />
              {width > 0 && (
                <i
                  className={`absolute top-0 bottom-0 ${right ? 'rounded-r-[4px]' : 'rounded-l-[4px]'}`}
                  style={{ [right ? 'left' : 'right']: '50%', width: `${width}%`, background: right ? COLORS.safe : COLORS.danger }}
                />
              )}
            </span>
            <span className="col-span-2 mt-[2px] text-[11.5px] text-muted sm:col-span-1 sm:mt-0 sm:text-right">
              <b className="num font-semibold text-text">{formatFundingPct(m.cumulativeRatePct)}</b> · {PAID[m.payer]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
