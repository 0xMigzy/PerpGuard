/**
 * Who hears about an event. Pure.
 *
 * A wallet's own changes go to the chats WATCHING it (wallet alerts on), at
 * any size: someone watching #4088 wants its liquidation however small. The
 * feeds (every liquidation, every large taker order, on any account) go to
 * every chat whose threshold the event meets. A chat that qualifies both
 * ways hears once, as a watcher.
 */
import type { AlertPreferences } from './preferences.ts';
import { accountOf, type PerpEvent } from './types.ts';

export interface Recipient {
  readonly chatId: number;
  readonly why: 'watching' | 'feed';
}

export interface MatchInputs {
  /** Chats watching this account. */
  readonly watchersOf: (accountId: number) => readonly number[];
  /** Every chat that has started the bot: the feeds' audience. */
  readonly feedChats: () => readonly number[];
  readonly preferencesFor: (chatId: number) => AlertPreferences;
}

export function recipientsFor(event: PerpEvent, inputs: MatchInputs): readonly Recipient[] {
  const out = new Map<number, Recipient>();
  const watchers = inputs.watchersOf(accountOf(event)).filter((chatId) => inputs.preferencesFor(chatId).walletAlerts);

  if (event.kind !== 'large-trade') {
    for (const chatId of watchers) out.set(chatId, { chatId, why: 'watching' });
  }
  const size = event.kind === 'liquidation' ? event.liquidation.notionalAusd : event.kind === 'large-trade' ? event.order.notionalAusd : undefined;
  if (size !== undefined) {
    for (const chatId of inputs.feedChats()) {
      if (out.has(chatId)) continue;
      const p = inputs.preferencesFor(chatId);
      const min = event.kind === 'liquidation' ? p.liquidationMinAusd : p.largeTradeMinAusd;
      if (min !== undefined && size >= min) out.set(chatId, { chatId, why: 'feed' });
    }
  }
  return [...out.values()];
}
