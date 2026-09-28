# Perpl Exchange events: what each one means for PerpGuard

Generated from `apps/indexer/abis/Exchange.json` (see `abis/README.md` for provenance)
and cross-checked against the **mainnet** implementation actually deployed behind
`0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` on Monad chain 143.

All 204 ABI events are listed. Nothing is omitted.

| mark | meaning |
| - | - |
| **index now** | in the v1 indexer: needed for the dashboard, the aggregates or the liquidations feed |
| later | real signal we do not need on day 1 |
| diagnostic | this contract reports failures as events instead of reverting, so a batch can partly fail. Decode these only when we want reject analytics |
| `!` | topic0 is **absent from the deployed mainnet implementation**: historical logs only, or dead in this build |
| `~N` | occurrences in a live 100-block mainnet sample (~29s of chain) at head 108,613,771 |

## A. Accounts, free balance, deposits & withdrawals

| event | fields | | note |
| - | - | - | - |
| `AccountCreated` | `account, id` | **index now** | Wallet -> accountId. The ONLY on-chain link from a trader address to its account id; every other event is keyed by accountId. |
| `CollateralDeposit` | `accountId, amountCNS, balanceCNS` | **index now** | Free (cross) AUSD paid into the account. `balanceCNS` is the post-state, so it reconciles our running balance exactly. |
| `CollateralWithdrawal` | `accountId, amountCNS, balanceCNS` | **index now** | Free AUSD pulled out of the account. Needs a wallet signature, never an API key. |
| `OrderForwardingUpdated` | `accountId, allowed` | **index now** | The `fw` flag. No on-chain getter exists, so this event is the only way to know an account permits API-key-forwarded orders. |
| `AccountFeeTierSet` | `accountId, tier` | later | Account moved to a cheaper/dearer fee tier; changes which entry of the fee schedule applies to its fills. |
| `AccountFreeze` | `accountId, status` | later | One account frozen/unfrozen. A frozen account can only reduce risk; its resting orders get cleared. |
| `AccountFrozen` | `status` | later | Exchange-wide account freeze status. Same effect as above, applied to everyone. |
| `TransferAccountToProtocol` | `accountId, amountCNS, balanceCNS` | later | Admin sweep of account balance to the protocol treasury; moves free balance without a deposit/withdrawal. |
| `TransferProtocolToAccount` | `accountId, amountCNS, balanceCNS` | later | Protocol treasury credits an account (rebates, compensation); moves free balance without a deposit. |
| `AmountExceedsAvailableBalance` | `amountCNS, availableBalanceCNS, balanceCNS` | diagnostic | Withdrawal/lock attempt exceeded free balance. Reports available vs total balance at the moment of failure. |
| `LastForwardedDescIdReset` | `accountId, newDescId` | diagnostic | Forwarded-order nonce (`orderDescId`) high-water mark was reset for an account; only matters for replay protection. |
| `LastTriggeredDescIdReset` | `accountId, newDescId` | diagnostic | Same as above for trigger-order nonces. |
| `OrderForwardingNotAllowed` | `(none)` | diagnostic | On-chain twin of `sr 34` OrderForwardingNotAllowed: the account refused a forwarded order. Carries no ids, so it must be attributed to the enclosing OrderRequestV2. |
| `UnspecifiedCollateral` | `(none)` | diagnostic | Collateral token argument was zero/unset on a deposit call. Pure input-validation noise. |

## B. Position changes (size & PnL)

| event | fields | | note |
| - | - | - | - |
| `PositionClosed` `~11` | `perpId, accountId, positionType, pricePNS, deltaPnlCNS, fundingCNS` | **index now** | Position went to zero. Final realized PnL and funding; closes the Position row and decides win/loss. |
| `PositionDecreased` `~24` | `perpId, accountId, positionType, startDepositCNS, endDepositCNS, startLotLNS, endLotLNS, deltaPnlCNS, fundingCNS` | **index now** | Position shrank. `deltaPnlCNS` is REALIZED PnL on the closed part and `fundingCNS` the funding settled with it: the primary input to realized-PnL aggregates. |
| `PositionIncreased` `!` | `perpId, accountId, positionType, leverageHdths, startDepositCNS, endDepositCNS, pnlCollateralizedCNS, premiumPnlSettledCNS, maxNegPnlCollatBPS, pricePNS, startLotLNS, endLotLNS, insFeeCNS, protFeeCNS` | **index now** | Pre-upgrade forms of open/increase, without `priceResiduePNSQ16`. Still present in history, so a full backfill must decode them. |
| `PositionIncreasedV2` `~22` | `perpId, accountId, positionType, leverageHdths, startDepositCNS, endDepositCNS, pnlCollateralizedCNS, premiumPnlSettledCNS, maxNegPnlCollatBPS, pricePNS, startLotLNS, endLotLNS, insFeeCNS, protFeeCNS, priceResiduePNSQ16` | **index now** | Position grew. `startDeposit`/`endDeposit` show margin added by the fill, `insFeeCNS`+`protFeeCNS` are the fees paid. |
| `PositionInverted` `~1` | `perpId, accountId, positionType, leverageHdths, startDepositCNS, endDepositCNS, pnlCollateralizedCNS, pricePNS, startLotLNS, endLotLNS, deltaPnlCNS, fundingCNS, insFeeCNS, protFeeCNS` | **index now** | A fill larger than the position flipped it long<->short: realizes PnL on the old side and opens the new one in a single event. |
| `PositionOpened` `!` | `perpId, accountId, positionType, leverageHdths, depositCNS, pnlCollateralizedCNS, pricePNS, lotLNS, insFeeCNS, protFeeCNS` | **index now** | Pre-upgrade forms of open/increase, without `priceResiduePNSQ16`. Still present in history, so a full backfill must decode them. |
| `PositionOpenedV2` `~13` | `perpId, accountId, positionType, leverageHdths, depositCNS, pnlCollateralizedCNS, pricePNS, lotLNS, insFeeCNS, protFeeCNS, priceResiduePNSQ16` | **index now** | A new isolated position: side, lot, entry price, the deposit locked as its margin, and the open fees. Starts a Position row. |
| `PositionDoesNotExist` | `perpId, accountId` | diagnostic | An operation addressed a position that does not exist (already closed/liquidated). Common benign race. |

