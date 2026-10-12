import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { builderTermsFrom, declaredOrigin, enrollKey, newPerplKeyPair, perplPoster, postToPerpl, proofOfPossession, requestKeyPayload, type PerplPoster } from './perpl-key-enrolment.ts';

test('NO ORIGIN, NO REFERER: what ARRIVES at the server is content-type, content-length, host and nothing that names a site', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.end(JSON.stringify({ typed_data: { types: {}, domain: {}, message: {} }, mac: '0x01' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  await postToPerpl(`http://127.0.0.1:${port}/api`, '/v1/api-key/payload', { a: 1 });
  server.close();
  const h = seen[0]!;
  assert.equal(h.origin, undefined);
  assert.equal(h.referer, undefined);
  assert.deepEqual(Object.keys(h).filter((k) => k !== 'connection').sort(), ['content-length', 'content-type', 'host']);
});

test('the key pair: a 32-byte public key as 0x-hex for Perpl, the secret as 64 hex for sealing; the proof verifies against it', () => {
  const k = newPerplKeyPair();
  assert.match(k.publicKeyHex, /^0x[0-9a-f]{64}$/);
  assert.match(k.secretHex, /^[0-9a-f]{64}$/);
  const digest = `0x${'ab'.repeat(32)}`;
  const pop = proofOfPossession(k.privateKey, digest);
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(k.publicKeyHex.slice(2), 'hex').toString('base64url') }, format: 'jwk' });
  assert.equal(crypto.verify(null, Buffer.from('ab'.repeat(32), 'hex'), pub, Buffer.from(pop.slice(2), 'hex')), true);
});

const answering = (status: number, body: unknown): PerplPoster => async () => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body), sentHeaders: {} });

test('ENROL OUTCOMES, each its own kind: 404 no profile, 409 already enrolled, 423 the key limit, anything else failed', async () => {
  const req = { chainId: 10143, address: '0x1', typedData: { types: {}, domain: {}, message: {} }, mac: '0x', signature: '0x', popSignature: '0x' };
  assert.deepEqual(await enrollKey(answering(404, 'Not Found'), 'x', req), { kind: 'no-profile' });
  assert.deepEqual(await enrollKey(answering(409, ''), 'x', req), { kind: 'already-enrolled' });
  assert.deepEqual(await enrollKey(answering(423, ''), 'x', req), { kind: 'key-limit' });
  assert.equal((await enrollKey(answering(500, 'boom'), 'x', req)).kind, 'failed');
  assert.deepEqual(await enrollKey(answering(200, { api_key: { api_key: 'tok123' } }), 'x', req), { kind: 'enrolled', apiKey: 'tok123' });
  assert.equal((await enrollKey(answering(200, { nothing: 1 }), 'x', req)).kind, 'failed', 'a 200 with no key is not a key');
});

test('the payload: typed data and MAC on 200, and a refusal said as failed with its status', async () => {
  const ok = await requestKeyPayload(answering(200, { typed_data: { types: {}, domain: {}, message: {} }, mac: '0xab' }), 'x', { chainId: 10143, address: '0x1', publicKeyHex: '0x', label: 'PerpGuard' });
  assert.equal(ok.kind, 'ok');
  assert.deepEqual(await requestKeyPayload(answering(400, 'Bad Request'), 'x', { chainId: 10143, address: '0x1', publicKeyHex: '0x', label: 'PerpGuard' }), { kind: 'failed', status: 400, detail: 'Bad Request' });
});

test("OUR OWN APPROVED ORIGIN, AND ONLY THAT: with one declared it ARRIVES as given, still with no Referer; with none, nothing names a site", async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  await perplPoster({ origin: 'https://perpguard.app' })(`http://127.0.0.1:${port}/api`, '/v1/api-key/payload', { a: 1 });
  await perplPoster()(`http://127.0.0.1:${port}/api`, '/v1/api-key/payload', { a: 1 });
  server.close();
  assert.equal(seen[0]!.origin, 'https://perpguard.app');
  assert.equal(seen[0]!.referer, undefined);
  assert.deepEqual(Object.keys(seen[0]!).filter((k) => k !== 'connection').sort(), ['content-length', 'content-type', 'host', 'origin']);
  assert.equal(seen[1]!.origin, undefined);
});

