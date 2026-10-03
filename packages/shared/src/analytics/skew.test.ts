/**
 * Why skew is measured by margin, never by notional.
 *
 * Ground truth: fixtures/open-positions-mainnet.json, every open position on
 * Perpl mainnet read from the index in one statement. On an order book every
 * long lot was matched against a short lot, so open size per side is EQUAL on
 * every market, and size × mark is 50/50 whatever the mark. The site showed
 * exactly that — 50.0% on every market — until 3 Oct 2026. These tests exist so
 * nobody reintroduces it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MarketBreakdown } from './types.ts';

interface Fixture {
  readonly block: number;
  readonly markets: readonly { readonly marketId: number; readonly indexerName: string }[];
  readonly positions: readonly { readonly marketId: number; readonly side: 'LONG' | 'SHORT'; readonly lotLNS: string; readonly depositCNS: string }[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../fixtures/open-positions-mainnet.json', import.meta.url)), 'utf8'),
) as Fixture;

function bySide() {
  const out = new Map<number, { longLots: bigint; shortLots: bigint; longMargin: bigint; shortMargin: bigint; longs: number; shorts: number }>();
  for (const p of fixture.positions) {
    const acc = out.get(p.marketId) ?? { longLots: 0n, shortLots: 0n, longMargin: 0n, shortMargin: 0n, longs: 0, shorts: 0 };
    if (p.side === 'LONG') {
      acc.longLots += BigInt(p.lotLNS);
      acc.longMargin += BigInt(p.depositCNS);
      acc.longs += 1;
    } else {
      acc.shortLots += BigInt(p.lotLNS);
      acc.shortMargin += BigInt(p.depositCNS);
      acc.shorts += 1;
    }
    out.set(p.marketId, acc);
  }
  return out;
}

test('open long size equals open short size on every market: notional skew is 50/50 by construction', () => {
  const markets = bySide();
  assert.equal(markets.size, fixture.markets.length);
  for (const [marketId, m] of markets) {
    assert.equal(
      m.longLots,
      m.shortLots,
      `market ${marketId}: every long lot has a matching short lot, so size × mark per side cannot differ. Never serve it as skew.`,
    );
  }
});

test('the headcount is lopsided on the same markets whose size is perfectly balanced', () => {
  // So the 50/50 is not a quiet book: in the fixture BTC is 153 long against 112 short.
  const lopsided = [...bySide().values()].filter((m) => m.longs !== m.shorts);
  assert.ok(lopsided.length >= fixture.markets.length - 1, 'equal size is not equal headcount');
});

test('margin at risk varies by side where notional cannot', () => {
  const shares = [...bySide().values()].map((m) => Number(m.longMargin) / Number(m.longMargin + m.shortMargin));
  assert.ok(shares.every((s) => s !== 0.5), 'margin share is a measurement, not a constant');
  assert.ok(Math.max(...shares) - Math.min(...shares) > 0.2, 'and it spreads across markets');
});

test('the served breakdown has no notional share to reintroduce', () => {
  const noNotionalShare: 'longShareOfNotional' extends keyof MarketBreakdown ? false : true = true;
  assert.equal(noNotionalShare, true);
});
