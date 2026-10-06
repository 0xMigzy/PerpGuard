/**
 * What linking persists: the link itself, and the sealed key behind it.
 *
 * Two stores, because they have two lifetimes and two readers. A LINK is the
 * bot's authorisation record — which chat may act on which account — read on
 * every request; it lives in the bot's own `LinkStore` shape, persisted here.
 * A KEY is the sealed credential that lets the backend open a session for
 * that account; it is read at boot and on re-link, never on a request, and
 * never leaves this module unsealed except to the registry.
 *
 * Both are in-memory for every read, written through to Postgres, and loaded
 * at boot, like the watch and identity stores. A write that fails is logged;
 * the in-memory change stands until the next restart.
 */
import type { Pool } from 'pg';
import { InMemoryLinkStore, type LinkRecord, type LinkResult, type LinkStore } from '@perpguard/bot';

// ── links ───────────────────────────────────────────────────────────────────

const LINKS_SQL = `
create table if not exists account_links (
  telegram_user_id bigint      primary key,
  user_id          text        not null,
  chat_id          bigint      not null,
  account_id       bigint      not null,
  linked_at        timestamptz not null
);
alter table account_links add column if not exists network text`;

export class PostgresLinkStore implements LinkStore {
  readonly #inner: InMemoryLinkStore;
  readonly #pool: Pick<Pool, 'query'>;
  readonly #logger: { warn(message: string): void };
  #pending: Promise<void> = Promise.resolve();

  private constructor(inner: InMemoryLinkStore, pool: Pick<Pool, 'query'>, logger: { warn(message: string): void }) {
    this.#inner = inner;
    this.#pool = pool;
    this.#logger = logger;
  }

  static async load(options: { readonly pool: Pick<Pool, 'query'>; readonly capacity: number; readonly ownerTelegramUserId?: number | undefined; readonly logger?: { warn(message: string): void } }): Promise<PostgresLinkStore> {
    await options.pool.query(LINKS_SQL);
    const result = await options.pool.query('select telegram_user_id, user_id, chat_id, account_id, linked_at, network from account_links');
    const seed: LinkRecord[] = (result.rows as Array<Record<string, unknown>>).map((row) => ({
      telegramUserId: Number(row['telegram_user_id']),
      userId: String(row['user_id']),
      chatId: Number(row['chat_id']),
      accountId: Number(row['account_id']),
      linkedAtMs: new Date(row['linked_at'] as string | Date).getTime(),
      ...(row['network'] === 'mainnet' || row['network'] === 'testnet' ? { network: row['network'] } : {}),
    }));
    const inner = new InMemoryLinkStore({ capacity: options.capacity, ...(options.ownerTelegramUserId === undefined ? {} : { ownerTelegramUserId: options.ownerTelegramUserId }), seed });
    return new PostgresLinkStore(inner, options.pool, options.logger ?? { warn: (m) => console.warn(m) });
  }

  byTelegramUserId(telegramUserId: number): LinkRecord | undefined {
    return this.#inner.byTelegramUserId(telegramUserId);
  }

  byUserId(userId: string): LinkRecord | undefined {
    return this.#inner.byUserId(userId);
  }

  byAccountId(accountId: number): readonly LinkRecord[] {
    return this.#inner.byAccountId(accountId);
  }

  list(): readonly LinkRecord[] {
    return this.#inner.list();
  }

  link(record: LinkRecord): LinkResult {
    const result = this.#inner.link(record);
    if (result.ok) {
      this.#write(
        `insert into account_links (telegram_user_id, user_id, chat_id, account_id, linked_at, network) values ($1, $2, $3, $4, $5, $6)
         on conflict (telegram_user_id) do update set user_id = excluded.user_id, chat_id = excluded.chat_id, account_id = excluded.account_id, linked_at = excluded.linked_at, network = excluded.network`,
        [record.telegramUserId, record.userId, record.chatId, record.accountId, new Date(record.linkedAtMs).toISOString(), record.network ?? null],
      );
    }
    return result;
  }

  unlink(telegramUserId: number): boolean {
    const removed = this.#inner.unlink(telegramUserId);
    if (removed) this.#write('delete from account_links where telegram_user_id = $1', [telegramUserId]);
    return removed;
  }

  flush(): Promise<void> {
    return this.#pending;
  }

  #write(sql: string, values: readonly unknown[]): void {
    this.#pending = this.#pending
      .then(() => this.#pool.query(sql, values as unknown[]))
      .then(
        () => undefined,
        (error: unknown) => this.#logger.warn(`link store: could not persist (${error instanceof Error ? error.message : String(error)}); it stands in memory until the next restart`),
      );
  }
}

