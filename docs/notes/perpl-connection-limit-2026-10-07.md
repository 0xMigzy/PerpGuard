# Perpl's connection limit, measured (7 Oct 2026)

How many linked accounts one PerpGuard instance can hold depends on how many
Perpl WebSocket connections this box gets. The docs say: "Approximate rate
limits are ~50 messages/second per connection and ~5 connections per IP
(market-data and trading combined)". That would have capped the instance at
four linked accounts (one shared price feed plus one trading socket each).
It was measured instead, with `pnpm probe:connections`
(`apps/backend/src/scripts/probe-connection-limit.ts`), testnet, backend
stopped, from the production box.

## What was measured

| Run | Opened | Alive and flowing at the end | Refused |
|---|---|---|---|
| Public market data, no key | 8 | 8 | none |
| Public market data, no key | 24 | 24 | none |
| Signed-in trading, ONE key (account 710) | 7 | 7 | none |
| Mixed: 3 market data, then 4 trading | 7 | 7 | none |
| Signed-in trading, one key | 16 | 11 | #8, #12, #13, #15, #16 |
| One key filled (11 in, 5 refused), then 8 unsigned trading-endpoint connections on top | 8 | 8 accepted | none refused for count |

- A refused trading connection fails AT SIGN-IN with `1008 (too many
  connections)`. Sockets already open are NOT dropped: the 11 stayed up
  through every later attempt.
- The refusals are not a clean cut-off (#9, #10, #11 and #14 got in after #8
  was refused), consistent with several servers behind one address each
  counting for themselves. Roughly 7 to 11 signed-in sessions per key.
- Unsigned connections to the trading endpoint, from the same IP, while that
  key was full, were ACCEPTED, and closed only by the server's own
  `1008 "idle timeout"` about 10 s later for not signing in.

## What it means

The "~5 per IP" is not enforced at 5, 8 or 24. The limit that exists is
counted at SIGN-IN, so it binds signed-in sessions (per key, or per account),
not connections per IP. PerpGuard holds ONE trading socket per linked account,
each on that account's OWN key, so on this evidence no instance-wide ceiling
comes from sockets.

NOT YET PROVEN: per key vs per IP-for-signed-in-sessions. Settle it with a
second key: fill key A to its refusals, then sign in key B. If B gets its own
sessions, the limit is per key.

## Positions over REST, for the record

`GET /v1/trading/position-history` (API key, `read` scope) returns 710's open
positions in about 0.7 s, but as EVENTS, not current state: each row is one
change with its own deltas. 710's BTC came back as its open (2,000 lots,
122.278858 AUSD) plus three rows of `s: 0, c: 25000000` (the three 25 AUSD
top-ups); their sum is the live 197.278858. So a REST position reader must
fold events per `pid` (closed at `st: 2`) and poll the newest page for new
ones. No rate-limit headers were returned.
