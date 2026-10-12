/**
 * BEFORE A WALLET SIGNS, IT IS PUT ON THE CHAIN THE REQUEST NAMES, OR TOLD
 * WHICH ONE IN WORDS (12 Oct 2026). Perpl's key request carries its chain in
 * the EIP-712 domain, and a wallet on the other Monad network refuses it
 * with a chain id mismatch that reads as nonsense to a person. So the page
 * asks the wallet where it is, asks it to switch when it is elsewhere, and
 * when it does not, says "Your wallet is on Monad testnet. Switch it to
 * Monad mainnet to continue."
 *
 * NEVER WORSE THAN NOT ASKING: a wallet already on the chain, or one that
 * cannot say which chain it is on, is left alone and the signature is asked
 * for as before. A switch that fails for a reason other than the person
 * declining it does not stop the flow either: the signature is still asked
 * for, and only if THAT fails is the sentence shown. A wallet that signs
 * today cannot be blocked by this check.
 */

/** The part of a connected wallet this needs. Dynamic's `Wallet` satisfies it. */
export interface ChainSwitcher {
  getNetwork(): Promise<string | number | undefined>;
  switchNetwork(chainId: number): Promise<void>;
}

/** A wallet's own words for "the person said no". */
export const isDeclined = (error: unknown): boolean => error instanceof Error && /reject|denied|cancel|declin/i.test(error.message);

/** A wallet refusing a request for its chain: JSON-RPC -32602 "invalid params", or a chain mismatch in its own words. */
export const isChainRefusal = (error: unknown): boolean =>
  error instanceof Error && /invalid param|chain ?id|chain mismatch|does not match|wrong (network|chain)|unsupported chain|unrecognized chain/i.test(error.message);

/** The chain a typed-data domain names, as a number: Perpl sends it as a hex or decimal string. */
export function domainChainId(domain: Readonly<Record<string, unknown>>): number | undefined {
  return chainNumber(domain['chainId']);
}

function chainNumber(raw: unknown): number | undefined {
  try {
    const id = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(BigInt(raw)) : undefined;
    return id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export type EnsureChain =
  /** On the chain already, or moved there. */
  | { readonly state: 'already' | 'switched' }
  /** The wallet would not say where it is. Left alone. */
  | { readonly state: 'unknown' }
  /** Elsewhere, and the switch did not happen. `declined`: the person said no to it. */
  | { readonly state: 'elsewhere'; readonly current: number; readonly declined: boolean };

export async function ensureChain(wallet: ChainSwitcher, chainId: number): Promise<EnsureChain> {
  let current: number | undefined;
  try {
    current = chainNumber(await wallet.getNetwork());
  } catch {
    return { state: 'unknown' };
  }
  if (current === undefined) return { state: 'unknown' };
  if (current === chainId) return { state: 'already' };
  try {
    await wallet.switchNetwork(chainId);
  } catch (error) {
    return { state: 'elsewhere', current, declined: isDeclined(error) };
  }
  // A wallet can resolve the switch and stay where it was: ask again rather than trust the promise.
  try {
    const after = chainNumber(await wallet.getNetwork());
    if (after !== undefined && after !== chainId) return { state: 'elsewhere', current: after, declined: false };
  } catch {
    // It switched as far as it told us.
  }
  return { state: 'switched' };
}

/** The two chains this site can name; anything else is named by its number. */
export interface NamedChain {
  readonly chainId: number;
  readonly chainName: string;
}

/**
 * The sentence for a wallet on the wrong network. `current` unknown (the
 * wallet refused the request without ever saying where it is) names only
 * where to go.
 */
export function wrongChainText(current: number | undefined, wanted: NamedChain, known: readonly NamedChain[]): string {
  const go = `Switch it to ${wanted.chainName} to continue.`;
  if (current === undefined || current === wanted.chainId) return `Your wallet refused the request for ${wanted.chainName}. ${go}`;
  const name = known.find((k) => k.chainId === current)?.chainName ?? `another network (chain ${current})`;
  return `Your wallet is on ${name}. ${go}`;
}
