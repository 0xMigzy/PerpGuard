'use client';

/**
 * The ONLY provider in the app, around the ONLY route with a session.
 *
 * Dynamic lives here and nowhere else: this layout wraps `/link` and its
 * children, and the root layout knows nothing about it. Every other page is
 * public and read-only exactly as before. The environment id is public by
 * design — it names the Dynamic project, not a secret — and when it is
 * absent the page simply offers the key path without a wallet button.
 */
import type { ReactNode } from 'react';
import { DynamicContextProvider, mergeNetworks } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum';

export const DYNAMIC_ENVIRONMENT_ID = process.env['NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID']?.trim() || undefined;

type GenericNetwork = Parameters<typeof mergeNetworks>[0][number];

/**
 * Monad, declared to Dynamic so a Monad wallet is not told to switch chains
 * before signing. Measured on Sep 30 2026: without this the environment's
 * default list sent a wallet on chain 10143 to an "Update Network" step.
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

const withMonad = (dashboardNetworks: GenericNetwork[]): GenericNetwork[] => mergeNetworks([...MONAD_NETWORKS], dashboardNetworks);

export default function LinkLayout({ children }: { readonly children: ReactNode }) {
  if (DYNAMIC_ENVIRONMENT_ID === undefined) return <>{children}</>;
  return (
    <DynamicContextProvider settings={{ environmentId: DYNAMIC_ENVIRONMENT_ID, walletConnectors: [EthereumWalletConnectors], overrides: { evmNetworks: withMonad } }}>
      {children}
    </DynamicContextProvider>
  );
}
