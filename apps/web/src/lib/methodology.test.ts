import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIN_ROUND_TRIPS_FOR_RATIOS } from '../../../../packages/shared/src/analytics/types.ts';
import { RATIO_FLOOR, SKEW_PROOF } from './methodology.ts';

test('the note quotes the ratio floor the API enforces', () => {
  assert.equal(RATIO_FLOOR, MIN_ROUND_TRIPS_FOR_RATIOS);
});

test('the skew proof is the fixture, figure for figure', () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../fixtures/open-positions-mainnet.json', import.meta.url)), 'utf8')) as {
    block: number;
    markets: { marketId: number; lotDecimals: number }[];
    positions: { marketId: number; side: string; lotLNS: string }[];
  };
  assert.equal(fixture.block, SKEW_PROOF.block);
  assert.equal(fixture.markets.find((m) => m.marketId === SKEW_PROOF.marketId)?.lotDecimals, SKEW_PROOF.lotDecimals);
  const btc = fixture.positions.filter((p) => p.marketId === SKEW_PROOF.marketId);
  const lots = (side: string) => btc.filter((p) => p.side === side).reduce((s, p) => s + BigInt(p.lotLNS), 0n);
  assert.equal(lots('LONG'), BigInt(SKEW_PROOF.lots));
  assert.equal(lots('SHORT'), BigInt(SKEW_PROOF.lots));
  assert.equal(btc.filter((p) => p.side === 'LONG').length, SKEW_PROOF.longs);
  assert.equal(btc.filter((p) => p.side === 'SHORT').length, SKEW_PROOF.shorts);
});
