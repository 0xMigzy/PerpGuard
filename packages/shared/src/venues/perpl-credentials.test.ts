import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../errors.ts';
import { loadPerplCredentials, maskApiKey } from './perpl-credentials.ts';

const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';

const base = {
  PERPL_NETWORK: 'testnet',
  PERPL_API_KEY: 'opaque-token-value',
  PERPL_API_KEY_SECRET: SEED,
};

describe('loadPerplCredentials', () => {
  it('loads a complete set', () => {
    const creds = loadPerplCredentials({ ...base, PERPL_ACCOUNT_ID: '42' });
    assert.equal(creds.network, 'testnet');
    assert.equal(creds.apiKey, 'opaque-token-value');
    assert.equal(creds.accountId, 42);
    assert.equal(
      creds.secret.publicKeyHex(),
      '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
  });

  it('treats an empty or absent account id as undiscovered, not an error', () => {
    assert.equal(loadPerplCredentials({ ...base, PERPL_ACCOUNT_ID: '' }).accountId, undefined);
    assert.equal(loadPerplCredentials({ ...base, PERPL_ACCOUNT_ID: '  ' }).accountId, undefined);
    assert.equal(loadPerplCredentials(base).accountId, undefined);
  });

  it('names every missing variable at once', () => {
    assert.throws(
      () => loadPerplCredentials({}),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        for (const name of ['PERPL_NETWORK', 'PERPL_API_KEY', 'PERPL_API_KEY_SECRET']) {
          assert.ok(error.message.includes(name), `should name ${name}`);
        }
        return true;
      },
    );
  });

  it('rejects an unknown network and a non-numeric account id', () => {
    assert.throws(() => loadPerplCredentials({ ...base, PERPL_NETWORK: 'devnet' }), ConfigError);
    assert.throws(
      () => loadPerplCredentials({ ...base, PERPL_ACCOUNT_ID: 'abc' }),
      /positive integer/,
    );
    assert.throws(() => loadPerplCredentials({ ...base, PERPL_ACCOUNT_ID: '0' }), ConfigError);
  });

  it('never puts the secret anywhere printable', () => {
    const creds = loadPerplCredentials(base);
    assert.ok(!JSON.stringify(creds).includes(SEED));
    assert.ok(!String(creds.secret).includes(SEED));
  });
});

describe('maskApiKey', () => {
  it('shows only the ends', () => {
    assert.equal(maskApiKey('abcdefghijklmnop'), 'abcd…mnop (16 chars)');
    assert.equal(maskApiKey('short'), '*****');
  });
});
