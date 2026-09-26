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
