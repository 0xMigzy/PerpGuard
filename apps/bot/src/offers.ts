/**
 * The suggested amounts for one position, PRICED BY THE ENGINE and turned into
 * the actions their buttons carry. Shared by the manual alert and View
 * position so the two can never offer different amounts for the same position.
 *
 * The rule is `suggestAmounts`; every distance in it is the risk loop's own
 * projection (`projectAddMargin`), so no liquidation maths happens here.
 */
import type { MarketRiskConfig } from '@perpguard/shared';
import type { AlertAction } from '@perpguard/backend/alerts';
import type { RiskAssessment } from '@perpguard/backend/risk';
import type { FreeBalanceReading } from './balance.ts';
import { customAction } from './custom.ts';
import { suggestAmounts, type SuggestedAmount, type Suggestions } from './suggestedAmounts.ts';
import type { RiskView } from './view.ts';

export interface PricedOffers {
  readonly suggestions: Suggestions;
  /** Each suggested amount with the action its button carries (confirm first, as every amount). */
  readonly offers: ReadonlyArray<{ readonly amount: SuggestedAmount; readonly action: AlertAction }>;
  /** Why nothing could be priced, when nothing could. */
  readonly unpricedReason?: string;
}

export function pricedOffers(o: {
  readonly view: Pick<RiskView, 'projectAddMargin'>;
  readonly assessment: RiskAssessment;
  readonly market: MarketRiskConfig;
  /** The account's alert distance, percent. */
  readonly alertPct: number;
  readonly free: FreeBalanceReading;
  /** Held back from the free balance: Rescue in flight and the largest armed "minimum remaining". */
  readonly reservedCNS?: bigint | undefined;
  readonly bufferDecimals: number;
}): PricedOffers {
  const { assessment: a, market } = o;
  const unit = 10n ** BigInt(market.collateralDecimals);
  const now = o.view.projectAddMargin(a.marketId, 0n);
  if (!now.ok) return { suggestions: { amounts: [] }, offers: [], unpricedReason: now.reason };
  const current = now.projection.resultingBufferPct;
  if (current === undefined) return { suggestions: { amounts: [] }, offers: [], unpricedReason: `${a.symbol} has no liquidation distance to move` };

  const suggestions = suggestAmounts({
    currentBuffer: current,
    alertFraction: o.alertPct / 100,
    freeFloorCNS: o.free.known ? o.free.floorCNS : undefined,
    ...(o.reservedCNS === undefined ? {} : { reservedCNS: o.reservedCNS }),
    unitCNS: unit,
    project: (amountCNS) => {
      const p = o.view.projectAddMargin(a.marketId, amountCNS);
      return p.ok ? p.projection.resultingBufferPct : undefined;
    },
  });
  const offers: Array<{ amount: SuggestedAmount; action: AlertAction }> = [];
  for (const amount of suggestions.amounts) {
    const projected = o.view.projectAddMargin(a.marketId, amount.amountCNS);
    if (!projected.ok) continue;
    offers.push({ amount, action: customAction(projected.projection, market, a.positionId, o.bufferDecimals, a.liqBufferPct) });
  }
  return { suggestions, offers };
}
