-- The action_log table: every action PerpGuard tried to send, and what became of it.
--
-- TWO WRITES PER ACTION, not one. The row is inserted BEFORE the action is sent
-- and updated once the position has been looked at again. That ordering is the
-- point of the table: the row that matters most is the one that never gets its
-- settlement, because that is the action whose process died between sending and
-- answering — and it only exists to be found if it was written first.
--
-- WHAT THE VENUE SAID AND WHAT HAPPENED ARE DIFFERENT COLUMNS. `reported_status`
-- is the venue's own answer, kept verbatim; `outcome` is what the position
-- showed. For `t: 6` IncreasePositionCollateral these routinely DISAGREE: the
-- venue reports `st: 7 Failed, sr: 32 OrderDescIdTooLow` while the collateral is
-- credited in full, measured four times across three testnet runs (see
-- docs/evidence.md). A table with one status column would have to pick one, and
-- either choice loses the evidence.
--
-- Idempotent: safe to run on every boot.

create table if not exists action_log (
  id                bigserial   primary key,

  -- One per attempt. NOT a retry token: nothing in this codebase looks a key up
  -- to resume or replay an action. It is here so a human can find a row, and so
  -- a duplicate submission is visible after the fact.
  idempotency_key   text        not null unique,

  user_id           text        not null,

  -- 'add-margin' | 'reduce-position' | 'close-position'. Deliberately not an
  -- enum type: the set is defined in TypeScript, and a migration lagging behind
  -- it must not start rejecting writes of real actions.
  kind              text        not null,

  -- MARKET IDENTITY IS THE MARKET ID, NEVER THE NAME (CLAUDE.md). The symbol is
  -- stored for readability only; nothing joins on it.
  market_id         integer     not null,
  symbol            text        not null,

  -- `lp` on the wire. Never null on a sent action: isolated margin means the
  -- action names one position, and one with no id is refused before it is sent.
  -- BIGINT: a testnet pid is 4386927738881, past int32, and the first web
  -- top-up was refused by Postgres on exactly that before anything was sent.
  position_id       bigint,

  -- Which network this action went to. Analytics reads mainnet and actions run on
  -- testnet, so a row without this cannot be read safely a month later.
  network           text        not null,

  -- 'margin' for a top-up, 'size' for a reduce or close: which number below is
  -- being compared, and therefore what units they are in (AUSD micros or lots).
  watched_field     text        not null check (watched_field in ('margin', 'size')),

  -- numeric, not bigint: AUSD micros and lot counts are exact integers that can
  -- exceed 2^63 in principle, and numeric holds them without rounding. Never
  -- float8 — that is the same mistake as putting an Amount in a JSON number.
  requested         numeric     not null,
  before_value      numeric     not null,
  after_value       numeric,

  -- What the position showed: 'applied' | 'not-applied' | 'unknown' | 'refused'.
  -- 'refused' means it was never sent, which is a different fact from
  -- 'not-applied' — we sent it and the position did not move. Null until settled.
  outcome           text        check (outcome in ('applied', 'not-applied', 'unknown', 'refused')),

  -- The venue's own answer, verbatim, including the 'rejected' that means a
  -- top-up worked.
  reported_status   text,
  reported_reason   text,
  venue_ref         text,

  -- The sentence a human reads. Always written with the settlement.
  detail            text,

  opened_at         timestamptz not null,
  settled_at        timestamptz,

  -- A settled row has all four settlement fields or none of them, so a
  -- half-written row cannot claim an outcome it has no account of.
  constraint action_log_settled_together check (
    (settled_at is null and outcome is null and detail is null) or
    (settled_at is not null and outcome is not null and detail is not null)
  )
);

-- Widen a table created before position_id was bigint. A no-op once it is.
alter table action_log alter column position_id type bigint;

-- "What has been sent to this position, and when" — the read behind the UI's
-- per-position action history and behind any reconciliation by hand.
create index if not exists action_log_market_opened_idx
  on action_log (market_id, opened_at desc);

-- THE MOST IMPORTANT INDEX HERE. Unsettled rows are actions nobody can account
-- for, and rows whose outcome is 'unknown' are actions that need human eyes.
-- Partial, because those are the only rows worth scanning for.
create index if not exists action_log_needs_attention_idx
  on action_log (opened_at desc)
  where settled_at is null or outcome = 'unknown';
