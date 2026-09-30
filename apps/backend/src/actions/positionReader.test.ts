/**
 * The float boundary on the way into reconciliation.
 *
 * `VenuePosition` carries human `number` margins; the verdict compares exact
 * integers. If those integers disagree with the risk engine's by one micro, a
 * top-up that landed reconciles as a partial delta and reports `unknown` — so this
 * conversion has to go through the same `numberToScaled` the engine uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromVenuePosition, type VenuePosition } from '@perpguard/shared';
import { LoopPositionReader, toReconcilable } from './positionReader.ts';
import type { PositionSource } from '../risk/types.ts';
import { BTC, ETH, KILL_CONFIGS } from './testSupport.ts';

const btc: VenuePosition = {
  venue: 'perpl',
  network: 'testnet',
  symbol: 'BTC',
  marketId: BTC.marketId,
  positionId: 4242,
  side: 'long',
  size: 0.00001,
  entryPrice: 83_379.8,
  margin: 0.0557,
  marginMode: 'isolated',
  leverage: 2,
  fundingAccrued: 0,
};

class FakeSource implements PositionSource {
  positions: VenuePosition[] = [btc];
  state: ReturnType<PositionSource['status']> = {
    state: 'live',
    lastUpdateMs: 1_000_000,
    ageMs: 10,
  };
  readonly listeners = new Set<(p: readonly VenuePosition[]) => void>();

  snapshot(): readonly VenuePosition[] {
    return this.positions;
  }

  onSnapshot(listener: (p: readonly VenuePosition[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): ReturnType<PositionSource['status']> {
    return this.state;
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener(this.positions);
  }
}

const reader = (source: FakeSource, extra: Record<string, unknown> = {}) =>
  new LoopPositionReader({ source, configs: KILL_CONFIGS, ...extra });

test('a human margin becomes the same integer the risk engine would use', () => {
  // The whole point. The live testnet micro held 0.0557 AUSD of margin, which is
  // 55700 micros — and the engine has to agree to the last one.
  const converted = toReconcilable(btc, BTC);
  const engine = fromVenuePosition(btc, BTC);

  assert.equal(converted.marginCNS, 55_700n);
  assert.equal(converted.marginCNS, engine.depositCNS, 'identical to the engine’s figure');
  assert.equal(converted.sizeLNS, engine.lotLNS);
  assert.equal(typeof converted.marginCNS, 'bigint');
});

test('a margin a float cannot hold exactly still converts to the right micros', () => {
  // 0.0559 * 1e6 is 55899.99999999999 in float arithmetic. numberToScaled rounds
  // to the market's own precision instead, which is why this is 55900.
  assert.equal(toReconcilable({ ...btc, margin: 0.0559 }, BTC).marginCNS, 55_900n);
  assert.equal(toReconcilable({ ...btc, margin: 0.083584 }, BTC).marginCNS, 83_584n);
  assert.equal(toReconcilable({ ...btc, margin: 1000.07 }, BTC).marginCNS, 1_000_070_000n);
});

test('each market is scaled by its own config, never by a shared assumption', () => {
  const eth: VenuePosition = {
    ...btc,
    symbol: 'ETH',
    marketId: ETH.marketId,
    size: 10,
    margin: 2310,
  };
  // ETH has lotDecimals 3 against BTC's 5.
  assert.equal(toReconcilable(eth, ETH).sizeLNS, 10_000n);
  assert.equal(toReconcilable({ ...btc, size: 10 }, BTC).sizeLNS, 1_000_000n);
});

test('the reader finds the position on one market', () => {
  const source = new FakeSource();
  const found = reader(source).read(BTC.marketId);
  assert.equal(found?.marginCNS, 55_700n);
  assert.equal(found?.positionId, 4242);
});

test('no position on that market reads as undefined', () => {
  const source = new FakeSource();
  source.positions = [];
  assert.equal(reader(source).read(BTC.marketId), undefined);
});

test('two positions on one market read as NEITHER, loudly', () => {
  // An action reconciled against the wrong one of two positions on one market
  // would produce a confident verdict about the wrong exposure, and nothing on
  // the pair says which one the action went to.
  const source = new FakeSource();
  source.positions = [btc, { ...btc, positionId: 9999 }];
  const warned: Array<[number, number]> = [];

  const result = reader(source, {
    onAmbiguous: (marketId: number, count: number) => warned.push([marketId, count]),
  }).read(BTC.marketId);

  assert.equal(result, undefined);
  assert.deepEqual(warned, [[BTC.marketId, 2]]);
});

test('a market with no config reads as undefined rather than at the wrong scale', () => {
  // Without the market's own decimals every integer would be wrong by a power of
  // ten and look entirely plausible.
  const source = new FakeSource();
  source.positions = [{ ...btc, marketId: 4242, symbol: 'TAO' }];
  const warned: number[] = [];

  const result = reader(source, { onUnscalable: (marketId: number) => warned.push(marketId) }).read(
    4242,
  );

  assert.equal(result, undefined);
  assert.deepEqual(warned, [4242]);
});

test('status passes straight through: the reader invents no health of its own', () => {
  const source = new FakeSource();
  source.state = { state: 'stale', reason: 'socket closed.', lastUpdateMs: 1, ageMs: 99 };
  assert.deepEqual(reader(source).status(), source.state);
});

test('a snapshot fires the change listener, so a settle wait need not poll', () => {
  const source = new FakeSource();
  let fired = 0;
  const off = reader(source).onChange(() => {
    fired += 1;
  });

  source.emit();
  assert.equal(fired, 1);

  off();
  source.emit();
  assert.equal(fired, 1, 'and unsubscribing works');
});
