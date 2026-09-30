import type { ReactNode } from 'react';

/** One tooltip look for every chart: card surface, hairline, values in text ink. */
export function ChartTooltip({ title, rows }: { readonly title: ReactNode; readonly rows: readonly { readonly swatch?: string; readonly label: string; readonly value: string; readonly muted?: boolean }[] }) {
  return (
    <div className="rounded-[9px] border border-border2 bg-card2 px-3 py-2 text-[12px] shadow-none">
      <div className="mb-1 font-semibold text-text">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className={`flex items-center justify-between gap-4 ${row.muted ? 'text-muted' : 'text-text'}`}>
          <span className="flex items-center gap-[6px]">
            {row.swatch !== undefined && <i className="inline-block h-[9px] w-[9px] rounded-[2px]" style={{ background: row.swatch }} />}
            {row.label}
          </span>
          <span className="num">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
