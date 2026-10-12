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

import { TRADING, networkSplit } from './tradingNetwork.ts';

/** THIS deployment's bot: @PerpGuardBot on mainnet, @PerpGuardTestnetBot on testnet (`tradingNetwork.ts`). */
export const BOT_HANDLE = TRADING.botHandle;
/** Which network each half runs on, said once on Overview and on /bot (owner, 12 Oct 2026). */
export const NETWORK_SPLIT = networkSplit(TRADING);
export const BOT_URL = TRADING.botUrl;

/** The setup guide (apps/web/src/app/bot/guide), written for this deployment's network. Undefined would render "Coming soon" and no link. */
export const TESTNET_GUIDE_URL: string | undefined = '/bot/guide';

/** The manual alert at the account's alert distance, for a BTC long 2.7% from liquidation. */
export const ALERT_EXAMPLE = {
  /** The banner's network: the page prints its own deployment's, uppercase and bold, as the bot does (`actingBadge`). */
  network: 'testnet',
  /** The position and its distance; the distance is the part the page highlights. */
  position: 'BTC long',
  distance: '2.7%',
  /** "Margin 122 AUSD · 9,762 AUSD free", each amount bold in the chat. */
  margin: '122 AUSD',
  free: '9,762 AUSD',
  /**
   * The keyboard, row by row, exactly as labelled. Up to two top-ups that fit
   * the free balance and land clear of the alert line (5%, so 7%): the smaller
   * reaches it, the larger is twice that; each says the distance it buys and
   * what it leaves free.
   */
  keyboard: [['+150 → 11% away · 9,612 free'], ['+75 → 7.0% away · 9,687 free'], ['🎛 Custom amount', 'Dismiss'], ['📊 View / close position']],
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
