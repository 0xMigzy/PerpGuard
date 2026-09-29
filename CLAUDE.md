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

THE NUMBER WE QUOTE IS `rescuableLiquidationCount`: 463 of the 622 mainnet
liquidations we can judge, 74%, where the trader's free AUSD would have covered
the top-up that kept the position above maintenance margin. Quote it with its
hole — 32 liquidations are of positions opened before the indexer's start block
and cannot be judged, so they are excluded from the denominator, never counted
as failures.

NEVER quote `liquidationsWithSpareBalanceCount` or `hadSpareBalance` as a
headline. That flag is `freeBalanceBeforeCNS > 0`, so it counts dust: it is true
for 654 of 654 mainnet liquidations, the smallest balance being 0.00024 AUSD and
137 of them under 1 AUSD. 100% reads as a broken indexer, not as a finding. It
stays in the schema as a DIAGNOSTIC for reading one liquidation, and that is all.

## Critical domain facts
- Isolated margin: margin is per position. Adding margin is explicit, per position.
- `liqBufferPct` is SIGNED, not absolute. Negative means the position is already
  PAST its liquidation price. `abs()` makes a doomed position sort as the safest
  thing in the book — never reintroduce it. The UI renders a negative buffer as
  "past liquidation", never as a negative percentage.
- Reducing a position with proportional margin release leaves the liquidation
  price EXACTLY unchanged: size, margin, funding and the maintenance requirement
  all scale by the same factor and it cancels. Only adding margin, or keeping
  margin while reducing, buys room.
- Collateral is AUSD, 6 decimals (100000000 = 100.0 AUSD).
- NEVER hard-code market IDs, tick sizes or scaling. They differ between
  testnet and mainnet. Load them from `GET /v1/pub/context` at startup.
- MARKET IDENTITY IS THE MARKET ID, NEVER THE NAME. The market id is the only
  key shared by the contract, the indexer and the API; names disagree across
  them. Mainnet market 31 is `SOL` in the context's `size_units` and `SOL_v2`
  on chain, which is what the indexer stores. So anything joining indexer data
  to venue data joins on the market id and takes the canonical ticker from the
  context, the way `toVenueMarket` already does. Matching on a name silently
  drops that market.
- A MARKET BEING LISTED ON CHAIN DOES NOT MAKE IT VISIBLE IN THE API. The
  indexer sees 10 markets listed on mainnet; `GET /v1/pub/context` returns 9.
  Market 80 (TAO) is listed on chain, has real scaling and zero open positions,
  and the API does not mention it. Anything user-facing — symbols, prices,
  action availability — follows the CONTEXT, not the chain. The chain is the
  history; the context is what a trader can see and touch today.
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
- THE ACCOUNT STREAM'S `sn` IS THE BLOCK NUMBER, and it is ADVANCED BY
  HEARTBEATS ONLY. Measured, not assumed: `sn == at.b` in all 5 frames of
  `fixtures/positions-testnet.json`, and `sn == h` on 327 of 327 live
  heartbeats.
  - A heartbeat (`mt: 100`) lands on EVERY block, so expecting `sn` to advance
    by exactly `+1` per heartbeat is correct: 326 of 326 consecutive intervals
    were `+1` over a 100s window, 327 beats, no gap. Monad's ~300ms blocks are
    the cadence.
  - Every frame from the same block SHARES that block's `sn`. At sign-in
    `mt: 19` (WalletSnapshot), `mt: 23` (OrdersSnapshot) and `mt: 26`
    (PositionsSnapshot) all arrive carrying one `sn` — 66448894 in the first
    capture, 66605626 and 66605929 in two later ones. Snapshots and `mt: 27`
    updates never advance it. A gap detector that expects every frame to
    advance `sn` therefore fires constantly against a perfectly healthy socket.
  - `mt: 2`, THE PONG, CARRIES ITS OWN UNRELATED COUNTER: measured as `sn` 1,
    2, 3 across three pings, with no `h` and no `at`. It is not a block number
    and not part of the stream sequence, so tracking `sn` off it computes a gap
    of tens of millions against a healthy socket. Same reason proof-of-life
    must ignore replies, as the market-data feed already does.
  - So track `sn` off `mt: 100` only, with the sign-in `mt: 19` as the
    baseline. Re-measure any of this with `scripts/probeHeartbeatSn.ts`.
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
  history still contains them, and only 4 of the 10 live markets were listed with
  `ContractAddedV2` at all — the other 6 used V1 `ContractAdded`, and none of the
  listings fall inside a recent start window, so `apps/indexer` reads a market's
  scaling off the contract rather than relying on either event being in range.
  16 function selectors are likewise
  absent (`execOrder*`, `liquidation*`, `execFwdPositionOps*`, `getPerpetualInfo`,
  `setAccountFeeTiers`) — do not call those on mainnet off this ABI.
  See `apps/indexer/abis/README.md` for provenance and
  `apps/indexer/docs/EVENTS.md` for every event and what it means.
