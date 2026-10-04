'use client';

import { useState } from 'react';
import { formatDay, formatFundingPct, formatWhen } from '@/lib/format.ts';
import type { FundingHeatmap as Model, HeatCell, HeatColumn, HeatmapGrain, HeatRow } from '@/lib/funding.ts';
import { COLORS } from '@/lib/theme.ts';
import { MarketName } from '@/components/TokenIcon.tsx';
import { ChartTooltip } from './ChartTooltip.tsx';

/** "4 Oct · 03:12", "4 Oct", "week of 21 Sep": what one column covers, in UTC. */
export function columnLabel(column: HeatColumn, grain: HeatmapGrain): string {
  const base = grain === 'settlement' ? `${formatWhen(column.startMs)} UTC` : grain === 'utc-day' ? formatDay(column.startMs) : `week of ${formatDay(column.startMs)}`;
  return column.partial ? `${base} (partial)` : base;
}

/** What a cell's number IS: the rate applied, or a mean and over how many. */
export function cellMeaning(cell: HeatCell, grain: HeatmapGrain): string {
  if (grain === 'settlement') return 'rate applied';
  return `mean of ${cell.events.toLocaleString('en-US')} settlement${cell.events === 1 ? '' : 's'}`;
}

/** Signed simple APR, in percent units: "+0.49% APR". Tiny but non-zero never reads as 0.00%. */
export function formatApr(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  const abs = Math.abs(pct);
  const body = abs === 0 ? '0.00' : abs < 0.01 ? '<0.01' : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${body}% APR`;
}

export function payerWords(ratePct: number): string {
  return ratePct > 0 ? 'longs pay' : ratePct < 0 ? 'shorts pay' : 'nobody pays';
}

/** Hex to rgba, for one hue at many strengths. */
function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.toFixed(3)})`;
}

/**
 * Positive (longs pay) in the table's positive colour, negative in its negative
 * one, strength by |rate| on one shared scale. Square root, so the many small
 * rates are not all the same faint wash beside one large one. ZERO is a solid
 * neutral; NO SETTLEMENT is hatched and empty: a market that did not exist yet
 * is not a market at zero funding.
 */
const ZERO_FILL = COLORS.border2;
const MISSING_STYLE = {
  background: `repeating-linear-gradient(135deg, transparent 0 3px, ${tint(COLORS.border2, 0.9)} 3px 4px)`,
  boxShadow: `inset 0 0 0 1px ${COLORS.border2}`,
} as const;

function cellStyle(cell: HeatCell | undefined, max: number): React.CSSProperties {
  if (cell === undefined) return MISSING_STYLE;
  if (cell.ratePct === 0) return { background: ZERO_FILL };
  const strength = Math.sqrt(Math.min(1, Math.abs(cell.ratePct) / max));
  return { background: tint(cell.ratePct > 0 ? COLORS.safe : COLORS.danger, 0.18 + 0.8 * strength) };
}

interface Hover {
  readonly row: HeatRow;
  readonly column: HeatColumn;
  readonly cell: HeatCell | undefined;
  readonly x: number;
  readonly y: number;
}

export function FundingHeatmap({ model, view }: { readonly model: Model; readonly view: 'chart' | 'table' }) {
  return view === 'chart' ? <HeatGrid model={model} /> : <HeatTable model={model} />;
}

function HeatGrid({ model }: { readonly model: Model }) {
  const [hover, setHover] = useState<Hover | undefined>(undefined);
  const n = model.columns.length;
  // Each cell at least 7px, so a phone scrolls sideways rather than drawing slivers.
  const grid = { gridTemplateColumns: `minmax(84px, 110px) repeat(${n}, minmax(7px, 1fr)) minmax(96px, 120px)` };
  const ticks = tickIndexes(n);

  return (
    <div className="overflow-x-auto" onMouseLeave={() => setHover(undefined)} onScroll={() => setHover(undefined)}>
      <div className="grid items-center gap-[2px] text-[12.5px]" style={{ ...grid, minWidth: 84 + n * 9 + 96 }} role="img" aria-label="Funding heatmap. The same figures are available as text with the Table view.">
        {model.rows.map((row) => (
          <Row key={row.marketId} row={row} model={model} onHover={setHover} />
        ))}
        <div />
        {model.columns.map((c, i) => (
          <div key={c.startMs} className="relative h-[16px] text-[10.5px] text-muted2">
            {ticks.has(i) && <span className={`absolute top-[2px] whitespace-nowrap ${i === n - 1 ? 'right-0' : i === 0 ? 'left-0' : 'left-1/2 -translate-x-1/2'}`}>{tickLabel(c, model.grain)}</span>}
          </div>
        ))}
        <div />
      </div>
      {hover !== undefined && (
        // FIXED, in viewport coordinates: the grid scrolls sideways on a phone, and an
        // absolute tooltip inside it would be clipped above the first row.
        <div className="pointer-events-none fixed z-50" style={{ left: hover.x, top: hover.y, transform: 'translate(-50%, calc(-100% - 8px))' }}>
          <ChartTooltip
            title={
              <>
                {hover.row.symbol} · {columnLabel(hover.column, model.grain)}
              </>
            }
            rows={
              hover.cell === undefined
                ? [{ label: 'no settlement in this period', value: '—', muted: true }]
                : [
                    { label: cellMeaning(hover.cell, model.grain), value: formatFundingPct(hover.cell.ratePct) },
                    { label: payerWords(hover.cell.ratePct), value: '', muted: true },
                  ]
            }
          />
        </div>
      )}
    </div>
  );
}

