'use client';

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DailyPoint } from '@perpguard/shared';
import { formatAusd, formatCompact, formatDay, formatDayLong, formatSignedAusd } from '@/lib/format.ts';
import { COLORS } from '@/lib/theme.ts';
import { ChartTooltip } from './ChartTooltip.tsx';

/** Deposits minus withdrawals per day. Polarity: inflow safe, outflow danger, zero line marked. */
export function NetFlowChart({ days }: { readonly days: readonly DailyPoint[] }) {
  const data = days.map((d) => ({ dayMs: d.dayMs, net: d.netFlowAusd, deposited: d.depositedAusd, withdrawn: d.withdrawnAusd }));
  return (
    <div>
      <div className="flex flex-wrap gap-[14px] text-[12px] text-muted">
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: COLORS.safe }} />Net inflow</span>
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: COLORS.danger }} />Net outflow</span>
      </div>
      <div className="mt-2 h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke={COLORS.border} />
            <XAxis dataKey="dayMs" tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
            <YAxis tickFormatter={(v: number) => formatCompact(v)} tickLine={false} axisLine={false} width={60} />
            <ReferenceLine y={0} stroke={COLORS.border2} />
            <Tooltip
              cursor={{ fill: COLORS.card2 }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const row = payload[0]!.payload as { net: number; deposited: number; withdrawn: number };
                return (
                  <ChartTooltip
                    title={formatDayLong(Number(label))}
                    rows={[
                      { label: 'Deposited', value: formatAusd(row.deposited, 0), muted: true },
                      { label: 'Withdrawn', value: formatAusd(row.withdrawn, 0), muted: true },
                      { label: 'Net', value: formatSignedAusd(row.net, 0) },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="net" maxBarSize={24} radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.dayMs} fill={d.net >= 0 ? COLORS.safe : COLORS.danger} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
