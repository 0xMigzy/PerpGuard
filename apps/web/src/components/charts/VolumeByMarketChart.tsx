'use client';

import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { StackedVolume } from '@/lib/overview.ts';
import { formatAusd, formatCompact, formatDay, formatDayLong } from '@/lib/format.ts';
import { COLORS, OTHER_SERIES, SERIES } from '@/lib/theme.ts';
import { ChartTooltip } from './ChartTooltip.tsx';

const AVERAGE = '7-day average';

function colorOf(stacked: StackedVolume, key: string): string {
  const slot = stacked.slotOf[key];
  return slot === undefined ? OTHER_SERIES : SERIES[slot] ?? OTHER_SERIES;
}

/**
 * Daily volume stacked by market, with the trailing 7-day mean of the total as
 * a line ON THE SAME AXIS. One axis: both are AUSD per day.
 */
export function VolumeByMarketChart({ stacked }: { readonly stacked: StackedVolume }) {
  const data = stacked.days.map((d, i) => ({
    dayMs: d.dayMs,
    ...d.byKey,
    total: d.total,
    [AVERAGE]: stacked.average[i],
  }));
  return (
    <div>
      <div className="flex flex-wrap gap-[14px] text-[12px] text-muted">
        {stacked.keys.map((key) => (
          <span key={key}>
            <i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: colorOf(stacked, key) }} />
            {key}
          </span>
        ))}
        <span>
          <i className="mr-[6px] inline-block h-[2px] w-[12px] align-middle" style={{ background: COLORS.text }} />
          {AVERAGE}
        </span>
      </div>
      <div className="mt-2 h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke={COLORS.border} />
            <XAxis dataKey="dayMs" tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
            <YAxis tickFormatter={(v: number) => formatCompact(v)} tickLine={false} axisLine={false} width={52} />
            <Tooltip
              cursor={{ fill: COLORS.card2 }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const row = payload[0]!.payload as Record<string, number>;
                return (
                  <ChartTooltip
                    title={formatDayLong(Number(label))}
                    rows={[
                      ...stacked.keys.map((key) => ({ swatch: colorOf(stacked, key), label: key, value: formatAusd(row[key] ?? 0, 0) })),
                      { label: 'Total', value: formatAusd(row['total'] ?? 0, 0) },
                      { label: AVERAGE, value: formatAusd(row[AVERAGE] ?? 0, 0), muted: true },
                    ]}
                  />
                );
              }}
            />
            {stacked.keys.map((key) => (
              <Bar key={key} dataKey={key} stackId="volume" fill={colorOf(stacked, key)} stroke={COLORS.card} strokeWidth={1} maxBarSize={24} isAnimationActive={false} />
            ))}
            <Line type="monotone" dataKey={AVERAGE} stroke={COLORS.text} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: COLORS.card, strokeWidth: 2 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
