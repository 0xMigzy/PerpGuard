import type { ChartRung } from '@/lib/risk.ts';
import { formatCompact, formatCount } from '@/lib/format.ts';
import { COLORS } from '@/lib/theme.ts';

const W = 560;
const LABEL_W = 82;
const ROW_H = 28;
const BAR_H = 14;
const TOP = 10;

/**
 * Notional exposed at each move size, longs to the left of zero and shorts to
 * the right, diverging from one centre line. Every rung is a row; a rung with
 * nothing exposed still draws so the reader can see it is empty.
 */
export function LadderChart({ rungs }: { readonly rungs: readonly ChartRung[] }) {
  const max = Math.max(1, ...rungs.map((r) => Math.max(r.longsAusd, r.shortsAusd)));
  const centre = LABEL_W + (W - LABEL_W) / 2;
  const half = (W - LABEL_W) / 2 - 10;
  const height = TOP + rungs.length * ROW_H + 30;
  const px = (ausd: number) => (ausd / max) * half;
  const ticks = [0.5, 1].map((f) => ({ f, ausd: max * f }));
  const summary = rungs.map((r) => `${Math.round(r.size * 1000) / 10}%: ${formatCompact(r.longsAusd)} of longs, ${formatCompact(r.shortsAusd)} of shorts`).join('; ');
  return (
    <svg className="block h-auto w-full" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Notional exposed at each move size, longs left and shorts right. ${summary}`}>
      <line x1={centre} y1={TOP} x2={centre} y2={TOP + rungs.length * ROW_H} stroke={COLORS.border2} strokeWidth={1} />
      {ticks.map((t) => (
        <g key={t.f}>
          <line x1={centre - px(t.ausd)} y1={TOP} x2={centre - px(t.ausd)} y2={TOP + rungs.length * ROW_H} stroke={COLORS.border} strokeWidth={1} />
          <line x1={centre + px(t.ausd)} y1={TOP} x2={centre + px(t.ausd)} y2={TOP + rungs.length * ROW_H} stroke={COLORS.border} strokeWidth={1} />
          <text x={centre - px(t.ausd)} y={height - 8} textAnchor="middle" fill={COLORS.muted2} fontSize="10.5" className="num">{formatCompact(t.ausd)}</text>
          <text x={centre + px(t.ausd)} y={height - 8} textAnchor="middle" fill={COLORS.muted2} fontSize="10.5" className="num">{formatCompact(t.ausd)}</text>
        </g>
      ))}
      <text x={centre} y={height - 8} textAnchor="middle" fill={COLORS.muted2} fontSize="10.5" className="num">0</text>
      {rungs.map((r, i) => {
        const y = TOP + i * ROW_H + (ROW_H - BAR_H) / 2;
        const lw = Math.max(r.longsAusd > 0 ? 1.5 : 0, px(r.longsAusd));
        const sw = Math.max(r.shortsAusd > 0 ? 1.5 : 0, px(r.shortsAusd));
        return (
          <g key={r.size}>
            <text x={LABEL_W - 8} y={y + BAR_H - 3} textAnchor="end" fill={COLORS.muted} fontSize="10.5" className="num">{Math.round(r.size * 1000) / 10}%</text>
            <title>{`${Math.round(r.size * 1000) / 10}%: ${formatCount(r.longs)} longs (${formatCompact(r.longsAusd)}) exposed to a fall, ${formatCount(r.shorts)} shorts (${formatCompact(r.shortsAusd)}) to a rise`}</title>
            <rect x={centre - lw} y={y} width={lw} height={BAR_H} rx={2} fill={COLORS.safe} />
            <rect x={centre} y={y} width={sw} height={BAR_H} rx={2} fill={COLORS.danger} />
          </g>
        );
      })}
    </svg>
  );
}
