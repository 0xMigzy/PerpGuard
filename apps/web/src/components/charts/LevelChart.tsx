'use client';

import { Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatAxisMoney, formatDay, formatDayLong, formatMoney } from '@/lib/format.ts';
import { VAR } from '@/lib/theme.ts';
import { ChartTooltip } from './ChartTooltip.tsx';

export interface LevelPoint {
  readonly atMs: number;
  readonly value: number;
  /** True for the live reading the series ends on, rather than a day's close. */
  readonly live?: boolean;
}

/**
 * A level through time (open interest, an exchange balance): one series, on a
 * TIME axis so a final live reading sits where it belongs rather than one day
 * after the last close. The live point is marked and named in the tooltip.
 */
export function LevelChart({
  points,
  label,
  rows,
}: {
  readonly points: readonly LevelPoint[];
  /** What the value is, for the tooltip: "Open interest". */
  readonly label: string;
  /** Extra tooltip rows for a point, e.g. its largest markets. */
  readonly rows?: (p: LevelPoint) => readonly { readonly label: string; readonly value: string; readonly muted?: boolean }[];
}) {
  const live = points.find((p) => p.live === true);
  const first = points[0]?.atMs ?? 0;
  const last = points.at(-1)?.atMs ?? 0;
  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points as LevelPoint[]} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={VAR.border} />
          <XAxis dataKey="atMs" type="number" scale="time" domain={[first, last]} tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis tickFormatter={(v: number) => formatAxisMoney(v)} tickLine={false} axisLine={false} width={60} />
          <Tooltip
            cursor={{ stroke: VAR.border2 }}
            content={({ active, payload }) => {
              if (!active || payload === undefined || payload.length === 0) return null;
              const p = payload[0]!.payload as LevelPoint;
              return (
                <ChartTooltip
                  title={p.live === true ? 'Now, from the venue' : `${formatDayLong(p.atMs)}, at the UTC close`}
                  rows={[{ label, value: `${formatMoney(p.value)}` }, ...(rows?.(p) ?? [])]}
                />
              );
            }}
          />
          <Area type="linear" dataKey="value" stroke={VAR.accentHi} strokeWidth={2} fill={VAR.accent} fillOpacity={0.12} isAnimationActive={false} dot={false} activeDot={{ r: 4, stroke: VAR.card, strokeWidth: 2 }} />
          {live !== undefined && <ReferenceDot x={live.atMs} y={live.value} r={4} fill={VAR.accentHi} stroke={VAR.card} strokeWidth={2} />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
