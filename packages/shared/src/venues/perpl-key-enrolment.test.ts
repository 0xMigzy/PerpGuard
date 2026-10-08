import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { enrollKey, newPerplKeyPair, postToPerpl, proofOfPossession, requestKeyPayload, type PerplPoster } from './perpl-key-enrolment.ts';

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