## C. Isolated margin: per-position collateral

| event | fields | | note |
| - | - | - | - |
| `CollateralDecreaseRequested` | `perpId, accountId, expiryTS, amountCNS, clampToMaximum, positionType, entryPricePNS, lotLNS` | **index now** | Trader asked to pull margin out of a position. Two-phase: this request must later settle, expire, be cancelled or be declined. |
| `IncreasePositionCollateral` `~1` | `perpId, accountId, positionDepositCNS, amountCNS, balanceCNS` | **index now** | ADD MARGIN. Exactly the action PerpGuard offers: free balance moved into one position. `positionDepositCNS` is the new isolated margin. |
| `PositionCollateralDecreased` | `perpId, accountId, positionType, markPricePNS, impactAdjPricePNS, startDepositCNS, endDepositCNS, startEntryPricePNS, endEntryPricePNS, effBmfHdths, decreaseCNS, balanceCNS` | **index now** | REMOVE MARGIN settled: margin returned from a position to free balance, with the entry price re-struck. Raises the liquidation price. |
| `CollateralDecreaseDeclined` | `perpId, accountId, reason` | later | An operator declined the margin withdrawal, with a reason string. |
| `CollateralDecreaseRequestCancelled` | `perpId, accountId` | later | The pending margin-withdrawal request was cancelled by the trader. |
| `CollateralDecreaseRequestExpired` | `perpId, accountId, expiryTS, blockTS` | later | The pending margin-withdrawal request timed out without settling. |
| `BorrowMarginNotMetAfterDecCollateral` | `perpId, accountId, bmrCNS, fmvAfterCNS` | diagnostic | Margin withdrawal refused: the position would breach its borrow-margin requirement afterwards. |
| `CannotAdjustEntryPriceToDecCollateral` | `perpId, accountId, amountCNS, adjustmentAmountCNS, entryPricePNS, adjustedEntryPricePNS, positionType` | diagnostic | Margin withdrawal refused: the entry price cannot be re-struck for the requested amount. |
| `DecreaseCollateralBeyondMarkPrice` | `perpId, accountId, positionType, impactAdjPricePNS, markPricePNS` | diagnostic | Margin withdrawal refused: the implied entry-price adjustment would cross the mark price. |
| `InsufficientFundsToDecCollateral` | `perpId, accountId, amountCNS, withdrawMaxCNS` | diagnostic | Margin withdrawal refused: requested more than `withdrawMaxCNS` allows. |

## D. Liquidation, deleverage & unwind

