/**
 * Questions the bot has asked and is waiting on.
 *
 * WHEN THE BOT ASKS, IT HEARS THE ANSWER. Every question is sent with
 * Telegram's `force_reply`, so the person's keyboard opens on a reply to it,
 * and the question is parked here so the NEXT plain message from that person
 * in that chat is read as the answer — whether or not their client threaded
 * it as a reply. Before this, "Tell me what to watch" was a dead end: the
 * `710` someone sent back was ignored.
 *
 * One open question per person per chat; asking again replaces it. Questions
 * expire, because an answer typed an hour later is more likely to be about
 * something else.
 */

export type Question =
  /** "Send me an address or an account id." */
  | { readonly kind: 'watch-target' };

interface Parked {
  readonly question: Question;
  readonly askedAtMs: number;
}

export const QUESTION_TTL_MS = 15 * 60_000;

export class PendingQuestionStore {
  readonly #open = new Map<string, Parked>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? QUESTION_TTL_MS;
  }

  ask(chatId: number, telegramUserId: number, question: Question): void {
    this.#open.set(key(chatId, telegramUserId), { question, askedAtMs: this.#now() });
  }

  /** The open question, if one is open and fresh. Does not close it. */
  peek(chatId: number, telegramUserId: number): Question | undefined {
    const k = key(chatId, telegramUserId);
    const parked = this.#open.get(k);
    if (parked === undefined) return undefined;
    if (this.#now() - parked.askedAtMs > this.#ttlMs) {
      this.#open.delete(k);
      return undefined;
    }
    return parked.question;
  }

  close(chatId: number, telegramUserId: number): void {
    this.#open.delete(key(chatId, telegramUserId));
  }
}

const key = (chatId: number, telegramUserId: number): string => `${chatId}:${telegramUserId}`;
