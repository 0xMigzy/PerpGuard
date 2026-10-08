/**
 * SWITCHES THE OWNER CAN THROW WITHOUT A DEPLOY (8 Oct 2026).
 *
 * One row per flag in the backend's Postgres (`feature_flags`). The process
 * re-reads the table every 10 seconds and answers from memory, so
 * `pnpm flag wallet-key off` takes effect within 10 seconds with no restart,
 * and a request never waits on the database for it. A flag with no row is OFF:
 * a feature appears only once someone turns it on.
 *
 *   wallet-key   /link creates the API key from one wallet signature. Off: the
 *                page offers pasting a key, as before. Perpl's docs say an
 *                integrating site is to be approved first; if Perpl closes the
 *                no-Origin route, this goes off and nobody sees an outage.
 */
import type { Pool } from 'pg';

export const FLAG_NAMES = ['wallet-key'] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

const SQL = `
create table if not exists feature_flags (
  name       text        primary key,
  enabled    boolean     not null,
  updated_at timestamptz not null default now()
)`;

export interface FeatureFlags {
  isOn(name: FlagName): boolean;
}

/** For tests and a backend without Postgres: set by hand. */
export class InMemoryFeatureFlags implements FeatureFlags {
  readonly #on = new Set<FlagName>();
  constructor(on: readonly FlagName[] = []) {
    for (const n of on) this.#on.add(n);
  }
  isOn(name: FlagName): boolean {
    return this.#on.has(name);
  }
  set(name: FlagName, on: boolean): void {
    if (on) this.#on.add(name);
    else this.#on.delete(name);
  }
}

export class PostgresFeatureFlags implements FeatureFlags {
  readonly #pool: Pick<Pool, 'query'>;
  readonly #on = new Set<FlagName>();
  readonly #warn: (line: string) => void;
  #timer: ReturnType<typeof setInterval> | undefined;

  private constructor(pool: Pick<Pool, 'query'>, warn: (line: string) => void) {
    this.#pool = pool;
    this.#warn = warn;
  }

  static async load(pool: Pick<Pool, 'query'>, options: { readonly refreshMs?: number; readonly warn?: (line: string) => void } = {}): Promise<PostgresFeatureFlags> {
    await pool.query(SQL);
    const flags = new PostgresFeatureFlags(pool, options.warn ?? ((l) => console.warn(l)));
    await flags.refresh();
    flags.#timer = setInterval(() => void flags.refresh(), options.refreshMs ?? 10_000);
    flags.#timer.unref?.();
    return flags;
  }

  isOn(name: FlagName): boolean {
    return this.#on.has(name);
  }

  /** Reads every row. A failed read keeps the last answer: a database blip never flips a switch. */
  async refresh(): Promise<void> {
    try {
      const rows = (await this.#pool.query('select name, enabled from feature_flags')).rows as Array<{ name: string; enabled: boolean }>;
      this.#on.clear();
      for (const r of rows) if (r.enabled && (FLAG_NAMES as readonly string[]).includes(r.name)) this.#on.add(r.name as FlagName);
    } catch (error) {
      this.#warn(`feature flags: could not re-read (${error instanceof Error ? error.message : String(error)}); keeping the last answer`);
    }
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }
}

/** For the owner's script: set one flag. */
export async function setFlag(pool: Pick<Pool, 'query'>, name: FlagName, enabled: boolean): Promise<void> {
  await pool.query(SQL);
  await pool.query(
    `insert into feature_flags (name, enabled, updated_at) values ($1, $2, now())
     on conflict (name) do update set enabled = excluded.enabled, updated_at = now()`,
    [name, enabled],
  );
}

export async function readFlags(pool: Pick<Pool, 'query'>): Promise<ReadonlyArray<{ readonly name: string; readonly enabled: boolean; readonly updatedAt: string }>> {
  await pool.query(SQL);
  const rows = (await pool.query('select name, enabled, updated_at from feature_flags order by name')).rows as Array<{ name: string; enabled: boolean; updated_at: Date }>;
  return rows.map((r) => ({ name: r.name, enabled: r.enabled, updatedAt: new Date(r.updated_at).toISOString() }));
}
