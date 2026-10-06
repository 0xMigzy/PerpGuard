'use client';

/**
 * The ONLY providers in the app, around the ONLY route with a session.
 *
 * QueryClientProvider -> WagmiProvider -> RainbowKitProvider wrap /link and
 * its children; the root layout knows nothing about wallets, and every other
 * page is public and read-only exactly as before.
 */
import '@rainbow-me/rainbowkit/styles.css';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { wagmiConfig } from './walletConfig.ts';

/** RainbowKit in the site's own dark palette, not its default look. */
const theme = (() => {
  const base = darkTheme({ accentColor: '#8B5CF6', accentColorForeground: '#ffffff', borderRadius: 'small', fontStack: 'system', overlayBlur: 'small' });
  return {
    ...base,
    colors: {
      ...base.colors,
      modalBackground: '#0F1118',
      modalBorder: '#1C1F2A',
      generalBorder: '#262A38',
      menuItemBackground: '#141724',
      connectButtonBackground: '#0F1118',
      connectButtonInnerBackground: '#141724',
      modalText: '#ECEAFB',
      modalTextSecondary: '#8A8FA3',
      modalBackdrop: 'rgba(7, 8, 13, 0.72)',
    },
    radii: { ...base.radii, modal: '10px', actionButton: '8px', connectButton: '8px', menuButton: '8px', modalMobile: '10px' },
    fonts: { body: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  };
})();

export default function LinkLayout({ children }: { readonly children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme} modalSize="compact" appInfo={{ appName: 'PerpGuard' }}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
