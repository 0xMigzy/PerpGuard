/**
 * Every Telegram user is somebody, before they are anybody in particular.
 *
 * The bot is public now. `/start` used to mean "claim THE link", which gave a
 * stranger nothing and the second stranger a refusal. Now it means "register
 * this person": every Telegram user gets an app identity of their own —
 * `tg:<telegram user id>` — the moment they say hello, whether or not they
 * ever link a Perpl account. The watch tier keys subscriptions on the chat;
 * the acting tier (a separate, proof-based step) binds an identity to the
 * account it owns. Neither needs the other to exist first.
 *
 * In memory with a persistence port, like the watch store, and persisted in
 * the backend for the same reason: a self-restarting process must not forget
 * who it has met.
 */

export interface TelegramIdentity {
  /** The app-level user id, `tg:<telegram user id>`. Stable across chats. */
  readonly userId: string;
  readonly telegramUserId: number;
  /** The private chat (or group) this person last spoke from. */
  readonly chatId: number;
  readonly firstSeenAtMs: number;
}

export interface IdentityStore {
  /** Register, or re-register from a new chat. Returns whether this is a first sight. */
  register(telegramUserId: number, chatId: number, nowMs: number): { readonly identity: TelegramIdentity; readonly created: boolean };
  byTelegramUserId(telegramUserId: number): TelegramIdentity | undefined;
  byUserId(userId: string): TelegramIdentity | undefined;
  list(): readonly TelegramIdentity[];
}

/** `tg:4242`: the app user id for a Telegram user. One function, so it cannot be spelled two ways. */
export function identityUserId(telegramUserId: number): string {
  return `tg:${telegramUserId}`;
}

export class InMemoryIdentityStore implements IdentityStore {
  readonly #byTelegram = new Map<number, TelegramIdentity>();

  constructor(seed: readonly TelegramIdentity[] = []) {
    for (const identity of seed) this.#byTelegram.set(identity.telegramUserId, identity);
  }

  register(telegramUserId: number, chatId: number, nowMs: number): { readonly identity: TelegramIdentity; readonly created: boolean } {
    const existing = this.#byTelegram.get(telegramUserId);
    if (existing !== undefined) {
      if (existing.chatId === chatId) return { identity: existing, created: false };
      const moved: TelegramIdentity = { ...existing, chatId };
      this.#byTelegram.set(telegramUserId, moved);
      return { identity: moved, created: false };
    }
    const identity: TelegramIdentity = { userId: identityUserId(telegramUserId), telegramUserId, chatId, firstSeenAtMs: nowMs };
    this.#byTelegram.set(telegramUserId, identity);
    return { identity, created: true };
  }

  byTelegramUserId(telegramUserId: number): TelegramIdentity | undefined {
    return this.#byTelegram.get(telegramUserId);
  }

  byUserId(userId: string): TelegramIdentity | undefined {
    for (const identity of this.#byTelegram.values()) if (identity.userId === userId) return identity;
    return undefined;
  }

  list(): readonly TelegramIdentity[] {
    return [...this.#byTelegram.values()];
  }
}
