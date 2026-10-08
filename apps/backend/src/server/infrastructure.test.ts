import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerDomain } from './infrastructure.ts';

test('THE RPC URL NEVER LEAVES: only the provider domain, never the endpoint label, the path or the token', () => {
  const url = 'https://wandering-quiet-sky.monad-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef01234567/';
  const shown = providerDomain(url)!;
  assert.equal(shown, 'quiknode.pro');
  for (const secret of ['wandering-quiet-sky', 'monad-mainnet', '0123456789abcdef']) assert.ok(!shown.includes(secret), secret);
  assert.equal(providerDomain('https://rpc.monad.xyz'), 'monad.xyz');
  assert.equal(providerDomain('http://127.0.0.1:8545'), undefined, 'an IP names no provider');
  assert.equal(providerDomain('http://localhost:8545'), undefined);
  assert.equal(providerDomain('not a url'), undefined);
  assert.equal(providerDomain(undefined), undefined);
});
