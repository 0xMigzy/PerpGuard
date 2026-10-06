/**
 * Alert preferences that survive a restart. Same shape as the other stores:
 * memory is the source of truth for every read, Postgres is loaded at boot and
 * written through on each change. A chat with no row reads the defaults.
 */
import type { Pool } from 'pg';
import { InMemoryPreferenceStore, type AlertPreferences, type PreferenceStore } from './preferences.ts';
import { DEFAULT_WARNING_LEVELS } from './warnings.ts';

const MIGRATE_SQL = `
create table if not exists alert_preferences (
  chat_id              bigint      primary key,
  wallet_alerts        boolean     not null,
  liquidation_min_ausd integer,
  large_trade_min_ausd integer,
  updated_at           timestamptz not null default now()
);
alter table alert_preferences add column if not exists warning_levels real[]`;

export class PostgresPreferenceStore implements PreferenceStore {
  readonly #inner: InMemoryPreferenceStore;
  readonly #pool: Pick<Pool, 'query'>;

  private constructor(inner: InMemoryPreferenceStore, pool: Pick<Pool, 'query'>) {
    this.#inner = inner;
    this.#pool = pool;
  }

  static async load(pool: Pick<Pool, 'query'>): Promise<PostgresPreferenceStore> {
    await pool.query(MIGRATE_SQL);
    const inner = new InMemoryPreferenceStore();
    const result = await pool.query('select chat_id, wallet_alerts, liquidation_min_ausd, large_trade_min_ausd, warning_levels from alert_preferences');
    for (const row of result.rows as Array<Record<string, unknown>>) {
      inner.seed(Number(row['chat_id']), {
        walletAlerts: row['wallet_alerts'] === true,
        liquidationMinAusd: row['liquidation_min_ausd'] === null ? undefined : Number(row['liquidation_min_ausd']),
        largeTradeMinAusd: row['large_trade_min_ausd'] === null ? undefined : Number(row['large_trade_min_ausd']),
        // A row from before warning levels existed reads the default.
        warningLevels: Array.isArray(row['warning_levels']) ? (row['warning_levels'] as unknown[]).map(Number) : DEFAULT_WARNING_LEVELS,
      });
    }
    return new PostgresPreferenceStore(inner, pool);
  }

  get(chatId: number): AlertPreferences {
    return this.#inner.get(chatId);
  }

  /** Written to Postgres first: a setting the person was told is saved must survive a restart. */
  async set(chatId: number, p: AlertPreferences): Promise<void> {
    await this.#pool.query(
      `insert into alert_preferences (chat_id, wallet_alerts, liquidation_min_ausd, large_trade_min_ausd, warning_levels, updated_at) values ($1, $2, $3, $4, $5, now())
       on conflict (chat_id) do update set wallet_alerts = excluded.wallet_alerts, liquidation_min_ausd = excluded.liquidation_min_ausd,
         large_trade_min_ausd = excluded.large_trade_min_ausd, warning_levels = excluded.warning_levels, updated_at = now()`,
      [chatId, p.walletAlerts, p.liquidationMinAusd ?? null, p.largeTradeMinAusd ?? null, [...p.warningLevels]],
    );
    await this.#inner.set(chatId, p);
  }
}
