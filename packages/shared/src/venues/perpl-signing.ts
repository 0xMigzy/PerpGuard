/**
 * Ed25519 signing for Perpl API keys.
 * https://docs.perpl.xyz/resources/for-developers/api/authentication.md
 *
 * Node's built-in crypto does Ed25519, so there is no third-party dependency
 * here. The private key never leaves this module: it is held as a KeyObject
 * inside ApiSecret, which renders as `[redacted]` through every path a value
 * normally reaches a log by — String(), template literals, JSON.stringify and
 * console.log/util.inspect.
 *
 * Everything below is pure apart from the nonce, which takes its randomness
 * from an injectable source so tests can pin it.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** The literal action tag the trading-socket sign-in signature covers. */
export const WS_SIGNIN_TAG = 'trading-ws-signin';

/** MsgTypeApiKeySignIn. */
export const MT_API_KEY_SIGN_IN = 29;

const REDACTED = '[redacted ed25519 private key]';

/**
 * DER prefix for a PKCS#8-wrapped raw Ed25519 seed, i.e. everything before the
 * 32 key bytes:
 *
 *   SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING } }
 *
 * Verified byte-for-byte against what `generateKeyPairSync('ed25519')` exports,
 * and the resulting signer reproduces RFC 8032 test vector 1. See
 * perpl-signing.test.ts.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const SEED_BYTES = 32;
const HEX = /^[0-9a-fA-F]+$/;

/**
 * An Ed25519 private key that cannot be printed.
 *
 * Construct it with `ApiSecret.fromHex`. Nothing exposes the key material
 * again: the only thing you can do with it is sign.
 */
export class ApiSecret {
  readonly #key: KeyObject;

  private constructor(key: KeyObject) {
    this.#key = key;
  }

  /**
   * @param hex the 32-byte seed as hex, with or without a `0x` prefix. A
   * 64-byte value (seed ‖ public key, as some tools export) is accepted and
   * truncated to the seed.
   *
   * Error messages deliberately mention only the length, never the value.
   */
  static fromHex(hex: string, label = 'PERPL_API_KEY_SECRET'): ApiSecret {
    const trimmed = hex.trim().replace(/^0x/i, '');
    if (!HEX.test(trimmed)) {
      throw new RangeError(`${label} must be hex (it is not, ${trimmed.length} chars given)`);
    }
    if (trimmed.length !== SEED_BYTES * 2 && trimmed.length !== SEED_BYTES * 4) {
      throw new RangeError(
        `${label} must be a ${SEED_BYTES}-byte ed25519 key as ${SEED_BYTES * 2} hex chars ` +
          `(or ${SEED_BYTES * 4} for seed+public), got ${trimmed.length} chars`,
      );
    }
    const seed = Buffer.from(trimmed.slice(0, SEED_BYTES * 2), 'hex');
    return ApiSecret.fromSeed(seed, label);
  }

  static fromSeed(seed: Uint8Array, label = 'ed25519 seed'): ApiSecret {
    if (seed.length !== SEED_BYTES) {
      throw new RangeError(`${label} must be ${SEED_BYTES} bytes, got ${seed.length}`);
    }
    const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
    try {
      return new ApiSecret(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
    } catch (cause) {
      // Never surface the cause: OpenSSL errors can echo key bytes.
      throw new RangeError(`${label} is not a valid ed25519 private key`, { cause: undefined });
    }
  }

  /** Raw 64-byte Ed25519 signature over `message`. */
  sign(message: string | Uint8Array): Buffer {
    const data = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
    return sign(null, data, this.#key);
  }

  /** base64url, no padding — the encoding every Perpl signature field uses. */
  signBase64Url(message: string | Uint8Array): string {
    return this.sign(message).toString('base64url');
  }

  /**
   * The public key as `0x`-hex, which is what enrollment sends. Safe to print:
   * it is public, and it lets an operator check which key is loaded without
   * the secret going anywhere.
   */
  publicKeyHex(): string {
    const spki = createPublicKey(this.#key).export({ format: 'der', type: 'spki' });
    return `0x${spki.subarray(spki.length - SEED_BYTES).toString('hex')}`;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

/** Randomness for nonces. Injectable so tests are deterministic. */
export type RandomBytes = (size: number) => Uint8Array;

/** Client-random nonce, base64url with no padding. Single-use per request. */
export function randomNonce(random: RandomBytes = randomBytes, size = 16): string {
  return Buffer.from(random(size)).toString('base64url');
}

/**
 * The trading-socket sign-in canonical string: exactly four fields joined by a
 * single newline. Any deviation — a trailing newline, a numeric timestamp
 * formatted differently — changes the bytes and the server rejects the
 * signature.
 */
export function wsSignInCanonical(chainId: number, timestampMs: string, nonce: string): string {
  return [String(chainId), WS_SIGNIN_TAG, timestampMs, nonce].join('\n');
}

/**
 * The REST canonical string: six fields joined by newlines. Not used by the
 * websocket path, but it is the same key and the same encoding rules, and the
 * authenticated REST reads (positions, fills) land next.
 */
export function restCanonical(parts: {
  chainId: number;
  method: string;
  /** Path plus query string exactly as sent. */
  target: string;
  timestampMs: string;
  nonce: string;
  /** Hex SHA-256 of the raw body; the empty-string hash for an empty body. */
  bodySha256Hex: string;
}): string {
  return [
    String(parts.chainId),
    parts.method,
    parts.target,
    parts.timestampMs,
    parts.nonce,
    parts.bodySha256Hex,
  ].join('\n');
}

/** An `ApiKeySignIn` frame, ready to be JSON-stringified as the first message. */
export interface ApiKeySignInFrame {
  readonly mt: typeof MT_API_KEY_SIGN_IN;
  readonly chain_id: number;
  readonly api_key: string;
  /** Unix epoch milliseconds, decimal string. */
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface SignInOptions {
  readonly chainId: number;
  readonly apiKey: string;
  readonly secret: ApiSecret;
  /** Defaults to Date.now. Must be within ±30s of server time. */
  readonly now?: () => number;
  readonly random?: RandomBytes;
}

/**
 * Build the signed `mt: 29` frame. A fresh timestamp and nonce every time,
 * including on every reconnect: nonces are single-use.
 */
export function buildApiKeySignInFrame(options: SignInOptions): ApiKeySignInFrame {
  const timestamp = String((options.now ?? Date.now)());
  const nonce = randomNonce(options.random ?? randomBytes);
  const canonical = wsSignInCanonical(options.chainId, timestamp, nonce);
  return {
    mt: MT_API_KEY_SIGN_IN,
    chain_id: options.chainId,
    api_key: options.apiKey,
    timestamp,
    nonce,
    signature: options.secret.signBase64Url(canonical),
  };
}
