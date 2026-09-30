/**
 * Verifying a Dynamic-issued JWT, with nothing but Node's own crypto.
 *
 * WHAT THE PAGE'S TRUST ARGUMENT RESTS ON: the user signs in with Dynamic
 * (a wallet, or an email that Dynamic backs with one), Dynamic hands the
 * browser an RS256 token, and this backend verifies it against the
 * environment's public keys. No Perpl API key, no seed phrase and no
 * fund-moving signature ever passes through PerpGuard; the only thing the
 * token proves is which wallet the person holds, and the account is then read
 * off the Exchange contract from that address.
 *
 * Checks, per Dynamic's own guidance: the signature against the JWKS key
 * named by `kid`; `environment_id`; `iss`; `exp`/`iat`; and that the scope
 * includes `user:basic`, which is what says the login actually completed.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface DynamicIdentity {
  /** Dynamic's user id. */
  readonly sub: string;
  /** EVM wallets on the token, lowercased. */
  readonly wallets: readonly string[];
  readonly email: string | undefined;
  readonly expiresAtMs: number;
}

export interface Jwk {
  readonly kid?: string;
  readonly kty: string;
  readonly n?: string;
  readonly e?: string;
  readonly alg?: string;
  readonly use?: string;
}

export interface DynamicVerifierOptions {
  readonly environmentId: string;
  /** Fetches the JWKS document. Injected so the tests need no network. */
  readonly fetchJwks?: (url: string) => Promise<{ keys: readonly Jwk[] }>;
  readonly now?: () => number;
  /** Seconds of clock skew tolerated on iat/exp. */
  readonly skewSec?: number;
}

export class DynamicVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DynamicVerifyError';
  }
}

/** Where Dynamic publishes the environment's signing keys. Its issuer host, not the marketing site. */
export function jwksUrlFor(environmentId: string): string {
  return `https://app.dynamicauth.com/api/v0/sdk/${encodeURIComponent(environmentId)}/.well-known/jwks`;
}

const b64url = (s: string): Buffer => Buffer.from(s, 'base64url');

export class DynamicVerifier {
  readonly #env: string;
  readonly #fetchJwks: (url: string) => Promise<{ keys: readonly Jwk[] }>;
  readonly #now: () => number;
  readonly #skewSec: number;
  #keys = new Map<string, KeyObject>();
  #fetchedAtMs = 0;

  constructor(options: DynamicVerifierOptions) {
    this.#env = options.environmentId;
    this.#fetchJwks = options.fetchJwks ?? defaultFetchJwks;
    this.#now = options.now ?? Date.now;
    this.#skewSec = options.skewSec ?? 60;
  }

  async verify(token: string): Promise<DynamicIdentity> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new DynamicVerifyError('the token is not a JWT');
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string; typ?: string };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(b64url(h).toString('utf8')) as typeof header;
      payload = JSON.parse(b64url(p).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new DynamicVerifyError('the token could not be decoded');
    }
    if (header.alg !== 'RS256') throw new DynamicVerifyError(`unsupported algorithm ${JSON.stringify(header.alg)}; Dynamic signs with RS256`);
    if (typeof header.kid !== 'string') throw new DynamicVerifyError('the token names no signing key');

    const key = await this.#keyFor(header.kid);
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, b64url(s));
    if (!ok) throw new DynamicVerifyError('the signature does not verify against Dynamic’s keys');

    const nowSec = Math.floor(this.#now() / 1000);
    const exp = Number(payload['exp']);
    const iat = Number(payload['iat']);
    if (!Number.isFinite(exp) || exp + this.#skewSec < nowSec) throw new DynamicVerifyError('the token has expired; sign in again');
    if (Number.isFinite(iat) && iat - this.#skewSec > nowSec) throw new DynamicVerifyError('the token is from the future; check the clock');
    if (payload['environment_id'] !== this.#env) throw new DynamicVerifyError('the token is for a different Dynamic environment');
    const iss = String(payload['iss'] ?? '');
    if (iss.replace(/^https?:\/\//, '') !== `app.dynamicauth.com/${this.#env}`) throw new DynamicVerifyError(`unexpected issuer ${JSON.stringify(iss)}`);
    const scope = payload['scope'];
    const scopes = typeof scope === 'string' ? scope.split(/\s+/) : Array.isArray(scope) ? scope.map(String) : undefined;
    if (scopes !== undefined && !scopes.includes('user:basic')) throw new DynamicVerifyError('the login has not completed (scope lacks user:basic)');
    const sub = payload['sub'];
    if (typeof sub !== 'string' || sub === '') throw new DynamicVerifyError('the token has no subject');

    const creds = Array.isArray(payload['verified_credentials']) ? (payload['verified_credentials'] as Array<Record<string, unknown>>) : [];
    const wallets = creds
      .filter((c) => typeof c['address'] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c['address'] as string) && (c['chain'] === undefined || String(c['chain']).startsWith('eip155')))
      .map((c) => (c['address'] as string).toLowerCase());
    const email = typeof payload['email'] === 'string' ? payload['email'] : creds.find((c) => typeof c['email'] === 'string')?.['email'];
    return { sub, wallets: [...new Set(wallets)], email: typeof email === 'string' ? email : undefined, expiresAtMs: exp * 1000 };
  }

  /** Keys are cached; an unknown kid refetches once, since Dynamic rotates. */
  async #keyFor(kid: string): Promise<KeyObject> {
    const cached = this.#keys.get(kid);
    if (cached !== undefined) return cached;
    if (this.#now() - this.#fetchedAtMs < 30_000 && this.#fetchedAtMs !== 0) {
      throw new DynamicVerifyError('the token names a signing key Dynamic does not publish');
    }
    const jwks = await this.#fetchJwks(jwksUrlFor(this.#env));
    this.#fetchedAtMs = this.#now();
    const next = new Map<string, KeyObject>();
    for (const jwk of jwks.keys) {
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch {
        // A malformed key in the set is skipped, not fatal: the others may still verify.
      }
    }
    this.#keys = next;
    const key = next.get(kid);
    if (key === undefined) throw new DynamicVerifyError('the token names a signing key Dynamic does not publish');
    return key;
  }
}

async function defaultFetchJwks(url: string): Promise<{ keys: readonly Jwk[] }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new DynamicVerifyError(`Dynamic’s key set answered ${response.status}`);
  return (await response.json()) as { keys: readonly Jwk[] };
}
