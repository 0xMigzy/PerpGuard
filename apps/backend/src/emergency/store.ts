/**
 * Every close-everything run, as one row: what was requested, each receipt,
 * each verified outcome. Beside each close's own `action_log` row, this is the
 * run's record as the person saw it.
 */
import type { Pool } from 'pg';

export interface CloseAllRun {
  readonly accountId: number;
  readonly requestId: string;
  readonly by: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly requested: readonly unknown[];
  readonly receipts: readonly unknown[];
  readonly verified: readonly unknown[];
}

export interface CloseAllRunStore {
  record(run: CloseAllRun): Promise<void>;
}

export class InMemoryCloseAllRunStore implements CloseAllRunStore {
  readonly runs: CloseAllRun[] = [];
  async record(run: CloseAllRun): Promise<void> {
    this.runs.push(run);
  }
}

const MIGRATE = `
create table if not exists close_all_runs (
  account_id   bigint      not null,
  request_id   text        not null,
  requested_by text        not null,
  started_at   timestamptz not null,
  finished_at  timestamptz not null,
  requested    jsonb       not null,
  receipts     jsonb       not null,
  verified     jsonb       not null,
  primary key (account_id, request_id)
)`;

export class PostgresCloseAllRunStore implements CloseAllRunStore {
  readonly #pool: Pick<Pool, 'query'>;
  private constructor(pool: Pick<Pool, 'query'>) {
    this.#pool = pool;
  }
  static async load(pool: Pick<Pool, 'query'>): Promise<PostgresCloseAllRunStore> {
    await pool.query(MIGRATE);
    return new PostgresCloseAllRunStore(pool);
  }
  async record(run: CloseAllRun): Promise<void> {
    await this.#pool.query(
      `insert into close_all_runs (account_id, request_id, requested_by, started_at, finished_at, requested, receipts, verified)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (account_id, request_id) do nothing`,
      [run.accountId, run.requestId, run.by, new Date(run.startedAtMs).toISOString(), new Date(run.finishedAtMs).toISOString(), JSON.stringify(run.requested), JSON.stringify(run.receipts), JSON.stringify(run.verified)],
    );
  }
}
