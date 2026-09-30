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
  switch (action.intent) {
    case 'clear-danger':
      return 'This is the cheaper option: it buys exactly enough room to leave the danger band, and no more.';
    case 'to-safe':
      return 'This is the larger option: it reaches the buffer at which the position counts as safe again.';
    case 'custom':
      // No threshold to name, because the amount did not aim at one. What it
      // buys is on the line above, computed by the same engine as the offered
      // options — which is the only claim this screen ever makes.
      return 'This is your own amount. The buffer and liquidation price above are what it buys.';
  }
}

/**
 * @param notes things to read before confirming, shown above the final line.
 *   NOT refusals — a note is why the Confirm button is still here rather than
 *   why it is gone. They sit before "Nothing has been sent yet." so that
 *   sentence stays last, where a reader stops.
 */
export function renderConfirmation(
  action: AlertAction,
  market: MarketRiskConfig | undefined,
  notes: readonly string[] = [],
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
  lines.push(...notes);
  lines.push('Nothing has been sent yet.');
  return lines.join('\n');
}

/** The Confirm button's label. The only button label PerpGuard writes itself. */
export const CONFIRM_BUTTON_LABEL = 'Confirm';

/**
 * The retry button's label, offered ONLY after a reconciled `not-applied`.
 *
 * NEVER BLIND-RETRY; RETRYING AFTER RECONCILIATION IS CORRECT. Those are not in
 * tension, and the difference is entirely about what is known:
 *
 *   A BLIND RETRY is a re-send on the strength of a reported failure. For `t: 6`
 *   that report is wrong — `st: 7 Failed, sr: 32` comes back while the collateral
 *   IS credited — so re-sending on it adds the margin twice. Observed live:
 *   0.0559 -> 0.083584 -> 0.111268 AUSD.
 *
 *   A RETRY AFTER RECONCILIATION is a fresh action taken once the position itself
 *   has been read and shown NOT to have moved. Nothing landed, so nothing can
 *   land twice. The forwarder drops requests on testnet — `mt: 3` code 0 with no
 *   `mt: 24` and no `lfr` movement — and that is exactly the case this button
 *   exists for.
 *
 * The asymmetry that decides it: a trader whose rescue silently vanished, with no
 * way to send it again, is worse off than one we never alerted at all. They think
 * they are covered. So `not-applied` gets a button and `unknown` never does —
 * under `unknown` something may have landed, and that is the one state where
 * sending again could double it.
 */
export const RETRY_BUTTON_LABEL = 'Send again';
