-- The alert_log table.
--
-- ONE ROW PER ATTEMPT SEQUENCE, not per attempt and not per decision. A
-- suppressed alert writes nothing: cooldown alone suppresses most ticks, and a
-- row each would bury the rows that matter under thousands saying "working as
-- intended". What is here is every alert we actually tried to deliver, and
-- whether it arrived.
--
-- Cooldown state is NOT here. It lives in memory, so a restart may re-alert a
-- position once — the right failure direction, since the alternative is a
-- cooldown surviving a restart and swallowing the first DANGER after it. Noted
-- as a known limitation in docs/evidence.md.
--
-- Idempotent: safe to run on every boot.

create table if not exists alert_log (
  id              bigserial   primary key,

  -- market:state:assessment-timestamp. Not a cryptographic key — it is here so a
  -- human reading the table can tell two alerts apart, and so a re-delivery of
  -- the same assessment after a restart is recognisable as one.
  alert_key       text        not null,

  user_id         text        not null,

  -- MARKET IDENTITY IS THE MARKET ID, NEVER THE NAME (CLAUDE.md). The symbol is
  -- stored alongside for readability only; nothing joins on it.
  market_id       integer     not null,
  symbol          text        not null,

  kind            text        not null,
  -- RiskState, including FEED_DOWN and POSITIONS_UNTRUSTED, which are the absence
  -- of a severity rather than one. Deliberately not an enum type: the set is
  -- defined in TypeScript and a migration lagging behind it must not start
  -- rejecting writes of real alerts.
  state           text        not null,
  previous_state  text,

  message         text        not null,
  -- AlertAction[]. amountCNS is serialised as a STRING: AUSD micros exceed
  -- float64's exact range and jsonb numbers are float8, so a bigint written as a
  -- JSON number would round.
  actions         jsonb       not null default '[]'::jsonb,

  attempts        integer     not null check (attempts >= 1),
  outcome         text        not null check (outcome in ('delivered', 'failed')),
  last_error      text,

  created_at      timestamptz not null,
  delivered_at    timestamptz,

  -- Says what the two outcomes mean, so a half-written row cannot claim both.
  constraint alert_log_outcome_consistent check (
    (outcome = 'delivered' and delivered_at is not null) or
    (outcome = 'failed' and delivered_at is null)
  )
);

-- "What has this position been told, and when" — the read behind a cooldown
-- audit and behind the UI's per-position alert history.
create index if not exists alert_log_market_created_idx
  on alert_log (market_id, created_at desc);

-- Partial, because the interesting question is only ever about the failures.
create index if not exists alert_log_failed_idx
  on alert_log (created_at desc)
  where outcome = 'failed';
