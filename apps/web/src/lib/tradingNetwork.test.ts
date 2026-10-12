import assert from 'node:assert/strict';
import { test } from 'node:test';
import { networkFacts, networkSplit, otherNetwork, tradingNetworkFrom } from './tradingNetwork.ts';

test('the build setting: "mainnet" in any case is mainnet; unset or anything else is testnet, what the one deployment was', () => {
  assert.equal(tradingNetworkFrom('mainnet'), 'mainnet');
  assert.equal(tradingNetworkFrom(' Mainnet '), 'mainnet');
  for (const v of [undefined, '', 'testnet', 'prod', 'main']) assert.equal(tradingNetworkFrom(v), 'testnet');
});

test('each deployment names its own chain, Perpl site, bot and site, and they never cross', () => {
  const m = networkFacts('mainnet');
  const t = networkFacts('testnet');
  assert.deepEqual([m.chainId, m.perplSite, m.botHandle, m.siteUrl, m.funds], [143, 'app.perpl.xyz', '@PerpGuardBot', 'https://perpguard.app', 'Real funds']);
  assert.deepEqual([t.chainId, t.perplSite, t.botHandle, t.siteUrl, t.funds], [10143, 'testnet.perpl.xyz', '@PerpGuardTestnetBot', 'https://testnet.perpguard.app', 'Test funds only']);
  assert.equal(m.botUrl, 'https://t.me/PerpGuardBot');
  assert.equal(t.botUrl, 'https://t.me/PerpGuardTestnetBot');
  assert.equal(otherNetwork('mainnet'), 'testnet');
  assert.equal(otherNetwork('testnet'), 'mainnet');
});

test('the network line: analytics are mainnet on both sites; actions name the deployment\'s own network', () => {
  assert.equal(networkSplit(networkFacts('testnet')), 'Analytics: Monad mainnet, every block since launch. Actions: Monad testnet.');
  assert.equal(networkSplit(networkFacts('mainnet')), 'Analytics: Monad mainnet, every block since launch. Actions: Monad mainnet.');
});
