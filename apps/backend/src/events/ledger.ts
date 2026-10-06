/**
 * AT MOST ONCE PER CHAT, ACROSS RESTARTS. Before an event goes to a chat, the
 * engine claims (event id, chat) here; a claim that already exists means it
 * went out before, and it is not sent again. The claim is taken BEFORE the
 * send and kept whatever the send does: a duplicate alert is the failure this
 * exists to prevent, and a missed one is reported in the log instead.
 *
 * And where each feed got to (`CursorStore`), so a restart resumes rather than
 * replaying history or skipping what happened while it was down.
 */
import type { Pool } from 'pg';

export interface DeliveryLedger {
  /** True when this is the first claim of (event, chat): send it. False: it went before. */
  claim(eventId: string, chatId: number): Promise<boolean>;
  /** Forget claims older than this. */
  prune(olderThanMs: number): Promise<void>;
}

export interface CursorStore {
  get(source: string): Promise<number | undefined>;
  set(source: string, atMs: number): Promise<void>;
}

export class InMemoryLedger implements DeliveryLedger, CursorStore {
  readonly #claims = new Map<string, number>();
  readonly #cursors = new Map<string, number>();
  readonly #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  async claim(eventId: string, chatId: number): Promise<boolean> {
    const key = `${eventId}\u0000${chatId}`;
    if (this.#claims.has(key)) return false;
    this.#claims.set(key, this.#now());
    return true;
  }
  async prune(olderThanMs: number): Promise<void> {
    for (const [key, at] of this.#claims) if (at < olderThanMs) this.#claims.delete(key);
  }
  async get(source: string): Promise<number | undefined> {
    return this.#cursors.get(source);
  }
  async set(source: string, atMs: number): Promise<void> {
    this.#cursors.set(source, atMs);
  }
}

const MIGRATE_SQL = `
create table if not exists event_deliveries (
  event_id   text        not null,
  chat_id    bigint      not null,
  claimed_at timestamptz not null default now(),
  primary key (event_id, chat_id)
);
create index if not exists event_deliveries_claimed_at on event_deliveries (claimed_at);
create table if not exists event_cursor (
  source text   primary key,
  at_ms  bigint not null
)`;

export class PostgresLedger implements DeliveryLedger, CursorStore {
  readonly #pool: Pick<Pool, 'query'>;
  private constructor(pool: Pick<Pool, 'query'>) {
    this.#pool = pool;
  }
  static async load(pool: Pick<Pool, 'query'>): Promise<PostgresLedger> {
    await pool.query(MIGRATE_SQL);
    return new PostgresLedger(pool);
  }
  async claim(eventId: string, chatId: number): Promise<boolean> {
    const r = await this.#pool.query('insert into event_deliveries (event_id, chat_id) values ($1, $2) on conflict do nothing', [eventId, chatId]);
    return r.rowCount === 1;
  }
  async prune(olderThanMs: number): Promise<void> {
    await this.#pool.query('delete from event_deliveries where claimed_at < to_timestamp($1 / 1000.0)', [olderThanMs]);
  }
  async get(source: string): Promise<number | undefined> {
    const r = await this.#pool.query('select at_ms from event_cursor where source = $1', [source]);
    const row = r.rows[0] as { at_ms: string } | undefined;
    return row === undefined ? undefined : Number(row.at_ms);
  }
  async set(source: string, atMs: number): Promise<void> {
    await this.#pool.query('insert into event_cursor (source, at_ms) values ($1, $2) on conflict (source) do update set at_ms = excluded.at_ms', [source, atMs]);
  }
}
