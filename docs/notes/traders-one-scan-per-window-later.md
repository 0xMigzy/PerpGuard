# Traders list: one scan per window (deferred, 8 Oct 2026)

Owner's decision on 8 Oct: ship the 24H rolling window on the existing
per-sort queries, and do this after the hackathon.

## Today
Every (window, ranking, sort, direction, page, search) is its own query, each
cached for 5 minutes by the SWR cache. Measured on the live index, 8 Oct 2026:

| query | cost |
|---|---|
| whole-day list, one sort, 50 rows (376-5,247 traders) | 8-22 ms |
| 24H rolling list (fills both legs + liquidations), one sort | ~124-170 ms |
| `Position` by `closedAt`, one day (no index) | 1,750 ms |

So the cost grows with the number of distinct sort/search keys opened in five
minutes, at ~170 ms each for 24H.

## Later
Compute each window's full per-trader table ONCE (24H ~170 ms, the others
~20 ms), cache it, and rank, filter, search, page and sort in the application.
The cost is then fixed per window per 5 minutes whatever readers do. The
largest table is All, 5,247 rows, ~1-2 MB.

What moves from SQL into TypeScript: the rankings' `where` rules and activity
gates (`TRADER_ACTIVITY`), the round-trip floor and `belowFloor`, the address
prefix / account id search, and the sort maps (numeric, never a text alias).
Keep a test per ranking that the application's rows equal the SQL's.

## Also open
The P&L column stays on whole UTC days. Rebuilt from `Position."closedAt"`,
7 Oct 2026 disagreed with `TraderDay` for 70 traders (wins/losses) and 64
(realised + funding), while volume, trades, liquidations and flows matched
all 371. Suspected, NOT confirmed: `TraderDay` books realised P&L from partial
reduces on the reduce's day; `closedAt` puts the whole result on the close.
Settle it before any rolling P&L. A `closedAt` index would be needed first.