| event | fields | | note |
| - | - | - | - |
| `AccountLiquidationCredit` | `perpId, accountId, startBalanceCNS, endBalanceCNS` | **index now** | Same credit applied at account level rather than position level. |
| `BuyToLiquidateSettled` | `perpId, accountId, orderType, realizedPricePNS, lotLNS, amountCNS, balanceCNS` | **index now** | Buy-to-liquidate filled: realized price, lot and the resulting balance. Pairs with the Started event above. |
| `BuyToLiquidateStarted` | `perpId, posAccountId, liquidatorId, requestedLotLNS, leverageHdths, limitPricePNS, maxNegPnlCollatBPS` | **index now** | Third-party liquidator bought a distressed position off the book. Start of a buy-to-liquidate. |
| `PositionDeleveraged` `!` | `perpId, accountId, forceClose, positionType, entryPricePNS, markPricePNS, deleveragePricePNS, deltaPnlCNS, fundingCNS, startDepositCNS, endDepositCNS, startLotLNS, endLotLNS, amountCNS, balanceCNS` | **index now** | Pre-upgrade forms of deleverage and unwind, without `priceResiduePNSQ16`. Still present in history, so a full backfill must decode them. |
| `PositionDeleveragedV2` | `perpId, accountId, forceClose, positionType, entryPricePNS, markPricePNS, deleveragePricePNS, deltaPnlCNS, fundingCNS, startDepositCNS, endDepositCNS, startLotLNS, endLotLNS, amountCNS, balanceCNS, priceResiduePNSQ16` | **index now** | Auto-deleverage: a profitable position force-closed against an insolvent one. Forced closure, not a trade, and it must not count as a voluntary exit. |
| `PositionLiquidated` | `perpId, posAccountId, positionType, markPricePNS, liqPricePNS, liqLotLNS, posLotLNS, deltaPnlCNS, fundingCNS, posAmountCNS, posDepositCNS, accAmountCNS, accBalanceCNS, onOrderBook` | **index now** | THE liquidation event. Mark and liquidation price, lots taken vs lots remaining (so partial vs full is derivable), realized PnL, the position deposit consumed, and the account balance left over. `accBalanceCNS - accAmountCNS` is the free balance immediately before the event, which is what `wasRescuable` -- the "liquidated while holding enough AUSD to survive" number -- is computed against. Note that merely having *some* free balance is true of every liquidation on mainnet and means nothing; see `hadSpareBalance` in schema.graphql. |
| `PositionLiquidationCredit` | `perpId, accountId, startDepositCNS, endDepositCNS` | **index now** | Insurance fund topping a liquidated position back up; the difference between the deposit before and after tells us how much the fund paid. |
| `PositionUnwound` `!` | `perpId, accountId, markPricePNS, positionType, pricePNS, lotLNS, depositCNS, positionFmvCNS, paymentCNS, balanceCNS` | **index now** | Pre-upgrade forms of deleverage and unwind, without `priceResiduePNSQ16`. Still present in history, so a full backfill must decode them. |
| `PositionUnwoundV2` | `perpId, accountId, markPricePNS, positionType, pricePNS, lotLNS, depositCNS, positionFmvCNS, paymentCNS, balanceCNS, priceResiduePNSQ16` | **index now** | Whole-market unwind settled a position at the unwind price and paid the trader out. |
| `PositionUnwoundWithoutPayment` `!` | `perpId, accountId, markPricePNS, positionType, pricePNS, lotLNS, depositCNS, positionFmvCNS, amountOwedCNS` | **index now** | Pre-upgrade forms of deleverage and unwind, without `priceResiduePNSQ16`. Still present in history, so a full backfill must decode them. |
| `PositionUnwoundWithoutPaymentV2` | `perpId, accountId, markPricePNS, positionType, pricePNS, lotLNS, depositCNS, positionFmvCNS, amountOwedCNS, priceResiduePNSQ16` | **index now** | Unwind settled a position but could NOT pay: `amountOwedCNS` is a bad debt the trader never receives. |
| `InsurancePaymentForSettlement` | `perpId, accountId, insPaymentCNS` | later | Insurance fund paid to settle a fill that would otherwise have left the perp short. |
| `OrderCancelledByLiquidator` | `perpId, accountId, orderId, lockedBalanceCNS` | later | A liquidator cancelled a distressed account's resting orders before taking the position. |
| `ResidueTransferred` | `perpId, residueAmountCNS, positionBalanceCNS` | later | Leftover position balance swept back to the perp after settlement. |
| `UnwindCompleted` | `perpId, positionsUnwound, perpPositionBalanceCNS, insuranceBalanceCNS` | later | Market-wide unwind lifecycle: prepared, initialized, triggered, one iteration done, all done, or the staging cleared. |
| `UnwindContractTrigger` | `perpId` | later | Market-wide unwind lifecycle: prepared, initialized, triggered, one iteration done, all done, or the staging cleared. |
| `UnwindInitializationCleared` | `perpId` | later | Market-wide unwind lifecycle: prepared, initialized, triggered, one iteration done, all done, or the staging cleared. |
| `UnwindInitialized` | `perpId, sumPositiveFmvCNS` | later | Market-wide unwind lifecycle: prepared, initialized, triggered, one iteration done, all done, or the staging cleared. |
| `UnwindIterationCompleted` | `perpId, positionsUnwound, perpPositionBalanceCNS, insuranceBalanceCNS` | later | Market-wide unwind lifecycle: prepared, initialized, triggered, one iteration done, all done, or the staging cleared. |
| `UnwindPreparationCleared` | `perpId` | later | Market-wide unwind lifecycle: prepared, initialized, triggered, one iteration done, all done, or the staging cleared. |
| `UnwindPrepared` | `perpId` | later | Market-wide unwind lifecycle: prepared, initialized, triggered, one iteration done, all done, or the staging cleared. |
| `BankruptcyPricePreventsDeleverage` | `perpId, accountId, positionType, bankruptcyPricePNS, markPricePNS` | diagnostic | Deleverage refused: the bankruptcy price makes it impossible at the current mark. |
| `BuyToLiquidateBuyerRestricted` | `perpId, buyer` | diagnostic | Buy-to-liquidate refused: this buyer is not on the allow-list for the market. |
| `BuyToLiquidateSlippageExceeded` | `perpId, posAccountId, positionType, markPricePNS, limitPricePNS` | diagnostic | Buy-to-liquidate refused: the fill would have exceeded the liquidator's limit price. |
| `CantBuyToLiquidate` | `perpId, posAccountId, positionType, markPricePNS, bsLiqPricePNS, liqPricePNS, bkptPricePNS` | diagnostic | Buy-to-liquidate refused: the position is not distressed enough at the current mark. |
| `CantDeleverageAgainstOpposingPositions` | `perpId, accountId, forceClose, positionType, deleveragePricePNS, sortedPositionIds` | diagnostic | Deleverage refused: nothing on the opposing side to deleverage against. |
| `CantLiquidatePosAboveMMR` | `perpId, posAccountId, positionType, markPricePNS, liqPricePNS` | diagnostic | Liquidation refused: the position is still above its maintenance margin. |
| `DeleveragePositionListEmpty` | `perpId, accountId` | diagnostic | Deleverage refused: the candidate list was empty. |
| `InsolventPositionCannotBeForcedClose` | `perpId, posAccountId, positionType, bankruptcyPricePNS, markPricePNS` | diagnostic | Force-close refused: the position is already insolvent. |
| `InvalidBankruptcyPrice` | `perpId, accountId, depositCNS, posPricePNS, liqLotLNS, premiumPnlCNS` | diagnostic | Computed bankruptcy price was invalid for the position. |
| `InvalidLiquidationPrice` | `perpId, accountId, depositCNS, posPricePNS, liqLotLNS, premiumPnlCNS` | diagnostic | Computed liquidation price was invalid for the position; liquidation aborted. |
| `PerpPositionBalCreditPositiveSevere` | `perpId, accountId, realizedPricePNS, lotLNS, userProceedsToPosition, buyToLiquidate, creditPerpBalCNS` | diagnostic | Severe accounting alarm: the perp position balance was credited positive where it should not be. Worth alerting on, never normal. |
| `ResidueBalanceInsufficient` | `perpId, requestedAmountCNS, positionBalanceCNS` | diagnostic | Residue transfer asked for more than the perp position balance held. |
| `UnwindInsufficientBalance` | `perpId, accountId, perpPositionBalanceCNS, paymentCNS` | diagnostic | Unwind could not pay a position out of the perp balance. |
| `UnwindProcessInProgress` | `perpId` | diagnostic | An unwind is already running for this market; the call was a no-op. |

