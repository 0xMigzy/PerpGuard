/**
 * AUTOMATION STATE, PER ACCOUNT, PERSISTED (spec 52, 67). The one place that
 * says which automation an account runs and whether its kill switch is on.
 *
 *   mode               NONE | LIQUIDATION_RESCUE | COPY_TRADING   (one at a time)
 *   kill_switch_active a real boolean, read on every automated check
 *
 * THE KILL SWITCH IS REAL FROM DAY ONE (owner, 6 Oct 2026): Phase 20 builds
 * the screen that flips it; every automated path already asks
 * `automationStopped(account)` before it claims an attempt and again right
 * before it sends, and that reads this column. A placeholder returning false
 * is the thing that gets forgotten.
 *
 * Mode changes are ATOMIC compare-and-set (`from` -> `to`): two simultaneous
 * requests cannot both move an account out of NONE. Phase 19's Rescue XOR
 * Copy rule sits on exactly this row.
 */
import type { Pool } from 'pg';

export type AutomationMode = 'NONE' | 'LIQUIDATION_RESCUE' | 'COPY_TRADING';

export interface AutomationRow {
  readonly accountId: number;
  readonly mode: AutomationMode;
  readonly killSwitchActive: boolean;
  readonly updatedAtMs: number;
}

export interface AutomationStore {
  get(accountId: number): AutomationRow;
  /** True when automation must not act: the kill switch is on. Read on every automated check. */
  automationStopped(accountId: number): boolean;
  /** Compare-and-set. False when the account was not in `from` (someone else moved it first). */
  transition(accountId: number, from: AutomationMode, to: AutomationMode): Promise<boolean>;
  setKillSwitch(accountId: number, active: boolean): Promise<void>;
}

const fresh = (accountId: number): AutomationRow => ({ accountId, mode: 'NONE', killSwitchActive: false, updatedAtMs: 0 });

export class InMemoryAutomationStore implements AutomationStore {
  readonly #rows = new Map<number, AutomationRow>();
  readonly #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  get(accountId: number): AutomationRow {
    return this.#rows.get(accountId) ?? fresh(accountId);
  }
  automationStopped(accountId: number): boolean {
    return this.get(accountId).killSwitchActive;
  }
  async transition(accountId: number, from: AutomationMode, to: AutomationMode): Promise<boolean> {
    const row = this.get(accountId);
    if (row.mode !== from) return false;
    this.#rows.set(accountId, { ...row, mode: to, updatedAtMs: this.#now() });
    return true;
  }
  async setKillSwitch(accountId: number, active: boolean): Promise<void> {
    this.#rows.set(accountId, { ...this.get(accountId), killSwitchActive: active, updatedAtMs: this.#now() });
  }
  /** For the Postgres store's load. */
  seed(row: AutomationRow): void {
    this.#rows.set(row.accountId, row);
  }
}

const MIGRATE_SQL = `
create table if not exists automation_state (
  account_id         bigint      primary key,
  mode               text        not null default 'NONE' check (mode in ('NONE', 'LIQUIDATION_RESCUE', 'COPY_TRADING')),
  kill_switch_active boolean     not null default false,
  updated_at         timestamptz not null default now()
)`;

/**
 * Writes go to Postgres FIRST and the memory copy follows only on success: a
 * mode or a kill switch the person was told is set must survive a restart,
 * and the compare-and-set is the database's (`update ... where mode = $from`),
 * so two processes or two taps cannot both win.
 */
export class PostgresAutomationStore implements AutomationStore {
  readonly #inner = new InMemoryAutomationStore();
  readonly #pool: Pick<Pool, 'query'>;
  private constructor(pool: Pick<Pool, 'query'>) {
    this.#pool = pool;
  }
  static async load(pool: Pick<Pool, 'query'>): Promise<PostgresAutomationStore> {
    await pool.query(MIGRATE_SQL);
    const store = new PostgresAutomationStore(pool);
    const rows = await pool.query('select account_id, mode, kill_switch_active, updated_at from automation_state');
    for (const r of rows.rows as Array<Record<string, unknown>>) {
      store.#inner.seed({ accountId: Number(r['account_id']), mode: r['mode'] as AutomationMode, killSwitchActive: r['kill_switch_active'] === true, updatedAtMs: new Date(r['updated_at'] as string).getTime() });
    }
    return store;
  }
  get(accountId: number): AutomationRow {
    return this.#inner.get(accountId);
  }
  automationStopped(accountId: number): boolean {
    return this.#inner.automationStopped(accountId);
  }
  async transition(accountId: number, from: AutomationMode, to: AutomationMode): Promise<boolean> {
    await this.#pool.query('insert into automation_state (account_id) values ($1) on conflict do nothing', [accountId]);
    const r = await this.#pool.query('update automation_state set mode = $3, updated_at = now() where account_id = $1 and mode = $2', [accountId, from, to]);
    if (r.rowCount !== 1) return false;
    await this.#inner.transition(accountId, this.#inner.get(accountId).mode, to);
    return true;
  }
  async setKillSwitch(accountId: number, active: boolean): Promise<void> {
    await this.#pool.query(
      'insert into automation_state (account_id, kill_switch_active) values ($1, $2) on conflict (account_id) do update set kill_switch_active = excluded.kill_switch_active, updated_at = now()',
      [accountId, active],
    );
    await this.#inner.setKillSwitch(accountId, active);
  }
}
