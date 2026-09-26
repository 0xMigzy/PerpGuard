import assert from 'node:assert/strict';
import { verify, createPublicKey } from 'node:crypto';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import {
  ApiSecret,
  buildApiKeySignInFrame,
  randomNonce,
  restCanonical,
  wsSignInCanonical,
} from './perpl-signing.ts';

/**
 * RFC 8032 section 7.1, TEST 1. If the PKCS#8 wrapping of the raw seed were
 * wrong, this would produce a valid signature under the WRONG key — which the
 * server would reject and no local test would catch. Hence a known-answer test
 * rather than a sign-then-verify round trip.
 */
const RFC8032 = {
  seedHex: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  publicKeyHex: '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  message: '',
  signatureHex:
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc6' +
    '1e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
} as const;

const secret = ApiSecret.fromHex(RFC8032.seedHex);

describe('ApiSecret', () => {
  it('reproduces RFC 8032 test vector 1', () => {
    assert.equal(secret.sign(RFC8032.message).toString('hex'), RFC8032.signatureHex);
    assert.equal(secret.publicKeyHex(), RFC8032.publicKeyHex);
  });

  it('signs as base64url with no padding', () => {
    const sig = secret.signBase64Url('hello');
    assert.match(sig, /^[A-Za-z0-9_-]+$/, 'base64url alphabet only');
    assert.ok(!sig.includes('='), 'no padding');
    assert.equal(Buffer.from(sig, 'base64url').length, 64);
  });

  it('produces signatures the public key verifies', () => {
    const canonical = wsSignInCanonical(10143, '1751932800000', 'nonce');
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(RFC8032.publicKeyHex.slice(2), 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    assert.ok(verify(null, Buffer.from(canonical), key, secret.sign(canonical)));
  });

  it('accepts a 0x prefix and a 64-byte seed+public export', () => {
    assert.equal(ApiSecret.fromHex(`0x${RFC8032.seedHex}`).publicKeyHex(), RFC8032.publicKeyHex);
    const seedPlusPublic = RFC8032.seedHex + RFC8032.publicKeyHex.slice(2);
    assert.equal(ApiSecret.fromHex(seedPlusPublic).publicKeyHex(), RFC8032.publicKeyHex);
  });

  it('rejects malformed keys without echoing key material', () => {
    const shortKey = 'deadbeef';
    assert.throws(
      () => ApiSecret.fromHex(shortKey),
      (error: unknown) => {
        assert.ok(error instanceof RangeError);
        assert.ok(!error.message.includes(shortKey), 'must not echo the value');
        assert.match(error.message, /PERPL_API_KEY_SECRET/);
        return true;
      },
    );
    assert.throws(() => ApiSecret.fromHex('zz'.repeat(32)), /must be hex/);
  });

  it('never renders the key material', () => {
    const rendered = [
      String(secret),
      `${secret}`,
      JSON.stringify({ secret }),
      inspect(secret),
      inspect({ nested: { secret } }, { depth: 5 }),
    ];
    for (const text of rendered) {
      assert.ok(!text.includes(RFC8032.seedHex), `leaked in ${text}`);
      assert.match(text, /redacted/);
    }
  });
});

describe('canonical strings', () => {
  it('signs exactly the four documented websocket fields', () => {
    const canonical = wsSignInCanonical(10143, '1751932800000', '9Nq0Yp3kZ2c1aVb7');
    assert.equal(canonical, '10143\ntrading-ws-signin\n1751932800000\n9Nq0Yp3kZ2c1aVb7');
    assert.equal(canonical.split('\n').length, 4, 'no trailing newline');
  });

  it('matches the worked REST example from the docs', () => {
    assert.equal(
      restCanonical({
        chainId: 143,
        method: 'GET',
        target: '/v1/trading/fills?count=1',
        timestampMs: '1751932800000',
        nonce: '9Nq0Yp3kZ2c1aVb7',
        bodySha256Hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }),
      [
        '143',
        'GET',
        '/v1/trading/fills?count=1',
        '1751932800000',
        '9Nq0Yp3kZ2c1aVb7',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
  });
});

describe('randomNonce', () => {
  it('is unpadded base64url and fresh each call', () => {
    const nonces = new Set(Array.from({ length: 50 }, () => randomNonce()));
    assert.equal(nonces.size, 50);
    for (const nonce of nonces) assert.match(nonce, /^[A-Za-z0-9_-]{22}$/);
  });
});

describe('buildApiKeySignInFrame', () => {
  const frame = buildApiKeySignInFrame({
    chainId: 10143,
    apiKey: 'opaque-token',
    secret,
    now: () => 1751932800000,
    random: () => Buffer.alloc(16, 7),
  });

  it('carries the documented fields with a decimal-string timestamp', () => {
    assert.deepEqual(Object.keys(frame).sort(), [
      'api_key',
      'chain_id',
      'mt',
      'nonce',
      'signature',
      'timestamp',
    ]);
    assert.equal(frame.mt, 29);
    assert.equal(frame.chain_id, 10143);
    assert.equal(frame.timestamp, '1751932800000');
    assert.equal(typeof frame.timestamp, 'string');
  });

  it('signs the canonical string for that exact timestamp and nonce', () => {
    const expected = secret.signBase64Url(
      wsSignInCanonical(10143, frame.timestamp, frame.nonce),
    );
    assert.equal(frame.signature, expected);
  });

  it('never carries the private key', () => {
    assert.ok(!JSON.stringify(frame).includes(RFC8032.seedHex));
  });
});