## E. Orders & trades

| event | fields | | note |
| - | - | - | - |
| `MakerOrderFilled` `!` | `perpId, accountId, orderId, pricePNS, lotLNS, feeCNS, lockedBalanceCNS, amountCNS, balanceCNS` | **index now** | Pre-upgrade fill forms (no builder-code fields). Present in history. |
| `MakerOrderFilledV2` `~41` | `perpId, accountId, orderId, pricePNS, lotLNS, feeCNS, lockedBalanceCNS, amountCNS, balanceCNS, builderId, builderFeeCNS` | **index now** | MAKER SIDE OF A MATCH. Has perpId + accountId, so this is the one fill event that identifies its own trader. One per match -- the per-trade record. |
| `OrderCancelled` `~475` | `lockedBalanceCNS, amountCNS, balanceCNS` | **index now** | A resting order was removed and its balance lock released. No ids: attribute to the enclosing request. |
| `OrderChanged` `~1550` | `orderId, pricePNS, lotLNS, expiryBlock, lockedBalanceCNS, balanceCNS` | **index now** | A resting order's price, lot or expiry changed (also how re-posts renew `expiryBlock`). Keyed by the short, recycled orderId only. |
| `OrderPlaced` `~488` | `orderId, lotLNS, lockedBalanceCNS, amountCNS, balanceCNS` | **index now** | A resting order was posted. Carries no perpId/accountId -- attribute it to the enclosing OrderRequestV2. |
| `OrderRequest` `!` | `perpId, accountId, orderDescId, orderId, orderType, pricePNS, lotLNS, expiryBlock, postOnly, fillOrKill, immediateOrCancel, maxMatches, leverageHdths, lastExecutionBlock, amountCNS, maxNegPnlCollatBPS, gasLeft` | **index now** | Pre-upgrade scope opener without the `extension` field. Needed for a full backfill. |
| `OrderRequestV2` `~3470` | `perpId, accountId, orderDescId, orderId, orderType, pricePNS, lotLNS, expiryBlock, postOnly, fillOrKill, immediateOrCancel, maxMatches, leverageHdths, lastExecutionBlock, amountCNS, maxNegPnlCollatBPS, gasLeft, extension` | **index now** | SCOPE OPENER. The only order event carrying `perpId` + `accountId`. Everything that follows it in the transaction (place/change/cancel/taker-fill/IOC/reject) belongs to this request until the next one. |
| `TakerOrderFilled` `!` | `entryPricePNS, collatPricePNS, pnlPricePNS, lotLNS, feeCNS, amountCNS, balanceCNS` | **index now** | Pre-upgrade fill forms (no builder-code fields). Present in history. |
| `TakerOrderFilledV2` `~30` | `entryPricePNS, collatPricePNS, pnlPricePNS, lotLNS, feeCNS, amountCNS, balanceCNS, builderId, builderFeeCNS` | **index now** | TAKER SIDE, aggregated over the whole order and carrying NO ids: the taker is the enclosing request's account. `feeCNS` is the taker fee for the order. |
| `ClearingExpiredOrder` | `perpId, accountId, orderId, lockedBalanceCNS, recyclerAccountId, recyclerAmountCNS, recyclerBalanceCNS` | later | Housekeeping: a stale order was cleared and the recycle fee paid. `ClearingExpiredOrder` is the normal end of life for an order -- expiry is routine, not a failure. |
| `ClearingFrozenAccountOrder` | `perpId, accountId, orderId, lockedBalanceCNS, recyclerAccountId, recyclerAmountCNS, recyclerBalanceCNS` | later | Housekeeping: a stale order was cleared and the recycle fee paid. `ClearingExpiredOrder` is the normal end of life for an order -- expiry is routine, not a failure. |
| `ClearingInvalidCloseOrder` | `perpId, accountId, orderId, lockedBalanceCNS, recyclerAccountId, recyclerAmountCNS, recyclerBalanceCNS` | later | Housekeeping: a stale order was cleared and the recycle fee paid. `ClearingExpiredOrder` is the normal end of life for an order -- expiry is routine, not a failure. |
| `ClearingRemainingOrderLockBeyondBalance` | `perpId, accountId, orderId, pricePNS, remainingLotLNS, lockedBalanceCNS, excessiveLockedBalCNS, recyclerAccountId, recyclerAmountCNS, recyclerBalanceCNS` | later | Housekeeping: a stale order was cleared and the recycle fee paid. `ClearingExpiredOrder` is the normal end of life for an order -- expiry is routine, not a failure. |
| `ClearingSelfMatchingOrder` `~2` | `perpId, accountId, orderId, lockedBalanceCNS, recyclerAccountId, recyclerAmountCNS, recyclerBalanceCNS` | later | Housekeeping: a stale order was cleared and the recycle fee paid. `ClearingExpiredOrder` is the normal end of life for an order -- expiry is routine, not a failure. |
| `ImmediateOrCancelExecuted` `~833` | `unmatchedLotLNS, totalLotLNS` | later | How much of an IOC order went unmatched; the rest is discarded rather than rested. |
| `OrderBatchCompleted` `~1385` | `gasLeft` | later | End of the transaction's order batch. Useful as a scope terminator and a gas watermark. |
| `OrderCancelledByAdmin` | `perpId, accountId, orderId, lockedBalanceCNS` | later | Admin cancelled an order (market wind-down, frozen account cleanup). |
| `RecycleFeeToAccount` `!` | `accountId, perpId, orderId, recycleFeeCNS, recycleBalanceCNS` | later | Recycle fee routed to the recycler account or to the protocol. |
| `RecycleFeeToProtocol` | `perpId, orderId, recycleFeeCNS, recycleBalanceCNS` | later | Recycle fee routed to the recycler account or to the protocol. |
| `TriggerOrderExecution` | `(none)` | later | A trigger order fired. |
| `TriggerOrderRequest` | `triggerPricePNS, triggerPriceCondition, triggerRequestId, triggerPositionId` | later | Stop/take-profit registered, with its trigger price and condition. |
| `CancelExistingInvalidCloseOrders` | `lockedLotLNS, lockedPositionType, newPositionType` | diagnostic | Existing reduce-only orders were invalidated because the position side changed. |
| `CantChangeCloseOrder` | `perpId, orderId, accountId` | diagnostic | A close order cannot be amended the way the request asked. |
| `ChangeExpiredOrderNeedsNewExpiry` | `perpId, orderId, accountId, expiryBlock` | diagnostic | Amending an already-expired order requires a fresh expiry block. |
| `CloseOrderExceedsPosition` | `posLotLNS, orderLotLNS` | diagnostic | Reduce-only order was bigger than the position. |
| `CloseOrderPositionMismatch` | `positionType, orderType` | diagnostic | Reduce-only order side did not match the position side. |
| `CrossesBook` `~10` | `minAskOrMaxBidPNS, maxOrdersChecked` | diagnostic | Order rejected: would cross the book while post-only. |
| `ExceedsLastExecutionBlock` `~52` | `lastExecutionBlock` | diagnostic | Order rejected: submitted past its `lastExecutionBlock`. Frequent and benign -- orders self-expire in seconds. |
| `InsuficientFundsForRecycleFee` | `perpId, accountId, balanceCNS, lockedCNS, recycleFeeCNS` | diagnostic | Account could not pay the recycle fee. |
| `InvalidAccountFrozenOrder` | `orderType, immediateOrCancel` | diagnostic | A frozen account may only submit risk-reducing IOC orders; this one did not qualify. |
| `InvalidExpiryBlock` | `expiryBlock, blockNumber` | diagnostic | Expiry block was in the past or beyond the market's TTL window. |
| `InvalidOrderId` | `orderId, min, max` | diagnostic | Order id outside the valid slot range for the market. |
| `LotOutOfRange` | `minLotLNS, maxLotLNS` | diagnostic | Order lot outside the market minimum/maximum. |
| `MakerOrderSettlementFailed` | `perpId, accountId, orderId, orderType, pricePNS, lotLNS, maxNegPnlCollatBPS, reason, lockedBalanceCNS, recyclerAccountId, recyclerAmountCNS, recyclerBalanceCNS` | diagnostic | A maker order failed settlement at match time and was cleared instead of filled; the counterparty's taker fill does not happen. |
| `MaxMatchesReached` `~1` | `(none)` | diagnostic | Matching engine hit its per-order match cap and stopped early. |
| `MaximumAccountOrders` | `perpId, accountId` | diagnostic | Account already has the maximum number of live orders on this market. |
| `OrderDescIdTooLow` `~7` | `lastOrderDescId` | diagnostic | Forwarded-order nonce was not greater than the last one seen (replay guard). |
| `OrderDoesNotExist` `~22` | `perpId, orderId` | diagnostic | Order id not found: already filled, expired or recycled. The on-chain twin of a cancel that never produces an outcome. |
| `OrderExtensionRejected` | `perpId, accountId` | diagnostic | Request to extend an order's life was refused. |
| `OrderPostFailed` | `reason` | diagnostic | Post failed, with a numeric reason. |
| `OrderSettlementImpliesInsolvent` | `perpId, accountId, orderType, pricePNS, lotLNS, perpPositionBalCNS, perpInsuranceBalCNS, addedPosCollatReqCNS, requestedAmountCNS` | diagnostic | Settlement would have left the account insolvent, so the fill was refused. |
| `OrderSizeExceedsAvailableSize` | `orderLotLNS, availableLotLNS, positionLotLNS` | diagnostic | Order size exceeded the size still available on the position. |
| `PostOrderUnderMinimum` | `orderAmountCNS, minAmountCNS` | diagnostic | Resting order notional below the exchange minimum post size. |
| `PriceOutOfRange` | `minPricePNS, maxPricePNS` | diagnostic | Order price outside the market band. |
| `PriceSetDuringTriggerExec` | `triggerPricePNS` | diagnostic | A mark price was set while a trigger order was executing; ordering caveat for trigger analysis. |
| `RecycleBalanceInsufficientSevere` | `accountId, perpId, orderId, recycleFeeCNS, recycleBalanceCNS` | diagnostic | Severe: the recycle balance was too low to cover a fee it had promised. |
| `TriggerDescIdTooLow` | `lastTriggerDescId` | diagnostic | Trigger-order nonce was not greater than the last one seen. |
| `UnableToCancelOrder` | `perpId, orderId` | diagnostic | A cancel could not be executed. |
| `WrongAccountForOrder` `~8` | `perpId, orderId, accountId` | diagnostic | Order id belongs to a different account. |