- `positionType` on every position event is `0` = LONG, `1` = SHORT. Measured over
  496 real mainnet round trips, not inferred from the field order.
- TWO DIFFERENT SIDE ENCODINGS LIVE IN THIS REPO, AND `1` MEANS OPPOSITE THINGS
  IN THEM. Contract events (what `apps/indexer` reads) use `positionType`
  `0` = LONG, `1` = SHORT. The API wire (what the venue adapters read) uses `sd`
  `1` = Long, `2` = Short, with `0` = Unspecified. Both measured, the second off
  a real testnet position.
  - `sideOf()` in `apps/indexer/src/lib/scale.ts` is for CONTRACT EVENTS ONLY.
    Never point it at wire data: it would read `sd: 1` as SHORT.
  - An unrecognised value THROWS. It never defaults to long. A silently
    inverted position is a risk tool telling someone to add margin when they
    are short the other way — worse than no tool at all.
- The Perpl `Position` wire object is NOT DOCUMENTED — `types-and-errors.md`,
  `rest.md` and `websocket.md` circular-reference each other for it. The shape
  was read off the wire and is recorded in `fixtures/positions-testnet.json`
  and `docs/evidence.md`; `scripts/probePositions.ts` re-captures it. Key
  fields: `pid` position id (the `lp` a close is addressed to), `sd` side,
  `st` status, `s` size, `ep` entry price, `xp` exit price (CLOSE ONLY),
  `c` isolated margin, `lv` leverage hundredths, `dpnl` realized PnL,
  `fnd` funding. There is no mark price and no liquidation price on a
  position: both are ours to compute.
  - `c`, `fee`, `dpnl`, `fnd` and friends are AUSD `Amount` DECIMAL STRINGS.
    Parse them exactly — never `Number()`. The docs say so and money maths in
    this repo is integer-only anyway.
  - A SNAPSHOT IS NOT AN UPDATE. The same position in `mt: 26` carries
    `sr: 0` Unspecified, an empty `at: {}` and no `e[]` history; the `mt: 27`
    update carries the real reason. Never read a reason off a snapshot.
  - A CLOSED POSITION IS STILL DELIVERED, as a row with `st: 2` and `s: 0` —
    not as an omission. Drop anything whose `st` is not `1`; that is also the
    right handling for the forced exits (3 Liquidated, 4 Deleveraged,
    5 Unwound), whose exact field shapes we have NOT observed and must not
    assume.
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
- ONE NETWORK PER RISK LOOP, ENFORCED AT CONSTRUCTION. A position and the mark
  price it is assessed against MUST come from the same network. This is a rule,
  not a convention, and it is checked in code rather than left to care: both
  networks list BTC, so a testnet position priced off a mainnet mark produces
  entirely wrong numbers that look completely plausible — a liquidation price,
  a buffer percentage and an alert, all confidently derived from two unrelated
  markets. Nothing about the output would look off. Mixing must be impossible
  to express, not merely discouraged.

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
