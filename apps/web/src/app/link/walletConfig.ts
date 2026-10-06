/**
 * The wallet stack for /link, and nowhere else: wagmi + viem under RainbowKit.
 *
 * CHAINS: both Monad networks, straight from viem (monadTestnet 10143, monad
 * 143), testnet first. The signature this page asks for is a plain
 * personal_sign of a message that names its own chain, so no wallet is ever
 * asked to switch networks before signing. The browser gets ONLY the public
 * RPCs viem ships; the backend's own RPC URL (it carries a token) never leaves
 * the server.
 *
 * WALLETCONNECT IS OPTIONAL. With NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID set
 * (inlined at build time by build-web.sh) the list includes WalletConnect and
 * its QR code for phone wallets. Without it, only injected wallets are listed
 * (wagmi still discovers every installed extension via EIP-6963), and nothing
 * that needs a project id is offered: no QR, no broken button.
 *
 * Changing the id needs a NEW BUILD on Vercel, and Vercel skips any commit
 * that does not touch apps/web ("Skipped - Not affected"): an empty commit
 * does not redeploy. Redeploy from the dashboard or with a web change.
 */
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { coinbaseWallet, injectedWallet, metaMaskWallet, rabbyWallet, rainbowWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { monad, monadTestnet } from 'viem/chains';

export const WALLETCONNECT_PROJECT_ID = process.env['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID']?.trim() || undefined;

const APP = { appName: 'PerpGuard', appDescription: 'Link your wallet to PerpGuard on Telegram', appUrl: 'https://perpguard.app' } as const;

const connectors = connectorsForWallets(
  WALLETCONNECT_PROJECT_ID === undefined
    ? [{ groupName: 'Installed', wallets: [injectedWallet] }]
    : [
        { groupName: 'Popular', wallets: [metaMaskWallet, rabbyWallet, coinbaseWallet, rainbowWallet] },
        { groupName: 'More', wallets: [walletConnectWallet, injectedWallet] },
      ],
  // Unused by injected wallets; required by the type. Never a real id when absent.
  { ...APP, projectId: WALLETCONNECT_PROJECT_ID ?? 'no-walletconnect' },
);

export const wagmiConfig = createConfig({
  chains: [monadTestnet, monad],
  connectors,
  transports: { [monadTestnet.id]: http(), [monad.id]: http() },
  ssr: true,
});
