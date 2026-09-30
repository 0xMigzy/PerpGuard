import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DynamicVerifier, jwksUrlFor } from './dynamic.ts';

const ENV = 'fb6dd9d1-09f5-43c3-8a8c-eab6e44c37f9';
const NOW = 1_790_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as { n: string; e: string; kty: string }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (payload: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey; alg?: string } = {}) => {
  const h = b64({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? 'k1' });
  const p = b64(payload);
  const sig = sign('RSA-SHA256', Buffer.from(`${h}.${p}`), opts.key ?? privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
};
const claims = (over: Record<string, unknown> = {}) => ({
  sub: 'd261ee91', iss: `app.dynamicauth.com/${ENV}`, aud: 'https://perpguard.example', environment_id: ENV,
  verified_credentials: [{ address: '0x829114000000000000000000000000000000AbCd', chain: 'eip155', format: 'blockchain' }, { email: 'judge@example.com', format: 'email' }],
  scope: 'user:basic', exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000) - 5, ...over,
});
let fetches = 0;
const verifier = () => new DynamicVerifier({ environmentId: ENV, now: () => NOW, fetchJwks: async (url) => { fetches += 1; assert.equal(url, jwksUrlFor(ENV)); return { keys: [jwk] }; } });

test('a good token yields the subject, lowercased EVM wallets and the email', async () => {
  const id = await verifier().verify(mint(claims()));
  assert.equal(id.sub, 'd261ee91');
  assert.deepEqual(id.wallets, ['0x829114000000000000000000000000000000abcd']);
  assert.equal(id.email, 'judge@example.com');
  assert.equal(id.expiresAtMs, (Math.floor(NOW / 1000) + 3600) * 1000);
});

test('the JWKS is fetched once and reused across tokens', async () => {
  const v = verifier();
  const before = fetches;
  await v.verify(mint(claims()));
  await v.verify(mint(claims({ sub: 'x' })));
  assert.equal(fetches - before, 1);
});

test('every forgery and staleness is refused with a reason', async () => {
  const v = verifier();
  await assert.rejects(v.verify(mint(claims(), { key: other.privateKey })), /signature does not verify/);
  await assert.rejects(v.verify(mint(claims(), { alg: 'HS256' })), /RS256/);
  await assert.rejects(v.verify(mint(claims(), { kid: 'unknown' })), /does not publish/);
  await assert.rejects(v.verify(mint(claims({ exp: Math.floor(NOW / 1000) - 120 }))), /expired/);
  await assert.rejects(v.verify(mint(claims({ environment_id: 'someone-elses' }))), /different Dynamic environment/);
  await assert.rejects(v.verify(mint(claims({ iss: 'app.dynamicauth.com/other' }))), /issuer/);
  await assert.rejects(v.verify(mint(claims({ scope: 'user:partial' }))), /user:basic/);
  await assert.rejects(v.verify('not.a.jwt.at.all'), /not a JWT/);
  await assert.rejects(v.verify(mint(claims({ sub: '' }))), /no subject/);
});

test('a token with no wallet is still an identity: an email login before a wallet exists', async () => {
  const id = await verifier().verify(mint(claims({ verified_credentials: [{ email: 'judge@example.com', format: 'email' }] })));
  assert.deepEqual(id.wallets, []);
  assert.equal(id.email, 'judge@example.com');
});
