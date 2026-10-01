/**
 * Watch subscriptions that survive a restart.
 *
 * A PUBLIC subscription has to persist: the person who typed `/watch` is not
 * going to type it again after a deploy, and now that the backend restarts
 * itself on failure, "lost on restart" would mean "lost silently and often".
 *
 * The in-memory store stays the source of truth for every read and every cap
 * — the loop and the handlers never wait on Postgres — and this wraps it with
 * a load at boot and a write-through on every change. A write that fails is
 * logged and the in-memory change stands: the watcher was told they are
 * watching, and they are, until the next restart. `flush()` lets a caller
 * wait for the writes, which is what the tests use.
 */
import type { Pool } from 'pg';
import { InMemoryWatchStore, type InMemoryWatchStoreOptions, type WatchAddResult, type WatchStore, type WatchSubscription } from '@perpguard/bot';

export interface PostgresWatchStoreOptions extends InMemoryWatchStoreOptions {
  readonly pool: Pick<Pool, 'query'>;
  readonly logger?: { warn(message: string): void };
}

const MIGRATE_SQL = `
create table if not exists watch_subscriptions (
  chat_id    bigint      not null,
  account_id bigint      not null,
  label      text        not null,
  added_at   timestamptz not null,
  primary key (chat_id, account_id)
)`;

export class PostgresWatchStore implements WatchStore {
  readonly #inner: InMemoryWatchStore;
  readonly #pool: Pick<Pool, 'query'>;
  readonly #logger: { warn(message: string): void };
  #pending: Promise<void> = Promise.resolve();

  private constructor(inner: InMemoryWatchStore, options: PostgresWatchStoreOptions) {
    this.#inner = inner;
    this.#pool = options.pool;
    this.#logger = options.logger ?? { warn: (m) => console.warn(m) };
  }

  /** Create the table if needed and load every subscription. */
  static async load(options: PostgresWatchStoreOptions): Promise<PostgresWatchStore> {
    await options.pool.query(MIGRATE_SQL);
    const result = await options.pool.query('select chat_id, account_id, label, added_at from watch_subscriptions');
    const seed: WatchSubscription[] = (result.rows as Array<Record<string, unknown>>).map((row) => ({
      chatId: Number(row['chat_id']),
      accountId: Number(row['account_id']),
      label: String(row['label']),
      addedAtMs: new Date(row['added_at'] as string | Date).getTime(),
    }));
    const inner = new InMemoryWatchStore({ ...options, seed: [...(options.seed ?? []), ...seed] });
    return new PostgresWatchStore(inner, options);
  }

  get maxPerChat(): number {
    return this.#inner.maxPerChat;
  }

  get maxAccounts(): number {
    return this.#inner.maxAccounts;
  }

  add(subscription: WatchSubscription): WatchAddResult {
    const result = this.#inner.add(subscription);
    if (result.ok && !result.already) {
      this.#write(
        'insert into watch_subscriptions (chat_id, account_id, label, added_at) values ($1, $2, $3, $4) on conflict do nothing',
        [subscription.chatId, subscription.accountId, subscription.label, new Date(subscription.addedAtMs).toISOString()],
      );
    }
    return result;
  }

  remove(chatId: number, accountId: number): boolean {
    const removed = this.#inner.remove(chatId, accountId);
    if (removed) this.#write('delete from watch_subscriptions where chat_id = $1 and account_id = $2', [chatId, accountId]);
    return removed;
  }

  byChat(chatId: number): readonly WatchSubscription[] {
    return this.#inner.byChat(chatId);
  }

  accountIds(): readonly number[] {
    return this.#inner.accountIds();
  }

  watchersOf(accountId: number): readonly WatchSubscription[] {
    return this.#inner.watchersOf(accountId);
  }

  /** Resolves once every queued write has finished. */
  flush(): Promise<void> {
    return this.#pending;
  }

  #write(sql: string, values: readonly unknown[]): void {
    this.#pending = this.#pending
      .then(() => this.#pool.query(sql, values as unknown[]))
      .then(
        () => undefined,
        (error: unknown) => {
          this.#logger.warn(`watch store: could not persist a change (${error instanceof Error ? error.message : String(error)}); it stands in memory until the next restart`);
        },
      );
  }
}
