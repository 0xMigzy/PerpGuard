/**
 * Perpl order frames and status decoding — pure, no I/O.
 * https://docs.perpl.xyz/resources/for-developers/api/websocket.md
 * https://docs.perpl.xyz/resources/for-developers/api/types-and-errors.md
 *
 * Everything the trading socket sends or interprets is built here so the
 * socket itself only has to move bytes, and so the wire format can be tested
 * without a network.
 */
import { numberToScaled } from '../units.ts';
import type { Side, VenueMarket } from './types.ts';

/** Message types. Only the ones we send or read. */
export const MT = {
  Ping: 1,
  Pong: 2,
  StatusResponse: 3,
  SubscriptionRequest: 5,
  SubscriptionResponse: 6,
  MarketStateUpdate: 9,
  WalletSnapshot: 19,
  AccountUpdate: 21,
  OrderRequest: 22,
  OrdersSnapshot: 23,
  OrdersUpdate: 24,
  FillsUpdate: 25,
  PositionsSnapshot: 26,
  PositionsUpdate: 27,
  ApiKeySignIn: 29,
  Heartbeat: 100,
} as const;

/** The `sid` every command status arrives on. */
export const COMMAND_STATUS_SID = 100;

export const ORDER_TYPE = {
  OpenLong: 1,
  OpenShort: 2,
  CloseLong: 3,
  CloseShort: 4,
  Cancel: 5,
  IncreasePositionCollateral: 6,
  Change: 7,
} as const;
export type OrderType = (typeof ORDER_TYPE)[keyof typeof ORDER_TYPE];

export const ORDER_FLAGS = {
  GoodTillCancel: 0,
  PostOnly: 1,
  FillOrKill: 2,
  ImmediateOrCancel: 4,
} as const;
export type OrderFlags = (typeof ORDER_FLAGS)[keyof typeof ORDER_FLAGS];

/** OrderStatus (`st`). */
export const ORDER_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: 'Unspecified',
  1: 'Pending',
  2: 'Open',
  3: 'PartiallyFilled',
  4: 'Filled',
  5: 'Canceled',
  6: 'Expired',
  7: 'Failed',
  8: 'Untriggered',
  9: 'Triggered',
  10: 'Executed',
};

/**
 * OrderStatusReason (`sr`), the full 0–68 enumeration. Worth carrying in full:
 * a rejection that prints "sr: 32 OrderDescIdTooLow" tells you the request id
 * was stale, while a bare 32 tells you nothing.
 */
export const ORDER_STATUS_REASON_NAMES: Readonly<Record<number, string>> = {
  0: 'Unspecified',
  1: 'AmountExceedsAvailableBalance',
  2: 'AccountFrozen',
  3: 'CancelExistingInvalidCloseOrders',
  4: 'CantChangeCloseOrder',
  5: 'ChangeExpiredOrderNeedsNewExpiry',
  6: 'ClearingExpiredOrder',
  7: 'ClearingFrozenAccountOrder',
  8: 'ClearingInvalidCloseOrder',
  9: 'ClearingSelfMatchingOrder',
  10: 'CloseOrderExceedsPosition',
  11: 'CloseOrderPositionMismatch',
  12: 'ContractNotOperational',
  13: 'CrossesBook',
  14: 'ExceedsLastExecutionBlock',
  15: 'ForwardingReverted',
  16: 'ImmediateOrCancelExecuted',
  17: 'ImmediateOrderUnderMinimum',
  18: 'InsuficientFundsForRecycleFee',
  19: 'InvalidAccountFrozenOrder',
  20: 'InvalidExpiryBlock',
  21: 'InvalidOrderId',
  22: 'MakerOrderFilled',
  23: 'MakerOrderSettlementFailed',
  24: 'MaximumAccountOrders',
  25: 'MaxMatchesReached',
  26: 'NoOp',
  27: 'OrderBookFull',
  28: 'OrderCancelled',
  29: 'OrderCancelledByAdmin',
  30: 'OrderCancelledByLiquidator',
  31: 'OrderChanged',
  32: 'OrderDescIdTooLow',
  33: 'OrderDoesNotExist',
  34: 'OrderForwardingNotAllowed',
  35: 'OrderPlaced',
  36: 'OrderPostFailed',
  37: 'OrderSettlementImpliesInsolvent',
  38: 'OrderSizeExceedsAvailableSize',
  39: 'PostOrderUnderMinimum',
  40: 'PriceOutOfRange',
  41: 'RecycleBalanceInsufficientSevere',
  42: 'SizeOutOfRange',
  43: 'TakerOrderFilled',
  44: 'TakerOrderSettlementFailed',
  45: 'UnableToCancelOrder',
  46: 'UnmatchedLotRemainsInFillOrKill',
  47: 'UnspecifiedCollateral',
  48: 'UnspecifiedPrice',
  49: 'UnspecifiedSize',
  50: 'WrongAccountForOrder',
  51: 'WrongChainForOrder',
  52: 'WrongMarketForOrder',
  53: 'PerpetualInsolvent',
  54: 'Triggered',
  55: 'InvalidAmount',
  56: 'InvalidFlags',
  57: 'InvalidTriggerOrder',
  58: 'WrongTriggerPosition',
  59: 'TriggerDescIdTooLow',
  60: 'TriggerOrderRequest',
  61: 'ValueExceedsMaximum',
  62: 'ClearingRemainingOrderLockBeyondBalance',
  63: 'PriceSetDuringTriggerExec',
  64: 'TriggeredExecutionAttemptsExhausted',
  65: 'TriggeredOrderExecuted',
  66: 'TriggeredOrderPartiallyFilled',
  67: 'TriggeredOrderExpired',
  68: 'TriggeredOrderRecoverableFailure',
};

