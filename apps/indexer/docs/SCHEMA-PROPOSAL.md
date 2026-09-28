# apps/indexer — schema proposal (APPROVED, implemented)

Target: Envio HyperIndex against the Perpl Exchange proxy
`0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` on **Monad mainnet, chain 143**
(read-only analytics network, per CLAUDE.md).

**Status: approved and built.** `config.yaml`, `schema.graphql` and the handlers
are in place and running. What the schema below says still holds; §8 records the
five places reality moved it, and §6's open questions are resolved in §9.

---

## 1. What I verified first

**Monad mainnet is supported by HyperSync.** From
<https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks>:

| network | chain id | HyperSync endpoint |
| - | - | - |
| Monad | 143 | `https://monad.hypersync.xyz` (or `https://143.hypersync.xyz`) |
| Monad Testnet | 10143 | `https://monad-testnet.hypersync.xyz` |

No traces are listed for either, which is fine: we only need logs.
An API token is required — "requests without a token are rejected with HTTP 401" —
read from `ENVIO_API_TOKEN`. It is now in `.env` and present as an empty key in
`.env.example`. Indexers deployed to Envio Cloud do not need their own token.

**The address is the right contract.** Checked over `https://rpc.monad.xyz`:

| | |
| - | - |
| `eth_chainId` | `0x8f` = 143 |
| Proxy runtime | 225 bytes, ERC-1967 |
| Implementation (slot `0x3608…2bbc`) | `0xa9ab97a404a0bca04d6a5b4a39995fea9e791b2a` |
| `getContractVersion()` | 1.7.5 |
| `numberOfAccounts()` | 5341 |
| `isHalted()` | false |
| `getExchangeInfo()` collateral | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 decimals |
| `getMinAccountOpenCNS()` | `10000000` |

Two corrections to our notes fall out of this:

- CLAUDE.md says the minimum opening deposit is `100000000` (100 AUSD). That is the
  **testnet** value. Mainnet is `10000000` — 10 AUSD. The rule "read it from chain,
  never hard-code" stands; only the example number was wrong.
- The saved ABI is a **testnet** snapshot (`perpl-sdk` 0.2.9, impl `0xbcbd3701…adbb`).
  It decodes mainnet correctly for everything we need, but 14 of its 204 event
  topics are absent from the mainnet implementation, and all 14 are the **V1 forms
  of events that now have a V2**: `PositionOpened`, `PositionIncreased`,
  `PositionDeleveraged`, `PositionUnwound`, `PositionUnwoundWithoutPayment`,
  `MakerOrderFilled`, `TakerOrderFilled`, `OrderRequest`, `ContractAdded`, plus
  `MakerFeeUpdated`, `TakerFeeUpdated`, `RecycleFeeToAccount`, `AdminChanged`,
  `BeaconUpgraded`.
  **So: index the V2 forms for current data, and keep the V1 forms configured too,
  because a backfill from the exchange's first block replays history written by
  older implementations.** 16 function selectors are likewise absent
  (`execOrder*`, `liquidation*`, `execFwdPositionOps*`, `getPerpetualInfo`,
  `setAccountFeeTiers`, …) — irrelevant for indexing, but do not call them on
  mainnet off this ABI.

**First block.** HyperSync says the earliest log from the proxy is block
**54,773,010**; archive height was 108,613,840 at the time of writing. That is the
`start_block`, and it is ~53.8M blocks of history.

**Live volume.** In a 100-block sample at head 108,613,771 (29 seconds of chain)
the proxy emitted **8,553 logs** across 25 distinct event types. Full per-event
breakdown and a note on all 204 events: [`EVENTS.md`](./EVENTS.md).

---

## 2. Three facts about this contract that shape the schema

### 2.1 Most order events carry no account id

