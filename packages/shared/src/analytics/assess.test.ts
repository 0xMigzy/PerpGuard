import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessOpenPositions } from './assess.ts';
import type { OpenPosition } from './types.ts';
import type { MarketRiskConfig } from '../risk/position.ts';

const BTC: MarketRiskConfig = { marketId: 1, symbol: 'BTC', priceDecimals: 1, lotDecimals: 5, collateralDecimals: 6, maintenanceMargin: 2500, initialMargin: 5000 };
const configs = new Map([[1, BTC]]);
const marks = new Map([[1, { markPrice: 83_000, atMs: 1_790_000_000_000 }]]);

const position = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' },
  side: 'long',
  sizeLots: 0.5,
  entryPrice: 84_000,
  marginAusd: 2_800,
  leverage: 15,
  openedAtMs: 1_789_000_000_000,
  marginAddedAusd: 0,
  ...over,
});

test('a long below its entry shows a negative uPnL, a liquidation price below the mark, and a positive buffer', () => {
  const [a] = assessOpenPositions([position()], configs, marks);
  assert.equal(a!.reason, undefined);
  assert.equal(a!.markPrice, 83_000);
  assert.equal(a!.unrealisedPnlAusd, -500, '(83000 − 84000) × 0.5');
  assert.equal(a!.notionalAusd, 41_500);
  assert.ok(a!.liquidationPrice! < 83_000, 'a long liquidates below the mark');
  assert.ok(a!.liqBufferPct! > 0 && a!.liqBufferPct! < 0.1, `buffer ${a!.liqBufferPct}`);
  assert.equal(a!.isLiquidatable, false);
  assert.equal(a!.marginToSurviveAusd, 0);
});

test('a position already past its liquidation price reports a NEGATIVE buffer, never an absolute one', () => {
  const [a] = assessOpenPositions([position({ marginAusd: 100 })], configs, marks);
  assert.ok(a!.liqBufferPct! < 0, `buffer ${a!.liqBufferPct} must be signed`);
  assert.equal(a!.isLiquidatable, true);
  assert.ok(a!.marginToSurviveAusd! > 0, 'it needs a top-up to survive');
});

test('each hole keeps its reason and never becomes a zero', () => {
  const unlisted = position({ market: { marketId: 80, symbol: undefined, indexerName: 'TAO' } });
  const noMark = position({ market: { marketId: 2, symbol: 'ETH', indexerName: 'ETH' } });
  const noEntry = position({ entryPrice: undefined });
  const out = assessOpenPositions([unlisted, noMark, noEntry], new Map([[1, BTC], [2, { ...BTC, marketId: 2, symbol: 'ETH' }]]), marks);
  assert.match(out[0]!.reason!, /does not list/);
  assert.equal(out[0]!.markPrice, undefined);
  assert.match(out[1]!.reason!, /no mark/);
  assert.match(out[2]!.reason!, /entry price is unknown/);
  assert.equal(out[2]!.markPrice, 83_000, 'the mark is still known and shown');
  assert.equal(out[2]!.liquidationPrice, undefined);
  assert.equal(out[2]!.unrealisedPnlAusd, undefined);
});
