import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer.tsx';
import { Header } from '@/components/Header.tsx';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

/**
 * Where the site is served, so link-preview images resolve to an absolute URL
 * (a crawler cannot fetch a relative one). Lifted from the shared .env at build
 * time by scripts/build-web.sh; without it Next falls back to localhost.
 */
const siteUrl = process.env.PUBLIC_WEB_URL;

/** Cache-buster for every icon link and the manifest's icons. 2 = the new mark with the simplified 16px. */
const ICON_VERSION = 2;

export const metadata: Metadata = {
  ...(siteUrl === undefined || siteUrl === '' ? {} : { metadataBase: new URL(siteUrl) }),
  title: { default: 'PerpGuard', template: '%s · PerpGuard' },
  description: 'Protocol analytics and liquidation risk for Perpl: markets, traders, liquidations, and what the isolated-margin rule costs.',
  manifest: '/manifest.webmanifest',
  icons: {
    // ?v=: a new value makes browsers fetch the icon again instead of the one
    // they cached under the same path. Bump it whenever an icon changes.
    icon: [
      { url: `/favicon.ico?v=${ICON_VERSION}`, sizes: '16x16 32x32 48x48' },
      { url: `/favicon-32.png?v=${ICON_VERSION}`, sizes: '32x32', type: 'image/png' },
      { url: `/favicon-16.png?v=${ICON_VERSION}`, sizes: '16x16', type: 'image/png' },
    ],
    apple: [{ url: `/apple-touch-icon.png?v=${ICON_VERSION}`, sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    title: 'PerpGuard',
    description: 'Protocol analytics and liquidation risk for Perpl.',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'PerpGuard' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PerpGuard',
    description: 'Protocol analytics and liquidation risk for Perpl.',
    images: ['/og-image.png'],
  },
};

export const viewport: Viewport = {
  themeColor: '#07080D',
  colorScheme: 'dark',
};

/**
 * PUBLIC AND READ-ONLY. There is no session, no sign-in and no provider here:
 * every page reads the analytics API and nothing on any page can execute an
 * action. Actions live in Telegram.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Header />
        <main className="wrap pt-[26px] pb-[60px]">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