`OrderRequestV2` is the only order event with `perpId` **and** `accountId`.
Everything after it in the transaction — `OrderPlaced`, `OrderChanged`,
`OrderCancelled`, `TakerOrderFilledV2`, `ImmediateOrCancelExecuted`, `CrossesBook`,
`MaxMatchesReached` — has no ids at all and belongs to the request above it. A real
mainnet transaction, decoded (tx `0x65127306…bb35b5`, block 108,614,633):

```
[69] OrderRequestV2   perpId=10 accountId=4638 orderId=11 orderType=6 postOnly=true
[70] OrderChanged     orderId=11 …                        <- belongs to [69]
[71] OrderRequestV2   perpId=10 accountId=4638 orderId=1  …
[72] OrderChanged     orderId=1  …                        <- belongs to [71]
[73] OrderRequestV2   perpId=10 accountId=4638 orderId=14 …
[74] OrderChanged     orderId=14 …
[75] OrderRequestV2   perpId=10 accountId=4638 orderId=0  immediateOrCancel=true
[76] PositionDecreased    perpId=10 accountId=25   deltaPnlCNS=-1048599   <- the MAKER
[77] MakerOrderFilledV2   perpId=10 accountId=25   price=27938 lot=3579 fee=0
[78] PositionIncreasedV2  perpId=10 accountId=4638 insFee=3150 protFee=17848 <- the TAKER
[79] TakerOrderFilledV2   price=27938 lot=3579 fee=20998   <- no ids: taker is [75]
[80] ImmediateOrCancelExecuted unmatched=32021 total=35600
[81] OrderRequestV2   …
[82] ImmediateOrCancelExecuted unmatched=35600 total=35600  <- nothing matched
[83] OrderBatchCompleted
```

Note `3150 + 17848 = 20998`: **the taker's fee on `PositionIncreasedV2`
(`insFeeCNS` + `protFeeCNS`) equals `TakerOrderFilledV2.feeCNS` exactly.**

That matters, because every `Position*` event *does* carry `perpId` + `accountId`.
So per-trader PnL, fees and volume can be built entirely from position events and
maker fills, and we do not need `OrderRequestV2` — the single most expensive event
on the contract at ~35 per block — in v1 at all.

### 2.2 The on-chain order id is a short, recycled slot

The ids above are `11`, `1`, `14`, `0` — not the wide globally-unique `oid` the
trading API uses. They are per-market slot indices, reused after an order dies
(hence `clearOrderSlots`, `getOrderIdIndex`, `InvalidOrderId(orderId, min, max)`),
and `0` for orders that never rest. This is the on-chain twin of the `scid` /`oid`
distinction in CLAUDE.md. **Any `Order` entity keyed by `perpId-orderId` would
silently merge unrelated orders.** Combined with 10-second expiry, resting orders
are live state, not history: they belong to the websocket, not to an index.

### 2.4 `positionType` is 0 = LONG, 1 = SHORT — measured, not assumed

The ABI gives `positionType` as a bare `uint8`. I resolved it against real data
rather than guessing: over a recent 120k-block window I paired every
`PositionOpenedV2` with the `PositionClosed` that ended it (496 complete round
trips) and compared the sign of `deltaPnlCNS` with the price move over the
position's life.

| positionType | PnL agrees with price move | opposes | flat | verdict |
| - | - | - | - | - |
| 0 | 241 | 2 | 22 | **LONG** |
| 1 | 2 | 213 | 16 | **SHORT** |

The four outliers are positions that were increased mid-life, which moves the
average entry price away from the opening price my test used — expected, and not a
counter-example.

### 2.3 Failures are events, not reverts

71 of the 204 events are failure reports — the engine processes a batch and reports
per-item rejections instead of reverting. Four of them are in the live top twenty
(`ExceedsLastExecutionBlock` 52, `OrderDoesNotExist` 22, `WrongAccountForOrder` 8,
`OrderDescIdTooLow` 7 per 100 blocks). Normal operation, not incidents. None are
indexed in v1.

