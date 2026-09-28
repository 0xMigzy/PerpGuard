import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import {
  ORDER_FLAGS,
  ORDER_TYPE,
  buildCancelFrame,
  buildClosePositionFrame,
  buildLimitOrderFrame,
  buildMarketOrderFrame,
  classifyOrderUpdate,
  computeLastExecBlock,
  describeOrderStatus,
  isDefinitiveStatus,
  matchPlacement,
  nextRequestId,
  orderIdOf,
  reconcileOrderState,
  scaleLimitOrder,
  shortOrderIdOf,
  scalePriceAwayFromMarket,
} from './perpl-orders.ts';
import type { VenueMarket } from './types.ts';

/** Testnet BTC as GET /v1/pub/context reports it. */
const btcTestnet: VenueMarket = {
  venue: 'perpl',
  network: 'testnet',
  marketId: 16,
  instanceId: 12,
  symbol: 'BTC',
  displayName: 'BTC Perp',
  priceDecimals: 1,
  sizeDecimals: 5,
  maxLeverage: 15,
  maintenanceMarginRatio: 0.04,
  makerFeeMicros: 45,
  takerFeeMicros: 345,
  fundingIntervalSec: 3600,
  orderTtlBlocks: 20,
  isOpen: true,
};

describe('buildLimitOrderFrame', () => {
  const frame = buildLimitOrderFrame({
    sn: 1,
    rq: 900,
    marketId: 16,
    accountId: 7,
    side: 'long',
    priceScaled: 420000,
    sizeScaled: 1,
    leverageHundredths: 200,
    postOnly: true,
    lastExecBlock: 65_741_015,
  });

  it('carries exactly the documented fields', () => {
    assert.deepEqual(frame, {
      mt: 22,
      sn: 1,
      rq: 900,
      mkt: 16,
      acc: 7,
      t: 1,
      p: 420000,
      s: 1,
      fl: 1,
      lv: 200,
      lb: 65_741_015,
    });
  });

  it('maps side to the open order type', () => {
    assert.equal(
      buildLimitOrderFrame({
        sn: 1,
        rq: 1,
        marketId: 16,
        accountId: 7,
        side: 'short',
        priceScaled: 1,
        sizeScaled: 1,
        leverageHundredths: 100,
        postOnly: false,
        lastExecBlock: 2,
      }).t,
      2,
    );
  });

  it('refuses frames the gateway would reject or that would trade unintentionally', () => {
    const valid = {
      sn: 1,
      rq: 1,
      marketId: 16,
      accountId: 7,
      side: 'long' as const,
      priceScaled: 420000,
      sizeScaled: 1,
      leverageHundredths: 200,
      postOnly: true,
      lastExecBlock: 10,
    };
    // p: 0 is a MARKET order on this API — never buildable by accident.
    assert.throws(() => buildLimitOrderFrame({ ...valid, priceScaled: 0 }), /limit price/);
    assert.throws(() => buildLimitOrderFrame({ ...valid, sizeScaled: 0 }), /size/);
    // sn 0 is omitted from the mt 3 `cid`, leaving the ack uncorrelatable.
    assert.throws(() => buildLimitOrderFrame({ ...valid, sn: 0 }), /sn/);
    assert.throws(() => buildLimitOrderFrame({ ...valid, lastExecBlock: 0 }), /last execution/);
  });
});

describe('buildCancelFrame', () => {
  it('matches the documented cancel example', () => {
    assert.deepEqual(
      buildCancelFrame({
        sn: 2,
        rq: 901,
        marketId: 16,
        accountId: 7,
        orderId: 999,
        lastExecBlock: 65_741_020,
      }),
      { mt: 22, sn: 2, rq: 901, mkt: 16, acc: 7, oid: 999, t: 5, s: 0, fl: 0, lv: 0, lb: 65_741_020 },
    );
  });

  it('requires an order id', () => {
    assert.throws(
      () =>
        buildCancelFrame({ sn: 2, rq: 901, marketId: 16, accountId: 7, orderId: 0, lastExecBlock: 1 }),
      /oid/,
    );
  });
});