export function describeOrderStatus(st: number | undefined, sr?: number | undefined): string {
  const status = st === undefined ? 'st: absent' : `st: ${st} ${ORDER_STATUS_NAMES[st] ?? 'Unknown'}`;
  if (sr === undefined || sr === 0) return status;
  return `${status}, sr: ${sr} ${ORDER_STATUS_REASON_NAMES[sr] ?? 'Unknown'}`;
}

/**
 * The docs' deduplication rule: the first non-failure status in this set is
 * definitive and everything after it, including later failures, is ignored.
 */
const DEFINITIVE_STATUSES = new Set([2, 3, 4, 5, 8, 9, 10]);
const FAILED = 7;
const EXPIRED = 6;

export function isDefinitiveStatus(st: number): boolean {
  return DEFINITIVE_STATUSES.has(st) || st === FAILED || st === EXPIRED;
}

/** What a submitted frame was trying to achieve, which decides how `st` reads. */
export type OrderIntent = 'place' | 'cancel';

export type OrderOutcome = 'confirmed' | 'rejected' | 'pending';

/**
 * Decode an order update against the intent that produced it.
 *
 * The same `st` means opposite things depending on what was asked: `5 Canceled`
 * confirms a cancel and defeats a placement.
 */
export function classifyOrderUpdate(
  st: number | undefined,
  sr: number | undefined,
  intent: OrderIntent,
): { outcome: OrderOutcome; reason: string } {
  const reason = describeOrderStatus(st, sr);
  if (st === undefined) return { outcome: 'pending', reason };

  if (intent === 'cancel') {
    if (st === 5) return { outcome: 'confirmed', reason };
    if (st === EXPIRED) {
      return {
        outcome: 'rejected',
        reason: `${reason} — the order hit its last execution block before the cancel landed`,
      };
    }
    if (st === FAILED) return { outcome: 'rejected', reason };
    // Still Open/PartiallyFilled: the cancel has not taken effect yet.
    return { outcome: 'pending', reason };
  }

  if (st === 1) return { outcome: 'pending', reason };
  if (st === FAILED || st === EXPIRED || st === 5) return { outcome: 'rejected', reason };
  if (DEFINITIVE_STATUSES.has(st)) return { outcome: 'confirmed', reason };
  return { outcome: 'pending', reason };
}

/**
 * The last state we saw for one order id, as the socket records it.
 *
 * Only what reconciliation needs: the status, its reason, and whether it came
 * from the sign-in snapshot or a live update.
 */
