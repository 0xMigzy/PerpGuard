# Data and methodology

The detail behind the site's footer note. Every figure below names where it came
from and how many observations stand behind it. Where the sample is one, it says
one.

## Where the data comes from

- **The index.** Every analytics figure is read from the Perpl Exchange contract
  on Monad mainnet (chain 143), through the proxy
  `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`, which is what emits the events.
  It is indexed with Envio HyperIndex from the Exchange's deployment block,
  **54,773,010 (11 Feb 2026)**, into the Postgres schema `perpguard_full`. So
  "All" on the site means "since Feb 11, 2026", the real start of the index, and
  is never labelled "all time". Every event the index reads, and what it means:
  `apps/indexer/docs/EVENTS.md`.
- **The venue.** Mark prices, open-interest levels and market listings come from
  Perpl's API (`GET /v1/pub/context` and the market feed). A market listed on
  chain but missing from the context (mainnet market 80, TAO) is excluded and
  named, not shown.
- **Freshness.** Indexed answers are served from a stale-while-revalidate cache
  and say how old they are past 45 seconds. The Risk section names the block its
  positions came from.

## Verification of the index against the chain

> **NOT YET WRITTEN: source not located.** This section is meant to list the
> fourteen block ranges the index was verified over and what matched in each.
> That record is not in this repository (not in `docs/evidence.md`, the git
> history, or `apps/indexer/src/scripts/verify.ts`, which checks the index's own
> counters and not block ranges). It is left empty rather than reconstructed.

What *is* checked continuously, by `apps/indexer/src/scripts/verify.ts`:
`Market`, `Trader` and `Exchange` `openPositionCount` each equal the open
`Position` rows, every trader's wins plus losses equal their round trips, and
24-hour volume is compared against the venue's own figure once the index is
within 100,000 blocks of the head.

## Definitions

### Fees: maker plus taker

