import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer.tsx';
import { Header } from '@/components/Header.tsx';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'PerpGuard', template: '%s · PerpGuard' },
  description: 'Protocol analytics and liquidation risk for Perpl: markets, traders, liquidations, and what the isolated-margin rule costs.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/favicon.ico',
    apple: '/perpguard-logo-180.png',
  },
  openGraph: {
    title: 'PerpGuard',
    description: 'Protocol analytics and liquidation risk for Perpl.',
    images: [{ url: '/perpguard-banner-640x360.png', width: 640, height: 360 }],
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
