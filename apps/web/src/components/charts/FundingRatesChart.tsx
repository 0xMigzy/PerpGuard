'use client';

import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { FundingPanel, FundingPanels } from '@/lib/funding.ts';
import { formatCount, formatDay, formatDayLong, formatFundingPct, formatWhen } from '@/lib/format.ts';
import { COLORS } from '@/lib/theme.ts';
import { MarketName } from '@/components/TokenIcon.tsx';
import { ChartTooltip } from './ChartTooltip.tsx';

const DAY_MS = 86_400_000;

/** "13:43" under two days, "Oct 3" beyond: the tick says what the window resolves. */
function tickFor(spanMs: number): (ms: number) => string {
  if (spanMs >= 2 * DAY_MS) return formatDay;
  return (ms) => new Date(ms).toISOString().slice(11, 16);
}

function Panel({ panel, max }: { readonly panel: FundingPanel; readonly max: number }) {
  const first = panel.points[0]?.atMs ?? 0;
  const last = panel.points.at(-1)?.atMs ?? 0;
  const tick = tickFor(last - first);
  const daily = panel.resolution === 'utc-day';
  return (
    <div className="rounded-[10px] border border-border bg-card2/40 px-3 pt-[10px] pb-1">
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="font-semibold">
          <MarketName symbol={panel.symbol} size={18} />
        </span>
        <span className="num text-[11.5px] text-muted" title={daily ? 'A day’s mean is not a rate that was applied; 7D or 24H shows every rate applied.' : 'The last rate applied'}>
          {panel.lastRatePct === undefined ? `${formatCount(panel.eventCount)} events` : `last ${formatFundingPct(panel.lastRatePct)}`}
        </span>
      </div>
      <div className="h-[96px] w-full">
        {panel.points.length === 0 ? (
          <div className="pt-8 text-center text-[12px] text-muted">No funding event in this window.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={panel.points} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="atMs" type="number" domain={[first, last]} scale="time" tickFormatter={tick} tickLine={false} axisLine={false} minTickGap={40} tick={{ fontSize: 10 }} />
              <YAxis domain={[-max, max]} ticks={[-max, 0, max]} tickFormatter={(v: number) => formatFundingPct(v)} tickLine={false} axisLine={false} width={78} tick={{ fontSize: 10 }} />
              <ReferenceLine y={0} stroke={COLORS.border2} />
              <Tooltip
                cursor={{ stroke: COLORS.muted2 }}
                content={({ active, payload }) => {
                  if (!active || payload === undefined || payload.length === 0) return null;
                  const p = payload[0]!.payload as { atMs: number; ratePct: number };
                  return (
                    <ChartTooltip
                      title={daily ? formatDayLong(p.atMs) : `${formatWhen(p.atMs)} UTC`}
                      rows={[{ label: daily ? 'Mean rate per event' : 'Rate applied', value: formatFundingPct(p.ratePct) }]}
                    />
                  );
                }}
              />
              <Line dataKey="ratePct" type={daily ? 'linear' : 'stepAfter'} stroke={COLORS.accentHi} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/**
 * Funding rates over the window, one small multiple per market on ONE shared
 * scale: comparable at a glance, where a single chart of eleven lines would be a
 * tangle of hues. Every-rate panels are steps, because a rate holds until the
 * next settlement; daily means are a plain line, because they are not rates.
 */
export function FundingRatesChart({ panels }: { readonly panels: FundingPanels }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {panels.markets.map((m) => (
        <Panel key={m.marketId} panel={m} max={panels.maxAbsRatePct} />
      ))}
    </div>
  );
}
