import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { DynamicProviders } from '@/components/DynamicProviders.tsx';
import { Footer } from '@/components/Footer.tsx';
import { Header } from '@/components/Header.tsx';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'PerpGuard', template: '%s · PerpGuard' },
  description: 'Real-time risk monitoring for Perpl traders on Monad: liquidation alerts, stress tests, and a kill switch.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/favicon.ico',
    apple: '/perpguard-logo-180.png',
  },
  openGraph: {
    title: 'PerpGuard',
    description: 'Real-time risk monitoring for Perpl traders on Monad.',
    images: [{ url: '/perpguard-banner-640x360.png', width: 640, height: 360 }],
  },
};

export const viewport: Viewport = {
  themeColor: '#07080D',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <DynamicProviders>
          <Header />
          <main className="wrap pt-[26px] pb-[60px]">{children}</main>
          <Footer />
        </DynamicProviders>
      </body>
    </html>
  );
}
