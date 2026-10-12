import assert from 'node:assert/strict';
import { test } from 'node:test';
import { domainChainId, ensureChain, isChainRefusal, isDeclined, wrongChainText, type ChainSwitcher } from './ensureChain.ts';

const MAINNET = { chainId: 143, chainName: 'Monad mainnet' };
const TESTNET = { chainId: 10143, chainName: 'Monad testnet' };
const KNOWN = [MAINNET, TESTNET];

/** A wallet that starts on `on` and moves when a switch is allowed to succeed. */
function wallet(o: { on: string | number | undefined; onSwitch?: (id: number) => Promise<void>; staysPut?: boolean; mute?: boolean }): ChainSwitcher & { switches: number[] } {
  let at = o.on;
  const switches: number[] = [];
  return {
    switches,
    getNetwork: async () => {
      if (o.mute === true) throw new Error('not supported');
      return at;
    },
    switchNetwork: async (id) => {
      switches.push(id);
      await o.onSwitch?.(id);
      if (o.staysPut !== true) at = id;
    },
  };
}

test("the domain's chain, whichever way Perpl wrote it: hex string, decimal string or number; nonsense is undefined", () => {
  assert.equal(domainChainId({ chainId: '0x279f' }), 10143);
  assert.equal(domainChainId({ chainId: '10143' }), 10143);
  assert.equal(domainChainId({ chainId: 143 }), 143);
  for (const bad of [undefined, '', 'monad', 0, -1, 1.5, null, {}]) assert.equal(domainChainId({ chainId: bad }), undefined);
});

test('a wallet already on the chain is left alone, whether it reports a number or a string', async () => {
  for (const n of [143, '143', '0x8f']) {
    const w = wallet({ on: n });
    assert.deepEqual(await ensureChain(w, 143), { state: 'already' });
    assert.deepEqual(w.switches, []);
  }
});

test('a wallet on the other Monad network is asked to switch, once, to the chain the request names', async () => {
  const w = wallet({ on: 10143 });
  assert.deepEqual(await ensureChain(w, 143), { state: 'switched' });
  assert.deepEqual(w.switches, [143]);
});

test('NEVER WORSE THAN NOT ASKING: a wallet that cannot say where it is, or says nothing, is left alone', async () => {
  for (const w of [wallet({ on: 10143, mute: true }), wallet({ on: undefined }), wallet({ on: 'monad' })]) {
    assert.deepEqual(await ensureChain(w, 143), { state: 'unknown' });
    assert.deepEqual(w.switches, []);
  }
});

test('a declined switch is reported as declined, with where the wallet still is', async () => {
  const w = wallet({ on: 10143, staysPut: true, onSwitch: async () => { throw new Error('User rejected the request.'); } });
  assert.deepEqual(await ensureChain(w, 143), { state: 'elsewhere', current: 10143, declined: true });
});

test('a switch the wallet cannot do is not a declined one', async () => {
  const w = wallet({ on: 10143, staysPut: true, onSwitch: async () => { throw new Error('wallet_switchEthereumChain is not supported'); } });
  assert.deepEqual(await ensureChain(w, 143), { state: 'elsewhere', current: 10143, declined: false });
});

test('a wallet that says it switched and did not is still elsewhere', async () => {
  const w = wallet({ on: 10143, staysPut: true });
  assert.deepEqual(await ensureChain(w, 143), { state: 'elsewhere', current: 10143, declined: false });
});

test('the sentence names both networks, each way round, and an unknown chain by its number', () => {
  assert.equal(wrongChainText(10143, MAINNET, KNOWN), 'Your wallet is on Monad testnet. Switch it to Monad mainnet to continue.');
  assert.equal(wrongChainText(143, TESTNET, KNOWN), 'Your wallet is on Monad mainnet. Switch it to Monad testnet to continue.');
  assert.equal(wrongChainText(1, MAINNET, KNOWN), 'Your wallet is on another network (chain 1). Switch it to Monad mainnet to continue.');
});

test('a refusal from a wallet that never said where it is names only where to go, never a guess', () => {
  assert.equal(wrongChainText(undefined, MAINNET, KNOWN), 'Your wallet refused the request for Monad mainnet. Switch it to Monad mainnet to continue.');
});

test("a wallet's chain refusals are recognised in its own words; a decline and an ordinary failure are not", () => {
  for (const m of ['Invalid params', 'Provided chainId "143" must match the active chainId "10143"', 'chain mismatch', 'The current chain of the wallet (id: 10143) does not match the target chain', 'Unrecognized chain ID "0x8f"']) {
    assert.equal(isChainRefusal(new Error(m)), true, m);
  }
  for (const m of ['Failed to fetch', 'timeout']) assert.equal(isChainRefusal(new Error(m)), false, m);
  assert.equal(isDeclined(new Error('User rejected the request.')), true);
  assert.equal(isDeclined(new Error('Invalid params')), false);
});
