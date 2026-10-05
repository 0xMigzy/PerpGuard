# Risk page verification, 2026-10-05 (raw notes)

Snapshot checked: block 110,714,503. Chain reads at blocks 110,717,122 and
110,717,180 against the Exchange proxy 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F.
Outcome: the per-position maths is right; four page figures were wrong in how
they combined real numbers (two-sided "open interest", fall + rise added
together, pooled insurance cover). Fixed same day.

## The four figures, defined

- Open interest: ONE side. Every long lot is matched by a short lot, so the
  summed notional of all positions (longs + shorts) is twice open interest.
  The page showed the two-sided sum (3,200,194) as if it were open interest.
  Now: open interest = (long notional + short notional) / 2 per market;
  the two-sided figure may only appear as "Total position value, both sides".
- At risk at X%: notional (at today's mark) of the positions a SINGLE signed
  move liquidates. A fall closes longs only, a rise closes shorts only. The
  page added the fall rung to the rise rung (two worlds that cannot both
  happen). Share = at-risk notional / one-sided open interest.
- Losses beyond collateral (shortfall): equity below zero at the shocked mark,
  equity = deposit + uPnL (funding 0, see gap below). What the insurance fund
  would absorb if the price gapped straight through liquidation and
  bankruptcy. Per direction; the headline is the worse single direction.
- Insurance cover: per market only, fund balance / that market's losses
  beyond collateral in its worse single direction at 10%. Funds are per
  perpetual (Perpl docs, Insurance & ADL), never pooled. The total of the 11
  balances is fine as a total (money that exists), never as a ratio.

Chain position fields used (getPositionV2(perpId, accountId).positionInfo):
depositCNS (isolated margin), lotLNS (size), pricePNS (entry),
premiumPnlCNS (the docs' C_Funding; not in the index).

## Open interest, three independent sources

| Source | One-sided OI |
|---|---|
| Index, half of summed position notional at the snapshot's marks | 1,600,097 |
| Chain, getPerpetualInfoV2(perpId) longOpenInterestLNS x markPNS, 11 markets | 1,607,455 (later block, chain mark) |
| Venue, GET /v1/pub/context state.oi x state.mrk (/api/analytics/open-interest) | 1,602,516 |

Page showed 3,200,194 = 2 x 1,600,097. Index open lots == chain long/short
OI to the lot in all 11 markets at block 110,717,180.

## Per direction (snapshot block 110,714,503, all markets)

| Move | Positions | Notional | % of OI | Losses beyond collateral | Positions past collateral |
|---|---|---|---|---|---|
| fall 5% | 87 | 191,365 | 12.0% | 0 | 0 |
| rise 5% | 51 | 64,607 | 4.0% | 0 | 0 |
| fall 10% | 165 | 308,395 | 19.3% | 4,268.34 | see page (from ladder) |
| rise 10% | 90 | 312,912 | 19.6% | 1,588.78 | see page (from ladder) |

The old tiles: 138 / 255,973 at 5%, 255 / 621,307 at 10%, shortfall 5,857.13,
"154 positions" past collateral: all fall + rise added.

## Shortfall walkthrough, account 245, BTC long, chain state

| Step | Calculation | Result |
|---|---|---|
| Lots | 31,370 LNS / 10^5 | 0.3137 BTC |
| Entry | 862,590 PNS / 10 | 86,259.0 |
| Deposit (own collateral) | 1,825,859,480 / 10^6 | 1,825.86 AUSD |
| Shocked mark (-10%) | 85,796.1 x 0.9 | 77,216.4 |
| Unrealised PnL | 0.3137 x (77,216.4 - 86,259.0) | -2,836.66 |
| Equity | 1,825.86 - 2,836.66 | -1,010.80 |
| Loss beyond own collateral | -equity | 1,010.80 AUSD |
| Cross-check via bankruptcy price | 86,259.0 - 1,825.86 / 0.3137 = 80,438.6; (80,438.6 - 77,216.4) x 0.3137 | 1,010.80 |
| Maintenance requirement | 0.3137 x 86,259.0 / 25 | 1,082.38 |
| Liquidation price | 86,259.0 + (1,082.38 - 1,825.86) / 0.3137 | 83,888.9 (2.2% buffer) |

Recomputed from chain over the 255 snapshot-exposed positions: 252 still
liquidated (2 closed, 27 changed since), shortfall 5,872.91 vs page 5,857.13.

Liquidation price checks: position1 fixture 81,770.02 by hand vs 81,770.
Live: acct 2159 BTC long 74,041.1 (page 74,041.1); acct 2159 ETH short 3,049
(page 3,049). Distance measured from context state.mrk (mark), not lst/orl.
Maintenance margin read per market from context config.maintenance_margin,
equal to the contract's maintMarginFracHdths.

## ZEC discrepancy

Perpl docs (exchange/liquidation.md) say ZEC maintenance margin ~6.7%, max 8x.
Contract maintMarginFracHdths for market 50 = 1800 -> 100/1800 = 5.56%, and the
context agrees. We follow the contract.

## Known gap: funding term

premiumPnlCNS is nonzero on chain (acct 2159 BTC: -220.16 -> liq 74,041.1 vs
73,913.1 if counted as owed). Across the 255 at-risk positions |premiumPnl|
sums to 494 AUSD; shortfall 5,872.91 -> 5,895.40. Sign convention unconfirmed.
Left at zero on purpose before the deadline (comment in exposure.ts).

## Insurance and the backstop

- Balance: getPerpetualInfoV2(perpId) insuranceBalanceCNS (word 11). Page
  320,225.29 vs chain 320,227.87 (accrual), decoded by ABI field name.
- getInsuranceProtocolSplit returns 15,000 / 85,000 per 100K on all 11
  markets; the docs say 10% / 10% of the liquidation residual. Base unknown.
- Index: 0 insurance credits (PositionLiquidationCredit), 0 bad debt, over the
  whole history from 11 Feb 2026. From our handler, NOT an independent chain
  read: HyperSync 429'd for 10 minutes on the shared token.
- All 11 DELEVERAGE rows: market 30 (SOL v1), 8 Jun 2026, 3 txs, longs and
  shorts together. Looks like retiring SOL v1, not a bankruptcy ADL
  (inference; events carry no reason).
