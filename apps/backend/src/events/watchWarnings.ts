/**
 * Warning levels for watched wallets, applied on every watch pass, per chat.
 *
 * The decision is per (chat, account, market): each chat picked its own
 * levels, so each keeps its own "already warned" state. That state persists
 * (`watch_warning_state`), so a restart never repeats a warning; it is dropped
 * when the position closes, the chat stops watching, or warnings are off.
 *
 * HELD WHILE BLIND, like a stale price: a position the loop cannot see right
 * now, or whose index is not serving current figures, gets no warning and
 * keeps its state. A subscription under two minutes old takes the position as
 * it stands as its baseline, because its wallet screen has just shown it.
 */
import type { Pool } from 'pg';
import type { WatchSubscription } from '@perpguard/bot';
import { isBlind } from '../risk/types.ts';
import type { PositionsPass } from '../watch/loop.ts';
import type { ChatSender } from './engine.ts';
import type { AlertPreferences } from './preferences.ts';
import { renderWarning, type RenderContext } from './render.ts';
import { evaluateWarning } from './warnings.ts';

export interface WarningStateStore {
  get(key: string): readonly number[] | undefined;
  set(key: string, disarmed: readonly number[]): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): readonly string[];
}

export class InMemoryWarningState implements WarningStateStore {
  readonly #map = new Map<string, readonly number[]>();
  get(key: string): readonly number[] | undefined {
    return this.#map.get(key);
  }
  async set(key: string, disarmed: readonly number[]): Promise<void> {
    this.#map.set(key, disarmed);
  }
  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }
  keys(): readonly string[] {
    return [...this.#map.keys()];
  }
}

const MIGRATE_SQL = `
create table if not exists watch_warning_state (
  state_key  text        primary key,
  disarmed   real[]      not null,
  updated_at timestamptz not null default now()
)`;

/** Memory for reads, Postgres written through, loaded at boot. */
export class PostgresWarningState implements WarningStateStore {
  readonly #inner = new InMemoryWarningState();
  readonly #pool: Pick<Pool, 'query'>;
  private constructor(pool: Pick<Pool, 'query'>) {
    this.#pool = pool;
  }
  static async load(pool: Pick<Pool, 'query'>): Promise<PostgresWarningState> {
    await pool.query(MIGRATE_SQL);
    const store = new PostgresWarningState(pool);
    const rows = await pool.query('select state_key, disarmed from watch_warning_state');
    for (const row of rows.rows as Array<{ state_key: string; disarmed: unknown[] }>) await store.#inner.set(row.state_key, row.disarmed.map(Number));
    return store;
  }
  get(key: string): readonly number[] | undefined {
    return this.#inner.get(key);
  }
  async set(key: string, disarmed: readonly number[]): Promise<void> {
    await this.#pool.query('insert into watch_warning_state (state_key, disarmed, updated_at) values ($1, $2, now()) on conflict (state_key) do update set disarmed = excluded.disarmed, updated_at = now()', [key, [...disarmed]]);
    await this.#inner.set(key, disarmed);
  }
  async delete(key: string): Promise<void> {
    await this.#pool.query('delete from watch_warning_state where state_key = $1', [key]);
    await this.#inner.delete(key);
  }
  keys(): readonly string[] {
    return this.#inner.keys();
  }
}

export interface WatchWarningsOptions {
  readonly watchersOf: (accountId: number) => readonly WatchSubscription[];
  readonly preferencesFor: (chatId: number) => AlertPreferences;
  readonly state: WarningStateStore;
  readonly sender: ChatSender;
  readonly render: RenderContext;
  readonly logger: { warn(message: string): void };
  readonly now?: () => number;
  readonly graceMs?: number;
}

const keyOf = (chatId: number, accountId: number, marketId: number): string => `${chatId}:${accountId}:${marketId}`;

export class WatchWarnings {
  readonly #o: WatchWarningsOptions;
  readonly #now: () => number;
  readonly #grace: number;

  constructor(options: WatchWarningsOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#grace = options.graceMs ?? 120_000;
  }

  /** One watch pass. Returns how many warnings it sent. */
  async observe(pass: PositionsPass): Promise<number> {
    let sent = 0;
    const live = new Set<string>();
    for (const a of pass.assessments) {
      const accountId = a.watch?.accountId;
      if (accountId === undefined) continue;
      for (const sub of this.#o.watchersOf(accountId)) {
        const key = keyOf(sub.chatId, accountId, a.marketId);
        live.add(key);
        // Held while blind: no warning from figures we cannot trust, and the state stands.
        if (isBlind(a.state) || a.liqBufferPct === undefined) continue;
        const prefs = this.#o.preferencesFor(sub.chatId);
        if (!prefs.walletAlerts || prefs.warningLevels.length === 0) {
          if (this.#o.state.get(key) !== undefined) await this.#o.state.delete(key);
          continue;
        }
        const before = this.#o.state.get(key) ?? [];
        const r = evaluateWarning(prefs.warningLevels, a.liqBufferPct * 100, before);
        const baseline = this.#now() - sub.addedAtMs < this.#grace;
        if (r.fire !== undefined && !baseline) {
          const result = await this.#o.sender.send(sub.chatId, renderWarning(a, r.fire, prefs.warningLevels, pass.configs.get(a.marketId), this.#o.render));
          if (!result.ok) this.#o.logger.warn(`warnings: a ${r.fire}% warning for #${accountId} was not delivered: ${result.reason}`);
          sent += 1;
        }
        if (r.disarmed.join() !== before.join()) await this.#o.state.set(key, r.disarmed);
      }
    }
    // Forget positions that closed (their account was read and they are gone) and chats that stopped watching.
    for (const key of this.#o.state.keys()) {
      if (live.has(key)) continue;
      const [, accountPart] = key.split(':');
      if (pass.reads.has(Number(accountPart)) || !pass.watched.includes(Number(accountPart))) await this.#o.state.delete(key);
    }
    return sent;
  }
}

