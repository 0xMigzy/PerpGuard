/**
 * Rescue rules and every attempt, persisted (spec 42, 68).
 *
 * A RULE belongs to one position on one account (the venue's position id: a
 * position closed and reopened is a new one, and its rule has ended). It
 * carries its own FOUR LIMITS, each its own column:
 *
 *   max_rescues            how many top-ups at most
 *   max_total_cns          how much in all, INDEPENDENT of the count (owner,
 *                          6 Oct 2026): 5 rescues of 500 can still be capped at 1,000
 *   min_remaining_cns      free balance never spent
 *   cooldown_ms            between two rescues of the same position
 *
 * An ATTEMPT is claimed BEFORE anything is sent, unique on (rule, attempt
 * number), with the idempotency key `rescue:<account>:<position>:<rule>:<n>`.
 * A duplicate trigger, a restart or a retried event computes the same claim,
 * finds it taken, and sends nothing. Each attempt keeps the RECEIPT (what the
 * exchange said) and the VERIFIED OUTCOME (what the position showed) as
 * separate fields: on `t: 6` they disagree, and the verified one is the truth.
 */
import type { Pool } from 'pg';

export interface RescueRule {
  readonly id: number;
  readonly accountId: number;
  readonly marketId: number;
  readonly symbol: string;
  readonly positionId: number;
  /** Fraction: 0.04 is "at or below 4% from liquidation". */
  readonly triggerPct: number;
  readonly amountCNS: bigint;
  readonly maxRescues: number;
  readonly maxTotalCNS: bigint;
  readonly minRemainingCNS: bigint;
  readonly cooldownMs: number;
  readonly rescueCount: number;
  readonly totalRescuedCNS: bigint;
  readonly enabled: boolean;
  /** Set when the rule stopped itself (an unknown outcome, the position gone). Cleared only by the person. */
  readonly pausedReason: string | undefined;
  readonly lastAttemptAtMs: number | undefined;
  /** The last thing the person was told about this rule (`held:<reason>`, `exhausted`), so it is said once. */
  readonly lastNotice: string | undefined;
  readonly createdAtMs: number;
  /**
   * HOW IT WAS ARMED (owner, 7 Oct 2026): the Telegram user who tapped, from
   * which chat, when, and the server's signature over the rule (`arming.ts`).
   * Undefined on a rule written any other way, which is never acted on.
   */
  readonly armedBy: number | undefined;
  readonly armedChat: number | undefined;
  readonly armedAtMs: number | undefined;
  readonly armProof: string | undefined;
}

export type AttemptOutcome = 'applied' | 'not-applied' | 'unknown' | 'refused';

export interface RescueAttempt {
  readonly ruleId: number;
  readonly attemptNo: number;
  readonly idempotencyKey: string;
  readonly accountId: number;
  readonly marketId: number;
  readonly positionId: number;
  // what triggered it
  readonly triggerDistancePct: number;
  readonly triggerMark: string;
  readonly triggeredAtMs: number;
  // what was sent
  readonly amountCNS: bigint;
  readonly sentAtMs: number | undefined;
  // what the exchange's receipt said
  readonly receiptStatus: string | undefined;
  readonly receiptReason: string | undefined;
  readonly venueRef: string | undefined;
  // what the position showed afterwards
  readonly outcome: AttemptOutcome | undefined;
  readonly marginBeforeCNS: bigint | undefined;
  readonly marginAfterCNS: bigint | undefined;
  readonly appliedCNS: bigint | undefined;
  readonly distanceAfterPct: number | undefined;
  readonly verifiedAtMs: number | undefined;
  readonly detail: string | undefined;
}

export type NewRule = Omit<RescueRule, 'id' | 'rescueCount' | 'totalRescuedCNS' | 'enabled' | 'pausedReason' | 'lastAttemptAtMs' | 'lastNotice' | 'createdAtMs'>;

export const rescueKey = (r: Pick<RescueRule, 'accountId' | 'positionId' | 'id'>, attemptNo: number): string => `rescue:${r.accountId}:${r.positionId}:${r.id}:${attemptNo}`;

