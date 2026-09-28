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
