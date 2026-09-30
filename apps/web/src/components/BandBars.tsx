import type { LiquidationBand } from '@perpguard/shared';
import { formatCount, formatPct } from '@/lib/format.ts';
import { COLORS, OTHER_SERIES } from '@/lib/theme.ts';

/**
 * Bands as horizontal stacked bars: rescuable on top of not-rescuable on top
 * of unjudgeable, every band present even when empty. The count is printed at
 * the end of each bar so no reader has to estimate a length.
 */
export function BandBars({ bands, unit }: { readonly bands: readonly LiquidationBand[]; readonly unit: string }) {
  const max = Math.max(1, ...bands.map((b) => b.count));
  const total = bands.reduce((s, b) => s + b.count, 0);
  if (total === 0) return <div className="mt-3 text-[12.5px] text-muted">No liquidation in this window, so nothing to band.</div>;
  return (
    <div className="mt-3">
      <div className="mb-2 flex flex-wrap gap-[14px] text-[12px] text-muted">
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: COLORS.accentHi }} />Rescuable</span>
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: OTHER_SERIES }} />Not rescuable</span>
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px] border border-border2" style={{ background: 'transparent' }} />Unjudgeable</span>
      </div>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-[7px] text-[12px]">
        {bands.map((b) => (
          <BandRow key={b.label} band={b} max={max} unit={unit} />
        ))}
      </div>
    </div>
  );
}

function BandRow({ band, max, unit }: { readonly band: LiquidationBand; readonly max: number; readonly unit: string }) {
  const w = (n: number) => `${(n / max) * 100}%`;
  const judgeable = band.count - band.unknownCount;
  const rate = judgeable > 0 ? band.rescuableCount / judgeable : undefined;
  return (
    <>
      <span className="num whitespace-nowrap text-muted" title={`${band.label} ${unit}`}>{band.label}</span>
      <span className="flex h-[16px] w-full overflow-hidden rounded-[4px] bg-border" role="img" aria-label={`${band.label}: ${formatCount(band.count)} liquidations, ${formatCount(band.rescuableCount)} rescuable`}>
        <i className="block h-full" style={{ width: w(band.rescuableCount), background: COLORS.accentHi }} />
        <i className="block h-full" style={{ width: w(band.notRescuableCount), background: OTHER_SERIES }} />
        <i className="block h-full border-y border-r border-border2" style={{ width: w(band.unknownCount), background: 'transparent' }} />
      </span>
      <span className="num whitespace-nowrap text-right">
        {formatCount(band.count)}
        <span className="ml-1 text-[11px] text-muted2">{rate === undefined ? (band.count === 0 ? '' : 'unjudgeable') : `${formatPct(rate, 0)} rescuable`}</span>
      </span>
    </>
  );
}
