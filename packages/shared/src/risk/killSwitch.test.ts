/**
 * Kill switch maths. The ordering is the part that matters: a plan that closes
 * the safest position first may never reach the one that was about to go.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killSwitchPlan, triggerCondition } from './killSwitch.ts';
import { marketById } from './testMarkets.ts';
import type { MarketRiskConfig, RiskPosition } from './position.ts';

const BTC = marketById(1);
const ETH = marketById(20);
const PUMP = marketById(90);

const configs = new Map<number, MarketRiskConfig>([[1, BTC], [20, ETH], [90, PUMP]]);

/** Comfortable: 0.5 BTC long, well collateralised. */
const safe: RiskPosition = {
  marketId: 1, symbol: 'BTC', side: 'long',
  lotLNS: 50_000n, entryPricePNS: 840_295n, depositCNS: 2_810_330_000n, fundingCNS: 0n,
};
/** Tighter: 10 ETH short at the minimum that could have opened it. */
const middling: RiskPosition = {
  marketId: 20, symbol: 'ETH', side: 'short',
  lotLNS: 10_000n, entryPricePNS: 300_000n, depositCNS: 3_000_000_000n, fundingCNS: 0n,
};
/** In trouble: barely above maintenance. */
const urgent: RiskPosition = {
  marketId: 90, symbol: 'PUMP', side: 'long',
  lotLNS: 1_000_000n, entryPricePNS: 5_000n, depositCNS: 520_000_000n, fundingCNS: 0n,
};

const marks = new Map([[1, 840_073n], [20, 300_000n], [90, 4_700n]]);

test('the plan orders closes nearest-to-liquidation first', () => {
  const plan = killSwitchPlan([safe, middling, urgent], marks, configs);
  assert.deepEqual(
    plan.ordered.map((p) => p.symbol),
    ['PUMP', 'BTC', 'ETH'],
  );
  const buffers = plan.perPosition.map((l) => l.liqBufferPct!);
  for (let i = 1; i < buffers.length; i += 1) {
    assert.ok(buffers[i]! >= buffers[i - 1]!, 'buffers must be non-decreasing');
  }
});

test('projected realised PnL is what closing everything at the mark would book', () => {
  const plan = killSwitchPlan([safe, middling, urgent], marks, configs);
  const summed = plan.perPosition.reduce((total, line) => total + line.realisedPnlCNS, 0n);
  assert.equal(plan.projectedRealisedPnlCNS, summed);
  // The PUMP long is down 0.0003 on 1,000,000 lots = 300 AUSD.
  const pump = plan.perPosition.find((l) => l.position.symbol === 'PUMP')!;
  assert.equal(pump.realisedPnlCNS, -300_000_000n);
  // The BTC long is the fixture's -11.10, and the ETH short is flat.
  const btc = plan.perPosition.find((l) => l.position.symbol === 'BTC')!;
  assert.equal(btc.realisedPnlCNS, -11_100_000n);
  assert.equal(plan.projectedRealisedPnlCNS, -311_100_000n);
});

test('a position with no size sorts last, since nothing about it is urgent', () => {
  const empty: RiskPosition = { ...safe, marketId: 1, symbol: 'BTC', lotLNS: 0n, depositCNS: 0n };
  const plan = killSwitchPlan([empty, urgent], marks, configs);
  assert.deepEqual(plan.ordered.map((p) => p.symbol), ['PUMP', 'BTC']);
  assert.equal(plan.perPosition[1]!.liqBufferPct, undefined);
});

test('the order is total and stable, so the same book always fires the same way', () => {
  const a = killSwitchPlan([safe, middling, urgent], marks, configs);
  const b = killSwitchPlan([urgent, middling, safe], marks, configs);
  assert.deepEqual(a.ordered.map((p) => p.symbol), b.ordered.map((p) => p.symbol));
});

test('an empty book plans nothing', () => {
  const plan = killSwitchPlan([], marks, configs);
  assert.deepEqual(plan.ordered, []);
  assert.equal(plan.projectedRealisedPnlCNS, 0n);
});

// ── trigger conditions ───────────────────────────────────────────────────────

