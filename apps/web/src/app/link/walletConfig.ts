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
 * THE LIST IS DELIBERATE, not RainbowKit's default and not whatever happens
 * to be installed: MetaMask, Rabby, Rainbow, Coinbase, and WalletConnect as
 * the catch-all for every other phone wallet, in that order, on desktop and
 * on phones alike. Wallet auto-discovery (EIP-6963) is OFF, because it would
 * add any installed extension, including Phantom, which ended Monad support
 * in August 2026 and would appear and then fail.
 *
 * RABBY ON PHONES. RainbowKit's own Rabby entry knows only the browser
 * extension, so a phone never lists it. `rabby` below keeps that entry where
 * Rabby is injected (the extension, or Rabby's in-app browser) and otherwise
 * connects over WalletConnect with Rabby's registered deep link, `rabby://`,
 * taken from the WalletConnect wallet registry (Rabby, listing 18388be9…);
 * on desktop without the extension it shows a QR to scan with Rabby Mobile.
 *
 * WALLETCONNECT IS OPTIONAL. With NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID set
 * (inlined at build time by build-web.sh) the list above is offered. Without
 * it, the one browser wallet in the page is offered, and nothing that needs a
 * project id: no QR, no broken button.
 *
 * Changing the id needs a NEW BUILD on Vercel, and Vercel skips any commit
 * that does not touch apps/web ("Skipped - Not affected"): an empty commit
 * does not redeploy. Redeploy from the dashboard or with a web change.
 */
import { connectorsForWallets, getWalletConnectConnector, type Wallet } from '@rainbow-me/rainbowkit';
import { coinbaseWallet, injectedWallet, metaMaskWallet, rabbyWallet, rainbowWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http } from 'wagmi';
import { monad, monadTestnet } from 'viem/chains';

export const WALLETCONNECT_PROJECT_ID = process.env['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID']?.trim() || undefined;

const APP = { appName: 'PerpGuard', appDescription: 'Link your wallet to PerpGuard on Telegram', appUrl: 'https://perpguard.app' } as const;

/** Rabby's deep link, from the WalletConnect registry. WalletConnect's convention for a native link is `<scheme>wc?uri=`. */
export const RABBY_DEEP_LINK = 'rabby://';
export const rabbyWalletConnectUri = (uri: string): string => `${RABBY_DEEP_LINK}wc?uri=${encodeURIComponent(uri)}`;

/** Rabby everywhere: the extension where it is injected, the Rabby phone app over WalletConnect elsewhere. */
const rabby = (params: { projectId: string }): Wallet => {
  const extension = rabbyWallet();
  if (extension.installed === true) return extension;
  // Not injected here: neither installed nor not, so RainbowKit offers the phone app and the QR.
  const { installed: _notHere, ...rest } = extension;
  return {
    ...rest,
    downloadUrls: {
      ...rest.downloadUrls,
      // Both store links as the WalletConnect registry lists them for Rabby.
      ios: 'https://apps.apple.com/us/app/rabby-wallet-crypto-evm/id6474381673',
      android: 'https://play.google.com/store/apps/details?id=com.debank.rabbymobile',
      mobile: 'https://rabby.io',
      qrCode: 'https://rabby.io',
    },
    mobile: { getUri: rabbyWalletConnectUri },
    qrCode: { getUri: (uri: string) => uri, instructions: { learnMoreUrl: 'https://rabby.io', steps: [] } },
    createConnector: getWalletConnectConnector({ projectId: params.projectId }),
  };
};

const connectors = connectorsForWallets(
  WALLETCONNECT_PROJECT_ID === undefined
    ? [{ groupName: 'In this browser', wallets: [injectedWallet] }]
    : [{ groupName: 'Wallets', wallets: [metaMaskWallet, rabby, rainbowWallet, coinbaseWallet, walletConnectWallet] }],
  // Unused by injected wallets; required by the type. Never a real id when absent.
  { ...APP, projectId: WALLETCONNECT_PROJECT_ID ?? 'no-walletconnect' },
);

export const wagmiConfig = createConfig({
  chains: [monadTestnet, monad],
  connectors,
  // The list above is the list. See the note at the top.
  multiInjectedProviderDiscovery: false,
  transports: { [monadTestnet.id]: http(), [monad.id]: http() },
  ssr: true,
});