## F. Market definition & risk parameters

| event | fields | | note |
| - | - | - | - |
| `ContractAdded` `!` | `perpId, name, symbol, status, basePricePNS, priceDecimals, lotDecimals, takerFeePer100K, makerFeePer100K, initMarginFracHdths, maintMarginFracHdths, maxOpenInterestLNS, unityDescentThreshHdths, overColDescentThreshHdths, dcpBorrowThreshHdths, priceTolPer100K, marginTol, marginTolDecimals, refPriceMaxAgeSec, absFundingClampPctPer100K, permCancelMinOrders, permCancelSegment, insAmtPer100K, liqInsAmtPer100K, liqUserAmtPer100K, btlRestrictBuyers, btlPriceThreshPer100K, btlInsAmtPer100K, btlUserAmtPer100K, btlBuyerAmtPer100K, numPerpetuals` | **index now** | Pre-upgrade market definition, with maker/taker fees inline instead of a fee-schedule id. Markets listed before the upgrade only appear in this form. |
| `ContractAddedV2` | `perpId, name, symbol, status, basePricePNS, priceDecimals, lotDecimals, initMarginFracHdths, maintMarginFracHdths, maxOpenInterestLNS, unityDescentThreshHdths, overColDescentThreshHdths, dcpBorrowThreshHdths, priceTolPer100K, marginTol, marginTolDecimals, refPriceMaxAgeSec, absFundingClampPctPer100K, permCancelMinOrders, permCancelSegment, insAmtPer100K, liqInsAmtPer100K, liqUserAmtPer100K, btlRestrictBuyers, btlPriceThreshPer100K, btlInsAmtPer100K, btlUserAmtPer100K, btlBuyerAmtPer100K, numPerpetuals, perpFeeSchedId` | **index now** | MARKET DEFINITION: perpId, name, symbol, status, and critically `priceDecimals` + `lotDecimals`. Every notional we compute depends on these, and CLAUDE.md forbids hard-coding them -- this event is where the indexer learns them. |
| `ContractPaused` | `perpId, paused` | **index now** | Market paused/unpaused. Directly the "market we can watch but not act on" case: keep monitoring, disable the buttons. |
| `ContractRemoved` | `perpId` | **index now** | Market delisted. |
| `InitialMarginFractionUpdated` | `perpId, initMarginFracHdths` | **index now** | Initial margin fraction changed -> max leverage changed for this market. |
| `MaintenanceMarginFractionUpdated` | `perpId, maintMarginFracHdths` | **index now** | MAINTENANCE margin fraction changed -> every liquidation price in the market moves. Must be indexed or our liquidation warnings go stale. |
| `MaxOpenInterestUpdated` | `perpId, maxOpenInterestLNS` | **index now** | Open-interest cap changed; the denominator of OI utilisation. |
| `BuyToLiquidateParamsUpdated` | `perpId, insAmtPer100K, userAmtPer100K, buyerAmtPer100K, protAmtPer100K` | later | Buy-to-liquidate payout split, price threshold, or buyer restriction changed. |
| `BuyToLiquidateRestrictionUpdated` | `perpId, restrictBuyers` | later | Buy-to-liquidate payout split, price threshold, or buyer restriction changed. |
| `BuyToLiquidateThresholdUpdated` | `perpId, thresholdPer100K` | later | Buy-to-liquidate payout split, price threshold, or buyer restriction changed. |
| `DcpBorrowThreshUpdated` | `perpId, threshHdths` | later | Deleverage/descent thresholds tuned for a market. |
| `DefaultPerpFeeScheduleSet` | `feeSchedId, takerFeesPer100K, makerFeesPer100K` | later | Tiered fee schedule created, changed, migrated, or set as the perp/RWA default; fills price fees off these. |
| `DefaultRwaFeeScheduleSet` | `feeSchedId, takerFeesPer100K, makerFeesPer100K` | later | Tiered fee schedule created, changed, migrated, or set as the perp/RWA default; fills price fees off these. |
| `FeeParamsUpdated` | `perpId, insAmtPer100K` | later | Insurance-fund cut of fees for a market changed. |
| `FeeScheduleMigrated` | `feeSchedId, oldTakerFees, oldMakerFees, newTakerFees, newMakerFees` | later | Tiered fee schedule created, changed, migrated, or set as the perp/RWA default; fills price fees off these. |
| `FeeScheduleSet` | `feeSchedId, takerFeesPer100K, makerFeesPer100K` | later | Tiered fee schedule created, changed, migrated, or set as the perp/RWA default; fills price fees off these. |
| `FeeUnitRedenominated` | `oldDenominator, newDenominator, unitScale, rateDiv, migratedScheduleCount` | later | Tiered fee schedule created, changed, migrated, or set as the perp/RWA default; fills price fees off these. |
| `FundingClampPctUpdated` | `perpId, clampPctPer100k` | later | Funding-rate clamp changed for a market. |
| `FundingSumScalingExpUpdated` | `perpId, newExp` | later | Scaling exponent of the stored funding sum changed; affects how funding accruals decode. |
| `LiquidationBuyerUpdated` | `liquidationBuyer, accountId, added` | later | An address was added to or removed from the liquidation-buyer allow-list. |
| `LiquidationParamsUpdated` | `perpId, insAmtPer100K, liqAmtPer100K, userAmtPer100K` | later | Liquidation payout split (insurance / liquidator / user) changed; changes what a liquidation costs the trader. |
| `MakerFeeUpdated` `!` | `perpId, makerFeePer100K` | later | Maker/taker fee for a market changed (pre-fee-schedule form). |
| `MarginTolUpdated` | `perpId, tolerance, decimals` | later | Price/margin tolerance bands and max oracle age tuned for a market. |
| `OverCollatDescentThreshUpdated` | `perpId, threshHdths` | later | Deleverage/descent thresholds tuned for a market. |
| `PermissonedCancelParamsUpdated` | `cancelMinOrders, cancelSegment` | later | Permissioned bulk-cancel parameters changed. |
| `PerpFeeSchedIdSet` | `perpId, feeSchedId` | later | Which fee schedule a market uses. |
| `PriceMaxAgeUpdated` | `perpId, maxAgeSec` | later | Price/margin tolerance bands and max oracle age tuned for a market. |
| `PriceTolUpdated` | `perpId, tolPer100k` | later | Price/margin tolerance bands and max oracle age tuned for a market. |
| `TakerFeeUpdated` `!` | `perpId, takerFeePer100K` | later | Maker/taker fee for a market changed (pre-fee-schedule form). |
| `UnityDescentThreshUpdated` | `perpId, threshHdths` | later | Deleverage/descent thresholds tuned for a market. |
| `ContractNotOperational` | `perpId, status` | diagnostic | An operation touched a market that is not operational; reports the status byte. |
| `MonitorPauseAttempted` | `perpId, actualStatus, transitioned` | diagnostic | The monitor role tried to pause a market; says whether the state actually changed. |

