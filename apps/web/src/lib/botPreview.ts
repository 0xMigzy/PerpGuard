/**
 * The Bot page's facts in one place: where the bot is, and the example alert
 * it shows.
 *
 * THE EXAMPLE IS THE BOT'S REAL FORMAT. Its lines are what
 * `manualAlertText` (apps/bot/src/manualAlert.ts) writes for this position,
 * and its button labels what `amountButton` and the alert's keyboard write;
 * `apps/bot/src/botPagePreview.test.ts` renders the same example through the
 * bot's own code and fails if this file drifts from it. The figures are an
 * example, not live data, and the page says so.
 */

export const BOT_HANDLE = '@PerpGuardBot';
export const BOT_URL = 'https://t.me/PerpGuardBot';

/** The testnet setup guide (apps/web/src/app/bot/guide). Undefined would render "Coming soon" and no link. */
export const TESTNET_GUIDE_URL: string | undefined = '/bot/guide';

/** The manual alert at the account's alert distance, for a BTC long 2.7% from liquidation. */
export const ALERT_EXAMPLE = {
  /** The first line on every message that offers an action: the acting network, said once. */
  network: 'testnet',
  /** The position and its distance; the distance is the part the page highlights. */
  position: 'BTC long',
  distance: '2.7%',
  /** "Margin 122 AUSD · 9,762 AUSD free", each amount bold in the chat. */
  margin: '122 AUSD',
  free: '9,762 AUSD',
  /**
   * The keyboard, row by row, exactly as labelled. The two amounts are sized to
   * distances (the alert line, 5%, plus 2 and plus 5 points), each showing the
   * distance it buys.
   */
  keyboard: [['+75 → 7.0%'], ['+130 → 10%'], ['🎛 Custom amount', 'Dismiss'], ['📊 View position']],
} as const;

/** What the example is built from, for the bot-side test: the inputs behind the lines above. */
export const ALERT_EXAMPLE_INPUTS = {
  liqBufferPct: 0.027,
  marginCNS: 122_000_000n,
  freeCNS: 9_762_000_000n,
  /** The account's alert distance, percent. */
  alertPct: 5,
  /** The position's notional at the mark, AUSD: a top-up moves the distance by amount ÷ notional. */
  notionalAusd: 1_727,
} as const;