// ── sealed keys ─────────────────────────────────────────────────────────────

export interface StoredKey {
  readonly userId: string;
  readonly accountId: number;
  /** The sealed blob. Opaque here; only the vault reads it. */
  readonly blob: string;
  readonly storedAtMs: number;
}

export interface KeyStore {
  put(key: StoredKey): void;
  get(userId: string): StoredKey | undefined;
  /** Deleted, not unreferenced: an unlink must leave no key behind. */
  delete(userId: string): boolean;
  list(): readonly StoredKey[];
}

export class InMemoryKeyStore implements KeyStore {
  readonly #keys = new Map<string, StoredKey>();

  constructor(seed: readonly StoredKey[] = []) {
    for (const key of seed) this.#keys.set(key.userId, key);
  }

  put(key: StoredKey): void {
    this.#keys.set(key.userId, key);
  }

  get(userId: string): StoredKey | undefined {
    return this.#keys.get(userId);
  }

  delete(userId: string): boolean {
    return this.#keys.delete(userId);
  }

  list(): readonly StoredKey[] {
    return [...this.#keys.values()];
  }
}

const KEYS_SQL = `
create table if not exists account_keys (
  user_id    text        primary key,
  account_id bigint      not null,
  blob       text        not null,
  stored_at  timestamptz not null
)`;

export class PostgresKeyStore implements KeyStore {
  readonly #inner: InMemoryKeyStore;
  readonly #pool: Pick<Pool, 'query'>;
  readonly #logger: { warn(message: string): void };
  #pending: Promise<void> = Promise.resolve();

  private constructor(inner: InMemoryKeyStore, pool: Pick<Pool, 'query'>, logger: { warn(message: string): void }) {
    this.#inner = inner;
    this.#pool = pool;
    this.#logger = logger;
  }

  static async load(options: { readonly pool: Pick<Pool, 'query'>; readonly logger?: { warn(message: string): void } }): Promise<PostgresKeyStore> {
    await options.pool.query(KEYS_SQL);
    const result = await options.pool.query('select user_id, account_id, blob, stored_at from account_keys');
    const seed: StoredKey[] = (result.rows as Array<Record<string, unknown>>).map((row) => ({
      userId: String(row['user_id']),
      accountId: Number(row['account_id']),
      blob: String(row['blob']),
      storedAtMs: new Date(row['stored_at'] as string | Date).getTime(),
    }));
    return new PostgresKeyStore(new InMemoryKeyStore(seed), options.pool, options.logger ?? { warn: (m) => console.warn(m) });
  }

  put(key: StoredKey): void {
    this.#inner.put(key);
    this.#write(
      `insert into account_keys (user_id, account_id, blob, stored_at) values ($1, $2, $3, $4)
       on conflict (user_id) do update set account_id = excluded.account_id, blob = excluded.blob, stored_at = excluded.stored_at`,
      [key.userId, key.accountId, key.blob, new Date(key.storedAtMs).toISOString()],
    );
  }

  get(userId: string): StoredKey | undefined {
    return this.#inner.get(userId);
  }

  delete(userId: string): boolean {
    const removed = this.#inner.delete(userId);
    if (removed) this.#write('delete from account_keys where user_id = $1', [userId]);
    return removed;
  }

  list(): readonly StoredKey[] {
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
        (error: unknown) => this.#logger.warn(`key store: could not persist (${error instanceof Error ? error.message : String(error)}); it stands in memory until the next restart`),
      );
  }
}
