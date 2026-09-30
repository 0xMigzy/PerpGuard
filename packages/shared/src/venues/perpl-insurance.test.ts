import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET_PERPETUAL_INFO_V2_SELECTOR, decodeMarketInsurance, readMarketInsurance } from './perpl-insurance.ts';

/**
 * A real `getPerpetualInfoV2(1)` reply from mainnet, captured 2026-09-30. The
 * words that matter: 10 positionBalanceCNS 272078894109, 11 insuranceBalanceCNS
 * 177437095975, 12 markPNS 837149, 13 markTimestamp 1790800127, 18/19 long and
 * short open interest 918586 lots each.
 */
const CAPTURED =
  '0x0000000000000000000000000000000000000000000000000000000000000020' +
  '00000000000000000000000000000000000000000000000000000000000003e0' +
  '0000000000000000000000000000000000000000000000000000000000000420' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '0000000000000000000000000000000000000000000000000000000000000005' +
  '00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8' +
  '0000000000000000000000000000000000000000000000000000000000001388' +
  '0000000000000000000000000000000000000000000000000000000000000064' +
  '0000000000000000000000000000000000000000000000000000000000000009' +
  '000000000000000000000000000000000000000000000000000000000000003c' +
  '0000000000000000000000000000000000000000000000000000003f592a741d' +
  '0000000000000000000000000000000000000000000000000000002950133827' +
  '00000000000000000000000000000000000000000000000000000000000cc61d' +
  '000000000000000000000000000000000000000000000000000000006abd70ff' +
  '00000000000000000000000000000000000000000000000000000000000cc60d' +
  '000000000000000000000000000000000000000000000000000000006abd70ef' +
  '00000000000000000000000000000000000000000000000000000000000cc596' +
  '000000000000000000000000000000000000000000000000000000006abd7111' +
  '00000000000000000000000000000000000000000000000000000000000e043a' +
  '00000000000000000000000000000000000000000000000000000000000e043a' +
  '000000000000000000000000000000000000000000000000000000000348697e' +
  '0000000000000000000000000000000000000000000000000000000000000004';

test('the selector is keccak of the ABI signature', async () => {
  const { toFunctionSelector } = await import('viem');
  assert.equal(GET_PERPETUAL_INFO_V2_SELECTOR, toFunctionSelector('function getPerpetualInfoV2(uint256)'));
});

test('the captured mainnet reply decodes to the insurance and position balances by word index', () => {
  const decoded = decodeMarketInsurance(CAPTURED, 1);
  assert.ok(decoded.found);
  assert.equal(decoded.reading.insuranceBalanceCNS, 177_437_095_975n, '177,437.10 AUSD in the BTC insurance fund');
  assert.equal(decoded.reading.positionBalanceCNS, 272_078_894_109n);
  assert.equal(decoded.reading.markPNS, 837_149n, '83,714.9 at priceDecimals 1');
  assert.equal(decoded.reading.markAtMs, 1_790_800_127_000);
  assert.equal(decoded.reading.longOpenInterestLNS, 918_586n);
  assert.equal(decoded.reading.shortOpenInterestLNS, 918_586n);
});

test('a reply that is not the struct is refused rather than read as balances', () => {
  assert.match((decodeMarketInsurance('0x', 1) as { reason: string }).reason, /fewer than/);
  assert.match((decodeMarketInsurance(42, 1) as { reason: string }).reason, /not hex/);
  // A single word (the shape of a plain uint return) is not a tuple.
  const single = `0x${'1'.padStart(64, '0')}${'0'.repeat(64 * 19)}`;
  assert.match((decodeMarketInsurance(single, 1) as { reason: string }).reason, /tuple offset/);
});

test('the call carries the market id and a revert reads as "no such market"', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { params: [{ data: string }] };
    calls.push(body.params[0].data);
    if (body.params[0].data.endsWith('ff')) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: CAPTURED }));
  }) as typeof fetch;
  const found = await readMarketInsurance(1, { rpcUrl: 'http://rpc', exchangeAddress: '0xex', fetchImpl });
  assert.ok(found.found);
  assert.equal(calls[0], `${GET_PERPETUAL_INFO_V2_SELECTOR}${'1'.padStart(64, '0')}`);
  const none = await readMarketInsurance(255, { rpcUrl: 'http://rpc', exchangeAddress: '0xex', fetchImpl });
  assert.equal(none.found, false);
  assert.match((none as { reason: string }).reason, /reverted/);
});