---

## 3. Scope of v1: 33 events, no order book

Indexed (see `EVENTS.md` for the reasoning on each):

| area | events |
| - | - |
| accounts | `AccountCreated`, `CollateralDeposit`, `CollateralWithdrawal`, `OrderForwardingUpdated` |
| positions | `PositionOpenedV2`, `PositionIncreasedV2`, `PositionDecreased`, `PositionClosed`, `PositionInverted` + V1 `PositionOpened`, `PositionIncreased` |
| isolated margin | `IncreasePositionCollateral`, `PositionCollateralDecreased`, `CollateralDecreaseRequested`, `…RequestCancelled`, `…RequestExpired`, `…Declined` |
| forced exits | `PositionLiquidated`, `PositionLiquidationCredit`, `AccountLiquidationCredit`, `PositionDeleveragedV2`, `PositionUnwoundV2`, `PositionUnwoundWithoutPaymentV2` + the three V1 forms, `BuyToLiquidateStarted`, `BuyToLiquidateSettled` |
| trades | `MakerOrderFilledV2` + V1 `MakerOrderFilled` |
| markets | `ContractAddedV2` + V1 `ContractAdded`, `ContractPaused`, `ContractRemoved`, `InitialMarginFractionUpdated`, `MaintenanceMarginFractionUpdated`, `MaxOpenInterestUpdated` |
| prices & funding | `MarkUpdated`, `FundingEventCompleted` |
| exchange | `ExchangeInitialized`, `ExchangeHalted`, `Upgraded` |

Deliberately **not** in v1: every order event, every diagnostic, every admin/role
event, the oracle-report diagnostics, and the treasury transfers. Adding
`OrderRequestV2` + friends later buys us order-flow and cancel-rate analytics at
roughly a 20× increase in events handled; it is a phase-2 flag, not a day-1 cost.

---

## 4. Proposed `schema.graphql`

Conventions:

- `…CNS` = AUSD collateral micros (6 decimals), `…PNS` = price in the market's own
  `priceDecimals`, `…LNS` = lots in the market's own `lotDecimals`. Raw integers are
  stored as `BigInt`; nothing is pre-divided, because the scale is per market and
  comes off `ContractAddedV2`.
- `notionalCNS` is the one derived money figure: `lot × price` rescaled to AUSD
  micros using that market's decimals.
- **Volume is counted once per match**, from the maker fill. The taker fill is an
  aggregate over its whole order, so adding both would double count.
- Ids are strings. Feed rows use `"<txHash>-<logIndex>"`, daily buckets use
  `"<key>-<YYYY-MM-DD>"` in UTC.

