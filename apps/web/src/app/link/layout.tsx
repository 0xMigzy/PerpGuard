'use client';

/**
 * The ONLY provider in the app, around the ONLY route with a session.
 *
 * Dynamic connects the wallet on /link and nowhere else: the root layout
 * knows nothing about it, and every other page is public and read-only.
 *
 * CONNECT-ONLY. Dynamic's own sign-in (its signature, its JWT) is off: the
 * proof is the backend's Sign-In with Ethereum challenge, signed by the
 * connected wallet and verified by the backend with viem. Dynamic only finds
 * and connects the wallet, so the backend does not care which library did.
 * Without an environment id the page offers the API key path only.
 */
import type { ReactNode } from 'react';
import { DynamicContextProvider, mergeNetworks } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum';
import { DYNAMIC_ENVIRONMENT_ID } from './dynamicEnv.ts';

type GenericNetwork = Parameters<typeof mergeNetworks>[0][number];

/**
 * Monad, declared to Dynamic so a Monad wallet is not told to switch chains
 * before signing (measured 30 Sep 2026: without it a wallet on chain 10143
 * was sent to an "Update Network" step). The message names its own chain, so
 * no switch is ever needed to sign it.
 */
const MONAD_NETWORKS: readonly GenericNetwork[] = [
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
];

const withMonad = (dashboardNetworks: GenericNetwork[]): GenericNetwork[] => mergeNetworks([...MONAD_NETWORKS], dashboardNetworks);

export default function LinkLayout({ children }: { readonly children: ReactNode }) {
  if (DYNAMIC_ENVIRONMENT_ID === undefined) return <>{children}</>;
  return (
    <DynamicContextProvider
      settings={{
        environmentId: DYNAMIC_ENVIRONMENT_ID,
        walletConnectors: [EthereumWalletConnectors],
        initialAuthenticationMode: 'connect-only',
        overrides: { evmNetworks: withMonad },
      }}
    >
      {children}
    </DynamicContextProvider>
  );
}
