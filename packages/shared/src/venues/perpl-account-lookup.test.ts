import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET_ACCOUNT_BY_ADDR_SELECTOR, decodeAccountLookup, lookupAccountByAddress } from './perpl-account-lookup.ts';

const OWNER = '0x829114000000000000000000000000000000AbCd';
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const struct = (id: bigint) => `0x${word(id)}${word(9_998_926_134n)}${word(0n)}${word(0n)}${OWNER.slice(2).toLowerCase().padStart(64, '0')}${word(0n)}${word(0n)}${word(0n)}${word(0n)}`;

test('the selector is keccak of the ABI signature', async () => {
  const { toFunctionSelector } = await import('viem');
  assert.equal(GET_ACCOUNT_BY_ADDR_SELECTOR, toFunctionSelector('function getAccountByAddr(address)'));
});

test('an account struct decodes to its id; zero, short and non-hex answers are not accounts', () => {
  assert.deepEqual(decodeAccountLookup(struct(710n), OWNER.toLowerCase()), { found: true, accountId: 710, address: OWNER.toLowerCase() });
  assert.equal(decodeAccountLookup(struct(0n), 'x').found, false);
  assert.match((decodeAccountLookup('0x', 'x') as { reason: string }).reason, /no data/);
  assert.match((decodeAccountLookup(42, 'x') as { reason: string }).reason, /not hex/);
});

test('the call is made once, lowercased, and a revert reads as "no account"', async () => {
  const calls: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { params: [{ data: string }] };
    calls.push(body.params[0].data);
    if (body.params[0].data.endsWith('1'.padStart(64, '0'))) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x03a0e277' } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: struct(710n) }));
  }) as typeof fetch;
  const found = await lookupAccountByAddress(OWNER, { rpcUrl: 'http://rpc', exchangeAddress: '0xex', fetchImpl });
  assert.deepEqual(found, { found: true, accountId: 710, address: OWNER.toLowerCase() });
  assert.equal(calls[0], `${GET_ACCOUNT_BY_ADDR_SELECTOR}${OWNER.slice(2).toLowerCase().padStart(64, '0')}`, 'lowercased into the calldata');
  const none = await lookupAccountByAddress('0x0000000000000000000000000000000000000001', { rpcUrl: 'http://rpc', exchangeAddress: '0xex', fetchImpl });
  assert.equal(none.found, false);
  assert.match((none as { reason: string }).reason, /no account/);
  assert.equal((await lookupAccountByAddress('nope', { rpcUrl: 'http://rpc', exchangeAddress: '0xex', fetchImpl })).found, false);
});

test('account id -> owner: the selector is the signature, the owner is word 4, lowercased', async () => {
  const { toFunctionSelector } = await import('viem');
  const { GET_ACCOUNT_BY_ID_SELECTOR, decodeAccountOwner } = await import('./perpl-account-lookup.ts');
  assert.equal(GET_ACCOUNT_BY_ID_SELECTOR, toFunctionSelector('function getAccountById(uint256)'));
  const word = (v: string) => v.replace(/^0x/, '').padStart(64, '0');
  // Captured shape, account 4908 (6 Oct 2026): id, balance, locked, frozen, owner, then four more words.
  const reply = `0x${word((4908).toString(16))}${word('1')}${word('0')}${word('0')}${word('0Ca98e367cf05477AD694084656B8d04a7c7C4A6')}${word('0').repeat(4)}`;
  assert.equal(decodeAccountOwner(reply, 4908), '0x0ca98e367cf05477ad694084656b8d04a7c7c4a6');
  assert.equal(decodeAccountOwner(reply, 4909), undefined, 'a struct for another account is not this one');
  assert.equal(decodeAccountOwner(`0x${word('1')}${word('0').repeat(8)}`, 1), undefined, 'a zero owner is no owner');
  assert.equal(decodeAccountOwner('0x', 1), undefined);
});
