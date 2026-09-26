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
 * The docs say to "track `rq` to correlate updates" but never document the
 * Order object's full shape — `mt: 24` is only ever shown as
 * `{ id, st, sr, r }`, and `r` there is the boolean remove flag, not the
 * `r: RequestID` that appears on AccountEvent. So we look for the id under the
 * plausible names and fall back to matching the order's own contents.
 *
 * TODO: once a real testnet `mt: 24` has been seen (run with --verbose, which
 * prints unmatched entries raw), replace this with the single real field.
 */
const REQUEST_ID_FIELDS = ['rq', 'di', 'rid'] as const;

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

    const id = order['id'];
    if (typeof id !== 'number' || preexisting.has(id)) return false;

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