One definition everywhere: the sum of `MarketDay.feesCNS` over **whole UTC
days**, served with the range it covers (for example "the 7 UTC days from
2026-09-24 (today so far)"). Taker fees carry no timestamp finer than the day
bucket, so this is the only exact total there is. The maker half alone is exact
over a rolling window, and is served under its own name, `makerFeesAusd`. It is
never called "fees", because it is about a third of the real figure and would
look like the whole.

### Ratios: withheld under ten round trips

Win rate and profit factor are undefined for fewer than
`MIN_ROUND_TRIPS_FOR_RATIOS` = 10 round trips in the window, on the profile and
on the traders list. Counts and history are still served in full, and every
payload that withholds a ratio carries the floor it used. Three trades with two
wins is 66.7% and means nothing.

### Rescuable liquidations

A liquidation is **rescuable** when the trader's free AUSD at that moment would
have covered the top-up that kept the position above maintenance margin. Perpl
uses isolated margin, so free balance is never pulled in on its own. That is
the gap PerpGuard exists for.

- **The denominator is the judgeable liquidations.** A liquidation of a position
  opened before the index's start block cannot be judged, because its margin
  history is unknown. It is left out of the denominator and never counted as a
  failure. The full-history index starts at the Exchange's deployment, so today
  nothing is unjudgeable. The old index, which started at block 100,000,000, had
  18 such liquidations over 30 days.
- **Always quoted with its window.** At block 109,704,977 (1 Oct 2026): 467 of
  637 over 30 days (73.3%), and 2,318 of 3,463 since Feb 11, 2026 (66.9%).
  `docs/liquidation-finding-2026-10-01.md` has the monthly breakdown.
- **Not the same as "had a balance".** `hadSpareBalance` is true for any balance
  above zero, dust included: when last measured it was true for 654 of 654
  mainnet liquidations, the smallest balance being 0.00024 AUSD. It is a per-liquidation
  diagnostic and is never a headline.

## Skew: margin at risk, never notional

### The finding

**On an order-book perp, notional skew is 50/50 by construction.** Every long
lot was matched against a short lot, so the open size on each side of a market
is equal, and size × mark is equal whatever the mark. A long share by notional
cannot move.

The site showed exactly 50.0% long on every market until 3 Oct 2026. The code
was doing what it said. The quantity was the mistake.

### The proof

`fixtures/open-positions-mainnet.json` holds every open position on mainnet,
read from the index in one statement at **block 110,176,799** (2026-10-03 12:11
UTC): 695 positions across 11 markets.

| Market | Long lots | Short lots | Long / short positions | Long share of margin |
|---|---:|---:|---|---:|
| 1 (BTC) | 887,454 | 887,454 | 153 / 112 | 49.4% |
| 10 (MON) | 2,699,523 | 2,699,523 | 62 / 21 | 38.9% |
| 20 (ETH) | 175,659 | 175,659 | 62 / 38 | 47.4% |
| 31 (SOL) | 826,713 | 826,713 | 37 / 16 | 31.2% |
| 40 (HYPE) | 31,746 | 31,746 | 36 / 20 | 50.4% |
| 50 (ZEC) | 327,235 | 327,235 | 25 / 9 | 59.4% |
| 60 (LIT) | 33,005 | 33,005 | 18 / 6 | 62.7% |
| 70 (VVV) | 46,380 | 46,380 | 23 / 8 | 51.4% |
| 90 (PUMP) | 7,147,194 | 7,147,194 | 8 / 11 | 32.4% |
| 100 (NEAR) | 91,291 | 91,291 | 14 / 6 | 52.8% |
| 110 | 17,374 | 17,374 | 5 / 5 | 49.0% |

Size is equal on every market to the lot, while the headcount is lopsided on 10
of the 11. Margin varies, from 31% to 63% long, because the two sides run
different leverage: a side that posts less margin for the same size is the more
leveraged one. `packages/shared/src/analytics/skew.test.ts` asserts the equality
on the fixture and keeps a notional share out of the served type.

Re-capture it with:

```sql
select market_id, side, "lotLNS", "depositCNS" from "Position" where status = 'OPEN';
```

### What is shown instead

- **Long share of margin**: the isolated margin (`depositCNS`) posted by each
  side's open positions. This drives the Markets column, the Overview bar, the
  crowding tag and the Risk section's per-side totals.
- **Headcount** beside it, as "N long / M short positions".

### The crowding threshold, re-derived for margin

A market is tagged **Crowded long** or **Crowded short** when one side holds more
than 70% of open margin while funding is paying that side. That is the side with
the most to lose from a move against it. The 70% was first set against the
notional share, so it could never fire. It was re-derived for margin rather than
carried over.

**Sample.** 1,077 market-day ends: 11 markets on days when each had at least ten
open positions, from 24 Feb to 2 Oct 2026. Each is the margin split at UTC
midnight, rebuilt from position open and close times.

**Approximation, stated.** A closed position's `depositCNS` is zeroed at close,
so the rebuild weights each position by `peakDepositCNS`. That equals the
opening margin for every position that never had a margin action: all but 6,199
of 7.4 million closed positions. It overstates the margin of positions that were
reduced before closing. Checked against the index: positions open at the last
midnight matched the rebuild exactly (BTC 150 long / 76 short).

**Distribution of long share of margin:**

| Percentile | 1st | 5th | 10th | 25th | 50th | 75th | 90th | 95th | 99th |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| By margin | 14.2% | 20.4% | 25.0% | 33.4% | 43.6% | 51.4% | 62.0% | 70.4% | 78.8% |
| By headcount | 36.5% | 43.5% | 47.1% | 53.2% | 59.4% | 69.3% | 76.4% | 82.8% | 92.3% |

Margin centres below 50%, while headcount centres above it: there are more
longs, and they post less margin each.

**How often each threshold fires** (one side over the threshold, with funding
paying that side, over the 1,077 market-days):

| Threshold | Crowded long | Crowded short | Share of market-days | Markets ever tagged |
|---|---:|---:|---:|---:|
| 60% | 51 | 99 | 13.9% | 9 |
| 65% | 39 | 66 | 9.7% | 9 |
| **70%** | **25** | **41** | **6.1%** | **9** |
| 75% | 11 | 25 | 3.3% | 7 |
| 80% | 1 | 15 | 1.5% | 6 |

70% tags 6.1% of market-days, the tail, which is what "crowded" should mean, so
it stays. For comparison, a 70% threshold on headcount would tag 11.9%. Over
the last 30 days it would have tagged 5 market-days, on 4 markets.

<details>
<summary>The rebuild query</summary>

```sql
create temp table ev as
select market_id, side, date_trunc('day', "openedAt") as day, sum("peakDepositCNS") as dm, count(*) as dn
  from "Position" group by 1,2,3
union all
select market_id, side, date_trunc('day', "closedAt"), -sum("peakDepositCNS"), -count(*)
  from "Position" where "closedAt" is not null group by 1,2,3;
create temp table lvl as
with days as (select generate_series(date_trunc('day', (select min(day) from ev)), date_trunc('day', now()) - interval '1 day', interval '1 day') as day),
grid as (select m.market_id, s.side, d.day from (select distinct market_id from ev) m cross join (select distinct side from ev) s cross join days d),
agg as (select market_id, side, day, sum(dm) dm, sum(dn) dn from ev group by 1,2,3)
select g.market_id, g.side, g.day,
       sum(coalesce(a.dm,0)) over w as margin, sum(coalesce(a.dn,0)) over w as n
  from grid g left join agg a using (market_id, side, day)
window w as (partition by g.market_id, g.side order by g.day);
create temp table snap as
select l.market_id, l.day, l.margin long_m, s.margin short_m, l.n longs, s.n shorts,
       l.margin::numeric / nullif(l.margin + s.margin, 0) as m_share,
       l.n::numeric / nullif(l.n + s.n, 0) as n_share
  from lvl l join lvl s on s.market_id = l.market_id and s.day = l.day and s.side = 'SHORT'
 where l.side = 'LONG' and l.n + s.n >= 10;
-- funding paying the crowded side: the day's last FundingEvent per market
```

</details>

## The ground-truth position

The risk engine's liquidation maths is pinned to **one** real position:
`fixtures/position1.json`, read off the Perpl app on 26 Sep 2026.

| | |
|---|---|
| Market | BTC (mainnet market 1), long, isolated margin |
| Size, entry, mark | 0.5 BTC, 84,029.5, 84,007.3 |
| Margin, leverage | 2,810.33 AUSD, 15x |
| Venue's liquidation price | 81,770 |
| Engine's liquidation price | within the fixture's 1.0 tolerance |
| Unrealised PnL | −11.10 AUSD, within 0.01 |
| Buffer to liquidation | 2.68%, within 0.0005 |

`packages/shared/src/risk/fixture.test.ts` reproduces every expected figure
through the same adapter the bot and web use. The market's maintenance ratio
(4%) is read from `GET /v1/pub/context`, never hard-coded.

**What one position cannot settle.**

- **Leverage tiers.** This position sits at BTC's maximum leverage, so on its
  own it cannot show that maintenance margin does not step with leverage. The
  context answers that instead: one maintenance value per market, no tiers.
- **The buffer's denominator.** Whether the buffer divides by mark or by entry
  price is still open. Here mark and entry differ by 0.026%, so the two
  candidates are 7×10⁻⁶ apart, 70 times inside the tolerance. A second
  position, with mark well away from entry, is needed to decide it.
- **The margin excess.** Posted margin exceeds notional ÷ leverage by 9.35 AUSD,
  which is neither a maker nor a taker fee. So the engine always uses the
  venue's reported margin, never notional ÷ leverage.

The live check sits beside it: on testnet the engine predicted a 2.67% buffer
for a real position and the venue showed 2.67% (`docs/evidence.md`, 29 Sep).

## Margin top-ups are confirmed against the position, not the venue's reply

**The venue reports failure on a top-up that has applied in full.** A
`t: 6` IncreasePositionCollateral comes back on `mt: 24` as `st: 7 Failed,
sr: 32 OrderDescIdTooLow`, while the collateral is credited to the position by
exactly the amount sent. The request id was the correct `lfr + 1` every time,
so the reason code does not mean what it says for this order type.

**Sample: six top-ups on testnet, all six reported failed, all six applied to
the micro.**

| `rq` | Reported | Margin before → after (micros) | Applied | Requested |
|---|---|---|---:|---:|
| 12 | st 7, sr 32 | 55,822 → 83,001 | 27,179 | 27,179 |
| 15 | st 7, sr 32 | 55,900 → 83,584 | 27,684 | 27,684 |
| 16 | st 7, sr 32 | 83,584 → 111,268 | 27,684 | 27,684 |
| 19 | st 7, sr 32 | 55,700 → 83,160 | 27,460 | 27,460 |
| 24 | st 7, sr 32 | 55,616 → 66,765 | 11,149 | 11,149 |
| 25 | st 7, sr 32 | 66,765 → 77,765 | 11,000 | 11,000 |

Rows 15 and 16 are one top-up sent twice. The first investigation believed the
failure and re-sent, and the margin was added twice. On mainnet that would be a
trader's collateral committed twice because the venue said the first attempt
failed.

So PerpGuard:

- **Confirms a top-up by reading the position's margin (`c`) before and after.**
  That is the only field that says whether the collateral landed. The
  `action_log` keeps both answers side by side: `reported_status` (what the
  venue said) and `outcome` (what the position showed).
- **Never re-sends on the reported failure,** and never tells the user it
  failed. Telling someone their rescue failed when it worked is how they double
  it by hand.
- **Offers "Send again" only after reconciliation shows nothing landed**
  (`not-applied`), and never when the outcome is `unknown`.

Closes and reduces (`t: 3` / `t: 4`) reported their outcome truthfully on all
three measured round trips (`st: 4 Filled`). They are reconciled against the
position anyway, because "has told the truth so far" is not a guarantee. The
full runs are in `docs/evidence.md` (29 and 30 Sep 2026).

## What is not shown, and why

- **Order book depth.** The index reads contract events and holds no order book.
  The Risk section's shocks are static: they do not model the depth a
  liquidation would sell into.
- **Open-interest history.** The index holds changes in open interest, not
  levels, and the public RPC serves archive state only a few days back, so there
  is no anchor to turn the changes into a level. The level shown is the venue's
  current one.
- **Intraday candles.** Marks are bucketed by UTC day.
