# PerpGuard

Real-time risk monitoring for Perpl traders on Monad: liquidation alerts,
stress tests, and a kill switch.

Hackathon deadline: Oct 14 2026, 04:59 GMT+1. Submit by the evening of Oct 13.
Primary track: Onchain Finance & Trading.
Bounties: Perpl API, Perpl Analytics/Risk, Envio, Dynamic, Kimi.

## The problem we solve
Perpl uses ISOLATED MARGIN. Every position has its own collateral, and free
account balance is NEVER pulled in to rescue a losing position. Traders get
liquidated while holding plenty of spare AUSD. PerpGuard watches each position,
warns before liquidation, and lets the user add margin or close in one tap.

## Critical domain facts
- Isolated margin: margin is per position. Adding margin is explicit, per position.
- Collateral is AUSD, 6 decimals (100000000 = 100.0 AUSD).
- NEVER hard-code market IDs, tick sizes or scaling. They differ between
  testnet and mainnet. Load them from `GET /v1/pub/context` at startup.
- Trading requests are signed locally with an Ed25519 API key and sent through
  Perpl's forwarder.
- `mt: 3` with `code: 0` means ACCEPTED FOR FORWARDING ONLY. It is not posted
  and not filled. The real outcome arrives later on `mt: 24`.
  NEVER report success to a user before `mt: 24`.
- API keys can never withdraw or transfer funds out; those need a wallet signature.
- Docs index: https://docs.perpl.xyz/llms.txt — append `.md` to any page URL.
  ALWAYS read the relevant doc page before writing Perpl integration code.
  Do not guess endpoints, field names or message types.

## Networks
- Read-only analytics run against MAINNET (chain 143) so the demo shows real data.
- All trading actions run against TESTNET (chain 10143) with our own wallet.
- Network config comes from env vars, never hard-coded. Both must be selectable.

## Stack
TypeScript everywhere, pnpm workspaces.
- `apps/indexer`  — Envio HyperIndex against the Perpl Exchange contract
- `apps/backend`  — Node + Fastify: market feed, risk engine, alerts, actions, API
- `apps/bot`      — Telegram bot (grammY)
- `apps/web`      — Next.js App Router, Tailwind, dark mode
- `packages/shared` — config, types, units, Perpl client, venue adapters
Postgres. Kimi API for AI. Dynamic SDK for login.

## Rules
- Venue-specific code lives ONLY in `packages/shared/src/venues/`. The risk
  engine, bot and web use the `Venue` interface, never Perpl directly.
- Secrets only via environment variables. Never log or print keys.
- Risk maths must be pure functions with unit tests. No I/O inside them.
- AI output must be validated against a schema. AI NEVER triggers a trade.
  It suggests; the user confirms.
- Every action gets an idempotency key and a row in `action_log`.
  One in-flight action per position.
- Never act on price data older than `STALE_MS`. Show staleness in the UI.
- Prefer small, tested modules over large files.

## Working style
- Plan before writing code for anything non-trivial. Show me the plan first.
- Run what you write. Don't say "this should work" — execute it and show output.
- When a Perpl detail is unclear, read the doc page rather than guessing.
- Commit after each working step.

## Current phase
Day 1 (Sep 26): foundations, read-only. No trading code yet beyond the
test-order script.
