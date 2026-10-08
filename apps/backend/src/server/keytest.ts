/**
 * TEMPORARY (8 Oct 2026, Stage 1 of wallet-signed key creation): does Perpl's
 * programmatic key enrolment work server to server, for a wallet that has a
 * Perpl profile? Mounted ONLY when KEYTEST_TOKEN is set, and every request must
 * carry that token. Comes out again with the page /_keytest.
 *
 *   POST /api/keytest/payload {token, address}         -> Perpl's typed data
 *   POST /api/keytest/enroll  {token, nonce, signature} -> Perpl's answer, then a sign-in with the key
 *
 * NO ORIGIN, NO REFERER: Perpl is called with node's https module and exactly
 * three headers (content-type, content-length, host), never a claim to be any
 * site. The Ed25519 secret is made here, held in memory for at most five
 * minutes, used once to sign in, and never stored, logged or sent to the
 * browser. The API token is shown masked.
 */
import https from 'node:https';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { hashTypedData } from 'viem';

export interface KeyTestOptions {
  readonly token: string;
  /** e.g. https://testnet.perpl.xyz/api */
  readonly restBaseUrl: string;
  readonly chainId: number;
  /** Sign in once with the new key: whose account it is, and whether forwarding is on. */
  readonly signIn: (apiKey: string, secretHex: string) => Promise<{ readonly accountId: number | undefined; readonly forwardingAllowed: boolean | undefined }>;
  readonly log: (line: string) => void;
}

interface Pending {
  readonly address: string;
  readonly secret: crypto.KeyObject;
  readonly typedData: { readonly domain: Record<string, unknown>; readonly types: Record<string, unknown>; readonly primaryType?: string; readonly message: Record<string, unknown> };
  readonly mac: string;
  readonly atMs: number;
}

const HOLD_MS = 5 * 60_000;

/** A POST to Perpl with exactly content-type, content-length and host. Status and body, as Perpl sent them. */
export function perplPost(restBaseUrl: string, path: string, body: unknown): Promise<{ readonly status: number; readonly body: string; readonly sentHeaders: Record<string, unknown> }> {
  const base = new URL(restBaseUrl);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: base.hostname, path: `${base.pathname.replace(/\/$/, '')}${path}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let out = '';
        res.on('data', (c: Buffer) => (out += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out, sentHeaders: { ...req.getHeaders() } }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** The API token, masked for display: its length and last four characters. */
export function maskToken(token: string): string {
  return `<${token.length}-char token …${token.slice(-4)}>`;
}

export function registerKeyTestRoutes(app: FastifyInstance, o: KeyTestOptions): void {
  const pending = new Map<string, Pending>();
  const tokenOk = (t: unknown): boolean => {
    if (typeof t !== 'string') return false;
    const a = Buffer.from(t);
    const b = Buffer.from(o.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const sweep = (now: number) => {
    for (const [k, p] of pending) if (now - p.atMs > HOLD_MS) pending.delete(k);
  };

  app.post('/api/keytest/payload', async (request, reply) => {
    const body = (request.body ?? {}) as { token?: unknown; address?: unknown };
    if (!tokenOk(body.token)) return reply.code(404).send({ error: 'not found' });
    if (typeof body.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) return reply.code(400).send({ error: 'a wallet address is needed' });
    sweep(Date.now());
    const pair = crypto.generateKeyPairSync('ed25519');
    const publicHex = `0x${Buffer.from(pair.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex')}`;
    const perpl = await perplPost(o.restBaseUrl, '/v1/api-key/payload', { chain_id: o.chainId, address: body.address, public_key: publicHex, scope_mask: 3, label: 'PerpGuard key test' });
    o.log(`keytest: payload for ${body.address}: Perpl ${perpl.status} (headers sent: ${Object.keys(perpl.sentHeaders).join(', ')})`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(perpl.body);
    } catch {
      parsed = undefined;
    }
    const ok = perpl.status === 200 && typeof parsed === 'object' && parsed !== null && 'typed_data' in parsed && 'mac' in parsed;
    let nonce: string | undefined;
    if (ok) {
      const p = parsed as { typed_data: Pending['typedData']; mac: string };
      nonce = crypto.randomBytes(16).toString('hex');
      pending.set(nonce, { address: body.address, secret: pair.privateKey, typedData: p.typed_data, mac: p.mac, atMs: Date.now() });
    }
    return { nonce, perpl: { status: perpl.status, body: parsed ?? perpl.body, headersSent: perpl.sentHeaders }, publicKey: publicHex };
  });

  app.post('/api/keytest/enroll', async (request, reply) => {
    const body = (request.body ?? {}) as { token?: unknown; nonce?: unknown; signature?: unknown };
    if (!tokenOk(body.token)) return reply.code(404).send({ error: 'not found' });
    const p = typeof body.nonce === 'string' ? pending.get(body.nonce) : undefined;
    if (p === undefined) return reply.code(410).send({ error: 'that payload has expired or was used; request a new one' });
    pending.delete(body.nonce as string); // once only
    if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.signature)) return reply.code(400).send({ error: 'a wallet signature is needed' });

    // The proof of possession: the Ed25519 key signs the same EIP-712 digest the wallet signed.
    const { EIP712Domain: _domainType, ...types } = p.typedData.types as Record<string, unknown>;
    const primaryType = p.typedData.primaryType ?? Object.keys(types)[0]!;
    const domain = { ...p.typedData.domain, chainId: BigInt(p.typedData.domain['chainId'] as string) };
    const digest = hashTypedData({ domain, types, primaryType, message: p.typedData.message } as Parameters<typeof hashTypedData>[0]);
    const pop = `0x${crypto.sign(null, Buffer.from(digest.slice(2), 'hex'), p.secret).toString('hex')}`;

    const perpl = await perplPost(o.restBaseUrl, '/v1/api-key/enroll', { chain_id: o.chainId, address: p.address, typed_data: p.typedData, mac: p.mac, signature: body.signature, pop_signature: pop });
    o.log(`keytest: enroll for ${p.address}: Perpl ${perpl.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(perpl.body);
    } catch {
      parsed = undefined;
    }
    // The token, found wherever the reply nests it, masked for the page and kept here only to sign in once.
    const holder = parsed as { api_key?: unknown } | undefined;
    const inner = holder?.api_key as { api_key?: unknown } | string | undefined;
    const apiKey = typeof inner === 'string' ? inner : typeof inner?.api_key === 'string' ? inner.api_key : undefined;
    const shown = apiKey === undefined ? (parsed ?? perpl.body) : JSON.parse(JSON.stringify(parsed).split(apiKey).join(maskToken(apiKey)));

    let signIn: unknown;
    if (perpl.status === 200 && apiKey !== undefined) {
      const secretHex = Buffer.from(p.secret.export({ format: 'jwk' }).d as string, 'base64url').toString('hex');
      try {
        signIn = await o.signIn(apiKey, secretHex);
        o.log(`keytest: the new key signed in: ${JSON.stringify(signIn)}`);
      } catch (error) {
        signIn = { error: error instanceof Error ? error.message : String(error) };
        o.log(`keytest: the new key did not sign in: ${(signIn as { error: string }).error}`);
      }
    }
    return { perpl: { status: perpl.status, body: shown, headersSent: perpl.sentHeaders }, signIn, stored: false };
  });
}