export interface RescueStore {
  enabledRules(): readonly RescueRule[];
  rulesFor(accountId: number): readonly RescueRule[];
  rule(id: number): RescueRule | undefined;
  create(rule: NewRule, nowMs: number): Promise<RescueRule>;
  /** `triggerPct` moves with the account's alert distance; the signature does not cover it, so it stays valid. */
  update(id: number, patch: Partial<Pick<RescueRule, 'rescueCount' | 'totalRescuedCNS' | 'enabled' | 'pausedReason' | 'lastAttemptAtMs' | 'lastNotice' | 'triggerPct'>>): Promise<RescueRule>;
  /** Claims attempt `n` of a rule. False: it was claimed before (a duplicate), and nothing may be sent. */
  claim(attempt: Pick<RescueAttempt, 'ruleId' | 'attemptNo' | 'idempotencyKey' | 'accountId' | 'marketId' | 'positionId' | 'triggerDistancePct' | 'triggerMark' | 'triggeredAtMs' | 'amountCNS'>): Promise<boolean>;
  record(ruleId: number, attemptNo: number, patch: Partial<RescueAttempt>): Promise<void>;
  attempts(ruleId: number): readonly RescueAttempt[];
}

const blankAttempt = (a: Parameters<RescueStore['claim']>[0]): RescueAttempt => ({
  ...a,
  sentAtMs: undefined,
  receiptStatus: undefined,
  receiptReason: undefined,
  venueRef: undefined,
  outcome: undefined,
  marginBeforeCNS: undefined,
  marginAfterCNS: undefined,
  appliedCNS: undefined,
  distanceAfterPct: undefined,
  verifiedAtMs: undefined,
  detail: undefined,
});

