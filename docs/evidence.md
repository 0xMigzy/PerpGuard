# Evidence

Verified runs against live networks, recorded as they happened. Each entry says
what was sent, what came back, and what it proves — so the submission can point
at real outcomes rather than at code that looks right.

**This repo is public.** Nothing in this file may contain an API key, a key
secret, a public key id, a wallet private key, or any value derived from one.
Account ids, order ids, market ids and block numbers are public on chain and are
fine to record.

## 2026-09-26 — testnet write path: place, then cancel

The day-1 write-path check, `pnpm order:test` (`scripts/placeTestOrder.ts`).

| | |
| --- | --- |
| network | Perpl **testnet**, chain **10143** |
| trading socket | `wss://testnet.perpl.xyz/ws/v1/trading` |
| account | **710** |
| market | **16** (BTC), price 1dp, size 5dp, `order_ttl_blocks` **20** |
| order | PostOnly long, 0.00001 BTC, 2x, 50% below mark |

All three runs below used an Ed25519 API key signing through the Perpl
forwarder, against our own testnet account.

### Run 1 — place confirmed, cancel timed out

| step | result |
| --- | --- |
| place | `mt: 3` code 0, then **`mt: 24` CONFIRMED**, order **4312150769680** |
| cancel | `mt: 3` code 0, then **no `mt: 24` within 30000ms** — timed out |

The placement is the load-bearing part: the order reached a real `mt: 24`
outcome, not just the `mt: 3` forwarding ack. Reported as confirmed only after
`mt: 24`, which is the rule the executor is built around.

The cancel returned no outcome at all and was reported as UNKNOWN rather than as
success or failure.

### Why the cancel timed out

The first hypothesis was the 20-block TTL: the order self-expires roughly 10s
after it is sent, so the cancel could have been addressed to an order that was
already gone, and a cancel of an order that no longer exists may never produce
an `mt: 24`.

That turned out **not** to be what happened here. The cause was in our own code:
`PerplVenue.cancelOrder` correlated the outcome with

```ts
matches: (order) => order['id'] === orderId
```

but `mt: 23`/`mt: 24` entries carry **`oid`** (the wide, globally-unique order
id) and **`scid`** (the short per-contract id the explorer and `perpl-cli`
display) — and no `id` field at all. The docs render the entry as
`{ id, st, sr, r }`, which is where the wrong field name came from. So the
cancel's `mt: 24` did arrive and was discarded, and the wait ran its full 30s.
A matcher that matches nothing is indistinguishable from an answer that never
came.

Confirmed two ways: matching on `oid` makes the cancel confirm (runs 2 and 3),
and a regression test in `perpl-trading-socket.test.ts` delivers the real frame
to the old `order['id']` matcher and asserts it still times out.

The TTL hypothesis was worth ruling out rather than assuming, and it stays
handled on its own terms: a cancel timeout is now reconciled against the last
status seen for the order id instead of being treated as failure, and the cancel
is never re-sent with a fresh request id.

### Runs 2 and 3 — place and cancel, both confirmed

After the fix, with no change to the order's price or to any timing:

| run | order | place | cancel | ttl left when the cancel was sent |
| --- | --- | --- | --- | --- |
| 2 | **4312362647552** | `mt: 24` CONFIRMED | `mt: 24` CONFIRMED | ~17 of 20 blocks |
| 3 | **4312365596672** | `mt: 24` CONFIRMED | `mt: 24` CONFIRMED | ~17 of 20 blocks |

Both runs exited 0. The order was still `st: 2 Open, sr: 35 OrderPlaced` when
the cancel went out, with about 17 of its 20 blocks left — so the order never
needed to survive longer, and moving it nearer the mark would not have helped.
Distance from mark does not govern how long an order lives; `lb` does.

### What these runs prove

- The Ed25519 sign-in frame is accepted and the account snapshot arrives.
- Market id, tick scaling and `order_ttl_blocks` come from
  `GET /v1/pub/context`, not from anywhere in our code.
- A submission is admitted (`mt: 3` code 0) and its real outcome arrives
  separately (`mt: 24`). Nothing is reported as success before `mt: 24`.
- Order outcomes are correlated by `oid`, verified against live frames.
- A cancel that returns nothing is reconciled, not guessed at.

## 2026-09-28 — mainnet market-data feed: live prices, and a 30s outage

The price path, `pnpm prices` (`apps/backend/src/scripts/watch-prices.ts`).
Read-only: the public market-data websocket needs no key and cannot submit.

### Live prices from mainnet

| | |
| --- | --- |
| network | Perpl **mainnet**, chain **143** |
| socket | `wss://app.perpl.xyz/ws/v1/market-data` |
| subscribe | `mt: 5` → `market-state@143`, `heartbeat@143` |
| updates | `mt: 9`, keyed by market id; `mt: 100` heartbeat |

Decoding was cross-checked against `GET /v1/pub/context` on three markets with
three *different* `price_decimals`, so a wrong exponent could not pass:

| market | id | `price_decimals` | raw `mrk` | REST | websocket |
| --- | --- | --- | --- | --- | --- |
| BTC | 1 | 1 | 844111 | 84411.10 | 84,425.30 |
| ETH | 20 | 2 | 269228 | 2692.28 | 2,693.13 |
| SOL | 31 | 3 | 121912 | 121.91 | 121.94 |

Frame arrival measured over 25s on mainnet: **157 frames** (74 × `mt: 9`,
82 × `mt: 100`), inter-frame gap **median 165ms, p95 402ms, max 543ms**. That
measurement is what the 10s stall timeout is set against — ~20x the worst
healthy gap.

Also observed on mainnet: a quiet market goes `STALE` under a 10s `STALE_MS`
simply because its mark price has not moved. ETH sat stale for ~20s during one
run with the feed perfectly healthy. Staleness means "this price is old", not
"the feed is broken", and the UI needs to say so — worth deciding before the
risk engine treats the two the same.

