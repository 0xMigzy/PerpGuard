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

### The 30-second outage

Run against a local test double that speaks the same protocol on the real
mainnet market ids, **not** against the Perpl host — simulating the outage by
firewalling the real host was not permitted in this environment. The client
code, sockets, TCP resets, timers and backoff are all real; only the upstream
is local. Timings below are from `scratchpad/outage.log`.

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