```graphql
# ─────────────────────────────── reference ───────────────────────────────

type Exchange {                      # singleton, id = chain id ("143")
  id: ID!
  address: String!
  implementation: String!            # moves on Upgraded
  contractVersion: String!
  halted: Boolean!
  collateralToken: String!
  collateralDecimals: Int!
  minAccountOpenCNS: BigInt!
  accountCount: Int!
  marketCount: Int!
  openPositionCount: Int!
  tradeCount: BigInt!
  volumeCNS: BigInt!
  feesCNS: BigInt!
  liquidationCount: Int!
  liquidatedNotionalCNS: BigInt!
  rescuableLiquidationCount: Int!    # see §5
  spareBalanceAtLiquidationCNS: BigInt!
  lastUpgradeBlock: BigInt
  lastUpgradeAt: Timestamp
  updatedBlock: BigInt!
}

type Market {
  id: ID!                            # perpId; equals the REST API's market id
  perpId: BigInt!
  name: String!                      # "BTC", "MON" — from ContractAdded(V2)
  symbol: String!                    # often empty on chain; keep both
  priceDecimals: Int!                # NEVER hard-coded; learned from chain
  lotDecimals: Int!
  status: Int!
  paused: Boolean!
  listed: Boolean!                   # false after ContractRemoved
  initMarginFracHdths: BigInt!
  maintMarginFracHdths: BigInt!      # every liquidation price depends on this
  maxOpenInterestLNS: BigInt!
  feeSchedId: BigInt

  markPricePNS: BigInt               # latest only — no row per update
  markUpdatedBlock: BigInt
  markUpdatedAt: Timestamp
  lastFundingRatePct100k: BigInt
  lastFundingAt: Timestamp

  longLotsLNS: BigInt!               # tracked separately on purpose: in a perp the
  shortLotsLNS: BigInt!              # two must stay equal, so a divergence is a
  openInterestLNS: BigInt!           # self-check that our handlers are correct
  openPositionCount: Int!

  tradeCount: BigInt!
  volumeCNS: BigInt!
  feesCNS: BigInt!
  liquidationCount: Int!
  liquidatedNotionalCNS: BigInt!
  addedBlock: BigInt!
  addedAt: Timestamp!

  days: [MarketDay!]! @derivedFrom(field: "market")
}

type Trader {
  id: ID!                            # accountId
  accountId: BigInt!
  owner: String! @index              # wallet — only AccountCreated links the two
  createdBlock: BigInt!
  createdAt: Timestamp!
  forwardingAllowed: Boolean!        # the `fw` flag; no on-chain getter exists
  feeTier: Int!

  freeBalanceCNS: BigInt!            # running free (cross) AUSD
  depositedCNS: BigInt!
  withdrawnCNS: BigInt!
  marginDeployedCNS: BigInt!         # summed isolated margin of open positions

  realizedPnlCNS: BigInt!            # Σ deltaPnlCNS over realizing events
  fundingCNS: BigInt!                # Σ fundingCNS, signed
  feesPaidCNS: BigInt!               # insFee + protFee + maker fees
  netPnlCNS: BigInt!                 # realized + funding − fees
  volumeCNS: BigInt!
  tradeCount: Int!
  makerTradeCount: Int!
  takerTradeCount: Int!

  roundTrips: Int!                   # positions taken from open to flat
  wins: Int!
  losses: Int!
  winRate: BigDecimal! @config(precision: 10, scale: 4)
  bestRoundTripCNS: BigInt!
  worstRoundTripCNS: BigInt!

  liquidationCount: Int!
  liquidatedNotionalCNS: BigInt!
  liquidatedWithSpareBalanceCount: Int!   # §5 — the PerpGuard number
  spareBalanceAtLiquidationCNS: BigInt!
  marginAddCount: Int!
  marginAddedCNS: BigInt!

  openPositionCount: Int!
  firstTradeAt: Timestamp
  lastActiveAt: Timestamp!

  positions: [Position!]! @derivedFrom(field: "trader")
  liquidations: [Liquidation!]! @derivedFrom(field: "trader")
  days: [TraderDay!]! @derivedFrom(field: "trader")
}

# ───────────────────────── positions (isolated margin) ─────────────────────

enum Side { LONG SHORT }          # positionType 0 = LONG, 1 = SHORT (measured, §2.4)
enum PositionStatus { OPEN CLOSED LIQUIDATED DELEVERAGED UNWOUND }

type Position {
  id: ID!                            # "<perpId>-<accountId>-<epoch>"
  market: Market!
  trader: Trader!
  epoch: Int!                        # a flat pair can open a new position later
  side: Side!
  status: PositionStatus!

  lotLNS: BigInt!                    # 0 once closed
  peakLotLNS: BigInt!
  entryPricePNS: BigInt!
  depositCNS: BigInt!                # THE isolated margin backing this position
  peakDepositCNS: BigInt!
  leverageHdths: BigInt!

  marginAddedCNS: BigInt!            # via IncreasePositionCollateral
  marginRemovedCNS: BigInt!          # via PositionCollateralDecreased
  marginActionCount: Int!

  realizedPnlCNS: BigInt!
  fundingCNS: BigInt!
  feesCNS: BigInt!
  netPnlCNS: BigInt!
  isWin: Boolean                     # null while OPEN

  openedBlock: BigInt!
  openedAt: Timestamp!
  openTxHash: String!
  closedBlock: BigInt
  closedAt: Timestamp
  closeTxHash: String

  marginActions: [MarginAction!]! @derivedFrom(field: "position")
  liquidations: [Liquidation!]! @derivedFrom(field: "position")
}

type PositionCursor @internal {       # which epoch is live for a (market, trader)
  id: ID!                             # "<perpId>-<accountId>"
  epoch: Int!
  openPositionId: String
}

# ──────────────────────────────── feeds ───────────────────────────────────

type Trade {
  id: ID!                            # "<txHash>-<logIndex>" of the maker fill
  market: Market!
  pricePNS: BigInt!
  lotLNS: BigInt!
  notionalCNS: BigInt!
  maker: Trader!                     # from MakerOrderFilledV2 itself
  taker: Trader                      # paired within the tx; null if unresolved
  takerSide: Side
  makerFeeCNS: BigInt!
  makerOrderId: BigInt!              # short recycled slot id — not a stable key
  builderId: BigInt!
  blockNumber: BigInt!
  timestamp: Timestamp! @index
  txHash: String!
  logIndex: Int!
}

enum ForcedExitKind { LIQUIDATION BUY_TO_LIQUIDATE DELEVERAGE UNWIND UNWIND_UNPAID }

type Liquidation {
  id: ID!                            # "<txHash>-<logIndex>"
  kind: ForcedExitKind!              # one feed for every way a position is taken away
  market: Market!
  trader: Trader!
  position: Position!
  side: Side!

  markPricePNS: BigInt!
  execPricePNS: BigInt!              # liq / deleverage / unwind price
  lotLNS: BigInt!                    # lots taken
  remainingLotLNS: BigInt!
  isFull: Boolean!
  notionalCNS: BigInt!

  realizedPnlCNS: BigInt!
  fundingCNS: BigInt!
  marginLostCNS: BigInt!             # isolated deposit consumed
  insuranceCreditCNS: BigInt!        # from PositionLiquidationCredit in the same tx
  badDebtCNS: BigInt!                # UNWIND_UNPAID amountOwedCNS
  onOrderBook: Boolean!

  freeBalanceBeforeCNS: BigInt!      # §5
  wasRescuable: Boolean!
  marginToSurviveCNS: BigInt!

  blockNumber: BigInt!
  timestamp: Timestamp! @index
  txHash: String!
  logIndex: Int!
}

enum MarginActionKind {
  ADD REMOVE_REQUESTED REMOVE_SETTLED REMOVE_CANCELLED REMOVE_EXPIRED REMOVE_DECLINED
}

type MarginAction {
  id: ID!                            # "<txHash>-<logIndex>"
  kind: MarginActionKind!
  market: Market!
  trader: Trader!
  position: Position!
  amountCNS: BigInt!
  positionDepositAfterCNS: BigInt!
  freeBalanceAfterCNS: BigInt!
  reason: String                     # REMOVE_DECLINED only
  blockNumber: BigInt!
  timestamp: Timestamp! @index
  txHash: String!
}

enum CollateralFlowKind { DEPOSIT WITHDRAWAL }

type CollateralFlow {
  id: ID!                            # "<txHash>-<logIndex>"
  kind: CollateralFlowKind!
  trader: Trader!
  amountCNS: BigInt!
  balanceAfterCNS: BigInt!
  blockNumber: BigInt!
  timestamp: Timestamp! @index
  txHash: String!
}

type FundingEvent {
  id: ID!                            # "<perpId>-<fundingEventBlock>"
  market: Market!
  specifiedRatePct100k: BigInt!
  actualRatePct100k: BigInt!
  fundingPricePNS: BigInt!
  fundingPaymentPNS: BigInt!
  fundingSumPNS: BigInt!
  blockNumber: BigInt!
  timestamp: Timestamp! @index
}

# ────────────────────────── daily aggregates ──────────────────────────────

type MarketDay {
  id: ID!                            # "<perpId>-<YYYY-MM-DD>"
  market: Market!
  day: Timestamp! @index

  volumeCNS: BigInt!
  tradeCount: Int!
  feesCNS: BigInt!
  activeTraderCount: Int!

  openInterestOpenLNS: BigInt!
  openInterestCloseLNS: BigInt!
  openInterestHighLNS: BigInt!
  openInterestLowLNS: BigInt!

  markOpenPNS: BigInt!
  markHighPNS: BigInt!
  markLowPNS: BigInt!
  markClosePNS: BigInt!

  liquidationCount: Int!
  liquidatedNotionalCNS: BigInt!
  liquidatedMarginCNS: BigInt!
  rescuableLiquidationCount: Int!

  positionsOpened: Int!
  positionsClosed: Int!
  marginAddedCNS: BigInt!
  marginRemovedCNS: BigInt!

  fundingRateSumPct100k: BigInt!
  fundingEventCount: Int!
}

type MarketDayTrader @internal {      # set membership for activeTraderCount
  id: ID!                             # "<perpId>-<YYYY-MM-DD>-<accountId>"
}

type TraderDay {
  id: ID!                            # "<accountId>-<YYYY-MM-DD>"
  trader: Trader!
  day: Timestamp! @index
  volumeCNS: BigInt!
  tradeCount: Int!
  realizedPnlCNS: BigInt!
  fundingCNS: BigInt!
  feesCNS: BigInt!
  netPnlCNS: BigInt!
  wins: Int!
  losses: Int!
  liquidationCount: Int!
  marginAddedCNS: BigInt!
  marginRemovedCNS: BigInt!
  depositedCNS: BigInt!
  withdrawnCNS: BigInt!
  endFreeBalanceCNS: BigInt!
}
```