export interface LastOrderState {
  readonly orderId: number;
  readonly st: number | undefined;
  readonly sr: number | undefined;
  readonly source: 'snapshot' | 'update';
}

/**
 * Whether an order id is definitively no longer live.
 *
 * `gone` covers every terminal status — Filled, Canceled, Expired, Failed,
 * Executed. It deliberately does NOT claim our cancel caused it: an order that
 * expired at its `lb`, was filled, or was pulled by a liquidator is equally
 * gone, and the reason string says which.
 */
export type ReconciledOrderState = 'gone' | 'live' | 'unknown';

const TERMINAL_STATUSES = new Set([4, 5, 6, 7, 10]);

/**
 * Reconcile an order id against the last status seen for it.
 *
 * Exists because a cancel of an order that has already expired or is otherwise
 * gone may never produce an `mt: 24` at all, so the cancel's wait expiring is
 * not a failure — it is a prompt to look up what actually became of the order.
 *
 * States facts only, never policy: it reports what was last seen and leaves
 * "so retry" or "so give up" to the caller, which must never turn `unknown`
 * into a retry with a fresh request id.
 */
export function reconcileOrderState(
  last: LastOrderState | undefined,
): { state: ReconciledOrderState; reason: string } {
  if (last === undefined) {
    return { state: 'unknown', reason: 'no update for this order id arrived on this session' };
  }

  const seen = last.source === 'snapshot' ? 'in the sign-in snapshot' : 'on a live update';
  const described = describeOrderStatus(last.st, last.sr);

  if (last.st !== undefined && TERMINAL_STATUSES.has(last.st)) {
    return { state: 'gone', reason: `last seen ${seen} as ${described}, which is terminal` };
  }
  return { state: 'live', reason: `last seen ${seen} as ${described}` };
}

/** An `mt: 22` frame exactly as it goes on the wire. */
export interface OrderRequestFrame {
  readonly mt: typeof MT.OrderRequest;
  /** Unique and non-zero: echoed back as `cid` on the mt 3 status. */
  readonly sn: number;
  /** Idempotency key, strictly increasing per account. */
  readonly rq: number;
  readonly mkt: number;
  readonly acc: number;
  readonly t: OrderType;
  readonly s: number;
  readonly fl: OrderFlags;
  readonly lv: number;
  readonly lb: number;
  readonly p?: number;
  readonly oid?: number;
  /** Linked position id, on a close. */
  readonly lp?: number;
}