function Row({ row, model, onHover }: { readonly row: HeatRow; readonly model: Model; readonly onHover: (h: Hover | undefined) => void }) {
  return (
    <>
      <div className="sticky left-0 z-[1] bg-card pr-2 font-semibold whitespace-nowrap">
        <MarketName symbol={row.symbol} size={18} />
      </div>
      {row.cells.map((cell, i) => (
        <div
          key={model.columns[i]!.startMs}
          className="h-[22px] rounded-[2px]"
          style={cellStyle(cell, model.maxAbsRatePct)}
          onMouseEnter={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            onHover({ row, column: model.columns[i]!, cell, x: box.left + box.width / 2, y: box.top });
          }}
        />
      ))}
      {/* Pinned right, as the market is pinned left: on a phone the cells scroll between them and the APR never leaves the screen. */}
      <div className="num sticky right-0 z-[1] bg-card pl-2 text-right whitespace-nowrap" title={row.currentRatePct === undefined ? 'no settlement yet' : `current rate ${formatFundingPct(row.currentRatePct)} per settlement`}>
        {row.aprPct === undefined ? (
          <span className="text-muted2">—</span>
        ) : (
          <>
            <span className={row.aprPct > 0 ? 'text-safe' : row.aprPct < 0 ? 'text-danger' : 'text-muted'}>{formatApr(row.aprPct)}</span>
            <span className="block text-[10.5px] text-muted2">{payerWords(row.aprPct)}</span>
          </>
        )}
      </div>
    </>
  );
}

/** Three or so axis labels: first, last, and one or two between. */
function tickIndexes(n: number): Set<number> {
  if (n === 0) return new Set();
  if (n <= 3) return new Set(Array.from({ length: n }, (_, i) => i));
  return new Set([0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1]);
}

function tickLabel(c: HeatColumn, grain: HeatmapGrain): string {
  if (grain === 'settlement') return new Date(c.startMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return formatDay(c.startMs);
}

/** The same numbers as text: one row per market, one column per period, six decimal places. */
function HeatTable({ model }: { readonly model: Model }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <caption className="sr-only">Funding rate per {model.grain === 'settlement' ? 'settlement' : model.grain === 'utc-day' ? 'UTC day, mean per settlement' : 'UTC week, mean per settlement'}, in percent</caption>
        <thead>
          <tr className="border-b border-border text-[11px] text-muted">
            <th scope="col" className="sticky left-0 z-[1] bg-card px-2 py-[6px] text-left font-semibold">Market</th>
            <th scope="col" className="px-2 py-[6px] text-right font-semibold whitespace-nowrap">
              APR now
            </th>
            {model.columns.map((c) => (
              <th key={c.startMs} scope="col" className="px-2 py-[6px] text-right font-medium whitespace-nowrap">
                {columnLabel(c, model.grain)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row) => (
            <tr key={row.marketId} className="border-b border-border last:border-b-0">
              <th scope="row" className="sticky left-0 z-[1] bg-card px-2 py-[6px] text-left font-semibold whitespace-nowrap">
                <MarketName symbol={row.symbol} size={16} />
              </th>
              <td className="num px-2 py-[6px] text-right whitespace-nowrap">{row.aprPct === undefined ? '—' : `${formatApr(row.aprPct)}, ${payerWords(row.aprPct)}`}</td>
              {row.cells.map((cell, i) => (
                <td
                  key={model.columns[i]!.startMs}
                  className={`num px-2 py-[6px] text-right whitespace-nowrap ${cell === undefined ? 'text-muted2' : ''}`}
                  title={cell === undefined ? 'no settlement' : cellMeaning(cell, model.grain)}
                >
                  {cell === undefined ? 'no data' : formatFundingPct(cell.ratePct)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The key, in words as well as colour: every swatch is labelled. */
export function HeatLegend() {
  const swatch = 'inline-block h-[10px] w-[16px] rounded-[2px] align-[-1px]';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted">
      <span>
        <i className={swatch} style={{ background: tint(COLORS.danger, 0.85) }} /> <i className={swatch} style={{ background: tint(COLORS.danger, 0.3) }} /> negative: shorts pay
      </span>
      <span>
        <i className={swatch} style={{ background: ZERO_FILL }} /> exactly 0%
      </span>
      <span>
        <i className={swatch} style={{ background: tint(COLORS.safe, 0.3) }} /> <i className={swatch} style={{ background: tint(COLORS.safe, 0.85) }} /> positive: longs pay
      </span>
      <span>
        <i className={swatch} style={MISSING_STYLE} /> no settlement (not listed yet, or none in the period)
      </span>
    </div>
  );
}