test('a buffer threshold names only the positions that breached it', () => {
  const positions = [safe, middling, urgent];
  // A book with room to spare does not trip a threshold below its worst buffer.
  const loose = triggerCondition([safe, middling], marks, configs, {
    kind: 'worstBufferBelow',
    bufferPct: 0.001,
  });
  assert.equal(loose.met, false);
  assert.deepEqual(loose.causedBy, []);

  const tight = triggerCondition(positions, marks, configs, {
    kind: 'worstBufferBelow',
    bufferPct: 0.03,
  });
  assert.equal(tight.met, true);
  assert.ok(tight.causedBy.length >= 1);
  assert.equal(tight.causedBy[0]!.symbol, 'PUMP', 'the most urgent position comes first');
  for (const p of tight.causedBy) {
    const line = killSwitchPlan([p], marks, configs).perPosition[0]!;
    assert.ok(line.liqBufferPct! < 0.03);
  }
  assert.ok(tight.worstBufferPct! < 0.03);
});

/**
 * A position already past its liquidation price reports a NEGATIVE buffer, so it
 * breaches every threshold — which is the whole reason the buffer is signed. An
 * absolute value would report 0.0596 of room on a position that has none, and
 * the kill switch would rank it as the safest thing in the book.
 */
test('a position already past liquidation breaches any threshold, however tight', () => {
  const plan = killSwitchPlan([urgent], marks, configs);
  assert.ok(plan.perPosition[0]!.liqBufferPct! < 0, 'urgent should be past its liquidation price');
  for (const bufferPct of [0.5, 0.05, 0.001, 0]) {
    const result = triggerCondition([safe, urgent], marks, configs, {
      kind: 'worstBufferBelow',
      bufferPct,
    });
    assert.equal(result.met, true, `threshold ${bufferPct} should have fired`);
    assert.equal(result.causedBy[0]!.symbol, 'PUMP');
  }
});

test('an account-loss threshold fires on total unrealised loss', () => {
  const positions = [safe, middling, urgent];
  // Total unrealised is -311.10 AUSD.
  const under = triggerCondition(positions, marks, configs, {
    kind: 'accountLossBeyond',
    lossCNS: 400_000_000n,
  });
  assert.equal(under.met, false);
  assert.deepEqual(under.causedBy, []);
  assert.equal(under.totalUnrealisedPnlCNS, -311_100_000n);

  const over = triggerCondition(positions, marks, configs, {
    kind: 'accountLossBeyond',
    lossCNS: 300_000_000n,
  });
  assert.equal(over.met, true);
  // Biggest loser first.
  assert.deepEqual(over.causedBy.map((p) => p.symbol), ['PUMP', 'BTC']);
});

test('a profitable book never trips the loss threshold', () => {
  // Mark the PUMP long up instead of down.
  const winning = new Map(marks).set(90, 6_000n);
  const result = triggerCondition([urgent], winning, configs, {
    kind: 'accountLossBeyond',
    lossCNS: 1n,
  });
  assert.equal(result.met, false);
  assert.ok(result.totalUnrealisedPnlCNS > 0n);
});

test('a zero loss threshold does not fire on a flat book', () => {
  const flat = new Map(marks).set(90, 5_000n);
  const result = triggerCondition([urgent], flat, configs, {
    kind: 'accountLossBeyond',
    lossCNS: 0n,
  });
  assert.equal(result.totalUnrealisedPnlCNS, 0n);
  assert.equal(result.met, false, 'a zero threshold must not fire on a zero loss');
});

test('nonsense thresholds are refused rather than silently ignored', () => {
  assert.throws(
    () => triggerCondition([safe], marks, configs, { kind: 'accountLossBeyond', lossCNS: -1n }),
    RangeError,
  );
  assert.throws(
    () => triggerCondition([safe], marks, configs, { kind: 'worstBufferBelow', bufferPct: Number.NaN }),
    RangeError,
  );
});

test('the trigger is a predicate and nothing else: it never mutates its inputs', () => {
  const positions = [safe, middling, urgent];
  const snapshot = JSON.stringify(positions, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  triggerCondition(positions, marks, configs, { kind: 'worstBufferBelow', bufferPct: 0.5 });
  killSwitchPlan(positions, marks, configs);
  assert.equal(
    JSON.stringify(positions, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    snapshot,
  );
});