describe('nextRequestId', () => {
  it('is strictly greater than both the local counter and the account lfr', () => {
    assert.equal(nextRequestId(0, 500), 501);
    assert.equal(nextRequestId(700, 500), 701);
    assert.equal(nextRequestId(500, 500), 501);
  });
});

describe('computeLastExecBlock', () => {
  it('never exceeds head + order_ttl_blocks', () => {
    assert.equal(computeLastExecBlock(65_740_995, 20), 65_741_015);
    assert.equal(computeLastExecBlock(65_740_995, 20, 5), 65_741_010);
  });

  it('keeps at least one block of validity however large the safety margin', () => {
    assert.equal(computeLastExecBlock(100, 20, 100), 101);
  });
});

describe('scalePriceAwayFromMarket', () => {
  it('rounds a bid down and an ask up, never toward the book', () => {
    assert.equal(scalePriceAwayFromMarket(42008.37, 'long', 1), 420083);
    assert.equal(scalePriceAwayFromMarket(42008.37, 'short', 1), 420084);
  });

  it('leaves an exact tick alone on both sides', () => {
    assert.equal(scalePriceAwayFromMarket(42008.3, 'long', 1), 420083);
    assert.equal(scalePriceAwayFromMarket(42008.3, 'short', 1), 420083);
  });

  it('does not lose a tick to binary floating point', () => {
    // 0.29 * 100 is 28.999999999999996 in IEEE 754; truncating that gives 28.
    assert.equal(scalePriceAwayFromMarket(0.29, 'long', 2), 29);
  });
});

describe('scaleLimitOrder', () => {
  it('scales price and size with the market’s own decimals', () => {
    const scaled = scaleLimitOrder(btcTestnet, {
      side: 'long',
      price: 42008.37,
      size: 0.00001,
      leverage: 2,
    });
    assert.deepEqual(scaled, {
      priceScaled: 420083,
      sizeScaled: 1,
      leverageHundredths: 200,
      price: 42008.3,
      size: 0.00001,
    });
  });

  it('rejects a size below one size unit', () => {
    assert.throws(
      () => scaleLimitOrder(btcTestnet, { side: 'long', price: 42000, size: 0.000001, leverage: 2 }),
      /one size unit/,
    );
  });

  it('rejects leverage beyond the market maximum', () => {
    assert.throws(
      () => scaleLimitOrder(btcTestnet, { side: 'long', price: 42000, size: 0.001, leverage: 20 }),
      /max 15x/,
    );
    assert.throws(
      () => scaleLimitOrder(btcTestnet, { side: 'long', price: 42000, size: 0.001, leverage: 0 }),
      /leverage/,
    );
  });
});

describe('classifyOrderUpdate', () => {
  it('treats a resting order as a confirmed placement', () => {
    assert.equal(classifyOrderUpdate(2, 0, 'place').outcome, 'confirmed');
    assert.equal(classifyOrderUpdate(3, 0, 'place').outcome, 'confirmed');
    assert.equal(classifyOrderUpdate(4, 0, 'place').outcome, 'confirmed');
  });

  it('never calls a pending placement confirmed', () => {
    assert.equal(classifyOrderUpdate(1, 0, 'place').outcome, 'pending');
    assert.equal(classifyOrderUpdate(undefined, undefined, 'place').outcome, 'pending');
  });

  it('reads the same status oppositely for a cancel', () => {
    assert.equal(classifyOrderUpdate(5, 28, 'place').outcome, 'rejected');
    assert.equal(classifyOrderUpdate(5, 28, 'cancel').outcome, 'confirmed');
    assert.equal(classifyOrderUpdate(2, 0, 'cancel').outcome, 'pending');
  });

  it('reports a TTL expiry as a failure, with the reason spelled out', () => {
    const place = classifyOrderUpdate(6, 14, 'place');
    assert.equal(place.outcome, 'rejected');
    assert.match(place.reason, /Expired/);
    assert.match(place.reason, /ExceedsLastExecutionBlock/);

    const cancel = classifyOrderUpdate(6, 14, 'cancel');
    assert.equal(cancel.outcome, 'rejected');
    assert.match(cancel.reason, /before the cancel landed/);
  });

  it('names the stale-request-id rejection', () => {
    assert.equal(
      describeOrderStatus(7, 32),
      'st: 7 Failed, sr: 32 OrderDescIdTooLow',
    );
    assert.equal(classifyOrderUpdate(7, 32, 'place').outcome, 'rejected');
  });

  it('omits an unspecified reason', () => {
    assert.equal(describeOrderStatus(2, 0), 'st: 2 Open');
    assert.equal(describeOrderStatus(2, undefined), 'st: 2 Open');
  });
});

