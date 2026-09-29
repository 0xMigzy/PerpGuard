/**
 * `/positions` — every open position, assessed.
 *
 * IT RENDERS THROUGH THE ALERTS RENDERER, not through a second formatter of its
 * own. The numbers a trader acts on must read identically whether they arrived
 * as a 3am alert or were asked for just now: two renderers would eventually
 * disagree about a rounding, a precision or a word, and the disagreement would
 * surface as a trader comparing two screens and trusting neither.
 *
 * The rest of this file is about one thing — AN EMPTY LIST IS NOT THE SAME AS NO
 * POSITIONS. It is only "no positions" when the position source says it is live.
 * While the set is `awaiting-snapshot` or `stale`, an empty list means we have
 * not been told, and rendering that as an empty portfolio is how a monitor
 * reassures someone whose position is about to be liquidated.
 */
import type { PositionSourceStatus } from '@perpguard/shared';
import type { AlertConfig, AlertMessage } from '@perpguard/backend/alerts';
import { buildMessage } from '@perpguard/backend/alerts/render';
import { kindFor } from '@perpguard/backend/alerts/rules';
import type { MarketConfigs, RiskAssessment } from '@perpguard/backend/risk';

/**
 * One position, or an honest account of why it could not be rendered.
 *
 * A missing market config is not skipped. Without its `priceDecimals` and
 * `collateralDecimals` every price in the message would be wrong by a power of
 * ten and look entirely plausible, so the message is refused — but the position
 * is still named, because silently dropping it from `/positions` would tell the
 * trader they do not have it.
 */
export type PositionEntry =
  | { readonly ok: true; readonly message: AlertMessage }
  | {
      readonly ok: false;
      readonly symbol: string;
      readonly marketId: number;
      readonly reason: string;
    };

export function positionEntries(
  assessments: readonly RiskAssessment[],
  configs: MarketConfigs,
  alerts: AlertConfig,
): readonly PositionEntry[] {
  // Worst first. Someone with six positions reads the top of the list, and the
  // one in trouble has to be there.
  const ordered = [...assessments].sort((a, b) => {
    const rank = severityRank(b.state) - severityRank(a.state);
    return rank !== 0 ? rank : a.symbol.localeCompare(b.symbol);
  });

  return ordered.map((assessment): PositionEntry => {
    const market = configs.get(assessment.marketId);
    if (market === undefined) {
      return {
        ok: false,
        symbol: assessment.symbol,
        marketId: assessment.marketId,
        reason:
          `I have no market configuration for ${assessment.symbol} (market ` +
          `${assessment.marketId}), so I cannot render its prices at the right ` +
          `precision. I am still watching it.`,
      };
    }
    return {
      ok: true,
      message: buildMessage(assessment, kindFor(assessment.state), { alerts, market }),
    };
  });
}

/** Blind states sort above every real severity: they are why you stop scrolling. */
function severityRank(state: RiskAssessment['state']): number {
  switch (state) {
    case 'POSITIONS_UNTRUSTED':
      return 6;
    case 'FEED_DOWN':
      return 5;
    case 'PAST_LIQUIDATION':
      return 4;
    case 'DANGER':
      return 3;
    case 'WATCH':
      return 2;
    case 'SAFE':
      return 1;
  }
}

/**
 * The line that precedes the per-position messages.
 *
 * Carries the whole "empty is not empty" distinction, which is why it takes the
 * source status and not just a count.
 */
export function positionsHeader(
  assessments: readonly RiskAssessment[],
  positions: PositionSourceStatus,
): string {
  const usable = positions.state === 'live';
  if (assessments.length === 0) {
    if (usable) return 'No open positions.';
    return (
      `I have nothing to show, and I cannot tell you that means you have no ` +
      `positions: the position list is ${positions.state}, so I have not been told ` +
      `what is open.` + (positions.reason === undefined ? '' : ` ${positions.reason}`)
    );
  }
  const count = `${assessments.length} position${assessments.length === 1 ? '' : 's'}`;
  if (usable) return `${count}, worst first.`;
  return (
    `${count}, worst first — but the position list is ${positions.state}, so this ` +
    `may not be everything you hold and some of it may already be closed.`
  );
}
