/**
 * VERIFIED WALLET OWNERSHIP, KEPT. One of the three states the linking flow
 * never collapses (Phases 10-11):
 *
 *   wallet linked         a wallet is connected in the browser (the page's own state)
 *   ownership verified    THIS: the wallet signed our challenge, and the Exchange
 *                         contract says it owns this account on this network
 *   execution authorized  an API key is sealed for the account, or the
 *                         deployment runs it with its own key
 *
 * Until 6 Oct 2026 a proven wallet without a key lived only in the page's
 * session and was gone when the page closed, and "how was this linked" was
 * inferred from whether a key happened to be on file. Now the proof is a
 * record: address, account, network, when. It is deleted on unlink.
 */
import type { Pool } from 'pg';

export interface WalletProofRecord {
  /** The Telegram identity that proved it (`tg:<id>`). */
  readonly userId: string;
  /** Lowercased (CLAUDE.md: addresses are compared case-insensitively, always). */
  readonly address: string;
  readonly accountId: number;
  /** The network the Exchange contract was asked on: the trading network. */
  readonly network: string;
  readonly provedAtMs: number;
}

export interface WalletProofStore {
  get(userId: string): WalletProofRecord | undefined;
  put(record: WalletProofRecord): void;
  delete(userId: string): boolean;
}

export class InMemoryWalletProofStore implements WalletProofStore {
  readonly #byUser = new Map<string, WalletProofRecord>();
  constructor(seed: readonly WalletProofRecord[] = []) {
    for (const r of seed) this.#byUser.set(r.userId, r);
  }
  get(userId: string): WalletProofRecord | undefined {
    return this.#byUser.get(userId);
  }
  put(record: WalletProofRecord): void {
    this.#byUser.set(record.userId, { ...record, address: record.address.toLowerCase() });
  }
  delete(userId: string): boolean {
    return this.#byUser.delete(userId);
  }
}

const PROOFS_SQL = `
create table if not exists wallet_proofs (
  user_id    text        primary key,
  address    text        not null,
  account_id bigint      not null,
  network    text        not null,
  proved_at  timestamptz not null
)`;

/** Memory for reads, Postgres written through, loaded at boot. Same shape as the key store. */
export class PostgresWalletProofStore implements WalletProofStore {
  readonly #inner: InMemoryWalletProofStore;
  readonly #pool: Pick<Pool, 'query'>;
  readonly #logger: { warn(message: string): void };
  #pending: Promise<void> = Promise.resolve();

  private constructor(inner: InMemoryWalletProofStore, pool: Pick<Pool, 'query'>, logger: { warn(message: string): void }) {
    this.#inner = inner;
    this.#pool = pool;
    this.#logger = logger;
  }

  static async load(options: { readonly pool: Pick<Pool, 'query'>; readonly logger?: { warn(message: string): void } }): Promise<PostgresWalletProofStore> {
    await options.pool.query(PROOFS_SQL);
    const result = await options.pool.query('select user_id, address, account_id, network, proved_at from wallet_proofs');
    const seed = (result.rows as Array<Record<string, unknown>>).map((row) => ({
      userId: String(row['user_id']),
      address: String(row['address']).toLowerCase(),
      accountId: Number(row['account_id']),
      network: String(row['network']),
      provedAtMs: new Date(row['proved_at'] as string | Date).getTime(),
    }));
    return new PostgresWalletProofStore(new InMemoryWalletProofStore(seed), options.pool, options.logger ?? { warn: (m) => console.warn(m) });
  }

  get(userId: string): WalletProofRecord | undefined {
    return this.#inner.get(userId);
  }

  put(record: WalletProofRecord): void {
    this.#inner.put(record);
    this.#write(
      `insert into wallet_proofs (user_id, address, account_id, network, proved_at) values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set address = excluded.address, account_id = excluded.account_id, network = excluded.network, proved_at = excluded.proved_at`,
      [record.userId, record.address.toLowerCase(), record.accountId, record.network, new Date(record.provedAtMs).toISOString()],
    );
  }

  delete(userId: string): boolean {
    const removed = this.#inner.delete(userId);
    if (removed) this.#write('delete from wallet_proofs where user_id = $1', [userId]);
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
        (error: unknown) => this.#logger.warn(`wallet proofs: could not persist (${error instanceof Error ? error.message : String(error)}); it stands in memory until the next restart`),
      );
  }
}
