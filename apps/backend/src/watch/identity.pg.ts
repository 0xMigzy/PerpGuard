/**
 * Telegram identities that survive a restart. Same shape as the watch store:
 * the in-memory store answers every read, Postgres is written through, and a
 * failed write is logged rather than thrown at the person who just said hello.
 */
import type { Pool } from 'pg';
import { InMemoryIdentityStore, type IdentityStore, type TelegramIdentity } from '@perpguard/bot';

const MIGRATE_SQL = `
create table if not exists telegram_identities (
  telegram_user_id bigint      primary key,
  user_id          text        not null,
  chat_id          bigint      not null,
  first_seen_at    timestamptz not null
)`;

export class PostgresIdentityStore implements IdentityStore {
  readonly #inner: InMemoryIdentityStore;
  readonly #pool: Pick<Pool, 'query'>;
  readonly #logger: { warn(message: string): void };
  #pending: Promise<void> = Promise.resolve();

  private constructor(inner: InMemoryIdentityStore, pool: Pick<Pool, 'query'>, logger: { warn(message: string): void }) {
    this.#inner = inner;
    this.#pool = pool;
    this.#logger = logger;
  }

  static async load(options: { readonly pool: Pick<Pool, 'query'>; readonly logger?: { warn(message: string): void } }): Promise<PostgresIdentityStore> {
    await options.pool.query(MIGRATE_SQL);
    const result = await options.pool.query('select telegram_user_id, user_id, chat_id, first_seen_at from telegram_identities');
    const seed: TelegramIdentity[] = (result.rows as Array<Record<string, unknown>>).map((row) => ({
      telegramUserId: Number(row['telegram_user_id']),
      userId: String(row['user_id']),
      chatId: Number(row['chat_id']),
      firstSeenAtMs: new Date(row['first_seen_at'] as string | Date).getTime(),
    }));
    return new PostgresIdentityStore(new InMemoryIdentityStore(seed), options.pool, options.logger ?? { warn: (m) => console.warn(m) });
  }

  register(telegramUserId: number, chatId: number, nowMs: number): { readonly identity: TelegramIdentity; readonly created: boolean } {
    const result = this.#inner.register(telegramUserId, chatId, nowMs);
    const i = result.identity;
    this.#write(
      `insert into telegram_identities (telegram_user_id, user_id, chat_id, first_seen_at) values ($1, $2, $3, $4)
       on conflict (telegram_user_id) do update set chat_id = excluded.chat_id`,
      [i.telegramUserId, i.userId, i.chatId, new Date(i.firstSeenAtMs).toISOString()],
    );
    return result;
  }

  byTelegramUserId(telegramUserId: number): TelegramIdentity | undefined {
    return this.#inner.byTelegramUserId(telegramUserId);
  }

  byUserId(userId: string): TelegramIdentity | undefined {
    return this.#inner.byUserId(userId);
  }

  list(): readonly TelegramIdentity[] {
    return this.#inner.list();
  }

  flush(): Promise<void> {
    return this.#pending;
  }

  #write(sql: string, values: readonly unknown[]): void {
    this.#pending = this.#pending
      .then(() => this.#pool.query(sql, values as unknown[]))
      .then(
        () => undefined,
        (error: unknown) => this.#logger.warn(`identity store: could not persist (${error instanceof Error ? error.message : String(error)}); it stands in memory until the next restart`),
      );
  }
}
