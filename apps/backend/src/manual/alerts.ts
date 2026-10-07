/**
 * 🔔 MANUAL ALERTS: WHEN (Part 2, owner, 7 Oct 2026). Every linked account's
 * positions, against that account's alert distance, once a second.
 *
 *   - ONE ALERT PER POSITION PER CROSSING, never one per tick: the crossing
 *     rule is the watched wallets' (`events/warnings.ts`), one level. It fires
 *     when the distance reaches the alert, and re-arms only after the position
 *     recovers a quarter of it (at least half a point).
 *   - Remembered per (account, position) in Postgres, so a restart does not
 *     say it again.
 *   - HELD WHILE BLIND: a position list that is not live, or a position that
 *     cannot be priced, says nothing and changes nothing.
 *   - Nothing here sends money. The message offers amounts; the person taps
 *     and confirms. When Auto top-up is armed, the message says it is adding.
 */
import type { Pool } from 'pg';
import { evaluateWarning } from '../events/warnings.ts';
import type { RiskAssessment } from '../risk/types.ts';

export interface ManualAlertStateStore {
  /** The alert level (percent) this position has already fired at and not re-armed, if any. */
  get(accountId: number, positionId: number): number | undefined;
  set(accountId: number, positionId: number, firedAtPct: number | undefined): Promise<void>;
}

export class InMemoryManualAlertState implements ManualAlertStateStore {
  readonly #by = new Map<string, number>();
  get(accountId: number, positionId: number): number | undefined {
    return this.#by.get(`${accountId}:${positionId}`);
  }
  async set(accountId: number, positionId: number, firedAtPct: number | undefined): Promise<void> {
    if (firedAtPct === undefined) this.#by.delete(`${accountId}:${positionId}`);
    else this.#by.set(`${accountId}:${positionId}`, firedAtPct);
  }
  /** For the Postgres store's load. */
  seed(accountId: number, positionId: number, firedAtPct: number): void {
    this.#by.set(`${accountId}:${positionId}`, firedAtPct);
  }
}

export class PostgresManualAlertState implements ManualAlertStateStore {
  readonly #inner = new InMemoryManualAlertState();
  readonly #pool: Pick<Pool, 'query'>;
  private constructor(pool: Pick<Pool, 'query'>) {
    this.#pool = pool;
  }
  static async load(pool: Pick<Pool, 'query'>): Promise<PostgresManualAlertState> {
    await pool.query(`create table if not exists manual_alert_state (
      account_id  bigint not null,
      position_id bigint not null,
      fired_pct   real   not null,
      updated_at  timestamptz not null default now(),
      primary key (account_id, position_id))`);
    const s = new PostgresManualAlertState(pool);
    for (const r of (await pool.query('select account_id, position_id, fired_pct from manual_alert_state')).rows as Array<Record<string, unknown>>) {
      s.#inner.seed(Number(r['account_id']), Number(r['position_id']), Number(r['fired_pct']));
    }
    return s;
  }
  get(accountId: number, positionId: number): number | undefined {
    return this.#inner.get(accountId, positionId);
  }
  async set(accountId: number, positionId: number, firedAtPct: number | undefined): Promise<void> {
    if (firedAtPct === undefined) await this.#pool.query('delete from manual_alert_state where account_id = $1 and position_id = $2', [accountId, positionId]);
    else await this.#pool.query(`insert into manual_alert_state (account_id, position_id, fired_pct) values ($1, $2, $3) on conflict (account_id, position_id) do update set fired_pct = excluded.fired_pct, updated_at = now()`, [accountId, positionId, firedAtPct]);
    await this.#inner.set(accountId, positionId, firedAtPct);
  }
}

/** What the engine needs from one linked account. */
export interface ManualAlertAccount {
  readonly accountId: number;
  /** The position list is fully loaded: anything else and nothing is judged. */
  positionsLive(): boolean;
  assessments(): readonly RiskAssessment[];
}

export interface ManualAlertsOptions {
  readonly accounts: () => Iterable<ManualAlertAccount>;
  /** Percent. */
  readonly alertPctOf: (accountId: number) => number;
  readonly state: ManualAlertStateStore;
  /** Says it. Not awaited by the tick: one person's slow send never holds another's alert. */
  readonly deliver: (accountId: number, assessment: RiskAssessment, alertPct: number) => Promise<void>;
  readonly logger: { info(message: string): void; warn(message: string): void };
  readonly tickMs?: number;
}

const BLIND = new Set(['FEED_DOWN', 'POSITIONS_UNTRUSTED']);

export class ManualAlerts {
  readonly #o: ManualAlertsOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(options: ManualAlertsOptions) {
    this.#o = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.tick(), this.#o.tickMs ?? 1_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const account of this.#o.accounts()) {
        if (!account.positionsLive()) continue;
        const level = this.#o.alertPctOf(account.accountId);
        for (const a of account.assessments()) {
          if (a.positionId === undefined || a.liqBufferPct === undefined || BLIND.has(a.state)) continue;
          const fired = this.#o.state.get(account.accountId, a.positionId);
          // A different level than the one that fired (the person changed it) starts fresh.
          const disarmed = fired === level ? [level] : [];
          const next = evaluateWarning([level], a.liqBufferPct * 100, disarmed);
          const nowFired = next.disarmed.includes(level) ? level : undefined;
          if (nowFired !== fired) await this.#o.state.set(account.accountId, a.positionId, nowFired);
          if (next.fire !== undefined) {
            this.#o.logger.info(`manual alert: account ${account.accountId} ${a.symbol} (pid ${a.positionId}) reached ${(a.liqBufferPct * 100).toFixed(2)}%, alert at ${level}%`);
            void this.#o.deliver(account.accountId, a, level).catch((error: unknown) => {
              this.#o.logger.warn(`manual alert for account ${account.accountId} ${a.symbol} did not go: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        }
      }
    } finally {
      this.#ticking = false;
    }
  }
}
