# PerpGuard

Real-time risk monitoring for Perpl traders on Monad: liquidation alerts,
stress tests, and a kill switch.

Hackathon deadline: Oct 14 2026, 04:59 GMT+1. Submit by the evening of Oct 13.
Primary track: Onchain Finance & Trading.
Bounties: Perpl API, Perpl Analytics/Risk, Envio, Kimi. (Dynamic was dropped
for RainbowKit on 6 Oct 2026: no Dynamic origin could be set for perpguard.app.)

## The problem we solve
Perpl uses ISOLATED MARGIN. Every position has its own collateral, and free
account balance is NEVER pulled in to rescue a losing position. Traders get
liquidated while holding plenty of spare AUSD. PerpGuard watches each position,
warns before liquidation, and lets the user add margin or close in one tap.

THE NUMBER WE QUOTE IS `rescuableLiquidationCount`, ALWAYS WITH ITS WINDOW:
2,318 of 3,463 mainnet liquidations (66.9%) since Perpl launched on 11 Feb
2026, and 467 of 637 (73.3%) over 30 days (`docs/liquidation-finding-2026-10-01.md`)
— liquidations where the trader's free AUSD would have covered the top-up that
kept the position above maintenance margin. Nothing is excluded: the index runs
from the Exchange's deployment block, so every liquidation can be judged. If a
position ever predates the index again, it is excluded from the denominator,
never counted as a failure.

NEVER SUM A PER-ACCOUNT LEVEL ACROSS LIQUIDATIONS. Free balance is a level an
account holds, not a flow; summing it over liquidations counts the same money
once per liquidation (#4734: 23 rescuable, its balance counted 23 times; the
"7.38M AUSD spare" tile was this). Sum across ACCOUNTS, or use a per-event
ratio: the cover ratio, the median of free balance / shortfall across
rescuable liquidations (187x over 2,344, full history, 4 Oct 2026). The
indexer's `spareBalanceAtLiquidationCNS` running totals are that same sum and
are never served.

MARGIN LOST IS NOT MONEY DESTROYED. `marginLostCNS` is the drop in the
position's deposit, and the event credits part of it straight back to the
account (`accAmountCNS`, 26% in a sample of 40; emitted, NOT stored by the
indexer). The Liquidations hero, "Potentially avoidable losses", is realised
loss (PnL + funding) summed over rescuable liquidations: once per event,
excludes liquidation fees, so it understates. Never word it as money the trader
would have kept: a top-up keeps the position open, it does not undo the price
move. See `docs/notes/accamount-finding-2026-10-05.md`.

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
- TOP-UP AMOUNTS ALWAYS ROUND UP to the displayed precision, never down. A
  rounded-down amount prints a figure that does not reach the stated buffer. The
  action's `amountCNS` carries the SAME ceiled figure the text showed, so the
  button sends exactly what the user read. The projected buffer and liquidation
  price quoted alongside are for the exact unrounded amount, so the ceiled action
  lands marginally BETTER than stated — understating the benefit is the safe
  direction, and the only one available once the figure is rounded at all.
- NEVER hard-code market IDs, tick sizes or scaling. They differ between
  testnet and mainnet. Load them from `GET /v1/pub/context` at startup.
- ADDRESSES ARE COMPARED CASE-INSENSITIVELY, EVERYWHERE, ALWAYS. Lowercase both
  sides of every comparison: `lower(owner) = $1` in SQL, `a.toLowerCase() ===
  b.toLowerCase()` in TypeScript. Never store a checksummed address and compare
  it to a lowercased one.
  - WHY THIS IS A RULE AND NOT A PREFERENCE: it fails SILENTLY. `Trader.owner`
    holds the address exactly as the event gave it, which on mainnet is
    mixed-case EIP-55 — `0xB7854953A71e45D1033B3d619E76d56391291765`. A lookup
    that lowercased its input and compared exactly matched NOTHING, and the
    result was indistinguishable from the correct answer, because "no account is
    linked to this address" is the ORDINARY reply: 1366 of 1556 mainnet accounts
    have no owner recorded. Found only because a live script printed no profile
    for an address it had itself just selected as linked.
  - It will recur the moment someone pastes a checksummed address into a wallet
    search, which is how every block explorer hands an address to a user.
- MARKET IDENTITY IS THE MARKET ID, NEVER THE NAME. The market id is the only
  key shared by the contract, the indexer and the API; names disagree across
  them. Mainnet market 31 is `SOL` in the context's `size_units` and `SOL_v2`
  on chain, which is what the indexer stores. So anything joining indexer data
  to venue data joins on the market id and takes the canonical ticker from the
  context, the way `toVenueMarket` already does. Matching on a name silently
  drops that market.
  - THE ACTION PATH TOO (fixed 7 Oct 2026). Every `ActionRequest` carries
    `marketId`; `getActionAvailability({ marketId, symbol })` and the frame's
    market resolve BY ID, the symbol only words the reason. Until then the
    venue looked the market up by symbol, so a live position on retired SOL
    30 would have been called actionable and its top-up, reduce or close
    addressed to SOL_v2 31. `MarketFeed` has no symbol index (it was
    last-writer-wins). Name lookups that remain are deliberate: an operator's
    typed `--symbol` in a script, resolved once against the current context,
    and cross-VENUE matching (Hyperliquid/Binance funding: ticker AND price),
    where no shared id exists.
- A MARKET BEING LISTED ON CHAIN DOES NOT MAKE IT VISIBLE IN THE API. On
  3 Oct 2026 the chain lists 17 markets on mainnet and `GET /v1/pub/context`
  returns 11 (BTC, MON, ETH, SOL, HYPE, ZEC, LIT, VVV, PUMP, NEAR 100, UNI 110
  — UNI was listed on chain on 30 Sep and is open). The six the context omits:
  ARB 120, AAVE 130, MORPHO 140 and ENA 150 (listed 30 Sep, paused, never
  traded), TAO 80 (listed 20 Aug, not paused, never traded) and SOL v1 30
  (retired: 127,499 trades, replaced by SOL_v2 31). Anything user-facing —
  symbols, prices, action availability — follows the CONTEXT, not the chain.
  The chain is the history; the context is what a trader can see and touch
  today.
  - THE ONE PLACE THE CHAIN SHOWS THROUGH is the Markets table's UPCOMING
    rows (`upcomingRows` in `apps/web/src/lib/markets.ts`): listed on chain,
    absent from the context, NEVER TRADED. Same table as the live markets, with
    a Status column; the contract's own symbol, the contract's last mark
    labelled "contract mark", "—" (never 0, sorted last) for every venue
    figure, and the contract's parameters in the row's detail. No opening date.
    A market the context omits that HAS traded is retired and is not shown
    anywhere on the page. The rule reads the data.
  - THE ONE NAMED EXCEPTION is `EXCLUDED_MARKETS` in the same file: mainnet
    80, TAO, off every page at the owner's request (4 Oct 2026). An explicit
    list with a reason per entry, never a rule, so nothing else can be dropped
    by accident. Delete the entry to bring it back.
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
- ADDING MARGIN REPORTS FAILURE AND APPLIES ANYWAY. `t: 6`
  IncreasePositionCollateral comes back `st: 7 Failed, sr: 32 OrderDescIdTooLow`
  on `mt: 24` while the collateral IS credited, by exactly the amount sent.
  Measured 4 times across 3 testnet runs (rq 12, 15, 16, 19), every one rejected,
  every one applied to the micro. The request id was never stale — it was the
  correct `lfr + 1` each time — so `OrderDescIdTooLow` does not mean what it says
  for this order type, and `lfr` advances on the "failed" request regardless.
  - So THIS IS THE ONE ACTION WHOSE OUTCOME IS NOT `mt: 24`. Reconcile it
    against the POSITION'S `c` (margin) before and after; that is the only field
    that says whether the collateral landed.
  - NEVER RE-SEND ON THE REPORTED FAILURE. Doing exactly that during the
    investigation ADDED THE MARGIN TWICE — 0.0559 -> 0.083584 -> 0.111268 AUSD.
    On mainnet that is a trader's collateral committed twice over because the
    venue said it had failed. Same rule as a cancel timeout, for the same reason.
  - And never report the failure to the user either: telling someone their
    rescue failed when it worked is how they double it by hand.
  See `docs/evidence.md` and `pnpm risk:live`.
