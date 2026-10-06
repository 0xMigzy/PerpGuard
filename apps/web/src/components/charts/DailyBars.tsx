'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCompact, formatDay, formatDayLong } from '@/lib/format.ts';
import { VAR } from '@/lib/theme.ts';
import { ChartTooltip } from './ChartTooltip.tsx';

/** One figure per UTC day as bars: small, one series, its name in the tooltip. */
export function DailyBars({
  days,
  label,
  format,
}: {
  readonly days: readonly { readonly dayMs: number; readonly value: number }[];
  readonly label: string;
  readonly format: (v: number) => string;
}) {
  return (
    <div className="h-[160px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={days as { dayMs: number; value: number }[]} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
          <CartesianGrid vertical={false} stroke={VAR.border} />
          <XAxis dataKey="dayMs" tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis tickFormatter={(v: number) => formatCompact(v).replace(/\.00$/, '')} tickLine={false} axisLine={false} width={48} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: VAR.card2 }}
            content={({ active, payload, label: day }) => {
              if (!active || payload === undefined || payload.length === 0) return null;
              const row = payload[0]!.payload as { value: number };
              return <ChartTooltip title={formatDayLong(Number(day))} rows={[{ label, value: format(row.value) }]} />;
            }}
          />
          <Bar dataKey="value" fill={VAR.accent} maxBarSize={22} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
