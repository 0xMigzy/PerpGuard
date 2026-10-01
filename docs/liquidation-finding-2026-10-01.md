# The rescuable-liquidation finding, captured 2026-10-01

Captured at 20:39 UTC on 1 October 2026, before the site moved to the
full-history index, by `apps/backend/src/scripts/compare-indexes.ts` (the
backend's own analytics code, run against both index schemas at once).

"Rescuable" means the trader's free AUSD, at the moment of liquidation, would
have covered the top-up that kept the position above maintenance margin. The
rate is always over the JUDGEABLE denominator: liquidations of positions
opened before an index's start cannot be judged and are excluded, never
counted as failures.

## Both figures, side by side (full-history index, block 109,704,977)

| Window | Dates (UTC) | Liquidations | Judgeable | Rescuable | Rate |
|---|---|---|---|---|---|
| 30 days | 1 Sep 2026 20:37 – 1 Oct 2026 20:37 | 637 | 637 | 467 | 73.3% |
| All time | 11 Feb 2026 (Exchange deployed, block 54,773,010) – 1 Oct 2026 20:38 | 3,463 | 3,463 | 2,318 | 66.9% |

The full-history index starts at the Exchange's deployment, so it sees every
position open: nothing in either window is unjudgeable.

## What the site showed until the cutover (live index, from block 100,000,000)

| Window | Liquidations | Judgeable | Rescuable | Unknown | Rate |
|---|---|---|---|---|---|
| 30 days | 637 | 619 | 460 | 18 | 74.3% |
| "All" (really 28 Aug – 1 Oct) | 699 | 666 | 500 | 33 | 75.1% |

The 18 unjudgeable 30-day liquidations are now judged: 7 rescuable, 11 not.

## The all-time rate, by month

| Month | Liquidations | Rescuable | Rate |
|---|---|---|---|
| 2026-02 | 11 | 8 | 72.7% |
| 2026-03 | 95 | 76 | 80.0% |
| 2026-04 | 159 | 137 | 86.2% |
| 2026-05 | 173 | 128 | 74.0% |
| 2026-06 | 489 | 268 | 54.8% |
| 2026-07 | 891 | 544 | 61.1% |
| 2026-08 | 994 | 680 | 68.4% |
| 2026-09 | 641 | 470 | 73.3% |
| 2026-10 (1 day) | 10 | 7 | 70.0% |

June and July pull the all-time rate down: they hold 1,380 of the 3,463
liquidations at 54.8% and 61.1%. Every other month sits between 68% and 86%.
June also holds all 11 forced exits that were not plain liquidations.