- THE `sr 32` LIE IS SPECIFIC TO `t: 6`. `t: 3`/`t: 4` CloseLong/CloseShort report
  their outcome TRUTHFULLY on `mt: 24`: `st: 4 Filled, sr: 43 TakerOrderFilled` on
  all three measured round trips, in about a second. So do not generalise the
  top-up's behaviour to every order type — but do keep reconciling against the
  position anyway, because "has told the truth so far" is not a guarantee.
  - A REDUCE KEEPS THE POSITION'S `pid`, and releases margin IN PROPORTION: `c`
    166576 -> 111051 on a 3-unit position reduced to 2, with `ep` unchanged. That
    is the arithmetic behind the rule that a proportional reduce leaves the
    liquidation price exactly where it was. `mt: 27` carries `st: 1 Open,
    sr: 14 PositionDecreased`; a full close carries `st: 2 Closed, sr: 13`.
  - See `fixtures/close-probe-testnet.json` and `pnpm close:probe`.
- `mt: 3` WITH `code: 0` DOES NOT MEAN THE REQUEST REACHED THE CONTRACT. The
  testnet forwarder drops requests: two of three opens produced an `mt: 3` code 0
  and then no `mt: 24` at all. `lfr` IS THE DISCRIMINATOR — it advances even on a
  request the contract REJECTS (every `sr 32` top-up moved it), so `lfr`
  unchanged after an `mt: 3` means the frame never landed on chain and its `rq`
  is still unconsumed. Reconcile with it; never retry on the `mt: 3` alone.
- NEVER BLIND-RETRY; RETRYING AFTER RECONCILIATION IS CORRECT. These are not in
  tension. A blind retry re-sends on the strength of a reported failure, which
  for `t: 6` is wrong and adds the margin twice. A retry after reconciliation is
  a fresh action taken once the POSITION has been read and shown not to have
  moved — nothing landed, so nothing can land twice. The bot offers "Send again"
  on a reconciled `not-applied` and NEVER on `unknown`, where something may have
  landed. A trader whose rescue silently vanished with no way to resend is worse
  off than one we never alerted: they think they are covered.
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
- `getPerpetualInfoV2(perpId)` DOES answer on mainnet (and so does the V1
  form, despite the ABI note above), and it is the only source of a market's
  INSURANCE FUND LEVEL: `insuranceBalanceCNS` is word 11 of the reply,
  `positionBalanceCNS` word 10, `markPNS` word 12, long/short open interest
  words 18/19 (the tuple-offset word is 0; the two leading strings are
  offsets, so every static member sits at a fixed word). Decoded by index in
  `packages/shared/src/venues/perpl-insurance.ts` and pinned against a
  captured reply. The indexer sees credits to the fund, never its balance.
- Docs index: https://docs.perpl.xyz/llms.txt — append `.md` to any page URL.
  ALWAYS read the relevant doc page before writing Perpl integration code.
  Do not guess endpoints, field names or message types.

## Numbers on the way out
- FEES ARE MAKER PLUS TAKER, EVERYWHERE. One definition: the sum of
  `MarketDay.feesCNS` over whole UTC days, bound to a DAY boundary and served
  with the range it covers (`FeesForPeriod.label`), on the protocol figure and
  on every per-market row alike. Taker fees have no timestamp finer than the
  day bucket, so this is the only exact total there is. The rolling maker half
  is served under its own name, `makerFeesAusd`, and is NEVER called "fees":
  it is a third of the real figure and looks like the whole.
- RATIOS ARE WITHHELD BELOW `MIN_ROUND_TRIPS_FOR_RATIOS` = 10 ROUND TRIPS.
  Win rate and profit factor come back undefined under the floor, on the
  profile and on the traders list; the counts and the history are still served
  in full and every payload that withholds carries the floor it used. Three
  trades and two wins is 66.7%, and it means nothing. The constant lives in
  `packages/shared/src/analytics/types.ts` and nowhere else.