## G. Mark price, oracle & funding

| event | fields | | note |
| - | - | - | - |
| `FundingEventCompleted` | `perpId, fundingEventBlock, specifiedRatePct100k, actualRatePct100k, fundingPricePNS, fundingPaymentPNS, fundingSumPNS, allowOverwrite` | **index now** | Funding settled for a market: the rate actually applied and the per-lot payment. The ongoing cost of holding a position. |
| `MarkUpdated` `~62` | `perpId, pricePNS` | **index now** | New mark price for a market. The risk engine takes live prices off the websocket, so the indexer keeps only the latest value and daily OHLC -- never a row per update. |
| `ContractLinkFeedUpdated` | `perpId, feedId` | later | Chainlink Data Streams verifier configured, or a market's feed id changed. |
| `IgnoreOracleUpdated` | `perpId, ignOracle` | later | Oracle turned off for a market, or the ignore-oracle override toggled: mark pricing stops being oracle-anchored. |
| `LinkDatastreamConfigured` | `verifierProxy` | later | Chainlink Data Streams verifier configured, or a market's feed id changed. |
| `LinkPriceUpdated` `~15` | `perpId, oraclePricePNS, timestamp` | later | New Chainlink oracle price for a market, with its timestamp. |
| `OracleDisabled` | `perpId` | later | Oracle turned off for a market, or the ignore-oracle override toggled: mark pricing stops being oracle-anchored. |
| `FundingEventSetTooEarly` | `perpId, blockNumber, fundingEventBlock` | diagnostic | Funding event was scheduled before its due block. |
| `FundingPriceExceedsTol` | `perpId, fundingPricePNS, oraclePNS, tolerancePer100k` | diagnostic | Funding price was outside tolerance of the oracle and was rejected. |
| `FundingSumAlreadySet` | `perpId, fundingEventBlock, storageIndex, fundingSumOffset` | diagnostic | Funding sum for that block was already written. |
| `InvalidLinkReportForContract` | `perpId, perpFeedId, reportFeedId` | diagnostic | Chainlink report rejected: older than the last update, expires too soon, dated in the future, negative price, wrong feed id, or wrong version. |
| `InvalidLinkReportVersion` | `perpId, reportVersion` | diagnostic | Chainlink report rejected: older than the last update, expires too soon, dated in the future, negative price, wrong feed id, or wrong version. |
| `LinkDsError` | `perpId, reason` | diagnostic | Chainlink verifier reverted or panicked while verifying a report (two overloads: reason string and raw revert data). |
| `LinkDsError` | `perpId, lowLevelData` | diagnostic | Chainlink verifier reverted or panicked while verifying a report (two overloads: reason string and raw revert data). |
| `LinkDsPanic` | `perpId, errorCode` | diagnostic | Chainlink verifier reverted or panicked while verifying a report (two overloads: reason string and raw revert data). |
| `MarkExceedsTol` | `perpId, markPNS, spotOraclePricePNS, tolerancePer100k` | diagnostic | Mark price moved outside the tolerance band around the oracle and was rejected. |
| `MarkPriceAgeExceedsMax` | `perpId, markTimestamp, timestamp, maxAgeSec` | diagnostic | Stored mark price is older than the market's max age. |
| `OracleAgeExceedsMax` | `perpId, oracleTimestamp, timestamp, maxAgeSec` | diagnostic | Oracle price is older than the market's max age. |
| `ReportAgeExceedsLastUpdate` `~15` | `perpId, lastUpdateTimestamp, reportValidFromTimestamp` | diagnostic | Chainlink report rejected: older than the last update, expires too soon, dated in the future, negative price, wrong feed id, or wrong version. |
| `ReportExpiresTooSoon` | `perpId, expiresAt, minRequired` | diagnostic | Chainlink report rejected: older than the last update, expires too soon, dated in the future, negative price, wrong feed id, or wrong version. |
| `ReportFromFuture` | `perpId, reportTimestamp, blockTimestamp` | diagnostic | Chainlink report rejected: older than the last update, expires too soon, dated in the future, negative price, wrong feed id, or wrong version. |
| `ReportPriceIsNegative` | `perpId, reportPrice` | diagnostic | Chainlink report rejected: older than the last update, expires too soon, dated in the future, negative price, wrong feed id, or wrong version. |
| `UpdateOracleFailed` `~15` | `perpId` | diagnostic | Oracle update failed for a market. Fires steadily in normal operation; do not read it as an outage on its own. |

