/**
 * The copy replay route: the size is checked and passed on in collateral
 * units, the answer carries its age, and the money goes out as text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { CopySource, CopySourceReader } from '@perpguard/shared';
import { CopyReplayService } from '../copy/service.ts';
import { registerCopyRoutes } from './copyRoutes.ts';

const T0 = Date.parse('2026-10-07T00:00:00Z');

function rig() {
  const asked: Array<{ accountId: number; fromMs: number; toMs: number }> = [];
  const source: CopySourceReader = {
    copySource: async (accountId, window): Promise<CopySource | undefined> => {
      asked.push({ accountId, fromMs: window.fromMs, toMs: window.toMs });
      if (accountId === 404) return undefined;
      return {
        accountId, fromMs: window.fromMs, toMs: window.toMs, collateralDecimals: 6,
        equityAtStartCNS: 100_000_000_000n, feesByDay: [], flows: [], closedFromBefore: [], openAtStart: 0, openedInWindow: 1,
        positions: [{
          key: '1-4886-1', market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC' }, side: 'long', status: 'closed', lotDecimals: 5, priceDecimals: 1,
          peakLotLNS: 200_000n, lotLNS: 0n, entryPricePNS: 1_000_000n, peakMarginCNS: 20_000_000_000n, netPnlCNS: -5_000_000_000n, leverageHdths: 1000n,
          openedAtMs: window.fromMs + 1, closedAtMs: window.fromMs + 2,
        }],
      };
    },
  };
  const service = new CopyReplayService({
    source,
    actingNetwork: 'testnet',
    actingMarkets: () => [{ marketId: 16, symbol: 'BTC', sizeDecimals: 5, maxLeverage: 15, takerFeeMicros: 0 } as never],
    marks: async () => [],
    now: () => T0,
  });
  const app = registerCopyRoutes(Fastify({ logger: false }), { service, collateralDecimals: 6, now: () => T0 + 5_000 });
  return { app, asked };
}

test('a replay at the default size: 30 days back from now, money as text rounded against the reader, with its age', async () => {
  const { app, asked } = rig();
  const res = await app.inject({ method: 'GET', url: '/api/analytics/copy/4886' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ageMs, 5_000);
  assert.equal(asked[0]!.toMs - asked[0]!.fromMs, 30 * 86_400_000);
  assert.equal(body.result.kind, 'replayed');
  assert.equal(body.result.followerStart, '1,000.00 AUSD');
  assert.equal(body.result.totals.closedResult, '−50.00 AUSD');
  assert.deepEqual(body.result.trades[0].copy, { kind: 'copied', size: '0.02', margin: '200.00 AUSD', fee: '0.00 AUSD', result: '−50.00 AUSD', resultAusd: -50, estimate: false, scale: 0.01 });
  assert.equal(body.result.trades[0].leader.resultBeforeFees, '−5,000.00 AUSD');
});

test('the size is the reader\'s, in whole AUSD, and bounded', async () => {
  const { app } = rig();
  const big = (await app.inject({ method: 'GET', url: '/api/analytics/copy/4886?size=50000.9' })).json();
  assert.equal(big.result.followerStart, '50,000.00 AUSD');
  for (const size of ['0', '5', 'abc', '99999999999', '-10']) {
    const res = await app.inject({ method: 'GET', url: `/api/analytics/copy/4886?size=${size}` });
    assert.equal(res.statusCode, 400, size);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/analytics/copy/abc' })).statusCode, 400);
});

test('an account the index does not hold says so', async () => {
  const { app } = rig();
  const body = (await app.inject({ method: 'GET', url: '/api/analytics/copy/404' })).json();
  assert.deepEqual(body.result, { kind: 'unknown-account', accountId: 404 });
});
