/**
 * Perpl API-key credentials from the environment.
 *
 * Variable names follow the docs' own table so a reader can move between the
 * two without translating:
 * https://docs.perpl.xyz/resources/for-developers/api/authentication.md
 *
 *   PERPL_NETWORK          mainnet | testnet
 *   PERPL_API_KEY          the opaque X-API-Key token
 *   PERPL_API_KEY_SECRET   the ed25519 private key, hex
 *   PERPL_ACCOUNT_ID       the on-chain trading account id; may be empty
 *
 * Env is injected rather than read from process.env, matching config.ts, so
 * this stays pure and testable. The secret is wrapped in ApiSecret the moment
 * it is read and never exists as a plain string beyond that point.
 */
import type { Env, NetworkName } from '../config.ts';
import { NETWORKS } from '../config.ts';
import { ConfigError } from '../errors.ts';
import { ApiSecret } from './perpl-signing.ts';

export interface PerplCredentials {
  readonly network: NetworkName;
  /** The opaque token. Log it only through maskApiKey. */
  readonly apiKey: string;
  readonly secret: ApiSecret;
  /**
   * Undefined when PERPL_ACCOUNT_ID is unset or empty. That is a normal state
   * on first run — the account id is discovered from the WalletSnapshot — so
   * it is not an error here.
   */
  readonly accountId: number | undefined;
}

function read(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * Reads every credential, reporting all missing variables in one error rather
 * than one per run.
 */
export function loadPerplCredentials(env: Env): PerplCredentials {
  const missing: string[] = [];

  const networkRaw = read(env, 'PERPL_NETWORK');
  if (networkRaw === undefined) missing.push('PERPL_NETWORK');

  const apiKey = read(env, 'PERPL_API_KEY');
  if (apiKey === undefined) missing.push('PERPL_API_KEY');

  const secretHex = read(env, 'PERPL_API_KEY_SECRET');
  if (secretHex === undefined) missing.push('PERPL_API_KEY_SECRET');

  if (missing.length > 0) {
    throw new ConfigError(
      `missing required env vars: ${missing.join(', ')}. ` +
        `Create an API key at https://testnet.perpl.xyz/apikeys and copy them into .env`,
    );
  }

  const network = NETWORKS.find((n) => n === networkRaw?.toLowerCase());
  if (network === undefined) {
    throw new ConfigError(
      `PERPL_NETWORK must be one of ${NETWORKS.join(' | ')}, got ${JSON.stringify(networkRaw)}`,
    );
  }

  const accountIdRaw = read(env, 'PERPL_ACCOUNT_ID');
  let accountId: number | undefined;
  if (accountIdRaw !== undefined) {
    const parsed = Number(accountIdRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ConfigError(
        `PERPL_ACCOUNT_ID must be a positive integer, got ${JSON.stringify(accountIdRaw)}`,
      );
    }
    accountId = parsed;
  }

  return {
    network,
    // Checked above; the compiler cannot see through the missing[] accumulation.
    apiKey: apiKey as string,
    secret: ApiSecret.fromHex(secretHex as string),
    accountId,
  };
}

/**
 * Safe rendering of the opaque token for logs: enough to tell two keys apart,
 * not enough to use. The token is not a secret in the way the private key is —
 * it cannot sign anything — but there is no reason to print it in full.
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)} (${apiKey.length} chars)`;
}
