/**
 * A linked account's own settings, as the Settings screen shows them.
 *
 * Keyed by ACCOUNT, because they change how that account's risk loop warns:
 * one account per linked user, and the setting belongs to the positions it
 * governs. Every button on the Settings screen says what it is set to now, so
 * nothing has to be remembered.
 *
 * Only what is built is listed. Quiet hours and a daily summary appear in the
 * layout review but need a timezone Telegram does not give us and a rule for
 * DANGER during quiet hours; they are not offered until those are decided.
 */
import { DEFAULT_WARN_LEVEL, type WarnLevel } from '@perpguard/backend/risk/warn';

export interface AccountSettings {
  readonly warnLevel: WarnLevel;
}

export const DEFAULT_SETTINGS: AccountSettings = { warnLevel: DEFAULT_WARN_LEVEL };

export interface AccountSettingsStore {
  get(accountId: number): AccountSettings;
  /** Persist, then apply to the live session. Resolves once both are done. */
  set(accountId: number, settings: AccountSettings): Promise<void>;
}

export class InMemoryAccountSettingsStore implements AccountSettingsStore {
  readonly #by = new Map<number, AccountSettings>();
  readonly #onChange: ((accountId: number, settings: AccountSettings) => void) | undefined;

  constructor(options: { readonly seed?: ReadonlyMap<number, AccountSettings>; readonly onChange?: (accountId: number, settings: AccountSettings) => void } = {}) {
    for (const [id, s] of options.seed ?? []) this.#by.set(id, s);
    this.#onChange = options.onChange;
  }

  get(accountId: number): AccountSettings {
    return this.#by.get(accountId) ?? DEFAULT_SETTINGS;
  }

  async set(accountId: number, settings: AccountSettings): Promise<void> {
    this.#by.set(accountId, settings);
    this.#onChange?.(accountId, settings);
  }
}
