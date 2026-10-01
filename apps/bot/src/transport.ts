/**
 * {@link AlertTransport} over Telegram.
 *
 * The alerts engine addresses an APP user; this resolves that to a chat through
 * the link store and sends. It renders nothing itself beyond attaching the
 * keyboard — the words come from `render.ts` in the alerts layer, so an alert and
 * a `/positions` entry for the same position are the same text.
 *
 * DELIVERY RESULTS ARE HONEST. `retryable` is what the engine's retry loop reads,
 * and both wrong answers cost something real — see `delivery.ts`. Nothing here
 * ever returns `ok: true` on a path that did not reach Telegram.
 */
import type { Api } from 'grammy';
import type { ActionAvailability } from '@perpguard/shared';
import type {
  AlertMessage,
  AlertRecipient,
  AlertTransport,
  DeliveryResult,
} from '@perpguard/backend/alerts';
import type { ActionExecutor, PendingActionStore } from './actions.ts';
import { classifyTelegramError } from './delivery.ts';
import { buildTelegramMessage } from './format.ts';
import { redactToken } from './config.ts';
import type { LinkStore } from './links.ts';

export interface TelegramTransportOptions {
  /** `bot.api`. Taking the Api rather than the Bot keeps this testable. */
  readonly api: Api;
  /** Held only so it can be redacted out of anything we hand back. */
  readonly token: string;
  readonly links: LinkStore;
  readonly store: PendingActionStore;
  /** Asked whether the ACTING venue can take this action. */
  readonly executor: ActionExecutor;
  readonly logger?: { warn(message: string): void };
}

export class TelegramAlertTransport implements AlertTransport {
  readonly #api: Api;
  readonly #token: string;
  readonly #links: LinkStore;
  readonly #store: PendingActionStore;
  readonly #executor: ActionExecutor;
  readonly #logger: { warn(message: string): void };

  constructor(options: TelegramTransportOptions) {
    this.#api = options.api;
    this.#token = options.token;
    this.#links = options.links;
    this.#store = options.store;
    this.#executor = options.executor;
    this.#logger = options.logger ?? { warn: (message) => console.warn(message) };
  }

  /**
   * One copy, shaped by the recipient's rights.
   *
   * A WATCHER GETS WORDS AND NOTHING ELSE: no keyboard, no pending-action
   * token minted, so there is nothing a crafted tap could find. The chat is
   * the recipient itself rather than a linked app user.
   */
  async send(recipient: AlertRecipient, message: AlertMessage): Promise<DeliveryResult> {
    if (recipient.rights === 'watch') {
      if (recipient.chatId === undefined) {
        return { ok: false, reason: `watch recipient ${recipient.userId} names no chat, so there is nowhere to deliver this`, retryable: false };
      }
      try {
        await this.#api.sendMessage(recipient.chatId, message.text, { link_preview_options: { is_disabled: true } });
        return { ok: true };
      } catch (error) {
        return classifyTelegramError(error, this.#token);
      }
    }

    const userId = recipient.userId;
    const link = this.#links.byUserId(userId);
    if (link === undefined) {
      // Not retryable: three attempts over a few seconds cannot make somebody
      // run /start. The engine records the row and moves on, which is the right
      // outcome — and the row is how "I never got any alerts" gets answered.
      return {
        ok: false,
        reason:
          `no Telegram chat is linked to user ${userId}; nobody has run /start, so ` +
          `there is nowhere to deliver this`,
        retryable: false,
      };
    }

    const availability = await this.#availabilityFor(message);
    const { text, keyboard } = buildTelegramMessage({
      message,
      availability,
      store: this.#store,
      userId,
      telegramUserId: link.telegramUserId,
    });

    try {
      await this.#api.sendMessage(link.chatId, text, {
        // No parse_mode. See format.ts: the rendered text contains characters
        // every Telegram markup dialect treats as syntax.
        ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
        link_preview_options: { is_disabled: true },
      });
      return { ok: true };
    } catch (error) {
      return classifyTelegramError(error, this.#token);
    }
  }

  /**
   * Ask the acting venue, and treat a thrown answer as "we do not know".
   *
   * NOT KNOWING DISABLES THE BUTTONS but changes nothing else: the alert still
   * goes out, with its options still written out in the text. A venue lookup
   * that failed must never cost a trader the warning.
   */
  async #availabilityFor(message: AlertMessage): Promise<ActionAvailability | undefined> {
    if (message.actions.length === 0) return undefined;
    try {
      return await this.#executor.availability(message.symbol);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.warn(
        redactToken(
          `could not ask the acting venue whether ${message.symbol} is actionable: ` +
            `${detail}. Sending the alert with its buttons disabled.`,
          this.#token,
        ),
      );
      return undefined;
    }
  }
}
