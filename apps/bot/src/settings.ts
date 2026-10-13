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
import { DEFAULT_ALERT_DISTANCE_PCT } from '@perpguard/backend/manual/distance';
import { DEFAULT_RESCUE_FLOOR_AUSD } from '@perpguard/backend/rescue/floor';

export interface AccountSettings {
  /** The risk bands on the screens (WATCH, DANGER). No longer chosen on a screen: the alert distance replaced it. */
  readonly warnLevel: WarnLevel;
  /**
   * THE ALERT DISTANCE, in percent (Part 2): where MANUAL alerts fire and
   * where an armed AUTO top-up acts. One number per account.
   */
  readonly alertPct: number;
  /**
   * THE RESCUE FLOOR, in whole AUSD (owner, 13 Oct 2026): the free balance
   * Rescue never spends. 0 lets it spend all of it. One number per account,
   * read by the engine at every decision.
   */
  readonly rescueFloorAusd: number;
}

export const DEFAULT_SETTINGS: AccountSettings = { warnLevel: DEFAULT_WARN_LEVEL, alertPct: DEFAULT_ALERT_DISTANCE_PCT, rescueFloorAusd: DEFAULT_RESCUE_FLOOR_AUSD };

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
