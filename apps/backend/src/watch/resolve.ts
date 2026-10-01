/**
 * `/watch <something>` -> an account id, through the same two lookups the web's
 * search uses, in the same order.
 *
 * THE INDEX FIRST, THE CHAIN SECOND. The index links a wallet to an account
 * only when it saw `AccountCreated`, which is a minority of mainnet accounts;
 * the Exchange contract resolves every one. So an address the index cannot
 * place is asked of the chain, and a checksummed address pasted from an
 * explorer resolves either way, because both lookups compare lowercased
 * (CLAUDE.md).
 *
 * An account the chain knows but the index holds nothing for is STILL
 * watchable: it exists, it simply has no indexed activity yet, and the loop
 * will find no positions on it until it does. Refusing it would tell someone
 * their own fresh account is not real.
 */
import type { AccountLookup, Analytics } from '@perpguard/shared';
import type { ResolvedWatchTarget, WatchResolver, WatchTarget } from '@perpguard/bot';

export interface WatchResolverDeps {
  readonly analytics: Pick<Analytics, 'wallet' | 'walletByAccountId'>;
  /** The Exchange contract on the ANALYTICS network. Absent means the index is the only source. */
  readonly lookupOnChain?: (address: string) => Promise<AccountLookup>;
}

export function createWatchResolver(deps: WatchResolverDeps): WatchResolver {
  return {
    async resolve(target: WatchTarget): Promise<ResolvedWatchTarget | { readonly error: string }> {
      if (target.kind === 'account') {
        const profile = await deps.analytics.walletByAccountId(target.accountId);
        if (profile === undefined) {
          return {
            error:
              `Account ${target.accountId} is not in the index. It may be newer than the index's start block, ` +
              `or it may not exist; if you have its owner address, /watch that instead and the Exchange contract is asked.`,
          };
        }
        return { accountId: profile.accountId, address: profile.address === '' ? undefined : profile.address.toLowerCase(), resolvedBy: 'index' };
      }

      const address = target.address.toLowerCase();
      const indexed = await deps.analytics.wallet(address);
      if (indexed.kind === 'found') {
        return { accountId: indexed.profile.accountId, address, resolvedBy: indexed.resolvedBy };
      }
      if (deps.lookupOnChain === undefined) {
        return { error: `${indexed.reason} The Exchange contract is not wired for lookups here, so that is as far as I can go.` };
      }
      const chain = await deps.lookupOnChain(address);
      if (!chain.found) {
        return { error: `${indexed.reason} The Exchange contract was asked too: ${chain.reason}.` };
      }
      return { accountId: chain.accountId, address, resolvedBy: 'chain' };
    },
  };
}
