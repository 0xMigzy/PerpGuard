# Perpl funding rate unit: we were 100× too small (raw notes, 2026-10-06)

## Symptom

8 of 11 markets showed exactly 0.000000% funding, the rest ±0.000040%, and
Perpl APRs of a fraction of a percent beside Hyperliquid's and Binance's ~11%.

## The unit, measured

`FundingEventCompleted.actualRatePct100k` (stored as-is in
`FundingEvent.actualRatePct100k`, and `Market.lastFundingRatePct100k`).

For every CLOSED position held across EXACTLY ONE settlement (no margin
actions), what it paid against what the stored rate would charge:

    implied = funding / (peak size × funding price)        (sign: longs pay a positive rate)
    ratio   = implied / (stored / 100,000)

| market | positions | median | p90 | max |
|--------|----------:|-------:|----:|----:|
| BTC    | 7,262 | 0.970 | 0.993 | 1.971 |
| ETH    |   833 | 0.813 | 0.949 | 2.852 |
| MON    |   481 | 0.990 | 0.998 | 1.000 |
| LIT    |   443 | 0.703 | 0.998 | 1.006 |
| SOL_v2 |   277 | 0.997 | 0.999 | 2.501 |
| ZEC    |   246 | 0.998 | 1.000 | 1.000 |
| PUMP   |    89 | 0.871 | 0.981 | 0.994 |
| VVV    |    74 | 0.778 | 1.000 | 1.000 |
| HYPE   |    72 | 0.994 | 0.999 | 1.493 |
| NEAR   |    68 | 0.993 | 0.998 | 1.000 |
| UNI    |    66 | 0.998 | 0.999 | 1.000 |

It clusters at 1.00. Below 1: positions that shrank before the settlement
(peak size overstates the size that paid). A worked case: a 0.00004 BTC long
across one settlement at stored rate 4 and $84,538.80 paid $0.000132;
0.00004 × 84,538.8 × 0.00004 = $0.000135.

So stored = rate as a FRACTION × 100,000. 4 = 0.00004 = 0.004% per
settlement. Percent = stored ÷ 1,000.

## The bug

`toRatePct` (and three copies in pg.ts) divided by 100,000 and called the
result a PERCENT: 100× too small. Every rate, mean, heatmap cell, APR, the
Markets Funding column and the Perpl column of the cross-venue scanner.

## The API

`GET /v1/pub/context` `markets[].funding.rate` is 10× the stored value
(BTC −10 vs −1, ETH −40 vs −4, HYPE 20 vs 2, NEAR −10 vs −1, at the same
settlement block): fraction × 1,000,000. Undocumented: the WebSocket page has
a TODO for MarketFundingUpdate's fields. `sum`, `idx` and `ppl` match the
chain exactly.

## After the fix (6 Oct 2026, 24H)

BTC −0.001%/settlement (−12.22% APR), ETH/ZEC/UNI −0.004% (−48.89%),
HYPE/VVV +0.002% (+24.45%), NEAR −0.001%, MON/SOL/LIT/PUMP 0. Rates move in
steps of 0.001% per settlement, ~12.2% a year.

## Not changed

The Markets risk score's funding ceiling went 0.001% -> 0.1% with the unit,
so no market's score moved. The crowding rule reads the sign only.
