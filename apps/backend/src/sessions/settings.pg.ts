/**
 * Account settings in Postgres, so "Warn me at" survives a restart.
 *
 * Loaded once at boot into memory (the bot reads them on every Settings
 * screen); a write goes to Postgres first and to memory and the live loop
 * only once it is stored, so a failed write is never shown as saved.
 */
import type { Pool } from 'pg';
import { DEFAULT_SETTINGS, type AccountSettings, type AccountSettingsStore } from '@perpguard/bot';
import { WARN_LEVELS, type WarnLevel } from '../risk/warn.ts';
import { ALERT_DISTANCE_FROM_WARN_LEVEL, DEFAULT_ALERT_DISTANCE_PCT, isAlertDistance } from '../manual/distance.ts';

const SCHEMA = `
create table if not exists account_settings (
  account_id  bigint primary key,
  warn_level  text not null,
  updated_at  timestamptz not null default now()
);
alter table account_settings add column if not exists alert_pct real`;

const isLevel = (value: unknown): value is WarnLevel => WARN_LEVELS.some((l) => l.level === value);

export class PostgresAccountSettingsStore implements AccountSettingsStore {
  readonly #pool: Pool;
  readonly #by: Map<number, AccountSettings>;
  readonly #onChange: ((accountId: number, settings: AccountSettings) => void) | undefined;

  private constructor(pool: Pool, by: Map<number, AccountSettings>, onChange: ((accountId: number, settings: AccountSettings) => void) | undefined) {
    this.#pool = pool;
    this.#by = by;
    this.#onChange = onChange;
  }

  static async load(options: { readonly pool: Pool; readonly onChange?: (accountId: number, settings: AccountSettings) => void }): Promise<PostgresAccountSettingsStore> {
    await options.pool.query(SCHEMA);
    const rows = (await options.pool.query('select account_id::text as id, warn_level, alert_pct from account_settings')).rows as Array<{ id: string; warn_level: string; alert_pct: number | null }>;
    const by = new Map<number, AccountSettings>();
    // An unknown stored level is ignored (the default applies), never guessed at.
    // A row from before the alert distance keeps the distance its level first warned at.
    for (const row of rows) {
      const warnLevel = isLevel(row.warn_level) ? row.warn_level : DEFAULT_SETTINGS.warnLevel;
      const alertPct = isAlertDistance(row.alert_pct) ? row.alert_pct : (ALERT_DISTANCE_FROM_WARN_LEVEL[warnLevel] ?? DEFAULT_ALERT_DISTANCE_PCT);
      by.set(Number(row.id), { warnLevel, alertPct });
    }
    return new PostgresAccountSettingsStore(options.pool, by, options.onChange);
  }

  get(accountId: number): AccountSettings {
    return this.#by.get(accountId) ?? DEFAULT_SETTINGS;
  }

  async set(accountId: number, settings: AccountSettings): Promise<void> {
    await this.#pool.query(
      `insert into account_settings (account_id, warn_level, alert_pct, updated_at) values ($1, $2, $3, now())
       on conflict (account_id) do update set warn_level = excluded.warn_level, alert_pct = excluded.alert_pct, updated_at = now()`,
      [accountId, settings.warnLevel, settings.alertPct],
    );
    this.#by.set(accountId, settings);
    this.#onChange?.(accountId, settings);
  }
}