test("NEVER A FALSE ORIGIN: only this deployment's own https site may be declared; Perpl's site, another site, http or a typo stop the process", () => {
  assert.equal(declaredOrigin(undefined, 'https://perpguard.app'), undefined, 'not asked for: none sent');
  assert.equal(declaredOrigin('  ', 'https://perpguard.app'), undefined);
  assert.equal(declaredOrigin('https://perpguard.app', 'https://perpguard.app/'), 'https://perpguard.app');
  assert.equal(declaredOrigin('https://perpguard.app/', 'https://perpguard.app'), 'https://perpguard.app', 'the origin, never a path');
  for (const perpl of ['https://app.perpl.xyz', 'https://testnet.perpl.xyz', 'https://perpl.xyz']) {
    assert.throws(() => declaredOrigin(perpl, perpl), /never claims to be Perpl/, `${perpl}, even if PUBLIC_WEB_URL said the same`);
  }
  assert.throws(() => declaredOrigin('https://perpguard.app', 'https://testnet.perpguard.app'), /not this deployment's own site/, 'the testnet site may not borrow the approved origin');
  assert.throws(() => declaredOrigin('https://perpguard.app', undefined), /not this deployment's own site/);
  assert.throws(() => declaredOrigin('http://perpguard.app', 'http://perpguard.app'), /must be https/);
  assert.throws(() => declaredOrigin('perpguard.app', 'https://perpguard.app'), /not a URL/);
});

test('THE BUILDER CODE rides on the PAYLOAD request and nowhere else: two extra fields when set, none when not; the enrol call never names it', async () => {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const post: PerplPoster = async (_base, path, body) => {
    bodies.push({ path, body: body as Record<string, unknown> });
    return { status: 200, body: JSON.stringify(path.endsWith('payload') ? { typed_data: { types: {}, domain: {}, message: {} }, mac: '0xab' } : { api_key: { api_key: 'tok' } }), sentHeaders: {} };
  };
  const base = { chainId: 143, address: '0x1', publicKeyHex: '0x02', label: 'PerpGuard' };
  await requestKeyPayload(post, 'x', { ...base, builder: { id: 7, maxFeePer100k: 0 } });
  await requestKeyPayload(post, 'x', base);
  await enrollKey(post, 'x', { chainId: 143, address: '0x1', typedData: { types: {}, domain: {}, message: {} }, mac: '0x', signature: '0x', popSignature: '0x' });
  assert.deepEqual(bodies[0]!.body, { chain_id: 143, address: '0x1', public_key: '0x02', scope_mask: 3, label: 'PerpGuard', builder_id: 7, max_builder_fee_per_100k: 0 });
  assert.deepEqual(Object.keys(bodies[1]!.body), ['chain_id', 'address', 'public_key', 'scope_mask', 'label'], 'no builder: the ordinary request, unchanged');
  assert.ok(!('builder_id' in bodies[2]!.body), 'the code is frozen into the key at the payload step');
});

test('builder terms from env: unset is none; a fee ceiling defaults to 0 (attribution only); out-of-range values stop the process', () => {
  assert.equal(builderTermsFrom(undefined, undefined), undefined);
  assert.equal(builderTermsFrom('', '50'), undefined, 'a ceiling without a code is no builder at all');
  assert.deepEqual(builderTermsFrom(' 7 ', undefined), { id: 7, maxFeePer100k: 0 });
  assert.deepEqual(builderTermsFrom('255', '100'), { id: 255, maxFeePer100k: 100 });
  for (const bad of ['0', '256', '1.5', 'seven', '-1']) assert.throws(() => builderTermsFrom(bad, undefined), /1 to 255/);
  for (const bad of ['101', '-1', '0.5', 'x']) assert.throws(() => builderTermsFrom('7', bad), /0 to 100/);
});
