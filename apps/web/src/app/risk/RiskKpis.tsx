'use client';

import type { ReactNode } from 'react';
import type { DirectionalExposure, RiskSnapshot } from '@perpguard/shared';
import { formatAge, formatAusdExact, formatCompact, formatCount, formatPct } from '@/lib/format.ts';
import { directionWord, wholeDays } from '@/lib/risk.ts';
import { VAR } from '@/lib/theme.ts';
import { Skeleton } from '@/components/Skeleton.tsx';
import { TokenIcon } from '@/components/TokenIcon.tsx';

/** The terminal system's panel (globals.css `.panel`): one surface, one hairline border, 8px, no shadow. */
export const PANEL = 'panel';

/**
 * A small "i" that shows its text on hover AND keyboard focus, so methodology
 * stays one tab away instead of a paragraph inside every card. The text is
 * also the accessible name, so a screen reader hears it without the popover.
 */
export function InfoTip({ text, align = 'right' }: { readonly text: ReactNode; readonly align?: 'left' | 'right' }) {
  return (
    <span className="group/tip relative inline-flex align-middle">
      <span
        tabIndex={0}
        role="note"
        className="inline-flex h-[15px] w-[15px] cursor-help items-center justify-center rounded-full border border-border2 text-[9.5px] font-semibold text-muted2 outline-none hover:border-muted hover:text-muted focus-visible:border-accent focus-visible:text-text"
      >
        i<span className="sr-only">: {text}</span>
      </span>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-[20px] z-20 hidden w-[260px] rounded-[6px] border border-border2 bg-card2 px-[10px] py-[8px] text-[11.5px] leading-[1.45] font-normal tracking-normal text-text normal-case group-hover/tip:block group-focus-within/tip:block ${
          align === 'right' ? 'right-[-6px]' : 'left-[-6px]'
        }`}
      >
        {text}
      </span>
    </span>
  );
}

/** A section label above a group of cards. */
export function GroupLabel({ children }: { readonly children: ReactNode }) {
  return <div className="section-label mb-2">{children}</div>;
}

/**
 * The KPI area, in three tiers: open interest first and largest, the four
 * single-direction stress cards, then the system-protection row. Every figure
 * is read straight off the snapshot; nothing is computed here but labels.
 */
export function RiskKpis({ s }: { readonly s: RiskSnapshot | undefined }) {
  const at5 = s?.atRisk['0.050'];
  const at10 = s?.atRisk['0.100'];
  if (s === undefined || at5 === undefined || at10 === undefined) {
    return (
      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3" aria-busy="true">
        <div className={`${PANEL} p-5`}>
          <Skeleton className="h-[12px] w-[110px]" />
          <Skeleton className="mt-4 h-[44px] w-[180px]" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:col-span-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={`${PANEL} p-4`}>
              <Skeleton className="h-[12px] w-[120px]" />
              <Skeleton className="mt-3 h-[26px] w-[110px]" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <>
      <section className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3" aria-label="Open interest and stress exposure">
        <OpenInterestCard s={s} />
        <div className="lg:col-span-2">
          <GroupLabel>Stress exposure</GroupLabel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StressCard d={at5.fall} />
            <StressCard d={at5.rise} />
            <StressCard d={at10.fall} />
            <StressCard d={at10.rise} />
          </div>
        </div>
      </section>
      <section className="mb-4" aria-label="System protection">
        <GroupLabel>System protection</GroupLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_0.8fr]">
          <LossesCard worse={at10.worse} />
          <InsuranceCard s={s} />
          <WeakestCoverCard s={s} />
        </div>
        <p className="metric-note mt-2 mb-0">
          * From our indexer&rsquo;s record of insurance-credit and bad-debt events, not an independent chain read: a direct count from the chain was rate-limited.
        </p>
      </section>
    </>
  );
}

function OpenInterestCard({ s }: { readonly s: RiskSnapshot }) {
  return (
    <div className={`${PANEL} metric flex min-h-[180px] flex-col`}>
      <div className="flex items-center justify-between gap-2">
        <span className="metric-label">Open interest</span>
        <InfoTip
          text={
            <>
              One side, at the venue&rsquo;s marks: every long is matched by a short, so a long/short split is always 50/50 and is not shown. Total position value, both sides:{' '}
              {formatCompact(s.totals.notionalAusd)} AUSD. Posted margin {formatCompact(s.totals.marginAusd)} (long {formatCompact(s.totals.longMarginAusd)}, short{' '}
              {formatCompact(s.totals.shortMarginAusd)}).
            </>
          }
        />
      </div>
      <div className="flex flex-1 flex-col justify-center py-4">
        <div className="metric-value metric-value-lg" title={`${formatAusdExact(s.totals.openInterestAusd)} AUSD`}>
          {formatCompact(s.totals.openInterestAusd)}
        </div>
        <div className="metric-support mt-3">
          <span className="num font-semibold text-text">{formatCount(s.counted.priced)}</span> open positions
          <span className="text-muted"> · {formatCount(s.counted.markets)} markets · AUSD</span>
        </div>
        {s.counted.unpriced > 0 && <div className="mt-1 text-[11.5px] text-watch">{formatCount(s.counted.unpriced)} more could not be priced</div>}
      </div>
    </div>
  );
}

/** One direction. A fall closes longs, a rise closes shorts; never a sum of the two. */
function StressCard({ d }: { readonly d: DirectionalExposure }) {
  const fall = d.move < 0;
  const size = `${Math.round(Math.abs(d.move) * 100)}%`;
  return (
    <div className={`${PANEL} metric`}>
      <div className="flex items-start justify-between gap-2">
        <span className="metric-label">
          If price {fall ? 'falls' : 'rises'} {size}
        </span>
        <span className="rounded-[4px] border border-border px-[6px] py-[1px] text-[10px] font-semibold tracking-[0.05em] text-muted uppercase">
          closes {fall ? 'longs' : 'shorts'}
        </span>
      </div>
      <div className="metric-value mt-[6px]" title={`${formatAusdExact(d.notionalAusd)} AUSD notional exposed`}>
        {formatCompact(d.notionalAusd)}
      </div>
      <div className="metric-support mt-[2px]">
        <span className="num text-text">{formatCount(d.positions)}</span> positions
        <span className="text-muted"> · </span>
        <span className="num text-text">{d.shareOfOpenInterest === undefined ? '—' : formatPct(d.shareOfOpenInterest)}</span>
        <span className="text-muted"> of OI</span>
      </div>
      <div className="metric-note mt-[6px]">
        {d.shortfallPositions === 0
          ? 'none past its own collateral'
          : `${formatCount(d.shortfallPositions)} past ${d.shortfallPositions === 1 ? 'its' : 'their'} own collateral · ${formatCompact(d.shortfallAusd)}`}
      </div>
    </div>
  );
}

function LossesCard({ worse }: { readonly worse: DirectionalExposure }) {
  const word = directionWord(worse.move);
  return (
    <div className={`${PANEL} metric`}>
      <div className="flex items-center justify-between gap-2">
        <span className="metric-label">Losses beyond collateral · 10%</span>
        <InfoTip
          text={`Equity below zero at the shocked mark: what the insurance fund would have to absorb if the price gapped straight through liquidation. One direction only; a fall and a rise are never added. This is exposure, not a realised loss.`}
        />
      </div>
      <div
        className="metric-value mt-[6px]"
        style={{ color: worse.shortfallAusd > 0 ? VAR.danger : VAR.text }}
        title={`${formatAusdExact(worse.shortfallAusd)} AUSD`}
      >
        {formatCompact(worse.shortfallAusd)}
      </div>
      <div className="metric-support mt-[2px]">worst case if every market {word} 10%</div>
      <div className="metric-note mt-[6px]">
        {worse.shortfallPositions === 0
          ? 'no position loses more than its own collateral'
          : `${formatCount(worse.shortfallPositions)} ${worse.shortfallPositions === 1 ? 'position' : 'positions'} past their own collateral`}
      </div>
    </div>
  );
}

function InsuranceCard({ s }: { readonly s: RiskSnapshot }) {
  const backstop = s.backstop;
  const days = backstop?.sinceMs === undefined ? undefined : wholeDays(backstop.sinceMs, s.asOf.indexerBlockAtMs ?? s.asOf.generatedAtMs);
  const never = backstop !== undefined && backstop.insuranceCredits === 0 && backstop.badDebtLiquidations === 0;
  return (
    <div className={`${PANEL} metric`}>
      <div className="flex items-center justify-between gap-2">
        <span className="metric-label">Insurance funds</span>
        <InfoTip
          text={`${formatCount(s.insurance.marketsWithReading)} per-market balances read off the Exchange contract and added together: how much money the funds hold. Each fund pays only for its own market, so cover is shown per market, never pooled.${
            s.asOf.insuranceAtMs === undefined ? '' : ` Read ${formatAge(Date.now() - s.asOf.insuranceAtMs)} ago.`
          }`}
        />
      </div>
      <div className="metric-value mt-[6px]" title={s.insurance.totalAusd === undefined ? undefined : `${formatAusdExact(s.insurance.totalAusd)} AUSD`}>
        {s.insurance.totalAusd === undefined ? 'unknown' : formatCompact(s.insurance.totalAusd)}
      </div>
      <div className="metric-support mt-[2px]">
        across {formatCount(s.insurance.marketsWithReading)} markets{s.insurance.marketsWithout === 0 ? '' : ` · ${formatCount(s.insurance.marketsWithout)} without a reading`}
      </div>
      <div className="metric-note mt-[6px]">
        {backstop === undefined
          ? 'draw history not read'
          : never
            ? `never drawn on: 0 insurance credits, 0 bad debt${days === undefined ? '' : ` in ${formatCount(days)} days`}*`
            : `drawn on: ${formatCount(backstop.insuranceCredits)} insurance credits, ${formatCount(backstop.badDebtLiquidations)} with bad debt*`}
      </div>
    </div>
  );
}

/** Deliberately the quietest card in the row: smaller figure, same panel. */
function WeakestCoverCard({ s }: { readonly s: RiskSnapshot }) {
  const w = s.weakestCover;
  const name = w === undefined ? undefined : (w.market.symbol ?? `market ${w.market.marketId}`);
  return (
    <div className={`${PANEL} metric`}>
      <div className="flex items-center justify-between gap-2">
        <span className="metric-label">Weakest cover · 10%</span>
        <InfoTip
          text="The market whose insurance fund is smallest against its own losses beyond collateral, each market in its worse single direction at 10%. Funds are not pooled."
          align="right"
        />
      </div>
      {w === undefined || name === undefined ? (
        <div className="metric-support mt-[8px]">No market has losses beyond collateral at 10%, so there is nothing to cover.</div>
      ) : (
        <>
          <div className="mt-[8px] flex items-center gap-2">
            <TokenIcon symbol={name} size={18} />
            <span className="num text-[20px] leading-none font-semibold tracking-[-0.02em]" style={{ color: w.cover < 10 ? VAR.danger : w.cover < 50 ? VAR.watch : VAR.text }}>
              {name} {w.cover.toFixed(1)}×
            </span>
          </div>
          <div className="metric-note mt-[8px]">
            its fund ÷ {formatCompact(w.shortfallAusd)} past collateral if {name} {directionWord(w.direction === 'fall' ? -1 : 1)} 10%
          </div>
        </>
      )}
    </div>
  );
}
