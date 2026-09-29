/**
 * The confirmation screen: the last thing a user reads before an action is sent.
 *
 * It exists to make one promise checkable — THE BUTTON SENDS EXACTLY WHAT THE
 * MESSAGE SHOWED. So it quotes the action's own rendered line verbatim and then
 * states the same figure again at the collateral's full precision, straight out
 * of `amountCNS`. If those two ever disagree, the disagreement is visible here
 * rather than discovered afterwards in a trader's margin balance.
 *
 * `amountCNS` is already the CEILED figure the alert text showed; the buffer and
 * liquidation price in the label are for the exact unrounded amount, so the
 * action lands marginally better than the line claims. That asymmetry runs one
 * way only and is stated rather than hidden.
 *
 * Pure.
 */
import { scaledToNumber, type MarketRiskConfig } from '@perpguard/shared';
import type { AlertAction } from '@perpguard/backend/alerts';

/** The exact amount, at the collateral's own precision. Not rounded, not grouped. */
export function formatExactAusd(amountCNS: bigint, market: MarketRiskConfig | undefined): string {
  if (market === undefined) return `${amountCNS} AUSD micros`;
  return `${scaledToNumber(amountCNS, market.collateralDecimals).toFixed(market.collateralDecimals)} AUSD`;
}

/** What each intent actually buys, said without an adjective. */
function intentLine(action: AlertAction): string {
  return action.intent === 'clear-danger'
    ? 'This is the cheaper option: it buys exactly enough room to leave the danger band, and no more.'
    : 'This is the larger option: it reaches the buffer at which the position counts as safe again.';
}

export function renderConfirmation(
  action: AlertAction,
  market: MarketRiskConfig | undefined,
): string {
  const lines = [
    `Confirm — add margin to ${action.symbol}`,
    action.label,
    `Exact amount sent: ${formatExactAusd(action.amountCNS, market)}.`,
    intentLine(action),
    'Isolated margin: this collateral goes to this position only.',
  ];
  if (action.positionId === undefined) {
    // Said out loud rather than discovered at submission. Without the venue's
    // own handle there is nothing to address the action to.
    lines.push('I do not have this position’s venue id, so I cannot address the action to it.');
  }
  lines.push('Nothing has been sent yet.');
  return lines.join('\n');
}

/** The Confirm button's label. The only button label PerpGuard writes itself. */
export const CONFIRM_BUTTON_LABEL = 'Confirm';