---

## 5. The four definitions worth arguing about

**Realized PnL.** `Σ deltaPnlCNS` from `PositionDecreased`, `PositionClosed`,
`PositionInverted`, `PositionLiquidated`, `PositionDeleveragedV2`. `fundingCNS` and
fees are kept in separate columns so the dashboard can show gross and net; `netPnl`
is the sum of the three. Unrealized PnL is **not** here — it moves with every mark
price and belongs to the live risk engine.

**Win rate** is per **round trip**, not per fill: a `Position` from open to flat is
one round trip, and it wins if its lifetime `netPnlCNS > 0`. A forced exit
(liquidation, deleverage, unwind) closes the round trip and is recorded as a loss
regardless of the arithmetic. Per-fill win rates flatter scalpers and mean nothing;
this definition is what a trader would recognise. `winRate` is 0 until the first
round trip completes, never null.

**Volume** is `notionalCNS` summed once per match, taken from the maker fill.
Acceptance test: our trailing-24h `Market.volumeCNS` should land on the REST API's
`markets[].state.dva` for the same market. If it does not, the handler is wrong.

**"Rescuable" liquidation — the number this whole product exists to show.**
Perpl is isolated margin, so free account balance is never pulled in to save a
losing position. `PositionLiquidated` hands us `posDepositCNS` (the margin that was
consumed) and `accBalanceCNS`. We also carry our own running `Trader.freeBalanceCNS`
from deposits, withdrawals and fills, so `freeBalanceBeforeCNS` is read **before**
the handler applies the event, which avoids the ambiguity of whether
`accBalanceCNS` already includes liquidation proceeds. A liquidation is *rescuable*
when `freeBalanceBeforeCNS >= marginToSurviveCNS` — the trader was holding enough
spare AUSD, in the same account, to have stayed above maintenance margin, and got
liquidated anyway. That is the headline: *"N liquidations on Perpl mainnet in the
last 30 days happened to traders who had the money sitting right there."*

