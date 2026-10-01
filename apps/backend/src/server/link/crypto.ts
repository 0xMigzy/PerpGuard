/**
 * API keys at rest: AES-256-GCM under a key from the environment.
 *
 * WHAT IS STORED is a blob that names the key it was sealed with:
 *
 *   v1.<key id>.<iv>.<ciphertext>.<tag>      (base64url fields)
 *
 * The key id is the first eight hex characters of SHA-256 over the raw
 * environment key, so a blob can say which key it needs without revealing
 * anything about that key. Decryption with a different key is refused by the
 * id check BEFORE any crypto runs, and reported as {@link KeyRotatedError}
 * rather than as a generic failure, because the two have different fixes.
 *
 * ROTATION, DECIDED: ROTATING THE ENVIRONMENT KEY INVALIDATES EVERY STORED
 * API KEY, AND EVERY LINKED USER RE-LINKS. On boot the link survives — the
 * chat still knows which account it is bound to — but its session cannot be
 * reopened, the bot says "re-link", and the next proof overwrites the blob.
 * There is no re-encryption path on purpose: keeping the old environment key
 * around long enough to re-seal everything is exactly the material a rotation
 * exists to destroy, and a process that holds two keys has two to leak.
 *
 * NOTHING HERE LOGS, ECHOES OR RETURNS A PLAINTEXT KEY. `seal` takes it in,
 * `open` hands it to the one caller that needs it, and neither puts it in an
 * error message.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class KeyRotatedError extends Error {
  readonly sealedWith: string;
  readonly current: string;
  constructor(sealedWith: string, current: string) {
    super(`this key was sealed with environment key ${sealedWith}, and the current one is ${current}: the environment key was rotated, so the stored API key cannot be opened and the account must be re-linked`);
    this.name = 'KeyRotatedError';
    this.sealedWith = sealedWith;
    this.current = current;
  }
}

export interface SealedCredentials {
  readonly apiKey: string;
  /** The Ed25519 secret as the hex the user pasted. */
  readonly secretHex: string;
}

const VERSION = 'v1';

export class KeyVault {
  readonly #key: Buffer;
  readonly keyId: string;

  /** @param keyHex 64 hex characters: a 32-byte key. Anything else is a configuration error. */
  constructor(keyHex: string) {
    const trimmed = keyHex.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      throw new RangeError('PERPGUARD_KEY_ENCRYPTION_KEY must be 64 hex characters (32 bytes); generate one with `openssl rand -hex 32`');
    }
    this.#key = Buffer.from(trimmed, 'hex');
    this.keyId = createHash('sha256').update(this.#key).digest('hex').slice(0, 8);
  }

  seal(credentials: SealedCredentials): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const plaintext = Buffer.from(JSON.stringify({ k: credentials.apiKey, s: credentials.secretHex }), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.keyId, b64(iv), b64(ciphertext), b64(tag)].join('.');
  }

  /** The key id a blob was sealed with, without opening it. */
  static sealedWith(blob: string): string | undefined {
    const parts = blob.split('.');
    return parts.length === 5 && parts[0] === VERSION ? parts[1] : undefined;
  }

  open(blob: string): SealedCredentials {
    const parts = blob.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('the stored key blob is not in a format this version understands');
    const [, keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string];
    if (keyId !== this.keyId) throw new KeyRotatedError(keyId, this.keyId);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext) as { k: string; s: string };
    return { apiKey: parsed.k, secretHex: parsed.s };
  }
}

const b64 = (bytes: Buffer): string => bytes.toString('base64url');
