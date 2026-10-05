import type { ReactNode } from 'react';
import type { Delta } from '@/lib/overview.ts';
import { formatSignedPct } from '@/lib/format.ts';
import { Skeleton } from './Skeleton.tsx';
import { Sparkline } from './Sparkline.tsx';

export interface StatTileProps {
  /** "Volume · 24h". The period is part of the label, from the API where it has one. */
  readonly label: string;
  /** The big figure, already formatted. */
  readonly value: string;
  /** The exact figure, for hover. */
  readonly exact?: string | undefined;
  readonly valueColor?: string | undefined;
  readonly delta?: Delta | undefined;
  /** What the delta is against, e.g. "vs prev". */
  readonly deltaLabel?: string;
  /** Which direction is good. Liquidations going up is not. */
  readonly goodDirection?: 'up' | 'down';
  readonly secondary?: ReactNode;
  readonly sparkline?: readonly number[] | undefined;
  readonly sparklineColor?: string | undefined;
  /** Shown instead of a sparkline when there is honestly no series for this figure. */
  readonly sparklineNote?: string | undefined;
  /** Marks the label amber when the period is not the page's timeframe. */
  readonly labelWarn?: boolean;
}

export function StatTile(props: StatTileProps) {
  const good = props.goodDirection ?? 'up';
  const delta = props.delta;
  let deltaNode: ReactNode;
  if (delta === undefined) {
    deltaNode = null;
  } else if (delta.fraction === undefined) {
    deltaNode = (
      <div className="text-[12px] font-semibold text-muted" title={delta.reason}>
        — <span className="ml-1 font-medium">{props.deltaLabel ?? 'vs prev'}: unknown</span>
      </div>
    );
  } else {
    const up = delta.fraction > 0;
    const flat = delta.fraction === 0;
    const isGood = flat ? undefined : (up && good === 'up') || (!up && good === 'down');
    const color = flat ? 'text-muted' : isGood ? 'text-safe' : 'text-danger';
    deltaNode = (
      <div className={`num text-[12px] font-semibold ${color}`}>
        {flat ? '' : up ? '▲ ' : '▼ '}
        {formatSignedPct(delta.fraction)}
        <span className="ml-1 font-medium text-muted">{props.deltaLabel ?? 'vs prev'}</span>
      </div>
    );
  }
  return (
    <div className="card stat-tile relative overflow-hidden px-[18px] pt-4 pb-[10px]">
      <div className={`stat-label text-[12.5px] font-medium ${props.labelWarn ? 'text-watch' : 'text-muted'}`}>{props.label}</div>
      <div
        className="stat-value num mt-2 mb-[6px] text-[30px] leading-[1.1] font-bold tracking-[-0.035em]"
        style={props.valueColor === undefined ? undefined : { color: props.valueColor }}
        title={props.exact}
      >
        {props.value}
      </div>
      {deltaNode}
      {props.secondary !== undefined && <div className="stat-secondary mt-[2px] text-[12px] text-muted">{props.secondary}</div>}
      {props.sparkline !== undefined ? (
        <Sparkline values={props.sparkline} color={props.sparklineColor} />
      ) : props.sparklineNote !== undefined ? (
        <div className="stat-note mt-2 flex h-[44px] items-end text-[11px] text-muted2">{props.sparklineNote}</div>
      ) : null}
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <div className="card px-[18px] pt-4 pb-[10px]">
      <Skeleton className="h-[14px] w-[110px]" />
      <Skeleton className="mt-3 mb-2 h-[30px] w-[140px]" />
      <Skeleton className="h-[12px] w-[90px]" />
      <Skeleton className="mt-2 h-[12px] w-[150px]" />
      <Skeleton className="mt-3 h-[44px] w-full" />
    </div>
  );
}
