import type { PerplKeyTypedData } from '@perpguard/shared';

/**
 * Perpl's typed data in viem's shape: the EIP712Domain entry out of `types` (viem derives it from
 * the domain), the chain id as a number, and the primary type named. Signed and verified exactly as
 * Perpl gave it otherwise.
 */
export function viemTypedData(t: PerplKeyTypedData): {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
} {
  const { EIP712Domain: _domainType, ...types } = t.types;
  const raw = t.domain['chainId'];
  const chainId = typeof raw === 'string' ? Number(BigInt(raw)) : raw;
  return { domain: { ...t.domain, chainId }, types, primaryType: t.primaryType ?? Object.keys(types)[0]!, message: t.message };
}
