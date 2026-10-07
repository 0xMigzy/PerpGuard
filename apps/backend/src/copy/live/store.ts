/**
 * 🔁 COPY TRADING, HALF B: what is remembered (owner, 7 Oct 2026).
 *
 *   copy_rules: one per follower account at a time. Who they copy, the free
 *     balance never spent, whether it is on, why it paused, and HOW IT WAS
 *     ARMED (the tap, signed: `arming.ts`). Copies only positions the leader
 *     opened at or after `started_at`.
 *   copy_legs: one per leader position seen, whatever became of it: skipped
 *     (with why), opening, open (our position id), not opened, unknown,
 *     closing, closed, close not landed, closed by you. `(rule, leader_key)`
 *     is UNIQUE and claimed BEFORE the send: an event is copied at most once,
 *     across restarts.
 */
import type { Pool } from 'pg';
import type { Side } from '@perpguard/shared';

export interface CopyRule {
  readonly id: number;
  readonly followerAccountId: number;
  readonly leaderAccountId: number;
  /** The free balance never spent. 0 is allowed. */
  readonly keepFreeCNS: bigint;
  readonly enabled: boolean;
  /** Set when copying paused itself (an unknown outcome). Cleared only by the person. */
  readonly pausedReason: string | undefined;
  /** Only leader positions opened at or after this are copied. */
  readonly startedAtMs: number;
  readonly armedBy: number | undefined;
  readonly armedChat: number | undefined;
  readonly armedAtMs: number | undefined;
  readonly armProof: string | undefined;
  /** The last thing said once (a held reason), so it is not repeated every pass. */
  readonly lastNotice: string | undefined;
}

export type LegStatus = 'skipped' | 'opening' | 'open' | 'not-opened' | 'unknown' | 'closing' | 'closed' | 'close-not-landed' | 'closed-by-you';

export interface CopyLeg {
  readonly ruleId: number;
  /** The index's id for the leader's position. */
  readonly leaderKey: string;
  readonly leaderMarketId: number;
  readonly symbol: string;
  readonly side: Side;
  readonly leaderOpenedAtMs: number;
  readonly status: LegStatus;
  /** Why it was skipped, or what went wrong, in a sentence. */
  readonly reason: string | undefined;
  readonly actingMarketId: number | undefined;
  readonly sizeLNS: bigint | undefined;
  readonly leverageHundredths: number | undefined;
  readonly positionId: number | undefined;
  readonly openKey: string;
  readonly closeKey: string | undefined;
  readonly openedAtMs: number | undefined;
  readonly closedAtMs: number | undefined;
}

export type NewCopyRule = Omit<CopyRule, 'id' | 'enabled' | 'pausedReason' | 'lastNotice'>;
export type LegPatch = Partial<Pick<CopyLeg, 'status' | 'reason' | 'actingMarketId' | 'sizeLNS' | 'leverageHundredths' | 'positionId' | 'closeKey' | 'openedAtMs' | 'closedAtMs'>>;

export const openKeyOf = (followerAccountId: number, leaderKey: string): string => `copy:${followerAccountId}:${leaderKey}:open`;
export const closeKeyOf = (followerAccountId: number, leaderKey: string): string => `copy:${followerAccountId}:${leaderKey}:close`;

export interface CopyStore {
  enabledRules(): readonly CopyRule[];
  ruleFor(followerAccountId: number): CopyRule | undefined;
  rule(id: number): CopyRule | undefined;
  create(rule: NewCopyRule): Promise<CopyRule>;
  update(id: number, patch: Partial<Pick<CopyRule, 'enabled' | 'pausedReason' | 'keepFreeCNS' | 'lastNotice'>>): Promise<CopyRule>;
  legs(ruleId: number): readonly CopyLeg[];
  /** Claims a leg BEFORE anything is sent. False when it already exists: never copied twice. */
  claim(leg: Omit<CopyLeg, 'closeKey' | 'openedAtMs' | 'closedAtMs' | 'positionId'>): Promise<boolean>;
  updateLeg(ruleId: number, leaderKey: string, patch: LegPatch): Promise<CopyLeg>;
}

export class InMemoryCopyStore implements CopyStore {
  readonly #rules = new Map<number, CopyRule>();
  readonly #legs = new Map<string, CopyLeg>();
  #next = 1;

