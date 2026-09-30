'use client';

import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCompact, formatDay, formatDayLong, formatSignedAusd } from '@/lib/format.ts';
import { COLORS } from '@/lib/theme.ts';
import { ChartTooltip } from './ChartTooltip.tsx';

export interface TraderDayBar {
  readonly dayMs: number;
  readonly netPnlAusd: number;
  readonly cumulativeAusd: number;
  readonly volumeAusd: number;
  readonly endFreeBalanceAusd: number;
}

const CUMULATIVE = 'Cumulative';

/**
 * One trader's days: net PnL per UTC day as bars, with the running total as a
 * line ON THE SAME AXIS. Polarity: a green day made money, a red day lost it.
 */
export function TraderDaysChart({ days }: { readonly days: readonly TraderDayBar[] }) {
  return (
    <div>
      <div className="flex flex-wrap gap-[14px] text-[12px] text-muted">
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: COLORS.safe }} />Day in profit</span>
        <span><i className="mr-[6px] inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: COLORS.danger }} />Day in loss</span>
        <span><i className="mr-[6px] inline-block h-[2px] w-[12px] align-middle" style={{ background: COLORS.text }} />{CUMULATIVE} net PnL</span>
      </div>
      <div className="mt-2 h-[240px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={days} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke={COLORS.border} />
            <XAxis dataKey="dayMs" tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
            <YAxis tickFormatter={(v: number) => formatCompact(v)} tickLine={false} axisLine={false} width={64} />
            <ReferenceLine y={0} stroke={COLORS.border2} />
            <Tooltip
              cursor={{ fill: COLORS.card2 }}
              content={({ active, payload, label }) => {
                if (!active || payload === undefined || payload.length === 0) return null;
                const row = payload[0]!.payload as TraderDayBar;
                return (
                  <ChartTooltip
                    title={formatDayLong(Number(label))}
                    rows={[
                      { swatch: row.netPnlAusd >= 0 ? COLORS.safe : COLORS.danger, label: 'Net PnL', value: formatSignedAusd(row.netPnlAusd, 0) },
                      { label: CUMULATIVE, value: formatSignedAusd(row.cumulativeAusd, 0) },
                      { label: 'Volume', value: formatCompact(row.volumeAusd), muted: true },
                      { label: 'Free balance at close', value: formatCompact(row.endFreeBalanceAusd), muted: true },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="netPnlAusd" maxBarSize={24} radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {days.map((d) => (
                <Cell key={d.dayMs} fill={d.netPnlAusd >= 0 ? COLORS.safe : COLORS.danger} />
              ))}
            </Bar>
            <Line type="monotone" dataKey="cumulativeAusd" stroke={COLORS.text} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: COLORS.card, strokeWidth: 2 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
