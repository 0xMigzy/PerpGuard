# The index has no taker side (6 Oct 2026)

A measured finding about our own data, like the funding unit and interval
notes beside it.

## What was found

`Trade.takerSide` exists in the indexer schema (`apps/indexer/schema.graphql`,
`takerSide: Side`) and has **never been populated**.

Over the 30 days to 6 Oct 2026, 3,778,089 fills, 3,599,241 of them with a
recorded taker, had `takerSide` set on **0** (`count("takerSide")` = 0).

## Why

A maker fill (`MakerOrderFilledV2`) names only the maker. The taker is
attached afterwards, when the transaction-scope join identifies it
(`apps/indexer/src/lib/takers.ts`, `attributeTaker`):

```ts
context.Trade.set({ ...trade, taker_id: taker.id, takerSide: trade.takerSide });
```

`trade.takerSide` is the fill's own value, written `undefined` when the fill
was created (`apps/indexer/src/handlers/trades.ts`). So the field copies itself
and stays empty. The taker's side is never derived from anything.

## Why it is not fixed

The fix belongs in the handler, but it changes how every historical fill is
written, which means a full re-sync of `perpguard_full` from the deployment
block (11 Feb 2026). Not worth it before submission; the data it would add is
available another way (below). If the schema is ever rebuilt for another
reason, fix this at the same time.

## What we do instead

Large-trade alerts (the event engine, `apps/backend/src/events/`) take a taker
order's side and action from the **position event of that account on that
market in the same transaction**, read off the receipt
(`FillDirections.directionOf`, `packages/shared/src/venues/perpl-fill-direction.ts`).
Exactly one such event answers. None or more than one leaves it blank, and
the alert says "direction not known" rather than guessing.

## The one case seen so far

Transaction `0xe50dea3772299a197bf4a25c0773feeb407eb70b573fadc84a2c721d170251c0`,
mainnet block 111,124,794, 6 Oct 2026 19:46:19 UTC, MON (market 10).

One transaction, many orders: 10 fills and 11 position events across seven
accounts. Two taker orders in it passed the $10K line in the dry run:

| Taker | Order | Position events of that account in the tx | Alert said |
|---|---|---|---|
| #940 | 10,926 AUSD | one: close short | "Closed a short" |
| #5383 | 10,010 AUSD | **three**: flip to short, add short, add short | "direction not known" |

#5383 was the taker in one fill and also the maker in others in the same
transaction, so it has three position events. "Exactly one event answers" does
not hold, so the alert stays blank. All three agree the result is short, so a
later refinement could say "now short (flipped and added)" when every event
names the same side. Not done: blank beats a guess until that rule is
written down and tested.

## How to re-measure

```sql
select count(*), count(taker_id), count("takerSide")
  from "Trade" where timestamp >= now() - interval '30 days';
```