## H. Exchange admin, proxy & protocol treasury

| event | fields | | note |
| - | - | - | - |
| `ExchangeHalted` | `halted` | **index now** | Whole exchange halted or resumed. The clearest "we can monitor but nobody can act" signal there is. |
| `Upgraded` | `implementation` | **index now** | PROXY UPGRADED. The implementation behind the address we index changed, so the ABI snapshot may no longer match. Index it as a tripwire: an upgrade is when to re-check the ABI. |
| `AdminChanged` `!` | `previousAdmin, newAdmin` | later | Proxy plumbing from OpenZeppelin: initializer version, proxy admin change, beacon change. |
| `AdministratorUpdated` | `administrator, added` | later | A privileged role was granted or revoked (general admin, monitor, position, price, tolerance). |
| `BeaconUpgraded` `!` | `beacon` | later | Proxy plumbing from OpenZeppelin: initializer version, proxy admin change, beacon change. |
| `BlockStatusChanged` | `addr, blocked` | later | An address was blocked/unblocked, whitelisted, or whitelisting was switched on/off: who may trade at all. |
| `ContractVersionSet` | `major, minor, patch` | later | Implementation version bumped; pairs with `Upgraded`. |
| `ExchangeInitialized` | `sender, collateralToken, collateralDecimals, minAccountOpenCNS, wrlsThousandthsTvl, wrlsMinWithdrawLimitCNS, recycleFeeCNS, whitelistingEnabled` | later | Exchange initialised: collateral token, decimals, minimum account opening amount. Useful provenance for the first block we index. |
| `Initialized` | `version` | later | Proxy plumbing from OpenZeppelin: initializer version, proxy admin change, beacon change. |
| `MinAccountOpenAmountUpdated` | `minAccountOpenCNS` | later | Exchange-wide minimums changed: account opening amount, minimum post, minimum settle, recycle fee. |
| `MinPostUpdated` | `minPostCNS` | later | Exchange-wide minimums changed: account opening amount, minimum post, minimum settle, recycle fee. |
| `MinSettleUpdated` | `minSettleCNS` | later | Exchange-wide minimums changed: account opening amount, minimum post, minimum settle, recycle fee. |
| `MonitorAdministratorUpdated` | `monitorAdministrator, added` | later | A privileged role was granted or revoked (general admin, monitor, position, price, tolerance). |
| `OwnershipTransferStarted` | `previousOwner, newOwner` | later | Ownership handover started or completed. |
| `OwnershipTransferred` | `previousOwner, newOwner` | later | Ownership handover started or completed. |
| `PositionAdministratorUpdated` | `positionAdministrator, added` | later | A privileged role was granted or revoked (general admin, monitor, position, price, tolerance). |
| `PriceAdministratorUpdated` | `priceAdministrator, added` | later | A privileged role was granted or revoked (general admin, monitor, position, price, tolerance). |
| `ProtocolBalanceDeposit` | `amountCNS` | later | Protocol treasury funded or drained. |
| `ProtocolBalanceWithdraw` | `amountCNS` | later | Protocol treasury funded or drained. |
| `RecycleFeeUpdated` | `recycleFeeCNS` | later | Exchange-wide minimums changed: account opening amount, minimum post, minimum settle, recycle fee. |
| `ToleranceAdministratorUpdated` | `toleranceAdministrator, added` | later | A privileged role was granted or revoked (general admin, monitor, position, price, tolerance). |
| `TransferPerpInsToProtocol` | `perpId, amountCNS` | later | Treasury <-> perp transfers, including topping up an insurance fund: solvency plumbing behind liquidations. |
| `TransferPerpPosToProtocol` | `perpId, amountCNS` | later | Treasury <-> perp transfers, including topping up an insurance fund: solvency plumbing behind liquidations. |
| `TransferProtocolToPerp` | `perpId, amountCNS, toInsuranceFund` | later | Treasury <-> perp transfers, including topping up an insurance fund: solvency plumbing behind liquidations. |
| `TransferProtocolToRecycleBal` | `amountCNS` | later | Treasury <-> perp transfers, including topping up an insurance fund: solvency plumbing behind liquidations. |
| `WRLSMinWithdrawLimitUpdated` | `limitCNS` | later | Withdrawal rate-limit parameters (TVL fraction, floor) changed. |
| `WRLSThousandthsTvlUpdated` | `thousandthsTvl` | later | Withdrawal rate-limit parameters (TVL fraction, floor) changed. |
| `WhitelistAddress` | `addr, whitelisted` | later | An address was blocked/unblocked, whitelisted, or whitelisting was switched on/off: who may trade at all. |
| `WhitelistingEnabledChanged` | `enabled` | later | An address was blocked/unblocked, whitelisted, or whitelisting was switched on/off: who may trade at all. |
| `WithdrawRateLimitBypassSet` | `addr, enabled` | later | Withdrawal rate limiter reset, force-reset, or bypassed for an address; a withdrawal can fail for this reason alone. |
| `WithdrawRateLimitForceReset` | `newExpiryBlock, newLimitCNS, perBlockCNS` | later | Withdrawal rate limiter reset, force-reset, or bypassed for an address; a withdrawal can fail for this reason alone. |
| `WithdrawRateLimitReset` | `newExpiryBlock, newLimitCNS, perBlockCNS` | later | Withdrawal rate limiter reset, force-reset, or bypassed for an address; a withdrawal can fail for this reason alone. |
| `ValueExceedsMaximum` | `value, maximum` | diagnostic | A setter argument exceeded its allowed maximum. |

