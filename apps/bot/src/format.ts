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
import { boughtDistance } from './account.ts';

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
    label: buttonLabel(action),
    data: encodeCallback({
      kind,
      token: tokenFor(action),
      marketId: action.marketId,
      amountCNS: action.amountCNS,
    }),
  }));
}

/**
 * `+562 → 4.0%`: the amount and the distance it buys, as on every other amount
 * button. The amount is read off the action's own label, so it is the very
 * figure (already ceiled, at the collateral's own precision) that is sent and
 * logged; the label itself stays whole in `action_log`.
 */
export function buttonLabel(action: AlertAction): string {
  const amount = /^Add ([\d,.]+)/.exec(action.label)?.[1];
  const to = boughtDistance(action.resultingBufferPct);
  return amount === undefined || to === undefined ? action.label : `+${amount} → ${to}`;
}

/** The third button's label. A prompt, not an amount: there is no amount yet. */
export const CUSTOM_BUTTON_LABEL = '🎛 Custom amount';

/**
 * The marker action behind the "Custom amount" button.
 *
 * A HANDLE ON A POSITION, NOT A TOP-UP. `amountCNS` is 0 because nothing has been
 * chosen — it exists so the tap can find its way back to the right market,
 * symbol and venue position id through the same pending-action store and the same
 * token cross-check as every other button.
 *
 * It is NOT put on `message.actions`. That list is what the alert offered and
 * what `action_log` records; a synthetic zero-amount entry in it would show up in
 * the log as a top-up of nothing that a trader never saw.
 */
export function customMarkerAction(message: AlertMessage): AlertAction {
  return {
    type: 'add-margin',
    intent: 'custom',
    marketId: message.marketId,
    symbol: message.symbol,
    positionId: message.positionId,
    amountCNS: 0n,
    label: CUSTOM_BUTTON_LABEL,
  };
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
 *
 * "CUSTOM AMOUNT" GOES LAST, BELOW BOTH COMPUTED OPTIONS AND NEVER INSTEAD OF
 * THEM. The computed amounts are the primary answer — they are the ones that come
 * with a stated outcome already — and a third button offers the same thing for a
 * figure the user chooses. It appears only when the message offers top-ups at
 * all: an alert sent while blind carries no actions, and a way to add margin
 * against a frozen price is exactly what "no top-ups while blind" forbids.
 */
export function buildTelegramMessage(options: BuildOptions): TelegramMessage {
  const { message, availability, store, userId, telegramUserId } = options;

  const buttons = buttonsFor(message.actions, availability, (action) => {
    return store.put({ userId, telegramUserId, action }).token;
  });

  const note = availabilityNote(availability, message.actions.length);
  const text = note === undefined ? message.text : `${message.text}\n${note}`;

  if (buttons.length === 0) return { text, keyboard: undefined };

  // Blocked when the venue cannot act, exactly like the computed buttons: the
  // option stays visible and the tap reports the reason.
  const marker = customMarkerAction(message);
  const custom: ActionButton = {
    label: CUSTOM_BUTTON_LABEL,
    data: encodeCallback({
      kind: availability?.actionable === true ? 'custom' : 'blocked',
      token: store.put({ userId, telegramUserId, action: marker }).token,
      marketId: marker.marketId,
      amountCNS: marker.amountCNS,
    }),
  };

  const keyboard = new InlineKeyboard();
  // One per row; a new row only BETWEEN buttons, so no empty row trails the last.
  [...buttons, custom].forEach((button, i) => {
    if (i > 0) keyboard.row();
    keyboard.text(button.label, button.data);
  });
  return { text, keyboard };
}
