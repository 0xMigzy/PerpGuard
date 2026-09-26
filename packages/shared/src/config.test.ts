import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHAIN_IDS,
  DEFAULT_STALE_MS,
  envVarNames,
  loadAppConfig,
  loadNetworkConfig,
} from './config.ts';
import { ConfigError } from './errors.ts';

describe('loadNetworkConfig', () => {
  it('falls back to the documented values when the env is empty', () => {
    const mainnet = loadNetworkConfig('mainnet', {});
    assert.equal(mainnet.chainId, 143);
    assert.equal(mainnet.restBaseUrl, 'https://app.perpl.xyz/api');
    assert.equal(mainnet.collateralDecimals, 6);

    const testnet = loadNetworkConfig('testnet', {});
    assert.equal(testnet.chainId, 10143);
    assert.equal(testnet.restBaseUrl, 'https://testnet.perpl.xyz/api');
    assert.notEqual(testnet.exchangeAddress, mainnet.exchangeAddress);
  });

  it('lets the env override every field', () => {
    const config = loadNetworkConfig('testnet', {
      PERPL_TESTNET_REST_URL: 'http://localhost:8080/api',
      PERPL_TESTNET_RPC_URL: 'http://localhost:8545',
      PERPL_TESTNET_EXCHANGE: '0xabc',
      PERPL_TESTNET_COLLATERAL: '0xdef',
      PERPL_TESTNET_COLLATERAL_DECIMALS: '18',
    });
    assert.equal(config.restBaseUrl, 'http://localhost:8080/api');
    assert.equal(config.rpcUrl, 'http://localhost:8545');
    assert.equal(config.exchangeAddress, '0xabc');
    assert.equal(config.collateralAddress, '0xdef');
    assert.equal(config.collateralDecimals, 18);
  });

  it('strips trailing slashes so url joins stay clean', () => {
    const config = loadNetworkConfig('mainnet', { PERPL_MAINNET_REST_URL: 'https://x.test/api///' });
    assert.equal(config.restBaseUrl, 'https://x.test/api');
  });

  it('ignores blank env values instead of producing empty urls', () => {
    const config = loadNetworkConfig('mainnet', { PERPL_MAINNET_REST_URL: '   ' });
    assert.equal(config.restBaseUrl, 'https://app.perpl.xyz/api');
  });

  it('rejects a chain id that disagrees with the network name', () => {
    assert.throws(
      () => loadNetworkConfig('testnet', { PERPL_TESTNET_CHAIN_ID: '143' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /is 143 but testnet is chain 10143/);
        return true;
      },
    );
  });

  it('rejects a non-integer chain id', () => {
    assert.throws(() => loadNetworkConfig('mainnet', { PERPL_MAINNET_CHAIN_ID: 'abc' }), ConfigError);
  });

  describe('strict mode', () => {
    it('names every missing var at once', () => {
      assert.throws(
        () => loadNetworkConfig('mainnet', {}, { strict: true }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          for (const name of envVarNames('mainnet')) {
            assert.match(error.message, new RegExp(name));
          }
          return true;
        },
      );
    });

    it('passes once every var is present', () => {
      const env = Object.fromEntries(
        envVarNames('testnet').map((name) => [name, name.endsWith('CHAIN_ID') ? '10143' : name.endsWith('DECIMALS') ? '6' : `value-for-${name}`]),
      );
      const config = loadNetworkConfig('testnet', env, { strict: true });
      assert.equal(config.chainId, 10143);
      assert.equal(config.exchangeAddress, 'value-for-PERPL_TESTNET_EXCHANGE');
    });
  });
});

describe('loadAppConfig', () => {
  it('defaults analytics to mainnet and trading to testnet', () => {
    const config = loadAppConfig({});
    assert.equal(config.analytics.name, 'mainnet');
    assert.equal(config.analytics.chainId, CHAIN_IDS.mainnet);
    assert.equal(config.trading.name, 'testnet');
    assert.equal(config.trading.chainId, CHAIN_IDS.testnet);
    assert.equal(config.staleMs, DEFAULT_STALE_MS);
  });

  it('makes both networks selectable', () => {
    const config = loadAppConfig({ ANALYTICS_NETWORK: 'testnet', TRADING_NETWORK: 'mainnet' });
    assert.equal(config.analytics.name, 'testnet');
    assert.equal(config.trading.name, 'mainnet');
  });

  it('accepts a network name in any case', () => {
    assert.equal(loadAppConfig({ ANALYTICS_NETWORK: 'TestNet' }).analytics.name, 'testnet');
  });

  it('rejects an unknown network name', () => {
    assert.throws(() => loadAppConfig({ TRADING_NETWORK: 'devnet' }), ConfigError);
  });

  it('reads STALE_MS and rejects a non-positive value', () => {
    assert.equal(loadAppConfig({ STALE_MS: '2500' }).staleMs, 2500);
    assert.throws(() => loadAppConfig({ STALE_MS: '0' }), ConfigError);
    assert.throws(() => loadAppConfig({ STALE_MS: '-1' }), ConfigError);
  });
});
