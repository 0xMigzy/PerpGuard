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
import type { AlertLog, AlertLogEntry } from './types.ts';

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

export class PostgresAlertLog implements AlertLog {
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
}

/**
 * An {@link AlertLog} that keeps rows in memory.
 *
 * For the demo and for tests of everything upstream. It is NOT a fallback for a
 * failed database: a process that alerts without recording is a process whose
 * undelivered DANGER alerts exist nowhere, so wiring this in place of a real log
 * is a decision to make deliberately, not a default to drift into.
 */
export class InMemoryAlertLog implements AlertLog {
  readonly rows: AlertLogEntry[] = [];

  async record(entry: AlertLogEntry): Promise<void> {
    this.rows.push(entry);
  }
}
