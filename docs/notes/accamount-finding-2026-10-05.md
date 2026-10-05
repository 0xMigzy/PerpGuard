# accAmountCNS finding, 2026-10-05 (raw notes)

Context: asked to make the Liquidations hero "preventable value" = sum of
margin lost over rescuable liquidations. Checked what the fields mean first.
Margin lost does not mean money destroyed. Went with realised loss instead
(owner approved option 1). Option 2 (exact figure via accAmountCNS) parked as
a stretch goal for Oct 12.

## The four columns on the Liquidations events table

- Size (`notionalCNS`): notional of the lots liquidated, lots x the price they
  closed at. Position size, not a loss.
- Margin lost (`marginLostCNS`): how far the position's own collateral fell at
  the event = deposit before - deposit left after
  (`apps/indexer/src/handlers/liquidations.ts`, `depositBeforeCNS -
  exit.remainingDepositCNS`). Margin REMOVED from the position, not money
  destroyed.
- Shortfall (`marginToSurviveCNS`): the top-up that would have kept the
  position above maintenance margin at the mark it died on. A per-event
  requirement, not money that existed.
- Spare held (`freeBalanceBeforeCNS`): the account's free balance immediately
  before the event = accBalanceCNS - accAmountCNS. A level; never sum it
  across liquidations.

## accAmountCNS is emitted but not stored

`PositionLiquidated` carries `accAmountCNS` (signed amount applied to the
account's free balance by the event) and `accBalanceCNS` (balance after). The
indexer uses them only to derive freeBalanceBeforeCNS and does NOT store
accAmountCNS on the Liquidation entity. So the part of the removed margin
that went back to the trader is not in the index.

## Sample of 40 random rescuable liquidations, decoded from chain receipts

| Sample of 40 | AUSD | Share |
|---|---|---|
| Margin lost | 12,870 | 100% |
| Credited back to the trader's account (accAmountCNS) | 3,283 | 26% |
| Realised loss (PnL + funding) | 8,512 | 66% |
| Remainder, probably a liquidation fee (not verified) | 1,075 | 8% |

- 40 of 40 had accAmountCNS > 0 (money credited back).
- accBalanceCNS - accAmountCNS == indexed freeBalanceBeforeCNS on 40 of 40,
  so the decode is right.
- margin lost == loss + credited back on 0 of 40: there is always a remainder.

## Totals over rescuable liquidations, by window (perpguard_full, 2026-10-05)

| Window | Rescuable | Margin lost (overstates) | Realised loss (in the index) |
|---|---|---|---|
| 24H | 3 | 280 | 146 |
| 7D | 74 | 26,045 | 17,942 |
| 30D | 421 | 109,394 | 69,306 |
| All | 2,347 | 646,652 | 425,344 |

Rolling windows (now - interval). All rescuable rows are kind LIQUIDATION;
the 11 DELEVERAGE rows are never rescuable; no unwinds in the index.
Over all rescuable: margin lost exceeds realised loss on 1,995 of 2,347 by
more than 1 AUSD, by 221,308 AUSD in total; realised loss never exceeds
margin lost by more than 1 AUSD.

## Options considered

1. Realised loss (PnL + funding) summed over rescuable. In the index, once
   per event, cannot be inflated, understates (excludes the fee remainder).
   CHOSEN.
2. Exact destroyed = marginLost - accAmountCNS. Needs accAmountCNS: schema
   change means full resync from Feb (no), or a backend side table filled
   from ~3,500 receipts and topped up for new ones (~half a day). Stretch goal.
3. Sum marginLost as asked. Rejected: ~a quarter went back to the trader.

Wording caveat: a top-up keeps the position open, it does not undo the price
move. What is avoided for certain is being closed out at the worst moment.
Copy must never say the trader would have kept this money.