describe('isDefinitiveStatus', () => {
  it('is true for terminal states and false while pending', () => {
    for (const st of [2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.ok(isDefinitiveStatus(st), `st ${st}`);
    assert.ok(!isDefinitiveStatus(1));
    assert.ok(!isDefinitiveStatus(0));
  });
});

describe('matchPlacement', () => {
  const frame = buildLimitOrderFrame({
    sn: 1,
    rq: 531,
    marketId: 16,
    accountId: 9001,
    side: 'long',
    priceScaled: 420000,
    sizeScaled: 1,
    leverageHundredths: 200,
    postOnly: true,
    lastExecBlock: 65_741_015,
  });

  it('trusts an explicit request id over everything else', () => {
    const matches = matchPlacement(frame, new Set());
    assert.ok(matches({ oid: 777, rq: 531, st: 2 }));
    assert.ok(!matches({ oid: 777, rq: 530, st: 2 }), 'a different rq is not ours');
    // Whichever name the field turns out to have, an explicit id is decisive.
    assert.ok(matches({ oid: 777, di: 531 }));
    assert.ok(!matches({ oid: 777, di: 999 }));
  });

  it('falls back to a new order id whose contents agree', () => {
    const matches = matchPlacement(frame, new Set([555]));
    assert.ok(matches({ oid: 777, st: 2, mkt: 16, acc: 9001, t: 1, p: 420000, s: 1 }));
    assert.ok(matches({ oid: 777, st: 2, sr: 0, r: false }), 'sparse entries still match');
  });

  it('never claims an order that was already open, or one on another market', () => {
    const matches = matchPlacement(frame, new Set([555]));
    assert.ok(!matches({ oid: 555, st: 5, sr: 28 }), 'open before we submitted');
    assert.ok(!matches({ oid: 778, st: 2, mkt: 99 }), 'different market');
    assert.ok(!matches({ oid: 778, st: 2, acc: 9002 }), 'different account');
    assert.ok(!matches({ oid: 778, st: 2, p: 1 }), 'different price');
    assert.ok(!matches({ st: 2 }), 'no order id at all');
  });

  it('keeps matching its own order after the socket has recorded that id', () => {
    // The socket records every id it sees, including ours. A live view of that
    // set would make the second update for our own order look like a stranger's.
    const live = new Set<number>([555]);
    const matches = matchPlacement(frame, live);
    assert.ok(matches({ oid: 778, st: 1 }));
    live.add(778);
    assert.ok(matches({ oid: 778, st: 2 }), 'still ours on the next update');
  });
});

/**
 * The real shape, captured from a testnet OrdersSnapshot for account 710.
 * Note `oid` (wide, what a cancel must address) alongside `scid` (short, what
 * perpl-cli and the explorer display) — and no `id` field at all.
 */
const REAL_ENTRY = {
  at: { b: 65793436, t: 1790407639000, tx: 1 },
  rq: 1,
  mkt: 16,
  acc: 710,
  oid: 4311838621696,
  scid: 65,
  st: 2,
  sr: 0,
  t: 1,
  p: 419921,
  os: 1,
  fl: 1,
  lv: 200,
};

describe('orderIdOf', () => {
  it('reads the wide oid, which is what a cancel must address', () => {
    assert.equal(orderIdOf(REAL_ENTRY), 4311838621696);
  });

  it('does not fall back to the short display id', () => {
    assert.equal(orderIdOf({ scid: 65 }), undefined);
  });

  it('ignores the `id` field the docs show but the wire never sends', () => {
    assert.equal(orderIdOf({ id: 65 }), undefined);
  });
});

describe('shortOrderIdOf', () => {
  it('reads scid, the id perpl-cli and the explorer print', () => {
    assert.equal(shortOrderIdOf(REAL_ENTRY), 65);
  });
});

describe('matchPlacement against a real entry', () => {
  const frame = buildLimitOrderFrame({
    sn: 1,
    rq: 1,
    marketId: 16,
    accountId: 710,
    side: 'long',
    priceScaled: 419921,
    sizeScaled: 1,
    leverageHundredths: 200,
    postOnly: true,
    lastExecBlock: 65793440,
  });

  it('matches on rq', () => {
    assert.equal(matchPlacement(frame, new Set())(REAL_ENTRY), true);
  });

  it('rejects an entry carrying someone else’s rq', () => {
    assert.equal(matchPlacement(frame, new Set())({ ...REAL_ENTRY, rq: 2 }), false);
  });

  it('falls back to oid for an entry with no rq, and skips ids seen at sign-in', () => {
    const { rq: _rq, ...noRq } = REAL_ENTRY;
    assert.equal(matchPlacement(frame, new Set())(noRq), true);
    assert.equal(matchPlacement(frame, new Set([4311838621696]))(noRq), false);
  });
});

describe('reconcileOrderState', () => {
  it('knows nothing when no update for the id ever arrived', () => {
    const { state, reason } = reconcileOrderState(undefined);
    assert.equal(state, 'unknown');
    assert.match(reason, /no update for this order id/);
  });

  it('reports an expired order as gone — the TTL case behind a cancel timeout', () => {
    const { state, reason } = reconcileOrderState({
      orderId: 4312150769680,
      st: 6,
      sr: 0,
      source: 'update',
    });
    assert.equal(state, 'gone');
    assert.match(reason, /st: 6 Expired/);
    assert.match(reason, /terminal/);
  });

  it('treats every terminal status as gone, whatever removed the order', () => {
    // 4 Filled, 5 Canceled, 6 Expired, 7 Failed, 10 Executed.
    for (const st of [4, 5, 6, 7, 10]) {
      const { state } = reconcileOrderState({ orderId: 1, st, sr: 0, source: 'update' });
      assert.equal(state, 'gone', `st ${st}`);
    }
  });

  it('reports a resting or pending order as live, never as gone', () => {
    // 1 Pending, 2 Open, 3 PartiallyFilled all still have something to cancel.
    for (const st of [1, 2, 3]) {
      const { state } = reconcileOrderState({ orderId: 1, st, sr: 0, source: 'update' });
      assert.equal(state, 'live', `st ${st}`);
    }
  });

  it('never claims our cancel caused the removal', () => {
    // sr 30 says a liquidator pulled it. Gone, but not by us.
    const { state, reason } = reconcileOrderState({
      orderId: 1,
      st: 5,
      sr: 30,
      source: 'update',
    });
    assert.equal(state, 'gone');
    assert.match(reason, /OrderCancelledByLiquidator/);
    assert.doesNotMatch(reason, /cancel(led)? by us|our cancel/i);
  });

  it('says where the status was seen, so a stale snapshot reads as one', () => {
    assert.match(
      reconcileOrderState({ orderId: 1, st: 2, sr: 0, source: 'snapshot' }).reason,
      /in the sign-in snapshot/,
    );
    assert.match(
      reconcileOrderState({ orderId: 1, st: 2, sr: 0, source: 'update' }).reason,
      /on a live update/,
    );
  });

  it('is live rather than gone when the status is missing entirely', () => {
    // An entry with no `st` proves nothing, and "nothing to cancel" is the one
    // conclusion that must never be reached by default.
    assert.equal(reconcileOrderState({ orderId: 1, st: undefined, sr: 0, source: 'update' }).state, 'live');
  });
});

// ── market and close frames ──────────────────────────────────────────────────

test('buildMarketOrderFrame sends a zero price with ImmediateOrCancel', () => {
  const frame = buildMarketOrderFrame({
    sn: 1,
    rq: 9,
    marketId: 16,
    accountId: 710,
    side: 'long',
    sizeScaled: 1,
    leverageHundredths: 1500,
    lastExecBlock: 100,
  });
  assert.equal(frame.t, ORDER_TYPE.OpenLong);
  // A market order is p:0 + IOC, per the docs' own client. Both are required:
  // p:0 with GTC would be a resting order at zero.
  assert.equal(frame.p, 0);
  assert.equal(frame.fl, ORDER_FLAGS.ImmediateOrCancel);
  assert.equal(frame.lv, 1500);
});

test('buildMarketOrderFrame maps short to OpenShort', () => {
  const frame = buildMarketOrderFrame({
    sn: 1,
    rq: 9,
    marketId: 16,
    accountId: 710,
    side: 'short',
    sizeScaled: 1,
    leverageHundredths: 1500,
    lastExecBlock: 100,
  });
  assert.equal(frame.t, ORDER_TYPE.OpenShort);
});

test('buildLimitOrderFrame still refuses a zero price', () => {
  assert.throws(
    () =>
      buildLimitOrderFrame({
        sn: 1,
        rq: 9,
        marketId: 16,
        accountId: 710,
        side: 'long',
        priceScaled: 0,
        sizeScaled: 1,
        leverageHundredths: 1500,
        postOnly: true,
        lastExecBlock: 100,
      }),
    /p \(limit price, scaled\)/,
  );
});

test('buildClosePositionFrame takes the POSITION side, not the order side', () => {
  const frame = buildClosePositionFrame({
    sn: 1,
    rq: 9,
    marketId: 16,
    accountId: 710,
    positionSide: 'long',
    positionId: 55,
    sizeScaled: 1,
    lastExecBlock: 100,
  });
  // Closing a long is a sell, and it is still CloseLong. Reading this as the
  // order's direction would send CloseShort and double the position.
  assert.equal(frame.t, ORDER_TYPE.CloseLong);
  assert.equal(frame.lp, 55);
  // Leverage belongs to the position; a close does not set it.
  assert.equal(frame.lv, 0);
  assert.equal(frame.p, 0);
  assert.equal(frame.fl, ORDER_FLAGS.ImmediateOrCancel);
});

test('buildClosePositionFrame closes a short with CloseShort', () => {
  const frame = buildClosePositionFrame({
    sn: 1,
    rq: 9,
    marketId: 16,
    accountId: 710,
    positionSide: 'short',
    positionId: 55,
    sizeScaled: 1,
    lastExecBlock: 100,
  });
  assert.equal(frame.t, ORDER_TYPE.CloseShort);
});

test('buildClosePositionFrame with a limit price rests instead of crossing', () => {
  const frame = buildClosePositionFrame({
    sn: 1,
    rq: 9,
    marketId: 16,
    accountId: 710,
    positionSide: 'long',
    positionId: 55,
    sizeScaled: 1,
    priceScaled: 830000,
    lastExecBlock: 100,
  });
  assert.equal(frame.p, 830000);
  assert.equal(frame.fl, ORDER_FLAGS.GoodTillCancel);
});

test('buildClosePositionFrame requires a position id', () => {
  assert.throws(
    () =>
      buildClosePositionFrame({
        sn: 1,
        rq: 9,
        marketId: 16,
        accountId: 710,
        positionSide: 'long',
        positionId: 0,
        sizeScaled: 1,
        lastExecBlock: 100,
      }),
    /lp \(position id\)/,
  );
});
