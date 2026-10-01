/**
 * The Postgres {@link ActionLog}, and an in-memory one.
 *
 * NO `pg` IMPORT, the same as the alert log: this takes a {@link SqlClient} — a
 * `query` method and nothing else — which `pg.Client` and `pg.Pool` both satisfy
 * structurally. So `apps/backend` needs no driver dependency here, the tests run
 * against a recording fake, and CI never needs a Postgres service.
 *
 * BIGINTS GO AS DECIMAL STRINGS into `numeric` columns. AUSD micros and lot
 * counts are exact integers: `JSON.stringify` throws on a bigint, a JS number
 * would be float8, and node-pg sends a JS number as a float. A string into
 * `numeric` is exact in both directions, which is the only acceptable answer for
 * a figure that is someone's collateral.
 */
import { readFileSync } from 'node:fs';
import type { ActionLog, ActionLogRow, ActionLogSettlement } from './types.ts';

export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

const OPEN = `
insert into action_log (
  idempotency_key, user_id, kind, market_id, symbol, position_id, network,
  watched_field, requested, before_value, opened_at, account_id
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11, $12)
`;

const SETTLE = `
update action_log set
  outcome         = $2,
  reported_status = $3,
  reported_reason = $4,
  venue_ref       = $5,
  after_value     = $6::numeric,
  detail          = $7,
  settled_at      = $8
where idempotency_key = $1
`;

const iso = (ms: number): string => new Date(ms).toISOString();
const num = (value: bigint | undefined): string | null =>
  value === undefined ? null : value.toString();

export class PostgresActionLog implements ActionLog {
  readonly #client: SqlClient;

  constructor(client: SqlClient) {
    this.#client = client;
  }

  /** Create the table if it is not there. Idempotent; safe on every boot. */
  async migrate(): Promise<void> {
    const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    await this.#client.query(sql);
  }

  async open(row: ActionLogRow): Promise<void> {
    await this.#client.query(OPEN, [
      row.idempotencyKey,
      row.userId,
      row.kind,
      row.marketId,
      row.symbol,
      row.positionId ?? null,
      row.network,
      row.field,
      num(row.requested),
      num(row.before),
      iso(row.openedAtMs),
      row.accountId ?? null,
    ]);
  }

  async settle(settlement: ActionLogSettlement): Promise<void> {
    await this.#client.query(SETTLE, [
      settlement.idempotencyKey,
      settlement.outcome,
      settlement.reportedStatus ?? null,
      settlement.reportedReason ?? null,
      settlement.venueRef ?? null,
      num(settlement.after),
      settlement.detail,
      iso(settlement.settledAtMs),
    ]);
  }
}

/** One recorded action, as the in-memory log holds it. */
export interface RecordedAction {
  readonly row: ActionLogRow;
  settlement: ActionLogSettlement | undefined;
}

/**
 * The in-memory {@link ActionLog}.
 *
 * Used when no database is configured, and by the tests. It keeps the same
 * two-phase shape rather than collapsing to one write, so a run without Postgres
 * exercises the same ordering — including the unsettled row, which is the thing
 * most worth being able to see.
 */
export class InMemoryActionLog implements ActionLog {
  readonly rows: RecordedAction[] = [];

  async open(row: ActionLogRow): Promise<void> {
    this.rows.push({ row, settlement: undefined });
  }

  async settle(settlement: ActionLogSettlement): Promise<void> {
    const found = [...this.rows]
      .reverse()
      .find((entry) => entry.row.idempotencyKey === settlement.idempotencyKey);
    if (found === undefined) {
      // A settlement with no row is a sequencing bug — the row is meant to exist
      // before the send. Loud rather than silently appended, because a settled
      // action with no opening row would hide exactly the ordering this layer
      // depends on.
      throw new Error(
        `no open action_log row for ${settlement.idempotencyKey}: a row is opened before the ` +
          `action is sent, so a settlement without one means the ordering was broken.`,
      );
    }
    found.settlement = settlement;
  }

  /** Rows nobody can account for: opened and never settled. */
  unsettled(): readonly RecordedAction[] {
    return this.rows.filter((entry) => entry.settlement === undefined);
  }

  find(idempotencyKey: string): RecordedAction | undefined {
    return this.rows.find((entry) => entry.row.idempotencyKey === idempotencyKey);
  }
}
