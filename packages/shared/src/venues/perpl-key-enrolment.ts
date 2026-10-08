/**
 * PERPL API KEY ENROLMENT, SERVER TO SERVER (8 Oct 2026).
 *
 * Perpl's documented flow (docs: resources/for-developers/api/authentication):
 * POST /v1/api-key/payload returns EIP-712 typed data and a MAC; the owner's
 * WALLET signs the typed data; the new Ed25519 key signs the same digest (proof
 * of possession); POST /v1/api-key/enroll returns the key's token.
 *
 * NO ORIGIN, NO REFERER, EVER. Perpl's server refuses an Origin it has not
 * approved (perpguard.app got 400) and accepts a request with none, which is
 * what this sends: node's https with exactly content-type, content-length and
 * host. Proven on testnet with the owner's wallet: enroll 200, the key signed in
 * as account #24 with forwarding on. Undocumented, so the caller keeps it behind
 * a switch.
 *
 * The Ed25519 secret is made here and returned to the caller to seal; it is
 * never logged.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

/** Perpl's typed data, as returned: signed exactly as given. */
export interface PerplKeyTypedData {
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>;
  readonly primaryType?: string;
  readonly domain: Readonly<Record<string, unknown>>;
  readonly message: Readonly<Record<string, unknown>>;
}

export interface PerplReply {
  readonly status: number;
  readonly body: string;
  /** The headers this request carried, for the record: never an Origin or a Referer. */
  readonly sentHeaders: Readonly<Record<string, unknown>>;
}

/** The transport: a POST that sends exactly the headers it is given. Replaceable in tests. */
export type PerplPoster = (restBaseUrl: string, path: string, body: unknown) => Promise<PerplReply>;

/** A POST to Perpl with exactly content-type, content-length and host. */
export const postToPerpl: PerplPoster = (restBaseUrl, path, body) => {
  const base = new URL(restBaseUrl);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // https in every real use; http only for a local test server, so the headers that ARRIVE can be checked.
    const req = (base.protocol === 'http:' ? http : https).request(
      {
        host: base.hostname,
        ...(base.port === '' ? {} : { port: Number(base.port) }),
        path: `${base.pathname.replace(/\/$/, '')}${path}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 15_000,
      },
      (res) => {
        let out = '';
        res.on('data', (c: Buffer) => (out += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out, sentHeaders: { ...req.getHeaders() } }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Perpl did not answer within 15 s')));
    req.on('error', reject);
    req.end(data);
  });
};

/** A fresh Ed25519 key: the public half as Perpl wants it (0x + 32 bytes hex), the secret as hex for sealing. */
export function newPerplKeyPair(): { readonly publicKeyHex: string; readonly secretHex: string; readonly privateKey: crypto.KeyObject } {
  const pair = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('hex');
  const secret = Buffer.from(pair.privateKey.export({ format: 'jwk' }).d as string, 'base64url').toString('hex');
  return { publicKeyHex: `0x${pub}`, secretHex: secret, privateKey: pair.privateKey };
}

/** The proof of possession: the new key's Ed25519 signature over the EIP-712 digest the wallet signed. */
export function proofOfPossession(privateKey: crypto.KeyObject, digestHex: string): string {
  return `0x${crypto.sign(null, Buffer.from(digestHex.replace(/^0x/, ''), 'hex'), privateKey).toString('hex')}`;
}

export type PayloadResult = { readonly kind: 'ok'; readonly typedData: PerplKeyTypedData; readonly mac: string } | { readonly kind: 'failed'; readonly status: number; readonly detail: string };

export async function requestKeyPayload(
  post: PerplPoster,
  restBaseUrl: string,
  request: { readonly chainId: number; readonly address: string; readonly publicKeyHex: string; readonly label: string },
): Promise<PayloadResult> {
  const reply = await post(restBaseUrl, '/v1/api-key/payload', { chain_id: request.chainId, address: request.address, public_key: request.publicKeyHex, scope_mask: 3, label: request.label });
  if (reply.status !== 200) return { kind: 'failed', status: reply.status, detail: reply.body.slice(0, 200) };
  try {
    const parsed = JSON.parse(reply.body) as { typed_data?: PerplKeyTypedData; mac?: string };
    if (parsed.typed_data === undefined || typeof parsed.mac !== 'string') return { kind: 'failed', status: reply.status, detail: 'no typed data in the reply' };
    return { kind: 'ok', typedData: parsed.typed_data, mac: parsed.mac };
  } catch {
    return { kind: 'failed', status: reply.status, detail: 'the reply was not JSON' };
  }
}

/**
 * What an enrolment came to. The four failures the owner named, each its own kind, so the page can
 * word them plainly (Perpl's documented codes: 404 no profile, 409 already registered, 423 the
 * profile's 16-key limit).
 */
export type EnrolResult =
  | { readonly kind: 'enrolled'; readonly apiKey: string }
  | { readonly kind: 'no-profile' }
  | { readonly kind: 'already-enrolled' }
  | { readonly kind: 'key-limit' }
  | { readonly kind: 'failed'; readonly status: number; readonly detail: string };

export async function enrollKey(
  post: PerplPoster,
  restBaseUrl: string,
  request: { readonly chainId: number; readonly address: string; readonly typedData: PerplKeyTypedData; readonly mac: string; readonly signature: string; readonly popSignature: string },
): Promise<EnrolResult> {
  const reply = await post(restBaseUrl, '/v1/api-key/enroll', {
    chain_id: request.chainId,
    address: request.address,
    typed_data: request.typedData,
    mac: request.mac,
    signature: request.signature,
    pop_signature: request.popSignature,
  });
  if (reply.status === 404) return { kind: 'no-profile' };
  if (reply.status === 409) return { kind: 'already-enrolled' };
  if (reply.status === 423) return { kind: 'key-limit' };
  if (reply.status !== 200) return { kind: 'failed', status: reply.status, detail: reply.body.slice(0, 200) };
  try {
    const parsed = JSON.parse(reply.body) as { api_key?: unknown };
    const inner = parsed.api_key as { api_key?: unknown } | string | undefined;
    const apiKey = typeof inner === 'string' ? inner : typeof inner?.api_key === 'string' ? inner.api_key : undefined;
    return apiKey === undefined ? { kind: 'failed', status: 200, detail: 'no key in the reply' } : { kind: 'enrolled', apiKey };
  } catch {
    return { kind: 'failed', status: 200, detail: 'the reply was not JSON' };
  }
}
