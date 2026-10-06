import { formatMoney, formatPct } from '@/lib/format.ts';

/** Long against short as one bar: the share is read at a glance, the amounts below it. */
export function SkewBar({ longAusd, shortAusd, note }: { readonly longAusd: number; readonly shortAusd: number; readonly note?: string }) {
  const total = longAusd + shortAusd;
  const longShare = total > 0 ? longAusd / total : 0;
  return (
    <div className="mt-3">
      <div className="flex h-[26px] overflow-hidden rounded-[7px]" role="img" aria-label={`Long ${formatPct(longShare)}, short ${formatPct(1 - longShare)}`}>
        <div className="bg-gradient-to-r from-[#2FA37A] to-safe" style={{ width: `${longShare * 100}%` }} />
        <div className="bg-gradient-to-r from-danger to-[#C94A5E]" style={{ width: `${(1 - longShare) * 100}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-[12px] text-muted">
        <span>
          Long <b className="num font-semibold text-text">{formatPct(longShare)}</b> · {formatMoney(longAusd)}
        </span>
        <span>
          Short <b className="num font-semibold text-text">{formatPct(1 - longShare)}</b> · {formatMoney(shortAusd)}
        </span>
      </div>
      {note !== undefined && <div className="mt-[6px] text-[11.5px] text-muted2">{note}</div>}
    </div>
  );
}
