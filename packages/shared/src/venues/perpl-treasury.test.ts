import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector } from 'viem';
import {
  BALANCE_OF_SELECTOR,
  PROTOCOL_BALANCE_DEPOSIT_TOPIC,
  PROTOCOL_BALANCE_WITHDRAW_TOPIC,
  collateralBalanceAt,
  decodeTreasuryLog,
  finalizedBlock,
  scanTreasuryMovements,
} from './perpl-treasury.ts';

const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const opts = (fetchImpl: typeof fetch) => ({ rpcUrl: 'http://rpc', exchangeAddress: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F', fetchImpl });

test('the topics are keccak of the event signatures', () => {
  assert.equal(PROTOCOL_BALANCE_DEPOSIT_TOPIC, toEventSelector('event ProtocolBalanceDeposit(uint256 amountCNS)'));
  assert.equal(PROTOCOL_BALANCE_WITHDRAW_TOPIC, toEventSelector('event ProtocolBalanceWithdraw(uint256 amountCNS)'));
  assert.equal(BALANCE_OF_SELECTOR, '0x70a08231');
});

test('a log decodes to a dated movement; another event is not one; a malformed one throws', () => {
  const log = { blockNumber: '0x10', transactionHash: '0xABC', logIndex: '0x2', topics: [PROTOCOL_BALANCE_WITHDRAW_TOPIC], data: word(308_867_777_932n) };
  assert.deepEqual(decodeTreasuryLog(log, 5), { block: 16, txHash: '0xabc', logIndex: 2, atMs: 5, direction: 'out', amountCNS: 308_867_777_932n });
  assert.equal(decodeTreasuryLog({ ...log, topics: ['0xdead'] }, 5), undefined);
  assert.throws(() => decodeTreasuryLog({ ...log, data: '0x12' }, 5), /not one word/);
});

test('the scan pages at 1,000 blocks, filters to the two topics, dates each block once, and sorts', async () => {
  const calls: { method: string; params: any[] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    calls.push({ method, params });
    if (method === 'eth_getLogs') {
      const from = parseInt(params[0].fromBlock, 16);
      const result =
        from === 1_000
          ? [
              { blockNumber: '0x5dc', transactionHash: '0xb', logIndex: '0x1', topics: [PROTOCOL_BALANCE_DEPOSIT_TOPIC], data: word(130_250_000_000n) },
              { blockNumber: '0x5dc', transactionHash: '0xb', logIndex: '0x0', topics: [PROTOCOL_BALANCE_WITHDRAW_TOPIC], data: word(1n) },
            ]
          : [];
      return new Response(JSON.stringify({ result }));
    }
    if (method === 'eth_getBlockByNumber') return new Response(JSON.stringify({ result: { timestamp: '0x64', number: '0x9' } }));
    return new Response(JSON.stringify({ result: '0x0' }));
  }) as typeof fetch;
  const moves = await scanTreasuryMovements(0, 2_499, { ...opts(fetchImpl), concurrency: 2 });
  const pages = calls.filter((c) => c.method === 'eth_getLogs').map((c) => [parseInt(c.params[0].fromBlock, 16), parseInt(c.params[0].toBlock, 16)]).sort((a, b) => a[0]! - b[0]!);
  assert.deepEqual(pages, [[0, 999], [1_000, 1_999], [2_000, 2_499]]);
  assert.deepEqual(calls.find((c) => c.method === 'eth_getLogs')!.params[0].topics, [[PROTOCOL_BALANCE_DEPOSIT_TOPIC, PROTOCOL_BALANCE_WITHDRAW_TOPIC]]);
  assert.equal(calls.filter((c) => c.method === 'eth_getBlockByNumber').length, 1, 'one distinct block, one call');
  assert.deepEqual(moves.map((m) => [m.logIndex, m.direction, m.atMs]), [[0, 'out', 100_000], [1, 'in', 100_000]]);
  assert.deepEqual(await scanTreasuryMovements(5, 4, opts(fetchImpl)), [], 'an empty range asks nothing');
});

test('finalized block and balance at a block are what they say', async () => {
  const seen: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    seen.push({ method, params });
    return new Response(JSON.stringify({ result: method === 'eth_call' ? word(3_838_376_912_802n) : { number: '0x69d9a0b' } }));
  }) as typeof fetch;
  assert.equal(await finalizedBlock(opts(fetchImpl)), 0x69d9a0b);
  assert.deepEqual(seen[0].params, ['finalized', false]);
  assert.equal(await collateralBalanceAt('0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', 110_989_971, opts(fetchImpl)), 3_838_376_912_802n);
  assert.equal(seen[1].params[0].data, `0x70a08231${'34b6552d57a35a1d042ccae1951bd1c370112a6f'.padStart(64, '0')}`);
  assert.equal(seen[1].params[1], '0x69d9293', 'block 110,989,971');
});