export interface LimitOrderFrameParams {
  readonly sn: number;
  readonly rq: number;
  readonly marketId: number;
  readonly accountId: number;
  readonly side: Side;
  readonly priceScaled: number;
  readonly sizeScaled: number;
  readonly leverageHundredths: number;
  readonly postOnly: boolean;
  readonly lastExecBlock: number;
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer, got ${value}`);
  }
}

/**
 * A resting limit order. `p > 0` always: a zero price means a market order,
 * which this function will not build by accident.
 */
export function buildLimitOrderFrame(params: LimitOrderFrameParams): OrderRequestFrame {
  assertPositiveInt(params.sn, 'sn');
  assertPositiveInt(params.rq, 'rq');
  assertPositiveInt(params.marketId, 'mkt');
  assertPositiveInt(params.accountId, 'acc');
  assertPositiveInt(params.priceScaled, 'p (limit price, scaled)');
  assertPositiveInt(params.sizeScaled, 's (size, scaled)');
  assertPositiveInt(params.leverageHundredths, 'lv (leverage, hundredths)');
  assertPositiveInt(params.lastExecBlock, 'lb (last execution block)');

  return {
    mt: MT.OrderRequest,
    sn: params.sn,
    rq: params.rq,
    mkt: params.marketId,
    acc: params.accountId,
    t: params.side === 'long' ? ORDER_TYPE.OpenLong : ORDER_TYPE.OpenShort,
    p: params.priceScaled,
    s: params.sizeScaled,
    fl: params.postOnly ? ORDER_FLAGS.PostOnly : ORDER_FLAGS.GoodTillCancel,
    lv: params.leverageHundredths,
    lb: params.lastExecBlock,
  };
}

export interface MarketOrderFrameParams {
  readonly sn: number;
  readonly rq: number;
  readonly marketId: number;
  readonly accountId: number;
  readonly side: Side;
  readonly sizeScaled: number;
  readonly leverageHundredths: number;
  readonly lastExecBlock: number;
}

/**
 * A market order that OPENS or adds to a position.
 *
 * A market order on Perpl is a zero price with the ImmediateOrCancel flag:
 * `p: price ?? 0, fl: price ? 0 : 4` in the docs' own client. Zero price is
 * therefore meaningful here and is sent explicitly, which is exactly why
 * buildLimitOrderFrame refuses it — the two cannot be confused.
 *
 * IOC matters beyond speed. An order that cannot fill now is cancelled rather
 * than left resting, so a market order can never quietly become a resting
 * order we then have to remember to clean up.
 *
 * https://docs.perpl.xyz/resources/for-developers/api/typescript.md
 */
export function buildMarketOrderFrame(params: MarketOrderFrameParams): OrderRequestFrame {
  assertPositiveInt(params.sn, 'sn');
  assertPositiveInt(params.rq, 'rq');
  assertPositiveInt(params.marketId, 'mkt');
  assertPositiveInt(params.accountId, 'acc');
  assertPositiveInt(params.sizeScaled, 's (size, scaled)');
  assertPositiveInt(params.leverageHundredths, 'lv (leverage, hundredths)');
  assertPositiveInt(params.lastExecBlock, 'lb (last execution block)');

  return {
    mt: MT.OrderRequest,
    sn: params.sn,
    rq: params.rq,
    mkt: params.marketId,
    acc: params.accountId,
    t: params.side === 'long' ? ORDER_TYPE.OpenLong : ORDER_TYPE.OpenShort,
    p: 0,
    s: params.sizeScaled,
    fl: ORDER_FLAGS.ImmediateOrCancel,
    lv: params.leverageHundredths,
    lb: params.lastExecBlock,
  };
}

export interface ClosePositionFrameParams {
  readonly sn: number;
  readonly rq: number;
  readonly marketId: number;
  readonly accountId: number;
  /**
   * The side of the POSITION being closed, not the side of the order that
   * closes it. Closing a long sends CloseLong, which is itself a sell.
   * Passing the order's direction here reverses the trade and doubles the
   * position instead of flattening it.
   */
  readonly positionSide: Side;
  /** `lp`, the position to close. Read it off the position, never guess it. */
  readonly positionId: number;
  readonly sizeScaled: number;
  /** Omit for a market close, which is what a kill switch wants. */
  readonly priceScaled?: number;
  readonly lastExecBlock: number;
}

/**
 * Close (or reduce) an existing position.
 *
 * `lv` is 0 on a close: leverage belongs to the position, and the close is not
 * setting it. `lp` names the position, which is why the position id has to be
 * read off the live position rather than reconstructed.
 *
 * https://docs.perpl.xyz/resources/for-developers/api/typescript.md
 */
export function buildClosePositionFrame(params: ClosePositionFrameParams): OrderRequestFrame {
  assertPositiveInt(params.sn, 'sn');
  assertPositiveInt(params.rq, 'rq');
  assertPositiveInt(params.marketId, 'mkt');
  assertPositiveInt(params.accountId, 'acc');
  assertPositiveInt(params.positionId, 'lp (position id)');
  assertPositiveInt(params.sizeScaled, 's (size, scaled)');
  assertPositiveInt(params.lastExecBlock, 'lb (last execution block)');
  if (params.priceScaled !== undefined) {
    assertPositiveInt(params.priceScaled, 'p (limit price, scaled)');
  }

  const isMarket = params.priceScaled === undefined;
  return {
    mt: MT.OrderRequest,
    sn: params.sn,
    rq: params.rq,
    mkt: params.marketId,
    acc: params.accountId,
    t: params.positionSide === 'long' ? ORDER_TYPE.CloseLong : ORDER_TYPE.CloseShort,
    p: isMarket ? 0 : params.priceScaled,
    s: params.sizeScaled,
    fl: isMarket ? ORDER_FLAGS.ImmediateOrCancel : ORDER_FLAGS.GoodTillCancel,
    lp: params.positionId,
    lv: 0,
    lb: params.lastExecBlock,
  };
}

export interface CancelFrameParams {
  readonly sn: number;
  readonly rq: number;
  readonly marketId: number;
  readonly accountId: number;
  readonly orderId: number;
  readonly lastExecBlock: number;
}

/** Cancel by order id. Size, flags and leverage are zero, per the docs' example. */
export function buildCancelFrame(params: CancelFrameParams): OrderRequestFrame {
  assertPositiveInt(params.sn, 'sn');
  assertPositiveInt(params.rq, 'rq');
  assertPositiveInt(params.marketId, 'mkt');
  assertPositiveInt(params.accountId, 'acc');
  assertPositiveInt(params.orderId, 'oid');
  assertPositiveInt(params.lastExecBlock, 'lb (last execution block)');

  return {
    mt: MT.OrderRequest,
    sn: params.sn,
    rq: params.rq,
    mkt: params.marketId,
    acc: params.accountId,
    oid: params.orderId,
    t: ORDER_TYPE.Cancel,
    s: 0,
    fl: ORDER_FLAGS.GoodTillCancel,
    lv: 0,
    lb: params.lastExecBlock,
  };
}

/** One entry from the `d` array of an `mt: 24` order update. */
export type OrderUpdateEntry = Record<string, unknown>;

/**
 * Field names an Order might carry its originating request id under.
 *
 * `rq` is the real one, confirmed against a testnet OrdersSnapshot:
 * `{"rq":1,"mkt":16,"acc":710,"oid":4311838621696,"scid":65,"st":2,...}`.
 * The others stay as a cheap hedge — the docs never publish the Order shape,
 * so a rename would otherwise silently fall through to content matching.
 */
const REQUEST_ID_FIELDS = ['rq', 'di', 'rid'] as const;

/**
 * The order id to address a cancel or amend to.
 *
 * It is `oid`, NOT `id`: the docs show `mt: 24` entries as `{ id, st, sr, r }`,
 * but the wire carries `oid` — a wide, globally unique id — alongside `scid`,
 * the short per-contract id the explorer and perpl-cli display. Reading `id`
 * yields undefined for every order, which loses the handle on a live order.
 */
export function orderIdOf(order: OrderUpdateEntry): number | undefined {
  const oid = order['oid'];
  return typeof oid === 'number' ? oid : undefined;
}

/**
 * The short per-contract order id (`scid`), for display only.
 *
 * This is what `perpl-cli show account` prints under "Order ID" and what the
 * explorer shows. Never send it as `oid` — the contract wants the wide id.
 */
export function shortOrderIdOf(order: OrderUpdateEntry): number | undefined {
  const scid = order['scid'];
  return typeof scid === 'number' ? scid : undefined;
}

/**
 * A predicate deciding whether an `mt: 24` entry is the outcome of `frame`.
 *
 * Correlation is strict where it can be — an explicit request id that differs
 * from ours rules an entry out — and conservative where it cannot: the
 * fallback requires an order id we had not already seen AND agreement on every
 * field the entry does carry, so someone else's order on the same market never
 * gets mistaken for ours.
 */
export function matchPlacement(
  frame: OrderRequestFrame,
  knownOrderIds: ReadonlySet<number>,
): (order: OrderUpdateEntry) => boolean {
  // Snapshotted, not read live: the socket records every order id it sees,
  // including the one this predicate is waiting for. Reading the live set
  // would make the matcher disown its own order on the second update.
  const preexisting = new Set(knownOrderIds);

  return (order: OrderUpdateEntry): boolean => {
    for (const field of REQUEST_ID_FIELDS) {
      const value = order[field];
      if (typeof value === 'number') return value === frame.rq;
    }

    const id = orderIdOf(order);
    if (id === undefined || preexisting.has(id)) return false;

    const agrees = (key: string, expected: number | undefined): boolean => {
      const value = order[key];
      return value === undefined || expected === undefined || value === expected;
    };
    return (
      agrees('mkt', frame.mkt) &&
      agrees('acc', frame.acc) &&
      agrees('t', frame.t) &&
      agrees('p', frame.p) &&
      agrees('s', frame.s)
    );
  };
}

/**
 * The next request id. `rq` is an idempotency key that must be strictly
 * greater than the account's last forwarded id (`lfr`) or the order fails with
 * sr 32; seeding from both guards against a local counter that has fallen
 * behind another client.
 */
export function nextRequestId(localCounter: number, lfr: number): number {
  return Math.max(localCounter, lfr) + 1;
}

/**
 * `lb` — the last block at which the order may execute. It must not exceed
 * `head + order_ttl_blocks`, so this clamps rather than trusting the caller.
 *
 * `safetyBlocks` shortens the window a little: the head block we hold is at
 * least as old as the last heartbeat, and an `lb` computed from a stale head
 * can only be too LOW (safe) rather than too high (rejected outright).
 */
export function computeLastExecBlock(
  headBlock: number,
  orderTtlBlocks: number,
  safetyBlocks = 0,
): number {
  assertPositiveInt(headBlock, 'headBlock');
  assertPositiveInt(orderTtlBlocks, 'orderTtlBlocks');
  const ttl = Math.max(1, orderTtlBlocks - Math.max(0, safetyBlocks));
  return headBlock + ttl;
}

/**
 * Scale a positive value to `decimals` places by truncation, reporting whether
 * anything was dropped. Goes via a decimal string rather than multiplying by a
 * power of ten, which would make 0.29 * 100 = 28.999999999999996 floor to 28.
 */
function truncateScaled(value: number, decimals: number): { floored: number; dropped: boolean } {
  const fixed = value.toFixed(decimals + 6);
  const [whole = '0', frac = ''] = fixed.split('.');
  const kept = frac.slice(0, decimals).padEnd(decimals, '0');
  return { floored: Number(`${whole}${kept}`), dropped: /[1-9]/.test(frac.slice(decimals)) };
}

/**
 * Scale a human price to the market's integer ticks, always rounding AWAY from
 * the market: down for a bid, up for an ask. A resting order that is meant to
 * sit far from the book must never be nudged toward it by rounding.
 */
export function scalePriceAwayFromMarket(price: number, side: Side, decimals: number): number {
  if (!(price > 0)) throw new RangeError(`price must be positive, got ${price}`);
  const { floored, dropped } = truncateScaled(price, decimals);
  return side === 'long' || !dropped ? floored : floored + 1;
}

export interface ScaledLimitOrder {
  readonly priceScaled: number;
  readonly sizeScaled: number;
  readonly leverageHundredths: number;
  /** The price actually sent, back in human units after tick rounding. */
  readonly price: number;
  readonly size: number;
}

/**
 * Scale and validate a limit order against one market's own configuration.
 * Nothing here is hard-coded: decimals, leverage ceiling and tick all come
 * from the VenueMarket, which came from GET /v1/pub/context.
 */
export function scaleLimitOrder(
  market: VenueMarket,
  order: { side: Side; price: number; size: number; leverage: number },
): ScaledLimitOrder {
  const priceScaled = scalePriceAwayFromMarket(order.price, order.side, market.priceDecimals);
  if (priceScaled <= 0) {
    throw new RangeError(
      `price ${order.price} rounds to 0 at ${market.priceDecimals} decimals on ${market.symbol}`,
    );
  }

  const sizeScaled = Number(numberToScaled(order.size, market.sizeDecimals));
  if (sizeScaled < 1) {
    const minSize = 10 ** -market.sizeDecimals;
    throw new RangeError(
      `size ${order.size} is below one size unit on ${market.symbol} (minimum ${minSize})`,
    );
  }

  if (!(order.leverage > 0) || order.leverage > market.maxLeverage) {
    throw new RangeError(
      `leverage ${order.leverage}x is outside ${market.symbol}'s range (max ${market.maxLeverage}x)`,
    );
  }
  const leverageHundredths = Math.round(order.leverage * 100);

  return {
    priceScaled,
    sizeScaled,
    leverageHundredths,
    price: priceScaled / 10 ** market.priceDecimals,
    size: sizeScaled / 10 ** market.sizeDecimals,
  };
}
