/**
 * Who may do anything at all.
 *
 * ONE GATE, IN FRONT OF EVERYTHING — commands and button taps alike. This is
 * the single worst bug available in this product: a bot that acts on a
 * stranger's tap moves a real trader's collateral on a real venue at the request
 * of someone who is not them. So the check is a pure function with its own
 * tests, and the middleware that calls it has no logic of its own to get wrong.
 *
 * TWO SEPARATE QUESTIONS, and both have to pass:
 *
 *   IS THIS THE LINKED PERSON?  Keyed on the Telegram user id.
 *   IS THIS THE LINKED CHAT?    Keyed on the chat id. A linked user who adds the
 *                               bot to a group and types /positions there would
 *                               otherwise publish their liquidation prices to
 *                               everyone in it. Authorising the person is not
 *                               the same as authorising the room.
 */
import { REFUSAL_TEXT, WRONG_CHAT_TEXT } from './help.ts';
import type { LinkRecord, LinkStore } from './links.ts';

export type AuthFailureCode =
  /** This Telegram user holds no link. */
  | 'not-linked'
  /** The right person, the wrong room. */
  | 'wrong-chat';

export type AuthResult =
  | { readonly ok: true; readonly link: LinkRecord }
  | { readonly ok: false; readonly code: AuthFailureCode; readonly text: string };

/**
 * Decide whether this update may proceed.
 *
 * `telegramUserId` undefined — a channel post, an anonymous admin — is a
 * refusal, not a pass. There is nobody to authorise.
 */
export function authorise(
  links: LinkStore,
  telegramUserId: number | undefined,
  chatId: number | undefined,
): AuthResult {
  if (telegramUserId === undefined) {
    return { ok: false, code: 'not-linked', text: REFUSAL_TEXT };
  }
  const link = links.byTelegramUserId(telegramUserId);
  if (link === undefined) {
    return { ok: false, code: 'not-linked', text: REFUSAL_TEXT };
  }
  if (chatId !== undefined && chatId !== link.chatId) {
    return { ok: false, code: 'wrong-chat', text: WRONG_CHAT_TEXT };
  }
  return { ok: true, link };
}