- EVERY DERIVED STATISTIC CARRIES ITS DENOMINATOR: a rate is rendered as
  "x of y", a share names what it is a share of, a window says which days it
  covers. A figure that cannot honour the section's timeframe says which
  window it used instead (fees: UTC days; trader windows: TraderDay buckets;
  open interest and TVL: levels, now). VISIBLE LABELS SHOW THE WINDOW THE
  READER PICKED ("30 days"); the exact whole-UTC-day span ("the 31 UTC days
  from 2026-09-06") is on the label's hover (6 Oct 2026, owner's request).
  A trader's "N UTC days" was the days it was ACTIVE, never the window.
- SKEW IS MARGIN AT RISK OR HEADCOUNT, NEVER NOTIONAL. On an order-book perp
  notional skew is IDENTICALLY 50/50 BY CONSTRUCTION: every long lot was
  matched against a short lot, so open size per side is equal on every market
  and size × mark is equal whatever the mark. The site showed exactly 50.0% on
  every market until 3 Oct 2026, and it read as a default, not a finding.
  Proof, mainnet block 110,176,799 (`fixtures/open-positions-mainnet.json`):
  BTC 887,454 lots long and 887,454 short, across 153 long and 112 short
  positions. Skew is `longShareOfMargin` (isolated margin per side, which
  varies because the sides run different leverage) with the headcount beside
  it; `skew.test.ts` asserts the equality and keeps a notional share out of
  the served type. The crowding threshold (70% of margin, funding paying that
  side) was re-derived for margin; see `docs/methodology.md`.
- A ROUND TRIP'S RESULT IS BEFORE FEES, AND SAYS SO (7 Oct 2026). The
  indexer never writes `Position.feesCNS`, so `Position.netPnlCNS` is realised
  plus funding only, and everything built on it is BEFORE trading fees: wins,
  losses and win rate (`Trader`/`TraderDay` count them off `isWin`), best and
  worst round trip, profit factor, max drawdown and streaks, per-market
  results, the insights' long/short split, the round-trip list. Account net
  P&L, ROI and Top PnL come from `Trader`/`TraderDay`, which DO include maker
  and taker fees. Every before-fees figure is labelled "before fees" where it
  is shown (profile, Traders list, Compare, insights, bot trader card); the
  Liquidations hero says it leaves out trading and liquidation fees.
- ORDER BY THE NUMERIC COLUMN, NEVER A `::text` OUTPUT ALIAS. Money columns
  are selected as text so node-pg cannot round them, and Postgres resolves a
  bare name in ORDER BY against the output list first — `order by net_pnl`
  sorted +99 above +911 on the live traders list. Sort maps name the source
  column and `pg.test.ts` pins them.

## The web app
- INDEXED ANSWERS ARE SERVED FROM A STALE-WHILE-REVALIDATE CACHE, AND SAY HOW
  OLD THEY ARE. A 30-day `/metrics` is five aggregate scans over millions of
  fill rows (3.6s measured; the timestamp index cannot help when the window is
  the whole table), so every indexed route serves its last computed answer at
  once and refreshes behind the reader past a 20s TTL (`SwrCache` in
  `apps/backend/src/server/responseCache.ts`); the indexer-health verdict is
  cached 2s. The envelope carries `computedAtMs`, `ageMs` and `revalidating`,
  and the page says "computed Ns ago" past 45s. Never cache without the age:
  a snapshot presented as the present is the same lie as a frozen price. The
  default views are warmed at boot and every 60s; the first request for any
  other window pays its scan once.
- PUBLIC AND READ-ONLY. THE BROWSER NEVER EXECUTES ANYTHING. No add margin,
  reduce, close or kill switch from the web; every action happens in Telegram.
  The backend's `/api/protect/*` routes still exist and no page calls them —
  `apps/web/src/lib/api.ts` has GETs against `/api/analytics/*` and nothing
  else, no session, no provider, no sign-in. Everything reads the mainnet
  indexer, so there is ONE network and NO network labelling anywhere on a page.
- SIX SECTIONS, in this order, Overview as the landing page: Overview,
  Markets, Traders, Liquidations, Risk, Bot (`/bot`; `/alerts` redirects to it
  permanently: the page was Alerts until 5 Oct 2026). `docs/frontend-mockup.html` is
  the layout reference — structure, density and wording; never its figures.
- ONE TIMEFRAME CONTROL PER SECTION, in the header of Overview, Markets,
  Traders and Liquidations, defaulting to 30D, carried between sections by the
  tabs. It drives the queries. No per-panel pills. Risk has no timeframe: it is
  a point-in-time snapshot and shows the block its state came from.
- THE RISK SECTION READS ONE LADDER. The backend evaluates every priced open
  position once per rung from −50% to +50% in half-percent steps
  (`buildRiskSnapshot`); the tiles are the ±5% and ±10% rungs, the slider walks
  the same array, the by-market table is the same rungs per market, and each
  position carries the least adverse rung that liquidates it so the "largest
  exposed" list is the ladder's own selection. Compute once, show twice. The
  page states that the shock is static and that all-markets assumes every
  market moves together, the worst case rather than the likely one, and that
  book depth is not shown because the indexer has no order book.
- ONE DIRECTION PER FIGURE ON THE RISK PAGE, NEVER SUMMED. A fall closes longs,
  a rise closes shorts, and no single move does both: every count, notional,
  share and loss beyond collateral is ONE rung (`AtRiskPair.fall` / `.rise`;
  there is no summed field to render). Until 5 Oct 2026 the tiles added the
  two ("255 at risk at 10%" was 165 + 90). OPEN INTEREST IS ONE SIDE: the
  summed notional of all positions is twice it and may only be called "Total
  position value, both sides". Insurance cover is PER MARKET against that
  market's worse direction; the 11 balances may be totalled, never pooled into
  a ratio. See `docs/notes/risk-verification-2026-10-05.md`.
- FUNDING ON THE MARKETS PAGE IS ONE HEATMAP OF RATES, NEVER AN AUSD TOTAL.
  Page order is header -> all-markets table -> funding heatmap, nothing
  between. One row per LIVE market (the table's live rows, so the counts always
  match; a live market with no settlement gets a row of missing cells, never
  dropped). Upcoming markets are never in it. Columns follow the page's
  timeframe: every settlement at 24H, the MEAN RATE PER SETTLEMENT by UTC day at
  7D and 30D, by UTC week at All; every cell carries how many settlements it
  averaged and the caption says which grain is drawn. A missing cell is
  hatched; a 0% cell is a solid neutral: not listed is not zero. Each row ends
  in a simple APR from the CURRENT rate × settlements a year (venue
  `funding_interval_sec`, else measured), stated on the panel as not
  compounded and assuming the rate holds. A Table view gives every figure as
  text. Positive = longs pay shorts (Perpl docs).
  - THE RATE'S UNIT IS A FRACTION × 100,000 (`ratePct100k` = "per 100k"):
    stored 4 is 0.004% per settlement, percent = stored ÷ 1,000
    (`fundingUnitsToPct`). MEASURED against positions' payments, 11 markets
    (6 Oct 2026). Until then the site divided by 100,000 and every Perpl rate
    and APR was 100× too small; the risk score's funding ceiling was rescaled
    with it (0.001% -> 0.1%) so no score moved. Rates move in steps of 0.001%
    per settlement (~12.2% APR). The API's undocumented `funding.rate` is 10×
    the stored value. See `docs/notes/perpl-funding-unit-2026-10-06.md`.
  - FUNDING SETTLES EVERY ~43 MIN, NOT HOURLY: 2,580 s in the context, 2,587 s
    measured between indexed settlements, about 33 a day. It was about 25 a
    day until 23 Jul 2026, so a whole weekly column holds 174 to 234. The API serves
    both figures as `MarketFundingSeries.cadence`; the page states them.
  - An AUSD total across traders needs each side's open interest at every
    settlement, which the index does not keep; it is said on the page, not
    estimated.
- FUNDING ACROSS VENUES sits BELOW the heatmap (header -> table -> heatmap ->
  scanner). Perpl's APR is the heatmap row's own `aprPct`; Hyperliquid and
  Binance come from `GET /api/analytics/funding/venues`, which the BACKEND
  fills (`apps/backend/src/funding/venueFundingStore.ts`): called only while
  read, at most once a minute per venue, never from the browser. A venue that
  fails keeps its last good figures with their age for 3 minutes, then its
  column says unavailable with the age of the last good figure; it never
  blocks the page. Markets match by ticker AND price (within 5%), so a
  same-ticker different asset is never compared; not listed is an empty cell,
  never 0. Intervals: Perpl ~43 min (context), Hyperliquid 1 h (docs, measured),
  Binance per contract from `fundingInfo`, measured when absent, NEVER assumed
  8 h. RAW IS THE DEFAULT; the interest term (0.01%/8h on both others, none on
  Perpl, ~11 points) is stated ABOVE the table and a toggle strips it. Each
  column says which "current" it is. Spread = Perpl minus the furthest venue.
  See `docs/notes/perpl-funding-interval-2026-10-05.md`.
- TOKEN ICONS ARE VENDORED, LICENSED AND IDENTIFIED. `apps/web/public/tokens/`
  holds the project's OWN mark from its brand page where it publishes one
  (Solana, Aave, Lighter), otherwise Cryptocurrency Icons (CC0) or Trust Wallet
  assets (MIT), pinned. Each is checked against the actual project, not the
  ticker (LIT is Lighter by price, not Litentry); `SOURCES.md` there records
  source, terms and how identity was checked, and a test keeps every mapped
  file in it. Never a logo from an exchange site. A market with no licensed
  source gets the initials circle. Icons are decorative: `aria-hidden`, the
  name is the text beside them.
- OPEN INTEREST HISTORY IS A LEVEL, because the index starts at the deployment
  block: a market's cumulative lot delta at a day's close IS its OI then
  (measured equal to the venue on every market, 6 Oct 2026). Lots × that day's
  close mark, one side, ending on the venue's reading now. History is NEVER
  shifted to meet the venue; a market more than 0.5% off is named on the chart
  (`apps/web/src/lib/oiHistory.ts`).
- THE EXCHANGE BALANCE IS REBUILT FORWARD FROM LAUNCH, never walked back from
  today: indexed deposits − withdrawals + the protocol treasury's own
  `ProtocolBalanceDeposit` − `ProtocolBalanceWithdraw`. The treasury events are
  not indexed (handlers would force a re-sync); `pnpm protocol:flows` scans them
  off the chain into `fixtures/protocol-flows-mainnet.json`, which the backend
  serves. At block 110,989,971 it rebuilt 3,838,349.21 against the contract's
  3,838,376.91 (27.70 apart); the 178.6K "gap" was the treasury's net
  withdrawals. Treasury<->account/perp transfers move money INSIDE the
  contract and are not counted.
  - THE SCAN IS INCREMENTAL AND THE BACKEND RUNS IT (`apps/backend/src/
    exchangeBalance/treasuryScanner.ts`): at start-up and every 15 minutes,
    from its stored cursor to the latest FINALIZED block, never overlapping
    (in-process flag + Postgres advisory lock), failures logged and retried
    next interval. Movements and cursor live in the backend's Postgres
    (`protocol_treasury_movements`, `protocol_treasury_cursor`), seeded once
    from the committed file. Venue code is `packages/shared/src/venues/
    perpl-treasury.ts`.
  - RECONCILED AT ONE BLOCK, the index's latest: collateral up to it, the
    contract's balance AT it. Never the live balance against the trailing
    index. The gap has been 27.700465 AUSD since it was first measured, with
    no event explaining it; outside 27.70 ± 1 the backend logs a warning and
    the page shows the difference in words. The page also states the block
    scanned through and how long ago.
- DAILY ACTIVE TRADERS ARE DISTINCT ACCOUNTS from `TraderDay` (tradeCount > 0),
  never `MarketDay.activeTraderCount`, which is per market.
- THE TRADES TAB READS TWO INDEXES ENVIO DOES NOT KNOW ABOUT:
  `Trade_maker_id_timestamp_pg` and `Trade_taker_id_timestamp_pg` on
  `perpguard_full."Trade"`, created CONCURRENTLY on 6 Oct 2026 (577 + 637 MB)
  so the schema never re-synced. Without them a quiet account's first page ran
  past 60 s; with them, 0.07 s. IF THE SCHEMA IS EVER REBUILT, RECREATE THEM
  (`create index concurrently … on "Trade" (maker_id, timestamp desc)`, and the
  same for `taker_id`). A fill records the account's ROLE, never its side or
  action, and only the maker's fee; ~6% have no paired taker.
  - DIRECTION ("Open long", "Add short", "Reduce long", "Close short", "Flip
    to long") comes from the position event in the SAME TRANSACTION, read off
    its receipt (`packages/shared/src/venues/perpl-fill-direction.ts`,
    `apps/backend/src/server/fillDirections.ts`): the index keeps a
    position's open and close transactions but not the adds and reduces
    between. Exactly one event of the account on the market answers;
    none or two leave it BLANK, never guessed. A flip is named by the side it
    lands on (the event's side; measured on 10 flips). Checked: 55 of 55
    opens/closes agree with the index. Receipts are cached; a page resolves
    every fill, the CSV its newest 2,000 transactions.
- HOT PROFILES ARE KEPT WARM (`apps/backend/src/server/hotProfiles.ts`): the
  10 busiest accounts, the default leaderboard's top 50 (net PnL, 30 days)
  and every bot-watched account, at boot and every 20 minutes, one at a time.
  Saved wallets live in visitors' browsers; the server cannot see them.
- COMPARE (`/compare?a=…`, up to 4): every figure is the profile's own, through
  the profile's helpers; each wallet is named by short address and id beside
  its colour; a loading wallet is named "loading…" in the legend.
- NOT BUILT, ON PURPOSE: order book depth, intraday candles. Single-market
  drill-down is a later pass.
- THE FOOTER HAS NO "Data & methodology" SECTION: taken off the site on 4 Oct
  2026 at the owner's request, to come back later. `docs/methodology.md` and
  `apps/web/src/lib/methodology.ts` stay; the section's markup is in git at
  `11e3eec`. Do not re-add it unasked.
- ONE CODE STORE PER PURPOSE, CHECKED (`CodePurpose` in
  `apps/backend/src/server/protect/session.ts`). /link and the protect API
  each get their own `LinkCodeStore`, and each refuses at construction a
  store made for the other (`codePurpose.test.ts`). Until 6 Oct 2026 they
  shared one, and a /link code, which any Telegram user can mint, opened an
  OWNER session on the environment account through `/api/protect/session`.
  The protect route also checks the code was minted for the protect user.
- "FROM THIS MACHINE" MEANS A LOOPBACK SOCKET AND NO PROXY HEADER
  (`apps/backend/src/server/origin.ts`). Behind Caddy, and the web app's
  rewrite, every request arrives from 127.0.0.1, so a loopback check alone
  lets the internet in. Used by the dev code mint (which `NODE_ENV=production`
  also refuses; the flag is not in `.env`) and by `/health`.
- PUBLIC `/health` IS THE VERDICT ONLY: status code, each component's state
  and the session count. Nothing that names an account: the full report
  lists every linked account, and "this account gave PerpGuard its key" is
  not public even though account ids are. The full report goes only to a
  request made on the box (`curl localhost:8080/health`). The code is the
  same either way, so monitors are unaffected.
- EMPTY STATES ARE DESIGNED. The likeliest first visit is someone with no
  account and no positions; every table and panel has a sentence for that.

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
Postgres. Kimi API for AI. RainbowKit + wagmi + viem for the wallet proof on /link.

## The Telegram bot: two tiers
- PUBLIC WATCH TIER: anyone, any chat, no wallet, no link. `/watch <address or
  account id>`, `/unwatch`, `/watching`. Addresses resolve through the SAME
  index-then-chain lookup the web search uses (`apps/backend/src/watch/resolve.ts`),
  so a checksummed address the index never saw still resolves. Watched accounts
  are MAINNET, read from the index and priced with the venue's marks by
  `apps/backend/src/watch/loop.ts`, never from the live trading socket; every
  watched assessment carries `watch: WatchedScope` with the indexer block and
  lag, the message says it in words, and while the index is not serving
  current figures the severity is HELD like a stale price.
- A WATCHER CAN NEVER ACT. Watch alerts carry no ACTION buttons, not even
  disabled ones; event alerts carry LINK buttons only (the trader's page,
  Monadscan), which open a page and call nothing back. That is enforced server-side in the bot's gate (`apps/bot/src/bot.ts`):
  every button tap from an unlinked chat is refused before any handler runs,
  whatever its payload, and the test "SERVER-SIDE: an unlinked chat sending a
  hand-crafted action payload is refused" pins it. The renderer dropping
  actions for a watched assessment is the echo, not the rule.
- ONE DECISION PER POSITION, FANNED OUT. `AlertEngine` decides whether to
  speak from the position's own history (cooldown, dwell, escalation, the
  stale-price gate), then asks `recipients(change)` and sends one copy per
  recipient shaped by its rights (`act` = owner with buttons, `watch` = words
  only). Adding recipients never changes when an alert fires. A watched
  position's history is keyed by account AND market, so two accounts on one
  market never share a cooldown.
- PUBLIC MEANS BOUNDED: per-chat command rate limit, per-chat watch cap and a
  bot-wide cap on distinct accounts (`apps/bot/src/watch.ts`). Subscriptions
  persist in the backend's Postgres (`watch_subscriptions`) so a self-restart
  does not unsubscribe anyone.
- THE TWO TIERS ARE NAMED ON EVERY SCREEN (7 Oct 2026, owner). /start says
  both: WATCH any mainnet account (read-only) and LINK your own testnet
  account to act. Home says which tier ("👁 Watching 2 mainnet accounts",
  "🔗 Linked: testnet #710"). Every watched-account message ends in
  `NO_BUTTONS`, which says why: actions run on testnet only. Every ACTION
  screen (account, margin, confirm, outcome, Rescue, Emergency, manual and
  Rescue alerts) opens with `actingBadge` ("🧪 TESTNET · test funds"), added
  by `badged()`/`withBadge`, never by hand. On /link, a wallet that owns a
  MAINNET account is refused for acting and offered "👁 Watch it instead"
  (`POST /api/link/watch-instead`), which watches ONLY the account the page
  session proved, never one posted in the body.
- EVERY TELEGRAM USER IS SOMEBODY: `/start` registers an identity
  (`tg:<telegram user id>`, `apps/bot/src/identity.ts`, persisted in
  `telegram_identities`) for anyone, and NEVER hands out the acting slot
  first-come. `/start` links only `TELEGRAM_OWNER_ID` to the environment
  account; everyone else links through `/link`, the proof-based page below.
  A linked chat gets the account's alerts with the buttons to act.

## The event engine (`apps/backend/src/events/`)
- ONE POLLER FOR THE WHOLE BOT, NEVER ONE PER USER. Two sources: the index
  feed (`FeedPoller`, every 15 s: liquidations and taker fills since its
  cursor) and the watch loop's passes (`PositionChanges`: each watched
  account's open positions diffed against the last read). Normalized events
  (`types.ts`) -> `recipientsFor` -> claim in the ledger -> render -> send.
- AT MOST ONCE PER (EVENT, CHAT), ACROSS RESTARTS. Every event id is built
  from the fact (`<txHash>-<logIndex>`, `<txHash>:<account>:<market>`,
  `<account>:<market>:<openedAtMs>:<kind>`), and `event_deliveries` is
  claimed BEFORE the send and kept whatever the send does. The feed cursor
  (`event_cursor`) is in the index's own time; each poll re-reads a minute
  behind it. First start begins NOW: history is not news. A watch pass's first
  read of an account is a baseline, never "opened".
- A LIQUIDATION IS NOT ALSO A "CLOSE": closes and reduces are held 20 s and
  dropped if a liquidation of that account and market since the position
  opened arrives. Watchers get their wallet's liquidations at ANY size.
- THE INDEX HAS NO TAKER SIDE: `Trade.takerSide` is never written (empty on
  every fill; `attributeTaker` copies the fill's own empty value). A fix needs
  a full re-sync, so it stays. A large trade's side and action come from the
  transaction's position event via `FillDirections.directionOf`, and stay
  blank, said in words, when the receipt gives no single answer.
- THRESHOLDS ARE PRESETS FITTED TO PERPL, not the spec's (owner, 6 Oct 2026):
  liquidations $1K/$5K/$10K/$25K/off, default $10K; large taker orders
  $10K/$20K/$25K/$50K/off, default $25K (`preferences.ts`, with the measured
  frequencies). The feeds reach every chat that has started the bot, at most
  10 a minute per chat, the rest counted in one line.
- EVERY EVENT ALERT SAYS HOW FRESH IT IS: the index block and how far behind
  the chain; position changes also say they are checked every 30 s.

## The Telegram bot: screens, not commands
- THE MENU IS THE REBUILD SPEC'S (sections 18-30), and `docs/bot-screens.html`
  is GENERATED from the real bot by `pnpm bot:screens`: every screen reachable
  from /start, as the owner and as a stranger. Regenerate it after any screen
  change. Home is "🛡 PERPGUARD / Analyse. Watch. Act." with a status block
  (Trading Account + network, Execution, Automation, Alerts) and the buttons
  Watch & Alerts, My Positions, Rescue and Margin, 🆘 Emergency and Trading
  Account (Rescue and Emergency for linked chats), Settings, Open PerpGuard. AN UNBUILT FEATURE HAS NO BUTTON
  (owner, 6 Oct 2026): Copy Trading appears when its phase lands, never as a
  dead button; the roadmap belongs in the README. A test walks every screen
  and fails on any label for an unbuilt feature.
- 👁 WATCH & ALERTS (Phase 8, `apps/bot/src/watchScreens.ts`): Watch Wallet
  (the watched-wallets list; a new watch shows "✅ WALLET ADDED" and what will
  be reported), Watchlist (a `starred` flag on `watch_subscriptions`, not a
  second concept: 30D PnL and all-time ROI), Top Traders, Liquidations, Large
  Trades, Warning Levels, Alert Settings. All public: they read the index or
  change the chat's OWN settings (`alert_preferences`). EVERY SCREEN STATES
  ITS LIMITS: index blocks behind, watched wallets re-read every 30 s, ~6% of
  fills with no taker, direction sometimes not known, past results do not
  predict returns.
- ROI IS ALL TIME, WITH ITS DENOMINATOR, AND WITHHELD UNDER 100 AUSD DEPOSITED
  (owner, 6 Oct 2026; `MIN_DEPOSIT_FOR_ROI_AUSD`). Lifetime net PnL over
  lifetime deposits, so both cover the same period; never a window's PnL over
  all-time deposits, never against current equity. The `roi` sort and ranking
  read the lifetime rows whatever window is asked. The Top ROI board also
  takes Top PnL's 10-round-trip floor (427 on 100 over 4 round trips is
  +426%, and noise). Rendered "+1,034% on 2,045 AUSD deposited". Top PnL is
  30 days. Not on the website.
- WARNING LEVELS FOR WATCHED WALLETS (`events/warnings.ts`,
  `events/watchWarnings.ts`): Early 20/10/5, Standard 10/5 (default), Late
  5/2, Custom up to five (typed, force_reply), Off. Per (chat, account,
  market): each level fires once, re-arms after recovering a quarter of the
  level (at least half a point), a fall through several is one message, held
  while blind, a new watch's first two minutes are a baseline, state persists
  (`watch_warning_state`). The old watch engine now sends watchers only "I
  cannot see it" and "I can see it again". The linked account keeps "Warn me
  at"; the two are unified in Phases 13-14.
- THE TRADING ACCOUNT SHOWS ACCOUNT, NETWORK AND EXECUTION AS SEPARATE FACTS
  (`apps/bot/src/trading.ts`): Execution is green only for a signed-in
  session that allows forwarding, and every other state is named with what to
  do. Wallet and Ownership rows wait for the persisted proof (Phase 10-11):
  today's link record does not keep how it was proved, so nothing claims it.
  Disconnect lives here, labelled with the account, not in Settings.
- Every screen is reachable by button;
  the only commands are `/start` (the menu), `/watch`, `/link` and `/help`,
  and the BotFather menu is set to exactly those at startup
  (`BOT_MENU_COMMANDS`). `/positions`, `/status`, `/cancel`, `/unwatch`,
  `/watching` and `/unlink` are gone; their jobs are buttons.
- NAVIGATION HAS ITS OWN CALLBACK NAMESPACE (`apps/bot/src/nav.ts`,
  `n1:<code>[:<id>]`), strict both ways and never decodable as an action. The
  gate lets an unlinked chat through ONLY with a nav payload that decodes to a
  route marked public (home, Watch & Alerts, watch, watchlist, wallet, stop
  watching, Trading Account, connect).
  Every action payload is still refused before any handler, and account
  routes resolve the link at tap time like a command. Screens edit the message
  they were tapped on; a `fresh` button (`+` on the code) opens a new message
  instead — used on outcome and kill-switch reports, which are the record of
  what happened to someone's money and must never be edited away.
- WHEN THE BOT ASKS, IT HEARS THE ANSWER. Questions go out with
  `force_reply` and are parked (`questions.ts`, and the amount store for a
  custom amount); the next plain message from that person in that chat is
  the answer, threaded or not. A pasted address is watched at once; a BARE
  NUMBER nobody asked for is only offered ("Watch account #1000?"), because
  it may be an amount typed after its prompt expired. Other chatter gets one
  pointer to the menu an hour, not a reply each.
- A NEW WATCH IS SPARED FIRST-SIGHT ALERTS for two minutes
  (`watchRecipients`): its wallet screen has just shown every position, and
  the first live run sent six alerts on top of it. Real changes go to all.
- PLAIN VOICE (`apps/backend/src/alerts/plain.ts`), shared by screens and
  watch alerts: money first and in bold; what someone HOLDS is floored, what
  something NEEDS is ceiled, and P&L ROUNDS AGAINST THE READER: a loss AWAY
  from zero, a gain toward it (`signedPnl`; owner, 7 Oct 2026: −64.8 reads
  −65, never a smaller loss than the real one); under one AUSD is "under 1 AUSD",
  never "0 AUSD"; never the word "safe"; a negative buffer is "past its
  closing price". Watch alerts carry freshness and "No buttons" every time.
- MY POSITIONS IS THE SCREEN A JUDGE READS LONGEST (Phase 14, `positionCard`
  in `apps/bot/src/account.ts`). Each position is a card: the DISTANCE FROM
  LIQUIDATION leads, bold, on the first line, then the band (OK, WATCH,
  DANGER, PAST LIQUIDATION, CANNOT SEE; never "safe"); then size and value,
  leverage (position value ÷ margin, said as such), margin and unrealised PnL,
  mark and liquidation price. Closest to liquidation first, at most 8 cards
  in one message, the rest counted and still on the buttons. A blind
  position shows no figure at all.
- THE TRADING ACCOUNT NAMES WHAT IS WRONG (Phase 13): Wallet, Ownership and
  Execution as three rows; Execution says which failure it is (key rotated,
  linked on another network, key for another account, not running, order
  forwarding off, with what to do) and offers "Fix authorization" (the
  connect page) only where a new key fixes it, never for forwarding, which
  needs the owner's wallet. A wallet proven without a key shows ownership
  verified and execution waiting, with "Add API key". THE LINK STORES ITS
  NETWORK (`account_links.network`); a link from another network is refused by
  name. MAINNET TRADING IS OFF unless `PERPGUARD_MAINNET_TRADING=1`: the
  registry refuses every session, monitoring is unaffected.
- MANUAL ADD MARGIN (Phase 15, spec 33-34): Margin → a position's 💰 MARGIN
  screen (manual, never automated; no Remove Margin, it is cut) → ➕ ADD
  MARGIN with +100/+250/+500/+1,000 AUSD and Custom, each amount PRICED BY
  THE ENGINE when the screen is built (no amount offered on a position it
  cannot see), one above the free floor offered with ⚠️, not hidden. Every
  amount is an action token: its tap shows ⚠️ CONFIRM ADD MARGIN with the
  before and after (margin, available, and the liquidation price and
  distance only when projected), and nothing sends before ✅ Confirm. The
  send path is the existing one: one in flight, reconciled against the
  position's margin, never re-sent on `sr 32`.
- THE ACCOUNT HALF (`apps/bot/src/account.ts`): My Positions, Margin (the
  same positions framed for adding margin; sends nothing itself), a position
  screen with Add (computed or custom), Reduce 25% and Close position,
  Settings. Every money button is a pending-action token through
  the existing confirmation, one-in-flight lock and reconciliation; nothing is
  offered while the feed or the position list is blind. The confirmation turns
  into the progress line and then the outcome IN PLACE, so Send cannot be
  tapped twice; Cancel deletes the token; Send again only after a reconciled
  not-applied. Reduce says the closing price does not move (proportional
  release). A top-up above the free-balance FLOOR is offered WITH a warning,
  not hidden: the floor can understate (warn, don't refuse). The `sr 32`
  top-up's outcome (owner's wording, 6 Oct 2026) leads with the success, then
  "The exchange's own report disagreed with what actually happened. The
  margin applied — I checked the position itself, not the receipt. Do not
  send it again." Never "failed", never "rejection".
- 🔴 THE KILL SWITCH (Phase 20, spec 54-57, 59, 80) STOPS AUTOMATION AND
  LEAVES POSITIONS OPEN (`apps/backend/src/rescue/killSwitch.ts`, bot half
  `apps/bot/src/killSwitch.ts`). Stop writes the persisted flag
  `automation_state.kill_switch_active` FIRST (every automated path reads it:
  `decide`, before the claim, the executor's last gate), then turns every
  Rescue rule off (`paused_reason 'kill switch'`), moves the mode to NONE
  whichever strategy held it, and reports a rescue in flight as stopped
  before sending or already sent (a sent top-up cannot be recalled). It sends
  NOTHING to the venue: no close, no reduce, no margin removed. Pending
  orders: PerpGuard places none (Rescue adds margin directly; Copy is not
  built), and the result says so. DATABASE ONLY: the bot routes resolve the
  chat's LINK, never its session, so a stop works with the socket down or the
  key needing re-linking (spec 54). Two taps (explain, confirm), the result is
  a NEW message. Idempotent. While on, enabling Rescue is refused. RESUME
  only lifts the block: every strategy stays off until turned on per
  position. A person's own taps still work while it is on.
  - 🆘 EMERGENCY (7 Oct 2026, owner): the Kill Switch's screen now holds TWO
    SEPARATE actions, never one button: 🔴 STOP PERPGUARD (the switch above,
    unchanged) and 🚪 CLOSE EVERYTHING (`apps/backend/src/emergency/`, bot
    half `apps/bot/src/emergency.ts`). Close everything:
    - lists every position (side, size, unrealised P&L, a loss rounded away
      from zero) and the total, says prices move, and is
      confirmed by TYPING "CLOSE ALL" (a parked `force_reply` question, good
      for two minutes, closed by the first answer whatever it is);
    - STOPS PERPGUARD FIRST, then closes one at a time through the account's
      own executor, key `closeall:<acct>:<request>:<pid>`. One run in flight
      per account; each request id runs once (the confirmation's, minted when
      the list was shown; a retry's, minted when its confirm screen was), so
      two taps or two typed answers send one set of orders. NEVER RE-SENT;
    - READS THE OUTCOME FROM THE POSITION LIST AFTERWARDS (`verify.ts`):
      closed (with `xp` from the closing row, which the trading socket now
      keeps), partly closed with what remains, still open with why, or NOT
      SEEN when the list is not fully loaded. Never "closed" for anything
      still open or unseen; DONE only when every one is closed. Retry per
      position for what is left. Already flat: says so, sends nothing;
    - logged per run in `close_all_runs` (requested, each receipt, each
      verified outcome) beside each close's own `action_log` row.
  - The retired close-all's nav codes (`kq`, `kx`) still decode to nothing,
    forever: the new switch uses `ks`/`ksc`/`ksx`/`ksr`/`ksv`, so an old button
    can never be read as the new meaning. The executor's old
    `fireKillSwitch` is reachable from no bot path; Close everything is the
    new module above, not that one.
- RESCUE IS TWO MODES (Part 2, owner, 7 Oct 2026). ONE NUMBER per account,
  THE ALERT DISTANCE (`apps/backend/src/manual/distance.ts`, `account_settings
  .alert_pct`): presets 2/3/5/8/10% or custom 0.5-20%, default 5% for new
  accounts (an existing "Warn me at" kept the distance it first warned at:
  Normal = 8%). Set in ⚙️ Settings ("Alert me at"), shown on home.
  - 🔔 MANUAL, ON FOR EVERYONE, NOTHING TO ARM (`manual/alerts.ts`, bot
    `manualAlert.ts`): at the distance, ONE message per position per crossing
    (re-armed after recovering a quarter of the distance, at least half a
    point; remembered in `manual_alert_state`, so a restart does not repeat
    it; held while blind): the position, distance, P&L, free balance, and
    +100/+250/+500/+1,000 (priced by the engine), Custom, View position,
    Dismiss. Every amount goes through the TWO-STEP confirm: a tap only shows
    ⚠️ CONFIRM ADD MARGIN. PerpGuard sends nothing on its own in this mode. A
    linked account's own WATCH/DANGER alerts (and their "recovered") are not
    sent any more (`manual/replaced.ts`): the crossing is said once, here.
    Past liquidation and "cannot see" still go out. Changing the distance
    starts fresh: a position already below the new line is told at once.
  - 🤖 AUTO, OFF UNTIL A TAP TURNS IT ON, PER POSITION: the Rescue engine
    above, unchanged in every safety (limits, total cap, floor, cooldown,
    reservation, idempotency, `sr 32`, one handover, the Kill Switch), acting
    AT THE ALERT DISTANCE (no trigger to pick; armed rules follow a change).
    The person picks the amount (default 100) and the maximum top-ups
    (default 2). For an armed position the crossing message says it is
    ADDING (with a one-tap Turn off), or that Auto is waiting and why
    (`RescueEngine.autoNow`, the same `decide`), never "adding" when it holds.
    The position screen shows Alert and Auto separately, how and when Auto
    was armed, and ⛔ Turn off auto in one tap.
  - ARMED INSIDE THE LINE IS A CHOICE (owner's finding, 7 Oct 2026: arming
    at the line fired within two seconds): the review offers "add now" or
    "from the next crossing" (`waitForCrossing`, persisted; the engine does
    nothing until it has SEEN the position above the line). Turning Auto off
    while a top-up is on its way says it cannot be recalled and its result
    will come. EVERY BUTTON TAP IS LOGGED (`describeTap`): who, chat, linked
    or not, the screen or the action's kind, market and amount, never a token.
  - AUTO IS ARMED BY A TAP AND ONLY BY A TAP (`rescue/arming.ts`), after a
    script-armed rule topped up 710 at 01:55 with nobody watching. Only the
    bot's handler arms, passing the tap (Telegram user, chat); the control
    checks both are linked to the account and SIGNS the rule (HMAC under a
    key derived from `PERPGUARD_KEY_ENCRYPTION_KEY`) over every field that
    matters, storing `armed_by`, `armed_chat`, `armed_at`, `arm_proof`. The
    engine checks the signature and that the armer is still linked before
    every judgement and right before every send; a rule that fails (a script,
    an operator tool, a database insert, an edited amount, an unlinked
    armer) is NEVER ACTED ON: switched off as `ignored: …` and logged. NO
    SCRIPT ARMS A RULE ON A REAL ACCOUNT; test rules go on a test account or
    database. Limit, said once: whoever holds the server key on the box could
    sign; this closes every path that does not.
- The bands on the screens (WATCH 8%, DANGER 3%: `risk/warn.ts`) still come
  from each account's loop; "Warn me at" is no longer a screen, the alert
  distance replaced it. Quiet hours and a daily summary are NOT BUILT: they
  need a timezone Telegram does not give and a rule for DANGER during quiet
  hours.
- 🛟 LIQUIDATION RESCUE (Phase 17, `apps/backend/src/rescue/`, bot half
  `apps/bot/src/rescue.ts`). A rule is ONE POSITION (venue pid; a reopened
  position is a new one and its rule ends) with a trigger, an amount and FOUR
  LIMITS, each its own column: max rescues, MAX TOTAL (independent, never
  count × amount once picked), minimum free balance never spent, cooldown.
  `decide.ts` is pure: triggered on two looks ≥1 s apart at or below the
  trigger; then kill switch -> feed/positions -> limits (exhausted) ->
  cooldown -> free-balance FLOOR (hold, never a scaled-down amount). The
  engine claims `rescue_attempts (rule, n)` with key
  `rescue:<acct>:<pid>:<rule>:<n>` BEFORE sending, sends through the
  account's own executor (the `sr 32` reconciliation is unchanged), and keeps
  the RECEIPT and the VERIFIED OUTCOME in separate columns. Limits move by the
  verified delta. UNKNOWN pauses the rule (counted as if landed) until the
  person resumes; a refusal waits a minute; nothing loops.
  - THE KILL SWITCH IS REAL: `automation_state.kill_switch_active`, read in
    `decide`, before the claim, and by the executor right before the send
    (`ActionCommand.stopCheck`, refusal `automation-stopped`). A person's own
    tap carries no stopCheck: the switch stops automation, never the person.
  - ONE AUTOMATION PER ACCOUNT: `automation_state.mode` moves NONE <->
    LIQUIDATION_RESCUE by compare-and-set; COPY_TRADING refuses Rescue.
  - Messages: rescued (spec 44, verified figures; the `sr 32` lines when the
    receipt disagreed), not landed, paused, held (once per reason; transient
    reasons only after 30 s), ended, and THE HANDOVER when limits are spent
    and it is still falling: rescues used, total added, distance, PerpGuard
    has stopped, what the trader can still do. Never "failed".
  - ENABLE is re-validated server-side (`control.ts`) against the live
    position; a second rule on a position replaces the first.
  - THE FLOOR IS ACCOUNT-WIDE (7 Oct 2026): ONE RESCUE IN FLIGHT PER
    ACCOUNT, locked from the balance check through settlement, and every
    amount sent is RESERVED off the balance `decide` sees. Released on a
    refusal and on not-applied (nothing left), on applied once the exchange's
    figure has fallen by the amount (2-minute limit, then released WITH a
    warning: a deposit can hide the fall). HELD on unknown. In memory on
    purpose: at boot the exchange balance is the truth, no phantom holds.
    Without this, two positions triggering together took 540 to 490 against
    a 500 minimum (test "THE FLOOR IS ACCOUNT-WIDE").
  - A POSITION IS GONE ONLY WHEN A FULLY LOADED LIST OMITS ITS ID. No risk
    reading (no price yet after a restart, no market config) is a hold,
    "It is not closed". A message calling an open position closed is the
    failure that destroys trust in every other message.
  - THE MARKET IS CHECKED BEFORE ANY ATTEMPT IS CLAIMED, by id: not listed
    ends the rule, worded as the MARKET ("says nothing about the position
    itself"); closed holds with no attempt row. The same refusal twice in a
    row pauses the rule: a dead cause writes at most two rows.
  - SPENT LIMITS END THE RULE with ONE handover (until 7 Oct it stayed on
    and repeated the handover on every dip: four times in one night).
  - Amounts are in the collateral's own decimals, read from the context
    (`getCollateralToken`), never assumed to be 6.
- THE MARKET LIST IS RE-READ EVERY 10 MINUTES (`ingest/marketRefresh.ts`):
  changed configs are applied IN PLACE to the map the loops hold, and a
  maintenance-margin change is logged as a warning naming both figures. A
  market the venue drops is KEPT for monitoring; actions on it are refused by
  id.
- `pnpm watch:demo` (mainnet, read-only) and `pnpm bot:account-demo`
  (testnet, MOVES REAL TESTNET COLLATERAL; stop the backend first, two
  clients on one key collide on request ids) drive the real bot with only
  Telegram's wire faked and write the chat as JSON for screenshots.

## Copy trading
- HALF A, WHAT WOULD HAVE HAPPENED (7 Oct 2026, owner): one leader's last 30
  days replayed onto an account of a given size, from the index ONLY; nothing
  is ever sent. `apps/backend/src/copy/replay.ts` (pure), `service.ts`,
  `GET /api/analytics/copy/:id?size=`, web `/copy/[id]` (linked from the
  trader page), bot "🔁 What if I'd copied? · 30D" on a trader's card (public
  route `copy-sim`; a linked chat is sized to its own account's equity, any
  other to 1,000 AUSD, said so). `pnpm copy:replay` runs it live and checks
  the rebuilt equity against the index.
  - Only new opens are copied; size is follower equity over leader equity at
    each open (2% -> 2%); markets match by each network's CONTEXT ticker,
    never the indexer name; a missing market is skipped by name; size rounds
    DOWN to the acting step, margin (the leader's PEAK, scaled) UP; leverage
    above the acting maximum is skipped; a leader with more than 3,000 opens
    in the window is refused WHOLE, never replayed in part.
  - `Position.netPnlCNS` HAS NO FEES: the indexer never writes
    `Position.feesCNS`; fees live per account per UTC day (`TraderDay`). So
    the leader's per-position result is BEFORE fees and is labelled so; each
    copy pays the ACTING market's taker fee on opening and closing its full
    size at entry (the least it would cost); the leader's equity takes its
    daily fees at each day's end. With that, the rebuilt equity matched the
    index to the micro on #4532 and within 0.31 AUSD on #5213; #4886 is 2%
    off, unexplained.
  - Half B (live copy onto testnet) is NOT BUILT; wait for the owner.

## Account sessions: one of everything PER LINKED ACCOUNT
- `AccountRegistry` (`apps/backend/src/sessions/registry.ts`) owns an
  `AccountSession` per account id: its own venue with its own credentials and
  socket, position source, risk loop (stamps `accountId` on every
  assessment), alert engine (history and alert keys by account AND market,
  recipients = the chats linked to that account), executor (own in-flight
  registry; REFUSES `wrong-account` before a lease when a command names
  another account), balance and bot view. Shared and safe to share: the
  market feed, market list and risk configs, the action and alert logs (every
  row carries the account), the Telegram transport.
- THE SOCKET MUST SIGN IN AS THE ACCOUNT THE SESSION WAS OPENED FOR, or the
  session reports a mismatch and the registry tears it down. The environment
  key's session is keyed by `PERPL_ACCOUNT_ID`, which is therefore required.
- `MAX_ACCOUNT_SESSIONS` (default 20) is a REFUSAL at the cap with a sentence,
  never a slowdown for everyone: "This PerpGuard instance is full … PerpGuard
  is open source and self-hostable", shown on the link page as written
  (`instanceFullText`). A session is a socket, a position set and a loop
  ticking every second.
  - PERPL'S CONNECTION LIMIT, MEASURED (7 Oct 2026,
    `docs/notes/perpl-connection-limit-2026-10-07.md`, `pnpm
    probe:connections`, backend stopped): the docs' "~5 per IP" is NOT
    enforced (24 public sockets and 7 signed-in ones all held). The real limit
    is at SIGN-IN, about 7 to 11 signed-in sessions on ONE key, refused with
    `1008 (too many connections)`, existing sockets never dropped; unsigned
    connections from the same IP were accepted while that key was full. One
    trading socket per linked account, each on its own key, so no
    instance-wide socket ceiling on this evidence. Per key vs per IP for
    signed-in sessions needs a second key to settle.
- ALERTS WAIT PER SCOPE AT BOOT (`alerts/startupGate.ts`): a linked
  account's alerts wait for THAT account's session to come up clean, the
  watch tier's for the watch loop, never for everyone. One person's broken
  key no longer holds every user's alerts for the 3-minute deadline.
- RESCUE MESSAGES ARE SENT WITHOUT WAITING (`#tell` in `rescue/engine.ts`):
  one person's slow Telegram send never holds another person's rule in the
  same tick, or the account's lock.
- `/unlink` must tear the session down immediately: `registry.close()`
  unreferences first (no request routed from then on finds it), then stops the
  loop, drains the engine, closes the socket. `/health` reports every session
  under `components.sessions`, each with connected / retrying / blind.
- THE BOT HOLDS NO VIEW, EXECUTOR OR BALANCE. Every handler resolves the
  requesting chat's link (`LinkRecord.accountId`) and the registry's session
  for it AT REQUEST TIME (`resolveAccount` in `apps/bot/src/bot.ts`), and the
  confirm tap re-resolves again before sending; an action whose
  `accountId` is not the chat's linked account is discarded. Nothing is cached
  from link time.
- The cross-account proof is `apps/backend/src/sessions/registry.test.ts`:
  two real sessions through fake sockets — action isolation, alert isolation,
  independent in-flight locks, the cap, teardown, the mismatch. `pnpm
  registry:live` runs the environment account through the registry on testnet.
- LINKING IS PROOF-BASED, AND THE TOKEN IS TRANSPORT, NOT PROOF. `/link`
  mints a one-time five-minute code whose URL opens the web page `/link`
  (`PUBLIC_WEB_URL`); redeeming it gives the page a 30-minute cookie session
  for that Telegram identity and LINKS NOTHING. The proof is one of two
  things collected on that page: a wallet signature over a Sign-In with
  Ethereum challenge the backend issued (`walletChallenge.ts`: this site,
  the trading chain, one-time nonce, five minutes, consumed before it is
  checked), verified server-side and mapped to an account by the Exchange contract, or a Perpl
  API key pasted there, used once to sign in and learn its account. A wallet
  that owns the environment account links at once; a wallet that owns any
  other account proves ownership and still needs a key for it, and a key for
  a different account than the wallet proved is refused.
  (`apps/backend/src/server/link/{service,routes,crypto,stores}.ts`.)
- THREE STATES, KEPT AND NEVER COLLAPSED (Phases 10-11, 6 Oct 2026): wallet
  (connected in the browser), OWNERSHIP VERIFIED (`wallet_proofs`: the wallet
  signed our challenge and the Exchange says it owns the account on the
  trading network; kept across visits, deleted on unlink) and EXECUTION
  AUTHORIZED (an API key sealed, or the deployment's own key). `LinkStatus`
  reports them from records (`proof` is `key`, `wallet` or `owner`, never
  inferred); the page and the bot's Trading Account show Wallet, Ownership
  and Execution as three rows. A kept proof binds the key that follows only
  while it waits for one; once linked, a key for another account is a switch.
- THE PAGE IS ONE FLOW: the signature is requested AUTOMATICALLY when a
  wallet connects (the owner failed the old second tap three times while
  testing it), the card is neutral ("one more step") until the backend has
  verified it, and green only for a wallet whose ownership is on record. A
  used `?code=` is removed from the address once it opens the session, and a
  refused code falls back to the session the browser holds, so returning
  from the wallet app never shows "This link has ended".
- A WALLET WHOSE ACCOUNT IS ON THE OTHER NETWORK IS TOLD SO BY NAME
  (`lookupElsewhere`, the analytics network): "This wallet owns Perpl account
  #4855 on mainnet. PerpGuard acts on testnet only for now". Nothing is ever
  linked there. Found when the owner's Rabby wallet (mainnet #4855, nothing
  on testnet) was refused as owning "no account".
- EVERY PAGE OUTCOME LOGS a line with the client (user-agent, named; iOS
  in-app Safari is indistinguishable from Safari and is said so) and an
  8-character hash of the page session, never the code, message, signature
  or key: code refused or redeemed, challenge issued, signature refused or
  verified, and any request that arrives without a valid session cookie.
- THE API KEY NEVER COMES BACK OUT. It is entered on the HTTPS page only
  (the form disables itself on plain HTTP off localhost), never asked for or
  accepted in Telegram, never echoed by any route, never logged, and sealed
  at rest with AES-256-GCM under `PERPGUARD_KEY_ENCRYPTION_KEY`
  (`account_keys`). `routes.test.ts` and `service.test.ts` pin "not in any
  reply, log or notice" on success, refusal and server error alike.
- ROTATION = RE-LINK. A rotated environment key makes every sealed key
  unreadable (`KeyRotatedError`); links survive, the sessions do not reopen
  at boot, `needsRelink` marks the user and every command and tap tells them
  to `/link` again. Nothing is re-encrypted and nothing is ever kept in the
  clear.
- `/unlink` (bot or page) removes the link, DELETES the key and closes the
  session at once; the environment account's session is never closed by an
  unlink. The web app has exactly ONE route with a session and ONE provider
  stack: wagmi + RainbowKit live in `apps/web/src/app/link/layout.tsx`, the
  root layout knows nothing of them, and every other page is public and
  read-only. The WalletConnect project id is OPTIONAL and inlined at BUILD
  time (`build-web.sh` lifts `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` from the
  shared `.env`); without it the page lists extension wallets only, no QR.
- THE WALLET LIST IS DELIBERATE (`apps/web/src/app/link/walletConfig.ts`),
  the same on desktop and phones: MetaMask, Rabby, Rainbow, Coinbase, then
  WalletConnect as the catch-all. EIP-6963 auto-discovery is OFF, so no
  installed extension adds itself; Phantom ended Monad support in August 2026
  and must never be offered. Rabby reaches phones through its registered
  WalletConnect deep link (`rabby://`, from the WalletConnect registry), not
  RainbowKit's extension-only entry.

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
Day 6 (Oct 1): the web app is the six public, read-only sections above,
served by the analytics API behind a stale-while-revalidate cache; the
Telegram bot has the public watch tier beside the linked tier and the
backend runs one session per linked account behind `AccountRegistry`,
with proof-based `/link` (wallet or sealed API key) feeding it; processes
run under systemd (`deploy/systemd/`). Actions live in the Telegram bot.

THE INDEX IS FULL HISTORY (cut over 1 Oct 2026, 20:47 UTC). The backend
reads schema `perpguard_full`, indexed from the Exchange's deployment block
54,773,010 (11 Feb 2026), via `search_path` on `INDEXER_DATABASE_URL`. It is
written by the `perpguard-backfill` unit, now the only indexer: do NOT
rename it or change its env, or Envio may reset the schema. The old live
index (schema `public`, from block 100,000,000, unit `perpguard-indexer`)
is stopped and disabled; its schema is kept for rollback until the owner
says drop it. "All" is named from the index's real start ("since Feb 11,
2026"), never "all time" on trust. The rescuable finding over all time
is 2,318 of 3,463 (66.9%) against 467 of 637 (73.3%) over 30 days, captured
in `docs/liquidation-finding-2026-10-01.md`; always quote one with its window.
- A RESTART NEVER SENDS "I CANNOT SEE THIS POSITION": each alert is held
  until ITS scope (its account's session, the watch loop) has assessed
  cleanly (`alerts/startupGate.ts`), then the startup blindness is dropped;
  past 3 minutes it is an outage and goes out.
- EVERY WEB BUILD IS CLEAN (`apps/web/scripts/build-web.sh` deletes the dist
  dir and `tsconfig.tsbuildinfo`), and CI runs it. Deploy by building into
  `NEXT_DIST_DIR=.next-staged` and swapping it for `.next`: seconds of
  downtime instead of minutes.
