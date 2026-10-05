'use client';

import type { ReactNode } from 'react';
import type { AssessedPosition, WalletProfile } from '@perpguard/shared';
import { formatAusd, formatCompact, formatCount } from '@/lib/format.ts';
import { accountSummary } from '@/lib/traders.ts';
import { Skeleton } from '@/components/Skeleton.tsx';

/** A tile figure: compact from 10K, two decimals below, so small accounts stay exact. */
const tile = (ausd: number): string => (Math.abs(ausd) >= 10_000 ? formatCompact(ausd) : formatAusd(ausd));
const signed = (ausd: number): string => `${ausd > 0 ? '+' : ausd < 0 ? '−' : ''}${tile(Math.abs(ausd))}`;

/**
 * The account's money now, in one strip: equity first, then what it is made
 * of, then what was put in and taken out over its life. The row under the
 * tiles shows the arithmetic and closes it against the lifetime flows, so the
 * six numbers read as one statement about the account. AUSD throughout.
 */
export function AccountSummary({
  profile,
  positions,
  positionsFailed,
}: {
  readonly profile: WalletProfile | undefined;
  /** The page's priced positions, or undefined while they load. */
  readonly positions: readonly AssessedPosition[] | undefined;
  /** The marks could not be read: margin is known, unrealised and equity are not. */
  readonly positionsFailed: boolean;
}) {
  if (profile === undefined || (positions === undefined && !positionsFailed)) {
    return (
      <section className="card mb-4 grid grid-cols-2 gap-x-4 gap-y-3 px-[18px] py-4 sm:grid-cols-3 lg:grid-cols-6" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i}>
            <Skeleton className="h-[11px] w-[80px]" />
            <Skeleton className="mt-2 h-[22px] w-[90px]" />
          </div>
        ))}
      </section>
    );
  }
  // Without marks every position counts as unpriced: margin stands, equity is withheld.
  const rows = positions ?? profile.openPositions.map((position) => ({ position }));
  const s = accountSummary(profile, rows);
  const n = s.positions;
  const equityKnown = s.equityAusd !== undefined;

  return (
    <section className="card mb-4 px-[18px] pt-4 pb-3" aria-label="Account summary">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-[1.5fr_repeat(5,1fr)]">
        <Cell label="Equity" lead value={s.equityAusd === undefined ? '—' : tile(s.equityAusd)} title={s.equityAusd === undefined ? undefined : `${formatAusd(s.equityAusd)} AUSD`}>
          {equityKnown ? 'free + margin + unrealised' : positionsFailed ? 'marks unavailable, so not totalled' : `${formatCount(s.unpriced)} of ${formatCount(n)} positions could not be priced`}
        </Cell>
        <Cell label="Free balance" value={tile(s.freeAusd)} title={`${formatAusd(s.freeAusd)} AUSD`}>
          not backing any position
        </Cell>
        <Cell label="Margin in use" value={tile(s.marginAusd)} title={`${formatAusd(s.marginAusd)} AUSD`}>
          {n === 0 ? 'no open position' : `across ${formatCount(n)} position${n === 1 ? '' : 's'}`}
        </Cell>
        <Cell
          label="Unrealised PnL"
          value={!equityKnown && s.unpriced === n && n > 0 ? '—' : signed(s.unrealisedAusd)}
          valueClass={s.unrealisedAusd > 0 ? 'text-safe' : s.unrealisedAusd < 0 ? 'text-danger' : ''}
          title={`${formatAusd(s.unrealisedAusd)} AUSD${s.unpriced > 0 ? `, ${formatCount(s.unpriced)} position${s.unpriced === 1 ? '' : 's'} not priced` : ''}`}
        >
          if closed at the mark
        </Cell>
        <Cell label="Deposited" value={tile(s.depositedAusd)} title={`${formatAusd(s.depositedAusd)} AUSD`}>
          lifetime
        </Cell>
        <Cell label="Withdrawn" value={tile(s.withdrawnAusd)} title={`${formatAusd(s.withdrawnAusd)} AUSD`}>
          lifetime
        </Cell>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-border pt-[10px] text-[12px] text-muted">
        <span className="num">
          {equityKnown ? (
            <>
              {formatAusd(s.freeAusd)} free + {formatAusd(s.marginAusd)} margin {s.unrealisedAusd < 0 ? '−' : '+'} {formatAusd(Math.abs(s.unrealisedAusd))} unrealised ={' '}
              <b className="font-semibold text-text">{formatAusd(s.equityAusd!)} equity</b>
            </>
          ) : (
            <>Equity is not totalled until every open position has a mark.</>
          )}
        </span>
        <span className="num">
          net {formatAusd(Math.abs(s.netInAusd))} {s.netInAusd >= 0 ? 'in' : 'out'}
          {s.sinceFirstDepositAusd !== undefined && (
            <>
              , so{' '}
              <b className={`font-semibold ${s.sinceFirstDepositAusd > 0 ? 'text-safe' : s.sinceFirstDepositAusd < 0 ? 'text-danger' : 'text-text'}`}>
                {s.sinceFirstDepositAusd === 0 ? 'level' : `${s.sinceFirstDepositAusd > 0 ? 'up' : 'down'} ${formatAusd(Math.abs(s.sinceFirstDepositAusd))}`}
              </b>{' '}
              since first deposit
            </>
          )}
        </span>
      </div>
    </section>
  );
}

function Cell({
  label,
  value,
  lead,
  valueClass,
  title,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly lead?: boolean;
  readonly valueClass?: string;
  readonly title?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className={lead === true ? 'col-span-2 sm:col-span-1' : ''}>
      <div className="text-[11.5px] font-medium tracking-[0.02em] text-muted uppercase">{label}</div>
      <div
        className={`num mt-1 font-semibold tracking-[-0.02em] ${lead === true ? 'text-[28px] leading-[1.1]' : 'text-[19px] leading-[1.2]'} ${valueClass ?? 'text-text'}`}
        title={title}
      >
        {value} {lead === true && <span className="text-[13px] font-medium tracking-normal text-muted">AUSD</span>}
      </div>
      <div className="mt-[2px] text-[11.5px] text-muted2">{children}</div>
    </div>
  );
}
