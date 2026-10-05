# Perpl funding interval: docs say hourly, chain says ~43 min (raw notes, 2026-10-05)

## The claim

docs.perpl.xyz/exchange/funding.md:
"The funding rate can be applied approximately once per hour. *Approximately*
because it is applied after a constant number of Monad blocks:
Every 8571 blocks (assumes 0.42 second average consensus time)".

8571 x 0.42 s = 3,600 s. The block count is the rule; "hourly" was derived from
an assumed block time that is no longer true.

## What the chain and the API say (mainnet, 5 Oct 2026)

- GET /v1/pub/context: every one of the 11 markets has
  funding_interval_blocks 8571 and funding_interval_sec 2580 (~43 min).
- Indexed settlements (perpguard_full."FundingEvent"): 2,592 s measured
  between BTC settlements over the last 24 h, 34 a day.
- 8571 x ~0.302 s = ~2,588 s. The context, the index and the block count agree.

## The July step, explained by the same arithmetic

Distinct settlement blocks per UTC day, spacing, and block time derived from
(last block - first block) / elapsed seconds:

| day        | settlements | s between | blocks between | s/block |
|------------|------------:|----------:|---------------:|--------:|
| 2026-07-21 | 26          | 3,438     | 8,571          | 0.401   |
| 2026-07-22 | 25          | 3,437     | 8,571          | 0.401   |
| 2026-07-23 | 27          | 3,165     | 8,901 *        | 0.356   |
| 2026-07-24 | 33          | 2,590     | 8,571          | 0.302   |
| 2026-07-25 | 34          | 2,602     | 8,571          | 0.304   |

\* a day straddling the change; the mean is mixed.

So ~25/day -> ~33/day on 23 Jul 2026 is Monad's block time dropping from
~0.40 s to ~0.30 s, with the interval held at 8,571 blocks. Note that even
before July it was ~57 min (0.40 s), never the 0.42 s the doc assumed.

Query (re-run any time):

    with e as (select distinct "blockNumber", "timestamp" from "FundingEvent"
               where "timestamp" between '2026-07-10' and '2026-08-05'),
    d as (select "timestamp"::date d, count(*) n, min("blockNumber") b0,
                 max("blockNumber") b1,
                 extract(epoch from max("timestamp") - min("timestamp")) s
          from e group by 1)
    select d, n, round(s/nullif(n-1,0)), round(((b1-b0)/nullif(n-1,0))::numeric),
           round((s/nullif(b1-b0,0))::numeric, 3) from d order by 1;

## What we do

- APR = current rate x (seconds a year / funding_interval_sec from the
  context), measured spacing as the fallback. Never "x 24 x 365".
- The Markets page states ~43 min and ~33 a day, not hourly.

## The other venues (for the funding scanner, same day)

- Hyperliquid: paid every hour, one eighth of an 8-hour rate ("funding is paid
  every hour at one eighth of the computed rate for each hour"). The API's
  metaAndAssetCtxs `funding` is that hourly rate. 72 of 72 gaps in
  fundingHistory were exactly 1 h, all 11 markets.
- Binance USD-M: per symbol, from /fapi/v1/fundingInfo fundingIntervalHours.
  BTC ETH SOL ZEC NEAR UNI 8 h; MON HYPE LIT VVV PUMP 4 h. Every gap in the
  last 20 settlements matched. fundingInfo lists only ADJUSTED symbols and the
  docs state no default, so a symbol absent from it is timed from its own
  settlement history, never assumed to be 8 h.
- Interest term: Hyperliquid and Binance both carry 0.01% per 8 h (10.95% APR
  simple) in their formula; Perpl's doc says its method "does not model the
  cost difference in borrowing USD versus spot crypto". That is a structural
  ~11-point gap on quiet markets, not an opportunity.

## Worth sending to the Perpl team

Second place the docs disagree with the chain:
1. ZEC maintenance margin: exchange/liquidation.md says ~6.7% (max 8x); the
   contract's maintMarginFracHdths for market 50 is 1800 -> 5.56%, and the
   context agrees (docs/notes/risk-verification-2026-10-05.md).
2. Funding interval: exchange/funding.md says approximately hourly at 0.42 s
   blocks; at today's ~0.30 s it is ~43 min, as the context's own
   funding_interval_sec 2580 says.
