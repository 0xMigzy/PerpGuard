/**
 * Who this bot is allowed to talk to.
 *
 * ONE LINKED USER TODAY, AND A TABLE SHAPED FOR MANY. The row is the unit — a
 * second user is a second row and a `capacity` of 2, not a different data
 * model. Nothing here is keyed on "the" user, and no field is a singleton.
 *
 * Two lookups, both needed, and they go in opposite directions:
 *
 *   byTelegramUserId  — the AUTHORISATION question. An update arrives carrying a
 *                       Telegram user id; may it do anything at all?
 *   byUserId          — the DELIVERY question. The alerts engine hands the
 *                       transport an app user id; which chat is that?
 *
 * They are separate because the two ids are separate. The alerts engine knows
 * nothing about Telegram and must not have to, and the day a user has both a
 * Telegram chat and a web session, the app user id is the thing they share.
 *
 * IN MEMORY FOR NOW, which means a restart unlinks everyone and the owner sends
 * `/start` again. The alternative — persisting a link but not persisting the
 * authorisation policy around it — is the worse failure, and the store is an
 * interface precisely so a Postgres implementation slots in without touching a
 * handler.
 */

export interface LinkRecord {
  /** The app-level user, as the alerts engine addresses them. */
  readonly userId: string;
  /**
   * THE PERPL ACCOUNT THIS LINK IS FOR. Every action request re-checks, at the
   * moment of the request, that the requesting chat's link names the account
   * owning the position; nothing is cached from link time. One account per
   * linked user, by design — a second account is a later feature.
   */
  readonly accountId: number;
  /** The Telegram user permitted to command this bot. */
  readonly telegramUserId: number;
  /**
   * Where messages go.
   *
   * Stored separately from `telegramUserId` because they are different things:
   * in a private chat they happen to be equal, in a group they are not, and
   * addressing a message to a user id that is really a group id delivers
   * somebody's liquidation warning to the wrong place.
   */
  readonly chatId: number;
  readonly linkedAtMs: number;
}

/** Why a `/start` was refused, so the reply can say which. */
export type LinkRefusal =
  /** Someone else already holds the only link slot. */
  | 'at-capacity'
  /** `TELEGRAM_OWNER_ID` is set and this is not them. */
  | 'not-the-owner'
  /** This Telegram user is already linked. Not an error; nothing to do. */
  | 'already-linked';

export type LinkResult =
  | { readonly ok: true; readonly record: LinkRecord }
  | { readonly ok: false; readonly refusal: LinkRefusal; readonly record?: LinkRecord };

export interface LinkStore {
  /** The authorisation lookup. */
  byTelegramUserId(telegramUserId: number): LinkRecord | undefined;
  /** The delivery lookup. */
  byUserId(userId: string): LinkRecord | undefined;
  /** Every link to one account: who an alert about it fans out to with actions. */
  byAccountId(accountId: number): readonly LinkRecord[];
  /** Every link. For `/status` and for a future admin view. */
  list(): readonly LinkRecord[];
  link(record: LinkRecord): LinkResult;
  unlink(telegramUserId: number): boolean;
}

export interface InMemoryLinkStoreOptions {
  /**
   * How many links may exist at once. One for now.
   *
   * A number rather than a boolean so raising it is a config change. It is
   * enforced on `link`, so the second `/start` from a stranger is refused by the
   * store rather than by a handler remembering to check.
   */
  readonly capacity?: number;
  /** When set, only this Telegram user may ever hold a link. */
  readonly ownerTelegramUserId?: number | undefined;
  readonly seed?: readonly LinkRecord[];
}

export class InMemoryLinkStore implements LinkStore {
  readonly #byTelegram = new Map<number, LinkRecord>();
  readonly #capacity: number;
  readonly #owner: number | undefined;

  constructor(options: InMemoryLinkStoreOptions = {}) {
    this.#capacity = options.capacity ?? 1;
    this.#owner = options.ownerTelegramUserId;
    for (const record of options.seed ?? []) this.#byTelegram.set(record.telegramUserId, record);
  }

  get capacity(): number {
    return this.#capacity;
  }

  byTelegramUserId(telegramUserId: number): LinkRecord | undefined {
    return this.#byTelegram.get(telegramUserId);
  }

  byUserId(userId: string): LinkRecord | undefined {
    for (const record of this.#byTelegram.values()) {
      if (record.userId === userId) return record;
    }
    return undefined;
  }

  list(): readonly LinkRecord[] {
    return [...this.#byTelegram.values()];
  }

  byAccountId(accountId: number): readonly LinkRecord[] {
    return [...this.#byTelegram.values()].filter((record) => record.accountId === accountId);
  }

  /**
   * Claim a link.
   *
   * The owner check runs BEFORE the capacity check so a configured owner gets
   * the accurate refusal rather than "at capacity" — the two have completely
   * different fixes, and telling someone the bot is full when in truth they are
   * the wrong person sends them looking in the wrong place.
   */
  link(record: LinkRecord): LinkResult {
    const existing = this.#byTelegram.get(record.telegramUserId);
    if (existing !== undefined) return { ok: false, refusal: 'already-linked', record: existing };
    if (this.#owner !== undefined && record.telegramUserId !== this.#owner) {
      return { ok: false, refusal: 'not-the-owner' };
    }
    if (this.#byTelegram.size >= this.#capacity) return { ok: false, refusal: 'at-capacity' };
    this.#byTelegram.set(record.telegramUserId, record);
    return { ok: true, record };
  }

  unlink(telegramUserId: number): boolean {
    return this.#byTelegram.delete(telegramUserId);
  }
}