`marginToSurviveCNS` is risk maths, so per CLAUDE.md it is a **pure function in
`packages/shared`, unit-tested against `fixtures/position1.json`**, imported by the
handler. It is not reimplemented in the indexer.

---

## 6. Open questions for you

1. **`Trade.taker`.** Filling it without indexing `OrderRequestV2` means pairing a
   maker fill with the next `Position*` event in the same transaction for the same
   `perpId` but a different `accountId`. That held on the transaction above; I want
   to validate it over a few thousand real transactions first. `taker` stays
   nullable so a failed pairing leaves a gap instead of a wrong attribution.
   Alternative: index `OrderRequestV2` for exact taker scoping, at ~20× the events.
2. **Backfill depth.** 53.8M blocks. Full history gives real aggregates and a real
   liquidation record; a recent-window start block gives a demo in minutes. I would
   run the full backfill once to Postgres and keep it, but it is worth agreeing the
   fallback before I start it. (I am still measuring the exact historical event
   counts — I will bring you the number.)
3. **No Docker here.** `envio dev` runs Postgres + Hasura in Docker, and this box
   has no Docker. Options: install it, point the indexer at an external Postgres, or
   deploy to Envio Cloud. This decides how "run what you write" works for the
   indexer.
4. **CLAUDE.md's venue rule.** "Venue-specific code lives ONLY in
   `packages/shared/src/venues/`." `apps/indexer` is unavoidably Perpl-specific.
   I propose the indexer counts as a data source rather than a consumer, and that
   the bot, web and risk engine read it only through a venue-agnostic analytics
   interface in `packages/shared` — so nothing downstream learns the word `perpId`.
   Say if you would rather draw that line somewhere else.

