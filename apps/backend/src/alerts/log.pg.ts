/**
 * The Postgres {@link AlertLog}.
 *
 * NO `pg` IMPORT, on purpose. This takes a {@link SqlClient} — a `query` method
 * and nothing else — which `pg.Client` and `pg.Pool` both satisfy structurally.
 * Three things follow: this file needs no driver dependency in `apps/backend`,
 * it tests against a recording fake with no database anywhere, and CI never
 * needs a Postgres service to typecheck or test the alerts layer.
 *
 * The caller owns the connection, its credentials and its lifecycle. Secrets
 * reach it through env vars and never through here.
 */
import { readFileSync } from 'node:fs';
import type { AlertAction, AlertLog, AlertLogEntry } from './types.ts';
import type { RiskState } from '../risk/types.ts';

/**
 * The read side, for the Alerts page: what was said to one user, newest first.
 *
 * Separate from {@link AlertLog} so the engine's write port stays one method,
 * and PAGED: a chatty week is hundreds of rows and nobody renders them all.
 */
export interface AlertHistoryReader {
  recent(userId: string, limit: number): Promise<readonly AlertLogEntry[]>;
}

/**
 * The slice of a Postgres client this needs.
 *
 * `values` is `readonly unknown[]` rather than anything narrower because a driver
 * accepts strings, numbers, Dates and nulls interchangeably, and pinning it would
 * only force casts at the call site.
 */
export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

const INSERT = `
insert into alert_log (
  alert_key, user_id, market_id, symbol, kind, state, previous_state,
  message, actions, attempts, outcome, last_error, created_at, delivered_at
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
`;

/**
 * Actions as JSON the driver can send.
 *
 * `amountCNS` BECOMES A STRING. It is AUSD micros as a bigint: `JSON.stringify`
 * throws on a bigint outright, and a number would be float8 in jsonb and could
 * round. A money figure that a button later sends to the venue must survive the
 * round trip exactly, so it goes as a decimal string.
 */
function serialiseActions(entry: AlertLogEntry): string {
  return JSON.stringify(
    entry.actions.map((action) => ({
      type: action.type,
      intent: action.intent,
      marketId: action.marketId,
      symbol: action.symbol,
      positionId: action.positionId ?? null,
      amountCNS: action.amountCNS.toString(),
      label: action.label,
    })),
  );
}

const iso = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString();

const RECENT = `
select alert_key, user_id, market_id, symbol, kind, state, previous_state, message, actions,
       attempts, outcome, last_error, created_at, delivered_at
  from alert_log
 where user_id = $1
 order by created_at desc, id desc
 limit $2
`;

const ms = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** The jsonb back into actions. `amountCNS` returns through BigInt, never Number. */
function deserialiseActions(value: unknown): readonly AlertAction[] {
  const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(raw)) return [];
  return raw.map((a: Record<string, unknown>) => ({
    type: 'add-margin' as const,
    intent: a['intent'] as AlertAction['intent'],
    marketId: Number(a['marketId']),
    symbol: String(a['symbol']),
    positionId: a['positionId'] === null || a['positionId'] === undefined ? undefined : Number(a['positionId']),
    amountCNS: BigInt(String(a['amountCNS'])),
    label: String(a['label']),
  }));
}

/** One row -> the entry the engine wrote. */
export function entryFromRow(row: Record<string, unknown>): AlertLogEntry {
  const created = ms(row['created_at']);
  if (created === undefined) throw new RangeError('alert_log row without created_at');
  return {
    alertKey: String(row['alert_key']),
    userId: String(row['user_id']),
    marketId: Number(row['market_id']),
    symbol: String(row['symbol']),
    kind: row['kind'] as AlertLogEntry['kind'],
    state: row['state'] as RiskState,
    previousState: row['previous_state'] === null || row['previous_state'] === undefined ? undefined : (row['previous_state'] as RiskState),
    text: String(row['message']),
    actions: deserialiseActions(row['actions']),
    attempts: Number(row['attempts']),
    outcome: row['outcome'] as AlertLogEntry['outcome'],
    lastError: row['last_error'] === null || row['last_error'] === undefined ? undefined : String(row['last_error']),
    createdAtMs: created,
    deliveredAtMs: ms(row['delivered_at']),
  };
}

export class PostgresAlertLog implements AlertLog, AlertHistoryReader {
  readonly #client: SqlClient;

  constructor(client: SqlClient) {
    this.#client = client;
  }

  /**
   * Create the table if it is not there. Idempotent; safe on every boot.
   *
   * The DDL lives in `schema.sql` rather than inline so there is exactly one
   * definition of the table, readable by a human with `psql` and by this.
   */
  async migrate(): Promise<void> {
    const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    await this.#client.query(sql);
  }

  async record(entry: AlertLogEntry): Promise<void> {
    await this.#client.query(INSERT, [
      entry.alertKey,
      entry.userId,
      entry.marketId,
      entry.symbol,
      entry.kind,
      entry.state,
      entry.previousState ?? null,
      entry.text,
      serialiseActions(entry),
      entry.attempts,
      entry.outcome,
      entry.lastError ?? null,
      iso(entry.createdAtMs),
      iso(entry.deliveredAtMs),
    ]);
  }

  async recent(userId: string, limit: number): Promise<readonly AlertLogEntry[]> {
    const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
    const result = (await this.#client.query(RECENT, [userId, capped])) as { rows?: Array<Record<string, unknown>> };
    return (result.rows ?? []).map(entryFromRow);
  }
}

/**
 * An {@link AlertLog} that keeps rows in memory.
 *
 * For the demo and for tests of everything upstream. It is NOT a fallback for a
 * failed database: a process that alerts without recording is a process whose
 * undelivered DANGER alerts exist nowhere, so wiring this in place of a real log
 * is a decision to make deliberately, not a default to drift into.
 */
export class InMemoryAlertLog implements AlertLog, AlertHistoryReader {
  readonly rows: AlertLogEntry[] = [];

  async record(entry: AlertLogEntry): Promise<void> {
    this.rows.push(entry);
  }

  async recent(userId: string, limit: number): Promise<readonly AlertLogEntry[]> {
    const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
    return [...this.rows]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, capped);
  }
}
