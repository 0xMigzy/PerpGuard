'use client';

import { useEffect, type ReactNode } from 'react';
import { DynamicContextProvider, mergeNetworks, useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum';
import { exchangeDynamicSession, notifySessionChanged, registerDynamicLogout } from '@/lib/session.ts';

/** The environment id is public by design: it names the Dynamic project, not a secret. */
export const DYNAMIC_ENVIRONMENT_ID = process.env['NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID']?.trim() || undefined;

/** The SDK's network shape, taken from its own merge helper rather than a second package. */
type GenericNetwork = Parameters<typeof mergeNetworks>[0][number];

/**
 * Monad, declared to Dynamic so a Monad wallet is not told to switch chains.
 *
 * Measured, not assumed: with the environment's default network list, a
 * wallet on chain 10143 got an "Update Network — this network is not
 * available" step before the sign-in signature (Sep 30 2026). The signature
 * itself is chain-agnostic; the wallet only proves who holds it. Declaring
 * both Monad networks here removes the step for the trader most likely to
 * arrive: one already on Monad. Chain ids are the same constants
 * `packages/shared` config uses (143 mainnet, 10143 testnet).
 */
const MONAD_NETWORKS: readonly GenericNetwork[] = [
  {
    chainId: 143,
    networkId: 143,
    name: 'Monad',
    vanityName: 'Monad',
    iconUrls: ['https://icons.llamao.fi/icons/chains/rsz_monad.jpg'],
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: ['https://rpc.monad.xyz'],
    blockExplorerUrls: ['https://monadexplorer.com'],
  },
  {
    chainId: 10143,
    networkId: 10143,
    name: 'Monad Testnet',
    vanityName: 'Monad Testnet',
    isTestnet: true,
    iconUrls: ['https://icons.llamao.fi/icons/chains/rsz_monad.jpg'],
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: ['https://testnet-rpc.monad.xyz'],
    blockExplorerUrls: ['https://testnet.monadexplorer.com'],
  },
];

/** Module-level so its identity is stable: the SDK keeps it in a dependency array. */
const withMonad = (dashboardNetworks: GenericNetwork[]): GenericNetwork[] => mergeNetworks([...MONAD_NETWORKS], dashboardNetworks);

/**
 * Dynamic around the whole app, when it is configured.
 *
 * On a successful login the SDK's JWT is exchanged, once, for the backend's
 * own HttpOnly session; on logout that session is closed too. The exchange
 * is the only place the token is read, and it goes to PerpGuard's backend and
 * nowhere else.
 */
export function DynamicProviders({ children }: { readonly children: ReactNode }) {
  if (DYNAMIC_ENVIRONMENT_ID === undefined) return <>{children}</>;
  return (
    <DynamicContextProvider
      settings={{
        environmentId: DYNAMIC_ENVIRONMENT_ID,
        walletConnectors: [EthereumWalletConnectors],
        overrides: { evmNetworks: withMonad },
        events: {
          onAuthSuccess: () => {
            void exchangeDynamicSession();
          },
          onLogout: () => {
            notifySessionChanged();
          },
        },
      }}
    >
      <LogoutBridge />
      {children}
    </DynamicContextProvider>
  );
}

/** Hands the SDK's own logout to the session module, so Sign out ends both sessions. */
function LogoutBridge() {
  const { handleLogOut } = useDynamicContext();
  useEffect(() => {
    registerDynamicLogout(handleLogOut);
    return () => registerDynamicLogout(undefined);
  }, [handleLogOut]);
  return null;
}