---

## 7. What I would build on approval, in order

1. `pnpm add -D envio` in `apps/indexer`, `config.yaml`, `codegen`. Note the V3 config
   key is **`chains`**, not `networks`, and `ENVIO_API_TOKEN` is read from the
   environment. Needs `field_selection: { transaction_fields: ["hash"] }` because the
   feed ids and the maker/taker pairing are per transaction.
2. `Market` + `Exchange` handlers only, started at block 54,773,010. Verify against
   chain: 9 markets, the right `priceDecimals`/`lotDecimals` per market, version 1.7.5.
3. Accounts and collateral flows. Verify `numberOfAccounts()` = our `accountCount`.
4. Positions, isolated-margin actions, and the long/short invariant
   `Market.longLotsLNS == Market.shortLotsLNS`, asserted as we go.
5. Trades and the daily aggregates. Verify trailing-24h volume against the REST
   API's `markets[].state.dva`.
6. Liquidations, the forced-exit feed, and `marginToSurviveCNS` from the pure risk
   function in `packages/shared`, unit-tested against `fixtures/position1.json`.

Each step is a commit with its verification output pasted in, per CLAUDE.md.

---

## 8. Where the built schema differs from this proposal

Five changes, all forced by what mainnet actually emits.

**Open interest is a signed delta series, not a level.** `longLotsLNS` /
`shortLotsLNS` / `openInterestLNS` became `longLotsDeltaLNS` /
`shortLotsDeltaLNS` / `openInterestDeltaLNS`. There is no exact anchor available
at our start block: the public RPC serves archive state only a few days back, and
`eth_call` at block 100,000,000 is rejected outright. An approximate anchor would
have broken the long == short check, which is the one thing that makes a handler
bug visible, so the series starts at zero and carries only real deltas. Absolute
open interest comes from the venue's own market state. The day buckets follow:
`oiDeltaOpenLNS` and friends.

