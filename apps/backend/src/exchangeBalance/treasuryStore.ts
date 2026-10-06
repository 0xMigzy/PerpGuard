import type { Pool } from 'pg';
import type { TreasuryMovement } from '@perpguard/shared';
import type { TreasuryStore } from './treasuryScanner.ts';

/**
 * The treasury scan's movements and cursor in the backend's Postgres. Seeded
 * ONCE from the committed one-off scan, so a fresh database does not rescan
 * 56 million blocks; after that only the incremental scanner writes. A save is
 * one transaction: the movements and the cursor that covers them, together.
 */
const SCHEMA = `
create table if not exists protocol_treasury_movements (
  tx_hash    text   not null,
  log_index  int    not null,
  block      bigint not null,
  at_ms      bigint not null,
  direction  text   not null check (direction in ('in', 'out')),
  amount_cns numeric not null,
  primary key (tx_hash, log_index)
);
create table if not exists protocol_treasury_cursor (
  id            int primary key check (id = 1),
  through_block bigint not null,
  updated_at    timestamptz not null default now()
);`;

/** Any fixed number: the advisory lock's key for this scan. */
const LOCK_KEY = 7_143_001;

export class PostgresTreasuryStore implements TreasuryStore {
  readonly #pool: Pool;
  readonly #seed: () => Promise<{ readonly throughBlock: number; readonly movements: readonly TreasuryMovement[] }>;

  constructor(pool: Pool, seed: () => Promise<{ readonly throughBlock: number; readonly movements: readonly TreasuryMovement[] }>) {
    this.#pool = pool;
    this.#seed = seed;
  }

  async load(): Promise<{ readonly throughBlock: number | undefined; readonly movements: readonly TreasuryMovement[] }> {
    await this.#pool.query(SCHEMA);
    let cursor = (await this.#pool.query<{ through_block: string }>('select through_block::text from protocol_treasury_cursor where id = 1')).rows[0];
    if (cursor === undefined) {
      const seed = await this.#seed();
      await this.save(seed.movements, seed.throughBlock);
      cursor = { through_block: String(seed.throughBlock) };
    }
    const rows = (
      await this.#pool.query<{ tx_hash: string; log_index: number; block: string; at_ms: string; direction: 'in' | 'out'; amount_cns: string }>(
        'select tx_hash, log_index, block::text, at_ms::text, direction, amount_cns::text from protocol_treasury_movements order by block, log_index',
      )
    ).rows;
    return {
      throughBlock: Number(cursor.through_block),
      movements: rows.map((r) => ({ txHash: r.tx_hash, logIndex: r.log_index, block: Number(r.block), atMs: Number(r.at_ms), direction: r.direction, amountCNS: BigInt(r.amount_cns) })),
    };
  }

  async save(movements: readonly TreasuryMovement[], throughBlock: number): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      for (const m of movements) {
        await client.query(
          `insert into protocol_treasury_movements (tx_hash, log_index, block, at_ms, direction, amount_cns)
           values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
          [m.txHash, m.logIndex, m.block, m.atMs, m.direction, m.amountCNS.toString()],
        );
      }
      await client.query(
        `insert into protocol_treasury_cursor (id, through_block, updated_at) values (1, $1, now())
         on conflict (id) do update set through_block = greatest(protocol_treasury_cursor.through_block, excluded.through_block), updated_at = now()`,
        [throughBlock],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async tryLock(): Promise<(() => Promise<void>) | undefined> {
    // Session-level: held by this one client until released, so it must be the same client that unlocks.
    const client = await this.#pool.connect();
    const got = (await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [LOCK_KEY])).rows[0]?.ok === true;
    if (!got) {
      client.release();
      return undefined;
    }
    return async () => {
      try {
        await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
      } finally {
        client.release();
      }
    };
  }
}

/** For tests and a backend with no Postgres: memory, seeded the same way, with an in-process lock. */
export class InMemoryTreasuryStore implements TreasuryStore {
  #throughBlock: number | undefined;
  #movements: TreasuryMovement[] = [];
  #locked = false;
  saves = 0;

  constructor(seed?: { readonly throughBlock: number; readonly movements: readonly TreasuryMovement[] }) {
    this.#throughBlock = seed?.throughBlock;
    this.#movements = [...(seed?.movements ?? [])];
  }

  async load() {
    return { throughBlock: this.#throughBlock, movements: [...this.#movements] };
  }

  async save(movements: readonly TreasuryMovement[], throughBlock: number): Promise<void> {
    this.saves += 1;
    const seen = new Set(this.#movements.map((m) => `${m.txHash}-${m.logIndex}`));
    for (const m of movements) if (!seen.has(`${m.txHash}-${m.logIndex}`)) this.#movements.push(m);
    this.#throughBlock = Math.max(this.#throughBlock ?? 0, throughBlock);
  }

  async tryLock(): Promise<(() => Promise<void>) | undefined> {
    if (this.#locked) return undefined;
    this.#locked = true;
    return async () => {
      this.#locked = false;
    };
  }
}

/** A backend with no Postgres: memory, seeded from the file on first load. Restarts rescan from the seed's cursor. */
export class LazySeededMemoryStore extends InMemoryTreasuryStore {
  readonly #seed: () => Promise<{ readonly throughBlock: number; readonly movements: readonly TreasuryMovement[] }>;
  #seeded = false;

  constructor(seed: () => Promise<{ readonly throughBlock: number; readonly movements: readonly TreasuryMovement[] }>) {
    super();
    this.#seed = seed;
  }

  override async load() {
    if (!this.#seeded) {
      const s = await this.#seed();
      await this.save(s.movements, s.throughBlock);
      this.#seeded = true;
    }
    return super.load();
  }
}