export class InMemoryRescueStore implements RescueStore {
  readonly #rules = new Map<number, RescueRule>();
  readonly #attempts = new Map<string, RescueAttempt>();
  #next = 1;
  enabledRules(): readonly RescueRule[] {
    return [...this.#rules.values()].filter((r) => r.enabled);
  }
  rulesFor(accountId: number): readonly RescueRule[] {
    return [...this.#rules.values()].filter((r) => r.accountId === accountId);
  }
  rule(id: number): RescueRule | undefined {
    return this.#rules.get(id);
  }
  async create(rule: NewRule, nowMs: number): Promise<RescueRule> {
    const made: RescueRule = { ...rule, id: this.#next++, rescueCount: 0, totalRescuedCNS: 0n, enabled: true, pausedReason: undefined, lastAttemptAtMs: undefined, lastNotice: undefined, createdAtMs: nowMs };
    this.#rules.set(made.id, made);
    return made;
  }
  async update(id: number, patch: Parameters<RescueStore['update']>[1]): Promise<RescueRule> {
    const r = this.#rules.get(id);
    if (r === undefined) throw new Error(`no rescue rule ${id}`);
    const next = { ...r, ...patch };
    this.#rules.set(id, next);
    return next;
  }
  async claim(a: Parameters<RescueStore['claim']>[0]): Promise<boolean> {
    const key = `${a.ruleId}:${a.attemptNo}`;
    if (this.#attempts.has(key)) return false;
    this.#attempts.set(key, blankAttempt(a));
    return true;
  }
  async record(ruleId: number, attemptNo: number, patch: Partial<RescueAttempt>): Promise<void> {
    const key = `${ruleId}:${attemptNo}`;
    const a = this.#attempts.get(key);
    if (a !== undefined) this.#attempts.set(key, { ...a, ...patch });
  }
  attempts(ruleId: number): readonly RescueAttempt[] {
    return [...this.#attempts.values()].filter((a) => a.ruleId === ruleId).sort((a, b) => a.attemptNo - b.attemptNo);
  }
  /** For the Postgres store's load. */
  seed(rules: readonly RescueRule[], attempts: readonly RescueAttempt[]): void {
    for (const r of rules) {
      this.#rules.set(r.id, r);
      this.#next = Math.max(this.#next, r.id + 1);
    }
    for (const a of attempts) this.#attempts.set(`${a.ruleId}:${a.attemptNo}`, a);
  }
}

const MIGRATE_SQL = `
create table if not exists rescue_rules (
  id                bigserial   primary key,
  account_id        bigint      not null,
  market_id         integer     not null,
  symbol            text        not null,
  position_id       bigint      not null,
  trigger_pct       real        not null check (trigger_pct > 0 and trigger_pct <= 1),
  amount_cns        bigint      not null check (amount_cns > 0),
  max_rescues       integer     not null check (max_rescues > 0),
  max_total_cns     bigint      not null check (max_total_cns > 0),
  min_remaining_cns bigint      not null check (min_remaining_cns >= 0),
  cooldown_ms       integer     not null check (cooldown_ms >= 0),
  rescue_count      integer     not null default 0,
  total_rescued_cns bigint      not null default 0,
  enabled           boolean     not null default true,
  paused_reason     text,
  last_attempt_at   timestamptz,
  last_notice       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists rescue_rules_one_enabled on rescue_rules (account_id, market_id) where enabled;
alter table rescue_rules add column if not exists armed_by bigint;
alter table rescue_rules add column if not exists armed_chat bigint;
alter table rescue_rules add column if not exists armed_at timestamptz;
alter table rescue_rules add column if not exists arm_proof text;
create table if not exists rescue_attempts (
  rule_id              bigint      not null references rescue_rules (id),
  attempt_no           integer     not null,
  idempotency_key      text        not null unique,
  account_id           bigint      not null,
  market_id            integer     not null,
  position_id          bigint      not null,
  trigger_distance_pct real        not null,
  trigger_mark         text        not null,
  triggered_at         timestamptz not null,
  amount_cns           bigint      not null,
  sent_at              timestamptz,
  receipt_status       text,
  receipt_reason       text,
  venue_ref            text,
  outcome              text,
  margin_before_cns    bigint,
  margin_after_cns     bigint,
  applied_cns          bigint,
  distance_after_pct   real,
  verified_at          timestamptz,
  detail               text,
  primary key (rule_id, attempt_no)
)`;

const ms = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : new Date(v as string).getTime());
const big = (v: unknown): bigint | undefined => (v === null || v === undefined ? undefined : BigInt(String(v)));
const iso = (v: number | undefined): string | null => (v === undefined ? null : new Date(v).toISOString());

/**
 * Postgres first, memory after, for every write: a rule or an attempt the
 * engine acted on must survive a restart, and THE CLAIM IS THE DATABASE'S
 * (`insert ... on conflict do nothing`): two processes cannot both claim it.
 */
export class PostgresRescueStore implements RescueStore {
  readonly #inner = new InMemoryRescueStore();
  readonly #pool: Pick<Pool, 'query'>;
  private constructor(pool: Pick<Pool, 'query'>) {
    this.#pool = pool;
  }

  static async load(pool: Pick<Pool, 'query'>): Promise<PostgresRescueStore> {
    await pool.query(MIGRATE_SQL);
    const store = new PostgresRescueStore(pool);
    const rules = (await pool.query('select * from rescue_rules')).rows as Array<Record<string, unknown>>;
    const attempts = (await pool.query('select * from rescue_attempts')).rows as Array<Record<string, unknown>>;
    store.#inner.seed(rules.map(fromRuleRow), attempts.map(fromAttemptRow));
    return store;
  }

  enabledRules(): readonly RescueRule[] {
    return this.#inner.enabledRules();
  }
  rulesFor(accountId: number): readonly RescueRule[] {
    return this.#inner.rulesFor(accountId);
  }
  rule(id: number): RescueRule | undefined {
    return this.#inner.rule(id);
  }
  attempts(ruleId: number): readonly RescueAttempt[] {
    return this.#inner.attempts(ruleId);
  }

  async create(rule: NewRule, nowMs: number): Promise<RescueRule> {
    const r = await this.#pool.query(
      `insert into rescue_rules (account_id, market_id, symbol, position_id, trigger_pct, amount_cns, max_rescues, max_total_cns, min_remaining_cns, cooldown_ms, created_at, armed_by, armed_chat, armed_at, arm_proof)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning *`,
      [rule.accountId, rule.marketId, rule.symbol, rule.positionId, rule.triggerPct, String(rule.amountCNS), rule.maxRescues, String(rule.maxTotalCNS), String(rule.minRemainingCNS), rule.cooldownMs, new Date(nowMs).toISOString(), rule.armedBy ?? null, rule.armedChat ?? null, iso(rule.armedAtMs), rule.armProof ?? null],
    );
    const made = fromRuleRow(r.rows[0] as Record<string, unknown>);
    this.#inner.seed([made], []);
    return made;
  }

  async update(id: number, patch: Parameters<RescueStore['update']>[1]): Promise<RescueRule> {
    const current = this.#inner.rule(id);
    if (current === undefined) throw new Error(`no rescue rule ${id}`);
    const next = { ...current, ...patch };
    await this.#pool.query(
      `update rescue_rules set rescue_count = $2, total_rescued_cns = $3, enabled = $4, paused_reason = $5, last_attempt_at = $6, last_notice = $7, trigger_pct = $8, updated_at = now() where id = $1`,
      [id, next.rescueCount, String(next.totalRescuedCNS), next.enabled, next.pausedReason ?? null, iso(next.lastAttemptAtMs), next.lastNotice ?? null, next.triggerPct],
    );
    return this.#inner.update(id, patch);
  }

  async claim(a: Parameters<RescueStore['claim']>[0]): Promise<boolean> {
    const r = await this.#pool.query(
      `insert into rescue_attempts (rule_id, attempt_no, idempotency_key, account_id, market_id, position_id, trigger_distance_pct, trigger_mark, triggered_at, amount_cns)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
      [a.ruleId, a.attemptNo, a.idempotencyKey, a.accountId, a.marketId, a.positionId, a.triggerDistancePct, a.triggerMark, new Date(a.triggeredAtMs).toISOString(), String(a.amountCNS)],
    );
    if (r.rowCount !== 1) return false;
    await this.#inner.claim(a);
    return true;
  }

  async record(ruleId: number, attemptNo: number, patch: Partial<RescueAttempt>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [ruleId, attemptNo];
    const col: Record<string, string> = {
      sentAtMs: 'sent_at', receiptStatus: 'receipt_status', receiptReason: 'receipt_reason', venueRef: 'venue_ref', outcome: 'outcome',
      marginBeforeCNS: 'margin_before_cns', marginAfterCNS: 'margin_after_cns', appliedCNS: 'applied_cns', distanceAfterPct: 'distance_after_pct', verifiedAtMs: 'verified_at', detail: 'detail',
    };
    for (const [k, v] of Object.entries(patch)) {
      const c = col[k];
      if (c === undefined) continue;
      values.push(k.endsWith('AtMs') ? iso(v as number | undefined) : typeof v === 'bigint' ? String(v) : (v ?? null));
      sets.push(`${c} = $${values.length}`);
    }
    if (sets.length > 0) await this.#pool.query(`update rescue_attempts set ${sets.join(', ')} where rule_id = $1 and attempt_no = $2`, values);
    await this.#inner.record(ruleId, attemptNo, patch);
  }
}

function fromRuleRow(r: Record<string, unknown>): RescueRule {
  return {
    id: Number(r['id']),
    accountId: Number(r['account_id']),
    marketId: Number(r['market_id']),
    symbol: String(r['symbol']),
    positionId: Number(r['position_id']),
    triggerPct: Number(r['trigger_pct']),
    amountCNS: BigInt(String(r['amount_cns'])),
    maxRescues: Number(r['max_rescues']),
    maxTotalCNS: BigInt(String(r['max_total_cns'])),
    minRemainingCNS: BigInt(String(r['min_remaining_cns'])),
    cooldownMs: Number(r['cooldown_ms']),
    rescueCount: Number(r['rescue_count']),
    totalRescuedCNS: BigInt(String(r['total_rescued_cns'])),
    enabled: r['enabled'] === true,
    pausedReason: r['paused_reason'] === null ? undefined : String(r['paused_reason']),
    lastAttemptAtMs: ms(r['last_attempt_at']),
    lastNotice: r['last_notice'] === null ? undefined : String(r['last_notice']),
    createdAtMs: ms(r['created_at']) ?? 0,
    armedBy: r['armed_by'] === null || r['armed_by'] === undefined ? undefined : Number(r['armed_by']),
    armedChat: r['armed_chat'] === null || r['armed_chat'] === undefined ? undefined : Number(r['armed_chat']),
    armedAtMs: ms(r['armed_at']),
    armProof: r['arm_proof'] === null || r['arm_proof'] === undefined ? undefined : String(r['arm_proof']),
  };
}

function fromAttemptRow(r: Record<string, unknown>): RescueAttempt {
  return {
    ruleId: Number(r['rule_id']),
    attemptNo: Number(r['attempt_no']),
    idempotencyKey: String(r['idempotency_key']),
    accountId: Number(r['account_id']),
    marketId: Number(r['market_id']),
    positionId: Number(r['position_id']),
    triggerDistancePct: Number(r['trigger_distance_pct']),
    triggerMark: String(r['trigger_mark']),
    triggeredAtMs: ms(r['triggered_at']) ?? 0,
    amountCNS: BigInt(String(r['amount_cns'])),
    sentAtMs: ms(r['sent_at']),
    receiptStatus: r['receipt_status'] === null ? undefined : String(r['receipt_status']),
    receiptReason: r['receipt_reason'] === null ? undefined : String(r['receipt_reason']),
    venueRef: r['venue_ref'] === null ? undefined : String(r['venue_ref']),
    outcome: r['outcome'] === null ? undefined : (String(r['outcome']) as AttemptOutcome),
    marginBeforeCNS: big(r['margin_before_cns']),
    marginAfterCNS: big(r['margin_after_cns']),
    appliedCNS: big(r['applied_cns']),
    distanceAfterPct: r['distance_after_pct'] === null ? undefined : Number(r['distance_after_pct']),
    verifiedAtMs: ms(r['verified_at']),
    detail: r['detail'] === null ? undefined : String(r['detail']),
  };
}