**`Position.lotKnown`.** A full close emits ONLY `PositionClosed`, and that event
publishes no lot figure at all. A position first seen there has an unknown size,
so it contributes nothing to the open-interest series until the fill that follows
it in the same transaction supplies the lots. `Market.oiUnverifiedCloseCount`
counts any that are still unresolved, so long == short is exact whenever it is
zero rather than approximately true.

**`Position.entryPriceKnown`.** `PositionDecreased` carries no price, so a
position first seen decreasing has no entry price and `marginToSurviveCNS` and
`wasRescuable` are null on any liquidation of it. `PositionIncreasedV2` does
publish the blended entry, so a position adopted there keeps a real entry price.

**`Liquidation.hadSpareBalance` joined `wasRescuable`.** `wasRescuable` is the
strong claim and is null when the entry price is unknown; `hadSpareBalance` is
always computable and never null, so the headline never has a hole. Both are
counted on `Exchange`, `Market`, `MarketDay` and `Trader`, and
`Exchange.liquidationsWithUnknownPositionCount` keeps the gap visible.

**`TxScope` and `Exchange.unattributedTakerFeeCNS`.** `TakerOrderFilledV2` names
no account, so the taker is whoever the preceding position event belonged to;
`TxScope` is the per-transaction scratch row that joins them, and also recovers
unsized closes. When no join is possible the fee lands in
`unattributedTakerFeeCNS` instead of being dropped.

Fees are taken from the fill events only. `insFeeCNS` + `protFeeCNS` on a
position event is the taker fee decomposed — 3150 + 17848 exactly equals the
20998 on the matching `TakerOrderFilledV2` — so counting both would double count.

---

## 9. The open questions, resolved

1. **`Trade.taker`** — shipped nullable with the transaction-scope heuristic, not
   validated over thousands of transactions. A null is honest.
2. **Backfill depth** — a recent window, `ENVIO_PERPGUARD_START_BLOCK`, default
   100,000,000 (~30 days). Measured rate on this box is ~15,200 blocks/min, so a
   full 30-day backfill is about 9 hours; it runs once. For reference, the full
   history the scan measured, across all 53.8M blocks:

   | event | count |
   | - | - |
   | `PositionIncreasedV2` | 11,195,216 |
   | `MakerOrderFilledV2` | 8,713,152 |
   | `PositionDecreased` | 8,598,428 |
   | `PositionClosed` | 6,568,145 |
   | `PositionOpenedV2` | 6,192,462 |
   | `TakerOrderFilledV2` | 5,448,175 |
   | `PositionInverted` | 662,136 |
   | `FundingEventCompleted` | 35,424 |
   | `CollateralDeposit` | 15,270 |
   | `IncreasePositionCollateral` | 15,090 |
   | `CollateralWithdrawal` | 10,927 |
   | `OrderForwardingUpdated` | 5,351 |
   | `AccountCreated` | 5,341 |
   | `PositionLiquidated` | 3,388 |
   | `ContractPaused` | 18 |
   | `PositionDeleveragedV2` | 11 |
   | `ContractAddedV2` | 4 |
   | `PositionUnwoundV2`, `PositionLiquidationCredit`, `PositionCollateralDecreased`, `CollateralDecreaseRequested`, `ContractRemoved`, `ExchangeHalted`, `BuyToLiquidate*` | 0 |

   `AccountCreated` = 5,341 matches `numberOfAccounts()` on chain exactly, which
   is a useful independent check on the scan itself. Note `ContractAddedV2` = 4
   against 10 live markets: the other six were listed with the V1 form, which is
   why market scaling is bootstrapped from the contract.
3. **No Docker** — local Postgres instead, one database for the indexer and the
   backend. Hasura is not running, so `ENVIO_HASURA=false`; the GraphQL layer
   comes with the Envio Cloud deployment. Indexing is unaffected.
4. **Venue rule** — added to CLAUDE.md as an amendment: `apps/indexer` is a
   venue-specific data source, and consumers go through a venue-agnostic
   analytics interface in `packages/shared`.
