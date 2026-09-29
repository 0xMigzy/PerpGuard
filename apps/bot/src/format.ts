/**
 * An {@link AlertMessage} as a Telegram message.
 *
 * Three rules, all of them load-bearing.
 *
 * NO `parse_mode`. The rendered text already contains `·`, `→`, `’` and grouped
 * decimals, and every Telegram markup dialect treats some of those as syntax.
 * Sending as plain text means a message can neither fail to send nor arrive
 * mangled because a price happened to contain a character the parser cared
 * about, and it means no escaping layer sits between the words `render.ts` wrote
 * and the words the trader reads.
 *
 * BUTTON LABELS ARE NOT WRITTEN HERE. Each comes from `action.label`, which is
 * the exact line the message body showed. The button and the sentence above it
 * therefore cannot disagree about the amount — they are the same string.
 *
 * AN UNAVAILABLE MARKET STILL GETS ITS MESSAGE, ITS OPTIONS AND ITS BUTTONS.
 * Monitoring and actionability are separate questions: a trader whose venue has
 * halted a market is exactly the trader who most needs the warning. The buttons
 * are rendered as disabled — a tap reports the reason and executes nothing — and
 * the reason is stated in the text as well, because a reason only visible on tap
 * is a reason most people never see.
 */
import { InlineKeyboard } from 'grammy';
import type { ActionAvailability } from '@perpguard/shared';
import type { AlertAction, AlertMessage } from '@perpguard/backend/alerts';
import { encodeCallback, type CallbackKind } from './callback.ts';
import type { PendingActionStore } from './actions.ts';

export interface ActionButton {
  /** The action's own rendered line. Never composed here. */
  readonly label: string;
  readonly data: string;
}

/**
 * Whether a tap may reach the executor.
 *
 * `undefined` availability means nobody asked, which is treated as NOT
 * actionable. Not asking is not an answer, and defaulting the other way would
 * make a forgotten `await` look like permission.
 */
function kindFor(availability: ActionAvailability | undefined): CallbackKind {
  return availability?.actionable === true ? 'act' : 'blocked';
}

/**
 * One button per action, in the order the message listed them.
 *
 * `tokenFor` is injected so this stays pure and so the store is written to
 * exactly once per action by the caller.
 */
export function buttonsFor(
  actions: readonly AlertAction[],
  availability: ActionAvailability | undefined,
  tokenFor: (action: AlertAction) => string,
): readonly ActionButton[] {
  const kind = kindFor(availability);
  return actions.map((action) => ({
    label: action.label,
    data: encodeCallback({
      kind,
      token: tokenFor(action),
      marketId: action.marketId,
      amountCNS: action.amountCNS,
    }),
  }));
}

/**
 * The line that explains why the buttons do nothing, or undefined when they do.
 *
 * Only ever added when there are actions to qualify. A `feed-down` message
 * carries none, and appending "actions unavailable" to it would answer a
 * question nobody asked while burying the one that matters.
 */
export function availabilityNote(
  availability: ActionAvailability | undefined,
  actionCount: number,
): string | undefined {
  if (actionCount === 0) return undefined;
  if (availability === undefined) {
    return 'Actions are unavailable: PerpGuard has not been told whether this market can be acted on.';
  }
  if (availability.actionable) return undefined;
  return `Actions are unavailable on ${availability.network}: ${availability.reason}`;
}

export interface TelegramMessage {
  readonly text: string;
  /** Absent when the message has no actions at all. */
  readonly keyboard: InlineKeyboard | undefined;
}

export interface BuildOptions {
  readonly message: AlertMessage;
  /** From the ACTING venue. Undefined means it was never asked. */
  readonly availability: ActionAvailability | undefined;
  readonly store: PendingActionStore;
  readonly userId: string;
  readonly telegramUserId: number;
}

/**
 * Text and keyboard for one alert, parking each action in the pending store.
 *
 * Every action gets its own token even when the button is disabled: tapping a
 * disabled button looks up the same action to report what it would have done,
 * and giving the two paths one lookup keeps them from drifting.
 *
 * One button per row. The labels are whole sentences — "Add 2,662 → buffer 9.0%,
 * liquidation 76,446.7" — and two of those side by side are unreadable on a
 * phone, which is where this message is read.
 */
export function buildTelegramMessage(options: BuildOptions): TelegramMessage {
  const { message, availability, store, userId, telegramUserId } = options;

  const buttons = buttonsFor(message.actions, availability, (action) => {
    return store.put({ userId, telegramUserId, action }).token;
  });

  const note = availabilityNote(availability, message.actions.length);
  const text = note === undefined ? message.text : `${message.text}\n${note}`;

  if (buttons.length === 0) return { text, keyboard: undefined };

  const keyboard = new InlineKeyboard();
  for (const button of buttons) keyboard.text(button.label, button.data).row();
  return { text, keyboard };
}
