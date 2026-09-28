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
- Orders self-expire fast. `order_ttl_blocks` is a per-market field on
  `GET /v1/pub/context`; it is 20 (~10s) on testnet BTC, and currently 20 on
  every market in both context fixtures. An order's last block `lb` may be no
  more than `head_block + market.order_ttl_blocks`. Read it per market, never
  hard-code it. Resting-order logic must treat expiry as normal: a resting
  order is gone within seconds unless re-posted, so never assume an order we
  placed is still live, and re-check before cancelling or amending.
- A cancel of an order that has already expired or is otherwise gone may never
  produce an `mt: 24` at all. So a cancel timeout is NOT a failure and NOT a
  success: the executor must treat it as "reconcile against order history" —
  look up what actually became of the order id — and report the reconciled
  state. It must NEVER blind-retry a cancel with a new request id: the original
  cancel may still land, and a second `rq` against a filled or re-used order id
  is a new action, not a retry of the old one.
- Order updates are keyed by `oid`, the wide globally-unique order id, NOT by
  `id`. The docs render `mt: 24` entries as `{ id, st, sr, r }`, but the wire
  sends `oid` plus `scid`, the short per-contract id the explorer and
  perpl-cli display. Address cancels and amends to `oid`; read outcomes by
  `oid`. Reading `id` silently matches nothing, which looks exactly like a
  timeout.
- Order rejection reasons (`sr`) worth handling by name:
  `sr 34` = OrderForwardingNotAllowed — the account's `fw` flag is false, so
  the account does not permit API-key-forwarded orders. Check `fw` from the
  account snapshot and say so before submitting rather than after.
  `sr 15` = ForwardingReverted — the on-chain forwarding transaction reverted.
- The Exchange is a PROXY on both networks. Index the proxy address; events are
  emitted by the proxy, never by the implementation.
  - testnet `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` -> impl `0xbcbd3701...adbb`
  - mainnet `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` -> impl `0xa9ab97a4...791b2a`
  Both report `getContractVersion()` 1.7.5.
- The saved ABI is a snapshot taken from the TESTNET build, not a guarantee, and
  mainnet has drifted from it. 14 of its 204 event topics are absent from the
  deployed mainnet implementation, and all 14 are the V1 forms of events that now
  have a V2: `PositionOpened`, `PositionIncreased`, `PositionDeleveraged`,
  `PositionUnwound`, `PositionUnwoundWithoutPayment`, `MakerOrderFilled`,
  `TakerOrderFilled`, `OrderRequest`, `ContractAdded`, plus `MakerFeeUpdated`,
  `TakerFeeUpdated`, `RecycleFeeToAccount`, `AdminChanged`, `BeaconUpgraded`.
  Read the V2 forms for anything current, and keep the V1 forms decodable: mainnet
  history still contains them, and 5 of the 9 live markets were listed with V1
  `ContractAdded` rather than `ContractAddedV2`. 16 function selectors are likewise
  absent (`execOrder*`, `liquidation*`, `execFwdPositionOps*`, `getPerpetualInfo`,
  `setAccountFeeTiers`) — do not call those on mainnet off this ABI.
  See `apps/indexer/abis/README.md` for provenance and
  `apps/indexer/docs/EVENTS.md` for every event and what it means.
- `positionType` on every position event is `0` = LONG, `1` = SHORT. Measured over
  496 real mainnet round trips, not inferred from the field order.
- `createAccount(uint256)` takes the OPENING DEPOSIT in AUSD micros, not an id.
  The minimum differs per network and is enforced on chain as
  `InsufficentAmountToOpenAccount`: mainnet 10000000 (10 AUSD), testnet
  100000000 (100 AUSD). Read it with `getMinAccountOpenCNS()`; never assume.
  It pulls the collateral with `transferFrom`, so it needs an ERC-20 approve to
  the Exchange first or it reverts.
- Forwarding is NOT set at account creation. The account owner enables it with
  a separate wallet transaction, `allowOrderForwarding(true)`. New accounts
  have it OFF. An API key cannot do this — it needs the owner's wallet.
- There is NO on-chain getter for the forwarding flag. Read `fw` from the API's
  `mt: 21` account snapshot. The indexer can only track it by watching
  `OrderForwardingUpdated(accountId, bool)` events and assuming false until one
  appears.
- `getAccountCreationInfo()` does not exist on this contract.
- PRE-FLIGHT: before submitting any order or collateral action, check `fw` from
  the `mt: 21` snapshot. When it is false, fail fast with a message naming
  `allowOrderForwarding(true)` and the owner wallet — do not submit and eat an
  `sr 34`. This lives in the executor path (`PerplVenue.#execute`) so every
  action inherits it; never re-implement it per action.
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
  - AMENDMENT, for `apps/indexer` only: an indexer is a venue-specific DATA
    SOURCE, not a consumer, so it is allowed to speak Perpl directly — it indexes
    the Perpl Exchange contract and nothing else could. The line holds one step
    later instead: nothing downstream reads the indexer's GraphQL directly.
    The bot, web and risk engine go through a venue-agnostic analytics interface
    in `packages/shared`, so no consumer ever learns the word `perpId`.
- Secrets only via environment variables. Never log or print keys.
- Risk maths must be pure functions with unit tests. No I/O inside them.
- AI output must be validated against a schema. AI NEVER triggers a trade.
  It suggests; the user confirms.
- Every action gets an idempotency key and a row in `action_log`.
  One in-flight action per position.
- Monitoring and actionability are SEPARATE. A market we can watch is not
  always a market we can act on: the two networks do not list the same
  markets (HYPE and VVV are mainnet-only), and markets can close. Ask the
  ACTING venue `getActionAvailability(symbol)`. When it says no, keep
  monitoring, keep alerting, and render the action buttons disabled with the
  returned reason shown. NEVER hide the position, silently drop the alert, or
  route the action to the analytics network instead. This is a permanent
  product rule, not a demo workaround — a trader whose venue has halted a
  market is exactly the trader who most needs the warning.
- Connection health and price age are SEPARATE questions, and `isStale` alone
  must never gate an action. On Perpl a mark price only changes when it moves,
  so a market nobody has traded for a minute has a minute-old price that is the
  venue's current truth. That is a QUIET MARKET, not a broken feed.
  - Ask the feed `feedStatus()` for connection health: `connected` /
    `reconnecting` / `disconnected`.
  - Ask `lastUpdate` / `ageMs` for how old one market's price is.
  - REFUSE TO ACT when the feed is not `connected`. Every price we hold is then
    frozen at whatever it was when the connection died, and the real market may
    have moved arbitrarily far since. Age cannot detect this — for the first
    few seconds a frozen price looks exactly like a fresh one.
  - KEEP WORKING NORMALLY on a quiet market whose price is merely old. Show the
    age; do not block on it, and never render a quiet market as a broken feed.
  - `STALE_MS` labels a price as old for the UI. It is not an action gate.
  Use `MarketFeed.canAct(marketId, feedStatus())`, which encodes exactly this.
- When the feed is down, keep monitoring, keep the last known state visible,
  and say plainly that the feed is down. A risk monitor that has gone blind
  must never look healthy — that is the same principle as the action
  availability rule above: the trader whose data we have lost is the one most
  exposed.
- Prefer small, tested modules over large files.

## Working style
- Plan before writing code for anything non-trivial. Show me the plan first.
- Run what you write. Don't say "this should work" — execute it and show output.
- When a Perpl detail is unclear, read the doc page rather than guessing.
- Commit after each working step.

## Current phase
Day 1 (Sep 26): foundations, read-only. No trading code yet beyond the
test-order script.