  enabledRules(): readonly CopyRule[] {
    return [...this.#rules.values()].filter((r) => r.enabled);
  }
  ruleFor(followerAccountId: number): CopyRule | undefined {
    return [...this.#rules.values()].filter((r) => r.followerAccountId === followerAccountId).sort((a, b) => b.id - a.id)[0];
  }
  rule(id: number): CopyRule | undefined {
    return this.#rules.get(id);
  }
  async create(rule: NewCopyRule): Promise<CopyRule> {
    const made: CopyRule = { ...rule, id: this.#next++, enabled: true, pausedReason: undefined, lastNotice: undefined };
    this.#rules.set(made.id, made);
    return made;
  }
  async update(id: number, patch: Parameters<CopyStore['update']>[1]): Promise<CopyRule> {
    const r = this.#rules.get(id);
    if (r === undefined) throw new Error(`no copy rule ${id}`);
    const next = { ...r, ...patch };
    this.#rules.set(id, next);
    return next;
  }
  legs(ruleId: number): readonly CopyLeg[] {
    return [...this.#legs.values()].filter((l) => l.ruleId === ruleId).sort((a, b) => a.leaderOpenedAtMs - b.leaderOpenedAtMs);
  }
  async claim(leg: Parameters<CopyStore['claim']>[0]): Promise<boolean> {
    const key = `${leg.ruleId}:${leg.leaderKey}`;
    if (this.#legs.has(key)) return false;
    this.#legs.set(key, { ...leg, closeKey: undefined, openedAtMs: undefined, closedAtMs: undefined, positionId: undefined });
    return true;
  }
  async updateLeg(ruleId: number, leaderKey: string, patch: LegPatch): Promise<CopyLeg> {
    const key = `${ruleId}:${leaderKey}`;
    const l = this.#legs.get(key);
    if (l === undefined) throw new Error(`no copy leg ${key}`);
    const next = { ...l, ...patch };
    this.#legs.set(key, next);
    return next;
  }
  /** For the Postgres store's load. */
  seed(rules: readonly CopyRule[], legs: readonly CopyLeg[]): void {
    for (const r of rules) {
      this.#rules.set(r.id, r);
      this.#next = Math.max(this.#next, r.id + 1);
    }
    for (const l of legs) this.#legs.set(`${l.ruleId}:${l.leaderKey}`, l);
  }
}

const MIGRATE = `
create table if not exists copy_rules (
  id                  bigserial primary key,
  follower_account_id bigint not null,
  leader_account_id   bigint not null,
  keep_free_cns       bigint not null check (keep_free_cns >= 0),
  enabled             boolean not null default true,
  paused_reason       text,
  last_notice         text,
  started_at          timestamptz not null,
  armed_by            bigint,
  armed_chat          bigint,
  armed_at            timestamptz,
  arm_proof           text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists copy_rules_one_enabled on copy_rules (follower_account_id) where enabled;
create table if not exists copy_legs (
  rule_id            bigint not null references copy_rules (id),
  leader_key         text   not null,
  leader_market_id   integer not null,
  symbol             text   not null,
  side               text   not null check (side in ('long', 'short')),
  leader_opened_at   timestamptz not null,
  status             text   not null,
  reason             text,
  acting_market_id   integer,
  size_lns           bigint,
  leverage_hdths     integer,
  position_id        bigint,
  open_key           text   not null unique,
  close_key          text   unique,
  opened_at          timestamptz,
  closed_at          timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (rule_id, leader_key)
);
`;

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());
const ms = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : new Date(v as string).getTime());
const big = (v: unknown): bigint | undefined => (v === null || v === undefined ? undefined : BigInt(String(v)));
const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

function ruleOf(r: Record<string, unknown>): CopyRule {
  return {
    id: Number(r['id']),
    followerAccountId: Number(r['follower_account_id']),
    leaderAccountId: Number(r['leader_account_id']),
    keepFreeCNS: BigInt(String(r['keep_free_cns'])),
    enabled: r['enabled'] === true,
    pausedReason: str(r['paused_reason']),
    lastNotice: str(r['last_notice']),
    startedAtMs: ms(r['started_at']) ?? 0,
    armedBy: num(r['armed_by']),
    armedChat: num(r['armed_chat']),
    armedAtMs: ms(r['armed_at']),
    armProof: str(r['arm_proof']),
  };
}

function legOf(r: Record<string, unknown>): CopyLeg {
  return {
    ruleId: Number(r['rule_id']),
    leaderKey: String(r['leader_key']),
    leaderMarketId: Number(r['leader_market_id']),
    symbol: String(r['symbol']),
    side: r['side'] === 'short' ? 'short' : 'long',
    leaderOpenedAtMs: ms(r['leader_opened_at']) ?? 0,
    status: String(r['status']) as LegStatus,
    reason: str(r['reason']),
    actingMarketId: num(r['acting_market_id']),
    sizeLNS: big(r['size_lns']),
    leverageHundredths: num(r['leverage_hdths']),
    positionId: num(r['position_id']),
    openKey: String(r['open_key']),
    closeKey: str(r['close_key']),
    openedAtMs: ms(r['opened_at']),
    closedAtMs: ms(r['closed_at']),
  };
}

export class PostgresCopyStore implements CopyStore {
  readonly #pool: Pick<Pool, 'query'>;
  readonly #inner = new InMemoryCopyStore();
  private constructor(pool: Pick<Pool, 'query'>) {
    this.#pool = pool;
  }
  static async load(pool: Pick<Pool, 'query'>): Promise<PostgresCopyStore> {
    await pool.query(MIGRATE);
    const store = new PostgresCopyStore(pool);
    const rules = (await pool.query('select * from copy_rules')).rows as Array<Record<string, unknown>>;
    const legs = (await pool.query('select * from copy_legs')).rows as Array<Record<string, unknown>>;
    store.#inner.seed(rules.map(ruleOf), legs.map(legOf));
    return store;
  }
  enabledRules(): readonly CopyRule[] {
    return this.#inner.enabledRules();
  }
  ruleFor(followerAccountId: number): CopyRule | undefined {
    return this.#inner.ruleFor(followerAccountId);
  }
  rule(id: number): CopyRule | undefined {
    return this.#inner.rule(id);
  }
  legs(ruleId: number): readonly CopyLeg[] {
    return this.#inner.legs(ruleId);
  }
  async create(rule: NewCopyRule): Promise<CopyRule> {
    const r = await this.#pool.query(
      `insert into copy_rules (follower_account_id, leader_account_id, keep_free_cns, started_at, armed_by, armed_chat, armed_at, arm_proof)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [rule.followerAccountId, rule.leaderAccountId, String(rule.keepFreeCNS), iso(rule.startedAtMs), rule.armedBy ?? null, rule.armedChat ?? null, iso(rule.armedAtMs), rule.armProof ?? null],
    );
    const made = ruleOf(r.rows[0] as Record<string, unknown>);
    this.#inner.seed([made], []);
    return made;
  }
  async update(id: number, patch: Parameters<CopyStore['update']>[1]): Promise<CopyRule> {
    const current = this.#inner.rule(id);
    if (current === undefined) throw new Error(`no copy rule ${id}`);
    const next = { ...current, ...patch };
    await this.#pool.query('update copy_rules set enabled = $2, paused_reason = $3, keep_free_cns = $4, last_notice = $5, updated_at = now() where id = $1', [
      id,
      next.enabled,
      next.pausedReason ?? null,
      String(next.keepFreeCNS),
      next.lastNotice ?? null,
    ]);
    return this.#inner.update(id, patch);
  }
  async claim(leg: Parameters<CopyStore['claim']>[0]): Promise<boolean> {
    const r = await this.#pool.query(
      `insert into copy_legs (rule_id, leader_key, leader_market_id, symbol, side, leader_opened_at, status, reason, acting_market_id, size_lns, leverage_hdths, open_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict do nothing`,
      [leg.ruleId, leg.leaderKey, leg.leaderMarketId, leg.symbol, leg.side, iso(leg.leaderOpenedAtMs), leg.status, leg.reason ?? null, leg.actingMarketId ?? null, leg.sizeLNS === undefined ? null : String(leg.sizeLNS), leg.leverageHundredths ?? null, leg.openKey],
    );
    if (r.rowCount !== 1) return false;
    await this.#inner.claim(leg);
    return true;
  }
  async updateLeg(ruleId: number, leaderKey: string, patch: LegPatch): Promise<CopyLeg> {
    const current = this.#inner.legs(ruleId).find((l) => l.leaderKey === leaderKey);
    if (current === undefined) throw new Error(`no copy leg ${ruleId}:${leaderKey}`);
    const n = { ...current, ...patch };
    await this.#pool.query(
      `update copy_legs set status = $3, reason = $4, acting_market_id = $5, size_lns = $6, leverage_hdths = $7, position_id = $8, close_key = $9, opened_at = $10, closed_at = $11, updated_at = now()
        where rule_id = $1 and leader_key = $2`,
      [ruleId, leaderKey, n.status, n.reason ?? null, n.actingMarketId ?? null, n.sizeLNS === undefined ? null : String(n.sizeLNS), n.leverageHundredths ?? null, n.positionId ?? null, n.closeKey ?? null, iso(n.openedAtMs), iso(n.closedAtMs)],
    );
    return this.#inner.updateLeg(ruleId, leaderKey, patch);
  }
}
