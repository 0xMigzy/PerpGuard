import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector } from 'viem';
import { POSITION_EVENT_ACTIONS, decodePositionEvent, directionFor, positionEventsInTx } from './perpl-fill-direction.ts';

const EX = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
const w = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
const log = (sig: string, perpId: number, accountId: number, type: number) => ({ address: EX.toLowerCase(), topics: [toEventSelector(sig)], data: `0x${w(perpId)}${w(accountId)}${w(type)}${w(0).repeat(4)}` });

test('the topics are the signatures, each mapped to its action', () => {
  const sigs: [string, string][] = [
    ['PositionOpenedV2(uint256,uint256,uint8,uint256,uint256,int256,uint256,uint256,uint256,uint256,uint256)', 'open'],
    ['PositionOpened(uint256,uint256,uint8,uint256,uint256,int256,uint256,uint256,uint256,uint256)', 'open'],
    ['PositionIncreasedV2(uint256,uint256,uint8,uint256,uint256,uint256,int256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)', 'add'],
    ['PositionIncreased(uint256,uint256,uint8,uint256,uint256,uint256,int256,int256,uint256,uint256,uint256,uint256,uint256,uint256)', 'add'],
    ['PositionDecreased(uint256,uint256,uint8,uint256,uint256,uint256,uint256,int256,int256)', 'reduce'],
    ['PositionClosed(uint256,uint256,uint8,uint256,int256,int256)', 'close'],
    ['PositionInverted(uint256,uint256,uint8,uint256,uint256,uint256,int256,uint256,uint256,uint256,int256,int256,uint256,uint256)', 'flip'],
  ];
  for (const [sig, action] of sigs) assert.equal(POSITION_EVENT_ACTIONS[toEventSelector(sig).slice(0, 10)], action, sig);
  assert.equal(Object.keys(POSITION_EVENT_ACTIONS).length, 7);
});

test('decoded by position: market, account, side (0 long, 1 short); anything else throws, never a default', () => {
  const dec = decodePositionEvent(log('PositionDecreased(uint256,uint256,uint8,uint256,uint256,uint256,uint256,int256,int256)', 1, 4734, 1), EX);
  assert.deepEqual(dec, { marketId: 1, accountId: 4734, action: 'reduce', side: 'short' });
  assert.equal(decodePositionEvent({ ...log('PositionClosed(uint256,uint256,uint8,uint256,int256,int256)', 1, 1, 0), address: '0xdead' }, EX), undefined, 'another contract');
  assert.throws(() => decodePositionEvent(log('PositionClosed(uint256,uint256,uint8,uint256,int256,int256)', 1, 1, 2), EX), /neither 0/);
});

test('the account\'s ONE event on the market answers; none or two answer nothing', () => {
  const e = [
    { marketId: 1, accountId: 7, action: 'add' as const, side: 'long' as const },
    { marketId: 1, accountId: 8, action: 'reduce' as const, side: 'short' as const },
  ];
  assert.equal(directionFor(e, 7, 1)!.action, 'add');
  assert.equal(directionFor(e, 7, 20), undefined);
  assert.equal(directionFor([...e, { marketId: 1, accountId: 7, action: 'close', side: 'long' }], 7, 1), undefined, 'ambiguous: blank beats a guess');
});

test('a receipt yields only this Exchange\'s position events', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ result: { logs: [log('PositionClosed(uint256,uint256,uint8,uint256,int256,int256)', 10, 5, 0), { address: EX, topics: ['0x1234'], data: '0x' }] } }))) as unknown as typeof fetch;
  assert.deepEqual(await positionEventsInTx('0xabc', { rpcUrl: 'x', exchangeAddress: EX, fetchImpl }), [{ marketId: 10, accountId: 5, action: 'close', side: 'long' }]);
});

test('receipts in batches: one request per batch, ids map back to transactions, a missing receipt stays absent', async () => {
  const { positionEventsInTxs } = await import('./perpl-fill-direction.ts');
  const requests: number[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const calls = JSON.parse(String(init.body)) as { id: number; params: [string] }[];
    requests.push(calls.length);
    return new Response(
      JSON.stringify(
        calls.map((c) => ({ id: c.id, result: c.params[0] === '0xgone' ? null : { logs: [log('PositionIncreasedV2(uint256,uint256,uint8,uint256,uint256,uint256,int256,int256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)', 1, Number(c.params[0].slice(3)), 0)] } })),
      ),
    );
  }) as unknown as typeof fetch;
  const map = await positionEventsInTxs(['0xa1', '0xa2', '0xgone', '0xa4', '0xa5'], { rpcUrl: 'x', exchangeAddress: EX, fetchImpl, batchSize: 2, concurrency: 1 });
  assert.deepEqual(requests, [2, 2, 1]);
  assert.equal(map.get('0xa2')![0]!.accountId, 2);
  assert.equal(map.get('0xa2')![0]!.action, 'add');
  assert.equal(map.has('0xgone'), false);
});
