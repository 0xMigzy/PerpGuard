'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HistoryMonth } from '@perpguard/shared';
import { formatCompact, formatCount } from '@/lib/format.ts';
import { formatMonth } from '@/lib/growth.ts';
import { COLORS } from '@/lib/theme.ts';
import { ChartTooltip } from './ChartTooltip.tsx';

/** Trades per UTC month, one series. The running month is drawn faint: it is not yet a month. */
export function GrowthChart({ months }: { readonly months: readonly HistoryMonth[] }) {
  return (
    <div className="mt-2 h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={months} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke={COLORS.border} />
          <XAxis dataKey="monthMs" tickFormatter={(v: number) => formatMonth(v).replace(' 2026', '')} tickLine={false} axisLine={false} interval={0} tick={{ fill: COLORS.muted, fontSize: 11.5 }} />
          <YAxis tickFormatter={(v: number) => formatCompact(v)} tickLine={false} axisLine={false} width={44} allowDecimals={false} tick={{ fill: COLORS.muted, fontSize: 11.5 }} />
          <Tooltip
            cursor={{ fill: COLORS.card2 }}
            content={({ active, payload }) => {
              if (!active || payload === undefined || payload.length === 0) return null;
              const row = payload[0]!.payload as HistoryMonth;
              return (
                <ChartTooltip
                  title={`${formatMonth(row.monthMs)}${row.partial ? ' · so far' : ''}`}
                  rows={[
                    { swatch: COLORS.accentHi, label: 'Trades', value: formatCount(row.trades) },
                    { label: 'Volume', value: `${formatCompact(row.volumeAusd)} AUSD` },
                    { label: 'New accounts', value: formatCount(row.newAccounts), muted: true },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="trades" fill={COLORS.accentHi} stroke={COLORS.card} strokeWidth={2} radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
            {months.map((row) => (
              <Cell key={row.monthMs} fillOpacity={row.partial ? 0.35 : 1} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
