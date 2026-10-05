'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { LiquidationDay } from '@/lib/liquidations.ts';
import { formatCount, formatDay, formatDayLong } from '@/lib/format.ts';
import { VAR, OTHER_SERIES } from '@/lib/theme.ts';
import { ChartTooltip } from './ChartTooltip.tsx';

const RESCUABLE = 'Rescuable';

/** Liquidations per UTC day, stacked: the ones the trader could have prevented on top of the rest. */
/**
 * `includesUnjudgeable`: day buckets carry no unjudgeable count, so the grey
 * series holds both whenever the window has any; the legend says so only then.
 */
export function LiquidationsByDayChart({ days, includesUnjudgeable = false }: { readonly days: readonly LiquidationDay[]; readonly includesUnjudgeable?: boolean }) {
  const OTHER = includesUnjudgeable ? 'Not rescuable or unjudgeable' : 'Not rescuable';
  return (
    <div>
      <div className="flex flex-wrap gap-[14px] text-[12px] text-muted">
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: VAR.accentHi }} />{RESCUABLE}</span>
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: OTHER_SERIES }} />{OTHER}</span>
      </div>
      <div className="mt-2 h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={days} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke={VAR.border} />
            <XAxis dataKey="dayMs" tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
            <YAxis tickFormatter={(v: number) => formatCount(v)} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: VAR.card2 }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const row = payload[0]!.payload as LiquidationDay;
                return (
                  <ChartTooltip
                    title={formatDayLong(Number(label))}
                    rows={[
                      { swatch: VAR.accentHi, label: RESCUABLE, value: formatCount(row.rescuable) },
                      { swatch: OTHER_SERIES, label: OTHER, value: formatCount(row.other) },
                      { label: 'Total', value: formatCount(row.total) },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="other" stackId="liq" fill={OTHER_SERIES} stroke={VAR.card} strokeWidth={1} maxBarSize={24} isAnimationActive={false} />
            <Bar dataKey="rescuable" stackId="liq" fill={VAR.accentHi} stroke={VAR.card} strokeWidth={1} maxBarSize={24} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