### The 30-second outage (test double — superseded by the live run below)

Run against a local test double that speaks the same protocol on the real
mainnet market ids, **not** against the Perpl host — simulating the outage by
firewalling the real host was not permitted in this environment. The client
code, sockets, TCP resets, timers and backoff are all real; only the upstream
is local. Timings below are from `scratchpad/outage.log`.

**Superseded:** the same outage has since been run against the real mainnet
host by cutting the machine's network — see
[the live outage run](#2026-09-28--live-mainnet-outage-real-network-30s-wifi-cut).
That run is the evidence for the submission; this one is kept because its
millisecond timings and the three failures it exposed are what the
implementation was built against.

| t | event |
| --- | --- |
| `00:16:18.312` | upstream killed |
| `00:16:18.320` | `DISCONNECTED (socket closed with 1006)` — **8ms** to notice |
| | retries at **405ms, 980ms, 1835ms, 3566ms, 7812ms, 8348ms, 8963ms** |
| `00:16:28.8` | prices flip **STALE** (10s after the last tick, = `STALE_MS`) |
| `00:16:48.321` | upstream back |
| `00:16:50.257` | `RECONNECTED after 7 failed attempt(s)`, resubscribed |
| `00:16:50.559` | `subscribed (sequence-gap)` — heartbeat `sn` restarted, caught |
| `00:16:51.719` | prices flowing again, staleness cleared |

Recovered **1.9s** after the upstream returned, having been down 30s.

### Two failures this run exposed

**A dead connection that never closes.** A blackholed route produces no close
event: the socket stays open and silent while TCP retransmits for minutes. A
stall watchdog now treats 10s of silence as death and drops into the normal
backoff path. Verified: silence at `00:17:08.327`, caught at `00:17:20.260`
(`stalled: no frames for 11955ms`), reconnected **457ms** later.

**Our own keep-alive was hiding it.** The first version counted *any* inbound
frame as proof of life, including the `mt: 2` pong answering our own `mt: 1`
ping. A server that answers pings while pushing no market data is exactly the
dead feed the watchdog exists to catch, and with a 30s ping and a 10s stall
timeout the two timers aligned and the pong reset the clock — the watchdog
silently never fired through 17.5s of real silence. Proof of life is now
restricted to frames the server pushes on its own; replies (`mt: 2`, `mt: 6`)
do not count.

**A backoff ceiling that was a product decision in disguise.** At a 30s cap the
feed stayed dark **~25s after connectivity was already back**, because the
delay had grown past the outage. The ceiling is the worst-case blind window
after recovery, not a tuning knob, so it is now 10s — at most six attempts a
minute, far inside the documented ~5 connections per IP.

## 2026-09-28 — a quiet market is not a broken feed

`isStale()` conflated two different questions, so a caller could not tell "this
price is correct but old" from "we have lost the connection". Connection health
is now asked separately, via `feedStatus()` → `connected` / `reconnecting` /
`disconnected`, and `MarketFeed.canAct(marketId, feedStatus())` is the only
action gate. Both halves verified.

**Old price, healthy feed → actionable.** Live mainnet, `STALE_MS=1500` to
surface quiet markets inside a short run:

```
[00:30:59.400] feed=CONNECTED 18 ticks | BTC 84,702.30 184ms | ETH 2,696.60 8827ms quiet | SOL 122.61 4026ms quiet
[00:31:02.403] feed=CONNECTED 23 ticks | BTC 84,702.30 2467ms quiet | ETH 2,696.60 432ms | SOL 122.61 33ms
```

ETH's price was **10.8s old** and never blocked: nobody had traded it, so that
was the venue's current mark. **0 BLOCKED lines in the whole run.** ETH then
ticked and its age dropped back to 432ms on its own.

**Fresh-looking price, dead feed → refused.** From the outage run, the moment
the connection dropped:

```
[00:28:10.705] DISCONNECTED (socket closed with 1006) — retrying in 447ms, attempt 1
[00:28:10.999] feed=RECONNECTING 81 ticks | BTC 84,383.50 494ms BLOCKED | ETH 2,693.15 495ms BLOCKED | SOL 121.91 495ms BLOCKED
```

The price was **494ms old** — by age alone, indistinguishable from perfectly
healthy — and already frozen and unusable. This is the case age can never
catch, and the reason connection health has to be a separate question.

`reconnecting` blocks actions exactly as `disconnected` does; the two differ
only in what the UI may claim. A feed keeps calling itself `reconnecting` for
60s and then admits `disconnected`, because "reconnecting…" for ten minutes
while a monitor is blind is the kind of reassuring lie this product cannot
afford. It keeps retrying either way.

## 2026-09-28 — live mainnet outage: real network, 30s wifi cut

The outage test re-run against the **real Perpl mainnet host**, with the outage
caused by physically cutting the machine's wifi rather than by a local test
double. **This is the run that replaces the test-double outage run above**: the
upstream is now Perpl's own `wss://app.perpl.xyz/ws/v1/market-data`, so the DNS
failures, TCP resets and real reconnect handshake are all against production
infrastructure.

| | |
| --- | --- |
| network | Perpl **mainnet**, chain **143** |
| socket | `wss://app.perpl.xyz/ws/v1/market-data` (real host) |
| outage | wifi disabled at the OS level for **~30s** |
| observed by | `pnpm prices` status line, watched live by the operator |

| phase | what the feed reported |
| --- | --- |
| wifi down | `feed=RECONNECTING`, every market **BLOCKED** |
| wifi still down | stayed `RECONNECTING` and blocked for the whole ~30s |
| wifi back | recovered to `feed=CONNECTED` **within a few seconds** |
| after recovery | prices ticking again, ages back to fresh, nothing blocked |

### What this run proves that the test double could not

- The reconnect path works against Perpl's real websocket endpoint, including a
  real TLS and subscribe handshake after the interface came back — not just
  against a loopback server we wrote.
- Losing the network mid-run is detected and surfaced as `RECONNECTING`, and
  **every market is blocked for the entire outage**, so no action could have
  been taken on a frozen price. This is the rule from the quiet-market entry
  holding on the real network: the prices on screen looked recent, and were
  refused anyway because the connection, not the age, is the gate.
- The monitor never looked healthy while it was blind. The status line said
  `RECONNECTING` and stayed saying it, which is what the product rule requires.
- Recovery is automatic and fast — no restart, no manual resubscribe — and the
  post-recovery prices are fresh rather than the pre-outage values replayed.

### Precision of this entry

The timings here are as observed on the status line, not parsed from a log: no
log file was captured for this run, and the ~30s outage and "within a few
seconds" recovery are the operator's reading rather than measured intervals.
The millisecond figures worth quoting — 8ms to notice the close, the backoff
ladder, the 1.9s recovery, the 11955ms stall detection — remain the test-double
run's, where the log exists. What this run adds is that the same behaviour holds
against the real host under a real network failure.

## 2026-09-28 — the Position wire shape, read off testnet

`Position` is the one wire object Perpl does not document.
`types-and-errors.md` says the full shapes are "documented alongside the
endpoints that return them"; `rest.md` and `websocket.md` both say see Types.
The reference is circular. The Rust SDK is a path dependency on an unpublished
crate, and the TypeScript docs type position history as `any[]`. CLAUDE.md
forbids guessing field names, so the wire was the only source left — and an
account with no position receives `mt: 26` with `d: []`, which teaches nothing.

So one real position was opened and closed on testnet at the exchange minimum,
with `scripts/probePositions.ts`. Account 710, BTC market 16, **0.00001 BTC**
(one size unit) at 2x — about **$0.83** of notional. Frames in
`fixtures/positions-testnet.json`.

### The shape

```json
{"at":{},"mkt":16,"acc":710,"pid":4354895577089,"rq":0,"oid":0,
 "st":1,"sr":0,"sd":1,"c":"417125","ep":833798,"s":1,
 "fee":"288","cfee":"0","efs":117606,"lv":200,
 "cpnl":"0","dpnl":"0","fnd":"0","pay":"0","xfs":0,
 "ots":{"b":66450433,"t":1790611779000,"tx":2}}
```

| Field | Meaning | Confirmed by |
| --- | --- | --- |
| `pid` | Position id — the `lp` a close is addressed to | the close was accepted against it |
| `mkt` / `acc` | market id, account id | 16 / 710, both known independently |
| `sd` | side. **1 = Long, 2 = Short** | docs' PositionType table, and the long we opened came back 1 |
| `st` | PositionStatus. 1 Open, 2 Closed | 1 while open, 2 after the close |
| `sr` | PositionStatusReason. 21 PositionOpened, 13 PositionClosed | both observed |
| `s` | size, scaled by `size_decimals` | 1 unit = 0.00001 BTC, and 0 after the close |
| `ep` | entry price, scaled by `price_decimals` | 833798 = $83,379.8 |
| `xp` | EXIT price. **Present only on a close** | 834436 = $83,443.6 |
| `c` | isolated margin, AUSD **decimal string** | "417125" = 0.417125 AUSD |
| `lv` | leverage, hundredths | 200 = 2x, as sent |
| `fee` / `cfee` | fee and cumulative fee, decimal strings | "288" = 3.45bps of $0.8338, the taker fee exactly |
| `dpnl` | realized PnL, decimal string | "638" — see the ledger below |
| `fnd` / `pay` | funding accrued / paid, decimal strings | "0" over a 65-second position |
| `efs` / `xfs` | funding sum at entry / at exit | 117606 both, no funding event in between |
| `ots` | opening block timestamp | matches the opening transaction |

There is **no mark price and no liquidation price on the position**. Both are
ours to compute — which is what the risk engine is for.

### The ledger closes exactly

    start   10000000000 micros
    open      -     288   taker fee, 3.45bps of $0.8338
    close     -     288   taker fee
    pnl       +     638   (834436 - 833798) / 10 * 0.00001 BTC
    -------------------
    end     10000000062   — exactly what the mt:19 WalletSnapshot then reported

Every published figure reconciles to the micro, which is the real check that
the field meanings above are right rather than merely plausible.

### Three things that will bite later

**A snapshot is not an update.** The same position in `mt: 26` and in `mt: 27`
differs: the snapshot carries `sr: 0` (Unspecified) rather than the real
reason, an empty `at: {}`, and no `e[]` event history. State versus state plus
why. Reading a reason off a snapshot gets Unspecified, not the truth.

**A closed position is still delivered.** The close arrives as a row in `d`
with `st: 2`, `s: 0`, `c: "0"` — not as an omission. A tracker that upserts
whatever arrives will hold a zero-size position forever. Drop anything whose
`st` is not 1. Only a *later* sign-in omits it: the snapshot after the close
was `d: []`.

**`sd` is not `positionType`.** The API wire uses 1 = Long, 2 = Short. The
contract events the indexer reads use 0 = LONG, 1 = SHORT. The value `1` is
therefore Long on one and SHORT on the other, and nothing about either
encoding is self-describing. `sideOf()` in `apps/indexer/src/lib/scale.ts`
must never be pointed at wire data.

### UNVERIFIED: a liquidated position may not look like this

Everything above is one position closed **by the user**, on purpose, at a
profit. A position closed by LIQUIDATION, deleveraging or unwinding is
documented to carry a different `st` (3 Liquidated, 4 Deleveraged, 5 Unwound)
and a different `sr` (19 PositionLiquidated, 15 PositionDeleveraged,
22 PositionUnwound), but we have not seen one on the wire and cannot force the
case today — it would mean deliberately losing a real position to the engine.

Treat the forced-exit shapes as **assumed, not measured**. In particular do not
assume `xp` is present, or that `c` returns to "0", on a liquidation. The
decoder should handle any `st` outside 1 by treating the position as gone,
which is correct for all of 2–5 regardless of what the other fields do.

## 2026-09-29 — the account stream's `sn` is the block number

`scripts/probeHeartbeatSn.ts` (`pnpm sn:probe`), read-only: signs in, listens,
places nothing. Run because the trading socket's gap detector expects heartbeat
`sn` to advance by exactly `+1`, and a false gap would mark the position set
untrustworthy and stop the risk loop assessing a healthy account — the same
class of failure as an indexer reporting itself 0 blocks behind while frozen.

| | |
| --- | --- |
| network | Perpl **testnet**, chain **10143** |
| socket | `wss://testnet.perpl.xyz/ws/v1/trading` |
| account | **710** |
| window | 100s, 327 heartbeats |

| question | measured |
| --- | --- |
| is `sn` the block number? | `sn == h` on **327 of 327** heartbeats |
| | `sn == at.b` in all **5** frames of `fixtures/positions-testnet.json` |
| does a heartbeat land on every block? | `sn` delta was `+1` on **326 of 326** intervals |
| do snapshots advance it? | no — `mt: 19`, `23`, `26` all shared one `sn` |
| false gaps in the window? | **0** |

Sign-in `sn` was 66605626 in one run and 66605929 in another, with `mt: 19`,
`mt: 23` and `mt: 26` sharing it each time. The first capture's 66448894 was the
same effect.

So the `+1` expectation is correct, and the existing detector — which reads `sn`
only off `mt: 19` and `mt: 100` — was already right. What was missing was the
reason, without which the next person to "fix" the tracker by reading `sn` off
every frame would have broken it.

### The trap this found

`mt: 2`, the pong, carries its own unrelated counter: `sn` **1, 2, 3** across
three pings, with no `h` and no `at`. Our `mt: 1` ping carries no `sn` at all,
so it is the server's counter, not an echo. A tracker that read it would compute
a gap of tens of millions against a perfectly healthy socket. This is the same
reason the market-data feed's proof-of-life ignores replies.

## 2026-09-29 — the risk loop against a real position: DANGER, then WATCH

The whole read path end to end, `pnpm risk:live --open`
(`apps/backend/src/scripts/live-risk-run.ts`): the live market feed, the live
authenticated account, the pure risk engine and the state machine, over one real
testnet position.

**Opened at MINIMUM SIZE and MAXIMUM LEVERAGE on purpose.** At 2x, one size unit
of BTC sits at a ~46% buffer and the loop reports SAFE for as long as anyone
cares to watch — that proves the plumbing and nothing else. At the market
maximum the buffer lands at 2.67%, which is DANGER on our thresholds and within
0.01pp of where `fixtures/position1.json` sits. So the run shows a real
classification and then a real transition, at about **$0.83 of notional**.

| | |
| --- | --- |
| network | Perpl **testnet**, chain **10143** |
| account | **710**, `fw true`, not frozen |
| market | **16** (BTC), maxLeverage **15x**, mmr **0.04**, price 1dp, size 5dp |
| position | long **0.00001 BTC** at **15x**, the market maximum |
| thresholds | watch 8/9%, danger 3/4%, dwell 60s |

Projected before anything was risked, from `getRiskConfigs()` off the live
context: 2x → 46.00%, 5x → 16.00%, 10x → 6.00%, **15x → 2.67%**. The run then
measured 2.67%. The projection is what made this safe to do at all.

### The transitions

| t | event |
| --- | --- |
| `+5.8s` | baseline: `feed=connected positions=live tracked=0` |
| `+5.8s` | OPEN sent, `t: 1`, `s: 1`, `lv: 1500` |
| `+6.7s` | `mt: 24` **st 4 Filled, sr 43 TakerOrderFilled** |
| `+6.7s` | **(none) -> DANGER**, buffer **2.67%**, liq **811311**, mark **833543** |
| `+9.7s` | position `pid 4365441302529`, margin **0.0557 AUSD**, 15x |
| `+9.7s`–`+79.7s` | held DANGER through the 60s dwell, buffer 2.67–2.71% |
| `+79.7s` | ADD MARGIN sent: **27460 micros** to reach a 6% buffer |
| `+81.9s` | **DANGER -> WATCH**, buffer **6.00%**, liq **783851** |
| `+88.7s` | CLOSE sent |
| `+90.0s` | `mt: 24` **st 4 Filled**, position gone, `tracked=0` |

A state change in each direction, against a real account: the opening
classification from a real fill, and a softening that had to earn both the exit
threshold and the dwell time. Nothing was reported before `mt: 24` except the
margin top-up, for the reason below.

Also visible, in the run that added margin twice: at a **9.32%** buffer the
position stayed **WATCH** rather than going SAFE, because only 17s of the 60s
dwell had been served. The asymmetry working on live data — the buffer had
cleared the 9% exit and the all-clear still had to wait.

### ADDING MARGIN REPORTS FAILURE AND APPLIES ANYWAY

The finding of this run, and the one thing here that contradicts a rule the repo
was built around.

`t: 6` IncreasePositionCollateral comes back **`st: 7 Failed, sr: 32
OrderDescIdTooLow`** on `mt: 24` — while the collateral **is credited, by exactly
the amount sent**. Four times across three runs:

| rq | `lfr` before | reported | margin before → after | applied | requested |
| --- | --- | --- | --- | --- | --- |
| 12 | 11 | st 7, sr 32 | 0.055822 → 0.083001 | 27179 | 27179 |
| 15 | 14 | st 7, sr 32 | 0.0559 → 0.083584 | 27684 | 27684 |
| 16 | 15 | st 7, sr 32 | 0.083584 → 0.111268 | 27684 | 27684 |
| 19 | 18 | st 7, sr 32 | 0.0557 → 0.08316 | 27460 | 27460 |

The request id was **never stale**: it was the correct `lfr + 1` every time, and
`lfr` advanced on the "failed" request anyway. So `OrderDescIdTooLow` does not
mean what its name says for this order type. The raw frame, verbatim:

```json
{"rq":15,"mkt":16,"acc":710,"oid":4365423542272,"scid":0,"st":7,"sr":32,
 "t":6,"r":true,"os":0,"fp":0,"fs":0,"f":"0","fl":4,"lv":0}
```

**How this was established, including the mistake.** Rows 15 and 16 are the same
top-up sent twice: the first investigation treated `sr 32` at face value, assumed
a stale request id, and re-sent with a fresh one. The margin was added **twice** —
0.0559 → 0.083584 → 0.111268 AUSD. That is what proved the point, and it is
exactly the bug this venue's behaviour sets a caller up for. On mainnet it is a
trader's collateral committed twice over because the venue said the first attempt
failed. The auto-retry is gone from the script; what replaced it reconciles the
position's margin before and after and reports which actually happened.

So, recorded in CLAUDE.md and in the builder's own docs:

- **This is the one action whose outcome is not on `mt: 24`.** Reconcile it
  against the position's `c`. Nothing else says whether the collateral landed.
- **Never re-send on the reported failure**, the same rule as a cancel timeout
  and for the same reason.
- **Never report the failure to the user either.** Telling someone their rescue
  failed when it worked is how they double it by hand.

The final run's reconciliation line, which is what a caller should do:

```
margin is now 0.08316 AUSD (was 0.0557): 27460 micros applied, 27460 requested
  — LANDED, while the order reported "rejected"
```

### What this run proves

- The risk engine's projected buffer matched the live one: **2.67% predicted,
  2.67% measured**, off market config read from `GET /v1/pub/context`.
- The loop classifies a real fill within a second of `mt: 24`, and both
  transitions came from real venue data, not a fixture.
- De-escalation is gated in practice, not just in unit tests: DANGER held for the
  full 60s dwell, and a 9.32% buffer stayed WATCH with 17s served.
- `feed` and `positions` health are reported as separate answers throughout
  (`feed=connected positions=live`), which is what makes "position data is stale"
  sayable at all.
- The position opened and closed cleanly. No position was left open.

## 2026-09-29 — alert cooldown state is in memory: a known limitation

The alerts layer keeps its per-position history — cooldown timestamps, the
once-per-entry WATCH latch, the once-per-outage blind latches — in a `Map` in the
`AlertEngine` process, not in Postgres. `alert_log` records what was *delivered*;
it is not read back to reconstruct cooldowns.

**The consequence, stated plainly: a restart may re-alert a position once.** If
the process dies 30 seconds after sending a DANGER alert and comes back, the next
assessment of that position looks like the first one it has ever seen, and the
alert goes out again. The trader gets a duplicate warning.

**Why that is the right failure direction.** The alternative is persisting the
cooldown, and its failure mode is the mirror image: a cooldown that survives a
restart can *swallow* the first DANGER alert after one. Those two are not
symmetric.

- A duplicate warning costs the trader a few seconds and some annoyance. They
  look at the position, see it is the one they already knew about, move on.
- A swallowed warning costs them the position. They are never told, and the thing
  that would have told them is sitting in a database saying "already handled".

A risk monitor gets to be wrong in one of those two directions, and it should
always be the noisy one. Same principle as escalation never being gated on dwell
time in `risk/state.ts`: a warning is never delayed, only an all-clear is.

**What would change this.** Persisting cooldowns is only safe alongside a
liveness record — something that says "this process was alerting continuously
across that window" — so a cooldown loaded from the database can be distinguished
from one that merely predates a gap. Without that distinction the persisted
version cannot tell "I already said this a minute ago" from "I was dead for an
hour and have no idea what happened". That is worth building if PerpGuard ever
runs multiple alerting processes, because then the in-memory version also stops
working: two processes would each alert once. It is not worth building for one.

Recorded because it is a real limitation of a shipped component, not a TODO: the
behaviour is deliberate, tested, and documented in `alerts/types.ts` on
`AlertHistory` and in `alerts/schema.sql`.

## 2026-09-30 — the actions layer against a real position: sr 32 resolved to APPLIED

`pnpm actions:live --twice` (`apps/backend/src/scripts/live-action-run.ts`). The
first time PerpGuard has moved money through the actions layer rather than
through an investigation script.

| | |
| --- | --- |
| network | Perpl **testnet**, chain **10143** |
| account | **710**, `fw true`, `frozen false` |
| market | **16** (BTC), 15x (the market maximum), 1 size unit |
| position | `pid` **4382847991809**, long, 0.00001 BTC |

### Two top-ups, both reported as failures, both APPLIED

| run | `rq` | `oid` | reported on `mt: 24` | margin before → after | applied | requested | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 24 | 4382981816320 | `st: 7 Failed, sr: 32` | 55616 → 66765 | 11149 | 11149 | **applied** |
| 2 | 25 | 4382990663683 | `st: 7 Failed, sr: 32` | 66765 → 77765 | 11000 | 11000 | **applied** |

One send each, one `mt: 24` entry each, one distinct `rq` each. The script prints
that count so "without a resend" is a number rather than a claim.

The state machine followed the money on live data: **DANGER 2.66% → 4.00%** on the
first top-up (the engine asked for exactly `dangerExitPct`, and the measured
buffer landed on it), then **DANGER → WATCH at 5.32%** on the second.

### The reported status and the outcome, side by side

Run 1's `mt: 24` entry, verbatim:

```json
{"rq":24,"mkt":16,"acc":710,"oid":4382981816320,"scid":0,"st":7,"sr":32,
 "t":6,"r":true,"os":0,"fp":0,"fs":0,"f":"0","bfa":"0","fl":4,"mm":10,
 "lv":0,"mnp":1000}
```

and the `action_log` row for the same action:

```
live:1790743366529:16  add-margin  margin requested=11149 before=55616
  settled: outcome=applied reported=rejected after=66765
```

Two columns, two answers, both kept. That is the whole design: `reported_status`
is what the venue said and `outcome` is what the position showed, and for this
order type they routinely disagree.

### The one-in-flight rule, against the real venue

`--twice` fires a second attempt 150ms after the first, while it is genuinely in
flight:

```
OUTCOME  REFUSED
CODE     already-in-flight
DETAIL   an action on market 16 is already in flight (live:1790743366529:16, sent
         150ms ago) and has not settled. Refusing rather than queueing: a second
         action sent behind the first is how the same top-up lands twice.
```

Refused, not queued, and never sent — so the venue saw one `rq`, not two. This is
the specific defence against the mistake that produced rows 15 and 16 of the
2026-09-29 table.

### NEW FINDING: `lfr` says whether a forwarded request reached the contract

Getting to the run above took three attempts to open a position, and the first two
are worth recording because they look exactly like a bug in our code and are not.

| attempt | frame | `mt: 3` | `mt: 24` | `lfr` | free balance | position |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | market order, `rq 23` | code 0 | **none in 30s** | 22 → **22** | unchanged | none |
| 2 | crossing limit, `rq 23` | code 0 | **none in 20s** | 22 → **22** | unchanged | none |
| 3 | market order, `rq 23` | code 0 | `st: 4 Filled, sr: 43` in **1.5s** | 22 → **23** | −55904 micros | opened |

All three sent `rq 23`, because **`lfr` never advanced on the two that produced
nothing** — so the request id was never consumed and the third attempt could reuse
it. That is the diagnostic:

- **`mt: 3` code 0 means the forwarder accepted the frame, and nothing more.** It
  does not mean the request reached the contract. Already the rule for reporting
  success; this is a second, independent reason for it.
- **`lfr` advancing is the evidence that it did reach the contract.** It advances
  even on a request the contract *rejects* — the `sr 32` runs proved that, since
  every one of those "failed" top-ups moved it. So `lfr` unchanged after an
  `mt: 3` means the frame never landed on chain at all.
- Therefore a forwarded request with no outcome and no `lfr` movement has
  consumed nothing, and its `rq` is still the correct next one.

**This is not a frame problem, a book problem, or a liquidity problem.** The frame
that failed twice is byte-identical in shape to the one that succeeded, the book
is real (bid 83320.1 / ask 83330.1 at the time, and attempt 3 filled against it as
a taker in one block), and the account had ~10000 AUSD free throughout. It is the
**forwarder dropping requests intermittently** on testnet — two of three, then one
of one, then one of one.

**What the actions layer did about it, which is the point.** Nothing was re-sent
at any stage. Each dead attempt was reconciled against the position and the
balance, both said nothing had happened, and the layer reported that rather than
guessing. The reconciliation was correct on all five events recorded here: twice
saying "nothing happened" when nothing had, and twice saying "applied" when the
venue said it had failed.

### What this run proves

- `t: 6` IncreasePositionCollateral is wired through `PerplVenue.addMargin` and
  resolves through the actions layer, not by hand.
- The reported `st: 7 Failed, sr: 32` is recorded, quoted, and then set aside in
  favour of the position's margin — twice, with the exact requested delta.
- One in-flight action per position holds against a real venue and a real race.
- The `action_log` row is opened before the send and settled after, and no row was
  left unsettled across any of the runs.
- `b - lb` tracks live: 9999999028 → 9999943124 micros on the open, then down by
  each top-up.
- A forwarded request that never reaches the chain is distinguishable from one
  that does, and neither is ever retried.

## 2026-09-30 — the close and reduce round trips, measured

`pnpm close:probe` and `pnpm close:probe --units 3 --reduce 1`
(`apps/backend/src/scripts/probe-close.ts`). `buildClosePositionFrame` was written
from the docs and had never been sent; this is what it does.

| phase | frame | `rq` | `mt: 24` | `lfr` | size | `mt: 27` |
| --- | --- | --- | --- | --- | --- | --- |
| close | `t:3 s:1 lp:4382847991809` | 26 | `st: 4 Filled, sr: 43` | 25→26 | 0.00001 → 0 | `st: 2, sr: 13` |
| open | `t:1 s:3` | 27 | `st: 4 Filled, sr: 43` | 26→27 | 0 → 0.00003 | `st: 1, sr: 21` |
| reduce | `t:3 s:1 lp:4383112298497` | 28 | `st: 4 Filled, sr: 43` | 27→28 | 0.00003 → 0.00002 | `st: 1, sr: 14` |
| close | `t:3 s:2 lp:4383112298497` | 29 | `st: 4 Filled, sr: 43` | 28→29 | 0.00002 → 0 | `st: 2, sr: 13` |

All four landed on the first send. None was re-sent.

### `t: 3` TELLS THE TRUTH — unlike `t: 6`

This is the finding. A close reports `st: 4 Filled, sr: 43 TakerOrderFilled` on
`mt: 24`, about a second after it goes out, on every one of the three round trips.
The `sr 32` behaviour — reported failure, full effect — is **specific to
`t: 6` IncreasePositionCollateral** and must not be generalised to the other
order types.

The actions layer still reconciles a close against the position's size rather than
believing `mt: 24`. "Has told the truth so far" is not a guarantee, and the cost of
keeping the discipline is nothing.

### A reduce keeps the `pid` and releases margin in proportion

The partial, `s: 1` against a 3-unit long:

```
mt:27  pid 4383112298497  st:1  sr:14 PositionDecreased  c:"111051"  ep:83197x
```

- **The position id is unchanged.** `pid 4383112298497` before and after. A reduce
  does not create a new position, so anything keyed on `pid` survives it.
- **Margin scales with size.** `c` 166576 → 111051 on a reduction from 3 units to
  2. 166576 × 2/3 = 111050.67, which rounds to exactly the 111051 reported.
- **The entry price does not move.** `ep` is the same before and after.

Those three together are the measured arithmetic behind the rule in CLAUDE.md that
a proportional reduce leaves the liquidation price **exactly** unchanged: size,
margin and the maintenance requirement all scale by the same factor and it
cancels. A reduce buys no room. It only slows the bleeding.

A full close instead carries `st: 2 Closed, sr: 13 PositionClosed` with `c: "0"`
and size 0 — **delivered as a row, not as an omission**, which is why the position
decoder drops anything whose `st` is not 1 rather than waiting for it to vanish.

### The balance ledger closes

    9999920975  before the first close
    9999997236  after it          +76261  (margin 77765 returned, less fees/PnL)
    9999829798  after opening 3u  -167438 (margin posted)
    9999885035  after reducing 1u  +55237 (one third of the margin, less fee)
    9999995312  after closing 2u  +110277 (the rest)

### What this run proves

- `t: 3` CloseLong is correct as built: `lp` names the position, `s` is in the
  market's own size units, `p: 0` with ImmediateOrCancel is a market exit.
- A partial reduce is the same frame with a smaller `s`, and works.
- `PerplVenue.closePosition` and `reducePosition` are now built on this rather
  than on the docs, and `ClosePositionRequest`/`ReducePositionRequest` carry
  `positionId`, `positionSide` and an exact `sizeLNS` because none of the three
  can be derived.
- `lfr` advanced on all four, so all four reached the contract — the same check
  that identified the two dropped opens earlier the same day.

## 2026-09-30 — the 24h volume window bug, measured and fixed

`pnpm analytics:live` prints the fixed figure next to the one the old query
produced, because this is the most checkable number on the analytics page and a
claim that it is now right is worth less than the gap on screen.

| source | 24h volume |
| --- | --- |
| rolling window over `Trade` rows | **16,189,480.85 AUSD** |
| the old query, over `MarketDay` buckets | 3,845,313.95 AUSD |
| ratio | **0.238x** |

### Why it was half, and sometimes a quarter

`MarketDay.id` is `<perpId>-<YYYY-MM-DD>` and `day` is UTC midnight, so

```sql
sum("volumeCNS") filter (where d.day >= now() - interval '24 hours')
```

selects whole buckets whose START is inside the window. At 05:04 UTC that is
today's bucket alone — five hours of data. At 12:00 UTC it is twelve hours, about
0.5x. At 02:00 UTC it is today's two hours plus yesterday's full day, about 1.08x.
**The error swings with the time of day**, so it is not a constant anyone could
learn to correct for, and a screenshot taken in the evening would have looked
roughly plausible.

### The fix is a rule, not a patch

ROLLING WINDOWS COME FROM RAW EVENT ROWS; DAY BUCKETS ARE ONLY FOR DAY SERIES.

`Trade`, `Liquidation`, `CollateralFlow` and `FundingEvent` are filtered on
`timestamp >= $since`, which is exact to the millisecond. `MarketDay` is read only
by `dailySeries`, where the bucket IS the unit the caller asked for. That removes
the bug class rather than the instance — the same query shape cannot come back for
liquidations or fees later.

Cross-checked: `Exchange.volumeCNS` and `sum("Trade"."notionalCNS")` are both
**2229336389548745** to the micro, so the all-time path and the windowed path agree
on the same source.

### Two figures the data cannot support, and what is served instead

**Total fees, for a rolling window.** A taker fill on this contract is an
AGGREGATE OVER A WHOLE ORDER, so the indexer cannot attribute it to a single match
and no per-event row carries it. Taker fees therefore have no timestamp finer than
the day bucket, and they are the larger share — 128,097.78 AUSD of total fees
against 42,038.75 of maker fees. So `makerFeesAusd` is exact for every window and
`totalFeesAusd` is `undefined` for a rolling one rather than being served at a
third of the real value. `DailyPoint.feesAusd` IS the exact total, because there
the bucket is the unit, so a fees chart is available now. Fixing the headline needs
a per-event taker-fee feed in the indexer: a schema change and a reindex of 21.5M
events, and therefore a separate step.

**TVL.** Deposits and withdrawals ARE indexed — 1,734 and 2,064 rows — but accounts
held collateral before the start block, so the net over our window is **negative**:
1,183,018.68 deposited against 2,435,946.98 withdrawn, net −1,252,928.30 AUSD.
That is an exact FLOW and a meaningless level, so the field is called
`netAusd` on `CollateralFlowStats` and nothing calls it TVL. An absolute figure
needs the collateral token's `balanceOf` the Exchange proxy, which is a chain read
rather than an indexer read.

Open interest has the same shape and the schema already said so: it is a delta
series from the start block, because the public RPC serves archive state only a few
days back and there is no exact anchor. Reported as `openInterestDeltaLots`, per
market, since lots are not comparable across markets — BTC has lotDecimals 5 and
MON has 0.

### Two bugs the live run found in the new code

**Addresses did not resolve.** `Trader.owner` stores the address exactly as the
event gave it, which on mainnet is mixed-case EIP-55 —
`0xB7854953A71e45D1033B3d619E76d56391291765`. The lookup lowercased its input and
compared it to that column exactly, so every linked address matched nothing — and
the failure was invisible, because "no linked account" is the ordinary answer here:
1,366 of 1,556 accounts have no owner recorded. Found by the script printing no
profile for an address it had just selected as linked. Fixed with
`lower(owner) = $1`, a scan over 1,556 rows.

**Funding rates printed as zero.** The contract publishes `pct100k`, and the real
mainnet values are integers running −4..4 — ±0.00004%. At four decimal places every
market read `0.0000%`, which was accurate and useless. Six places shows the
variation: BTC last 0.000030%, PUMP 0.000040%, MON mean 0.000015%.

### What this run proves

- Mainnet analytics reads through one venue-agnostic interface; nothing downstream
  sees SQL, a `perpId`, or a market id outside `MarketRef`.
- Canonical tickers resolve by MARKET ID: market 31 reads `SOL` though the indexer
  stored `SOL_v2`, and market 80 reads
  `market 80 (TAO, not listed by the venue)` rather than borrowing the chain's name.
- The rescue headline over the judgeable denominator: **485 of 647, 74.96%**, with
  the 33 unjudgeable excluded rather than counted as failures, and
  1,126,526.38 AUSD of spare balance sitting in those accounts.
  **Correction, 4 Oct 2026: that figure is not a real total and must not be
  quoted.** It summed each liquidation's free balance, so an account
  liquidated repeatedly had the same money counted once per liquidation
  (#4734: 23 rescuable liquidations, its balance counted 23 times). It is
  replaced by a per-event ratio: in the median rescuable liquidation the trader
  held 187x the shortfall (2,344 rescuable, full history, 4 Oct 2026).
- Wallet performance folds in SQL: 113,421 round trips for account 2118, a 207-loss
  streak, profit factor 0.022, max drawdown 8,812.54 AUSD, average hold 2.7 s.
- `health()` refuses to certify synced without an INDEPENDENT chain head, and got
  one: SYNCED, 68 blocks behind, `serveAsCurrent` true.

## 2026-09-30 — TVL from the chain, fees from buckets, and the analytics endpoint

Three decisions taken after the analytics interface landed, and the endpoint that
serves it.

### TVL is a chain read: 3,840,303.14 AUSD

`balanceOf` the collateral token for the Exchange PROXY, one `eth_call`, cached
30s.

```
TVL                3,840,303.14 AUSD
exact micros       3840303142327
source             chain (balanceOf on the Exchange proxy)
via                rpc.monad.xyz
```

And the indexed flow alongside it, which is why the chain read was necessary:

| figure | all time |
| --- | --- |
| deposits | 1,183,018.68 AUSD |
| withdrawals | 2,436,467.43 AUSD |
| **net flow** | **-1,253,448.75 AUSD** |

The flow is exact and the level is not derivable from it: accounts held collateral
before the start block, so withdrawals of pre-existing balances outweigh the
deposits we can see. Both figures are served, because they answer different
questions — what is in there now, and what moved in a window.

Every failure path reports `known: false` with a reason, never zero. The one worth
naming: an `eth_call` to a non-contract returns **`0x`**, and decoding that as a
balance would put a confident `0.00 AUSD` on a dashboard. `decodeBalance` refuses
an empty word and says to check the token address rather than the balance.

### Fees come from day buckets, labelled by what they actually cover

Not reindexed, deliberately. A taker fill is an aggregate over a whole order, so
taker fees have no timestamp finer than the UTC day bucket — and they are the
larger share. So fees are served from buckets and carry their own range:

```
fees for 24h  cover the 2 UTC days from 2026-09-29 (today so far)
fees for 7d   cover the 8 UTC days from 2026-09-23 (today so far)
fees for 30d  cover the 31 UTC days from 2026-08-31 (today so far)
fees for all  cover the 34 UTC days from 2026-08-28 (today so far)
```

The figure is EXACT for the range it states: summing buckets from a midnight is
precisely the fees charged since that midnight, today's partial bucket included.
`makerFeesAusd` stays exact for the rolling window and is reported separately.
`FeesForPeriod.label` exists so no surface can render this under the timeframe's
name — exact and honest beats precise-looking and wrong, which is the lesson from
the volume bug.

**KNOWN IMPROVEMENT, with its cost.** A `takerFeeCNS` column on `Trade`, a handler
change, and a reindex of 21.5M events would make fees exact for a rolling window
like every other figure. That is comparable to the original backfill, so it runs
overnight or not at all. Worth doing if there is slack after the frontend.

### The endpoint

`GET /api/analytics/*`, mounted only when `INDEXER_DATABASE_URL` is set — a backend
that refused to serve alerts because Postgres was unreachable would have the
priorities backwards, and `/health` reports the degradation instead.

EVERY RESPONSE CARRIES THE INDEXER HEALTH AND A `stale` FLAG. A client must be able
to render "these numbers are frozen" without a second request, because a client
that has to ask separately will forget to. A halted indexer's figures are still
served, flagged — the same rule as keeping the last known state visible when the
price feed drops. The machine-readable gate stays at `/health`, which returns 503.

Verified live:

```
GET /                      {"service":"perpguard-backend","status":"OK","analytics":"/api/analytics"}
GET /api/analytics/tvl     known:true  3840303.142327  "totalValueLockedCNS":"3840303142327"
GET /api/analytics/metrics stale:false  synced 128 behind  volume 16,451,577.22
GET .../wallet/0x83107A…   found: account 5201, 12465 round trips, PF 2.172, maxDD 2003.38
GET .../wallet/0x83107a…   found  (the same address lowercased)
GET .../wallet/0x123       400
GET .../metrics?timeframe=1h  400
GET .../account/abc        400
GET .../account/99999999   404
```

A bigint in a payload was a 500 before it was a bug: `JSON.stringify` throws on
one, so a valid TVL reading crashed the route. Bigints now serialise as decimal
STRINGS — emitting them as JSON numbers would be worse than the crash, since AUSD
micros exceed float64's exact range. The serialiser is registered in an
encapsulated Fastify scope so `/health` next door is untouched.

`fetchChainHead` was extracted to `packages/shared` while wiring this: the lag
monitor, the analytics reader and the indexer's `verify` script all need a REAL
chain head, and there were two copies of the same call. One implementation means
the three cannot disagree about the head and then disagree about whether the
indexer is healthy.
