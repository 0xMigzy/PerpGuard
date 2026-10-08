import type { NextConfig } from 'next';

/**
 * THE BROWSER TALKS ONLY TO THE BACKEND'S ANALYTICS API. Every `/api/*` request
 * the pages make is rewritten to it here, so the web app never learns a database
 * URL, an indexer endpoint or a venue host. Set BACKEND_URL to point elsewhere.
 *
 * The pages call `/api/analytics/*` only. The backend's `/api/protect/*` action
 * routes still exist and still pass through this rewrite, but no page calls
 * them: the browser never executes anything, and every action lives in Telegram.
 */
const backend = process.env['BACKEND_URL'] ?? 'http://127.0.0.1:8080';

const config: NextConfig = {
  reactStrictMode: true,
  // A screenshot or smoke build can be kept apart from a running dev server's
  // `.next` by pointing this elsewhere. Unset, it is the default.
  ...(process.env['NEXT_DIST_DIR'] === undefined ? {} : { distDir: process.env['NEXT_DIST_DIR'] }),
  // Types only: the web app imports the analytics TYPES from shared and never
  // its runtime, but the bundler still has to be able to read them.
  transpilePackages: ['@perpguard/shared'],
  // Wallet SDKs under /link reach optional imports that are not installed (the
  // x402 payment packages, React Native's storage). /link never pays anything
  // and never runs on React Native, so those imports resolve to empty modules.
  webpack(webpackConfig: { resolve: { alias: Record<string, unknown> } }) {
    for (const m of ['@react-native-async-storage/async-storage', '@x402/core/client', '@x402/evm', '@x402/evm/exact/client', '@x402/evm/upto/client', '@x402/svm/exact/client']) webpackConfig.resolve.alias[m] = false;
    return webpackConfig;
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
  },
  async redirects() {
    // The wallet pages became the Traders section. Old links keep working.
    return [
      // ONE ORIGIN: www redirects to the apex. Dynamic answers only from the origins on its
      // environment (https://perpguard.app), so /link on www would have a dead wallet button.
      { source: '/:path*', has: [{ type: 'host', value: 'www.perpguard.app' }], destination: 'https://perpguard.app/:path*', permanent: true },
      { source: '/wallets', destination: '/traders', permanent: true },
      { source: '/wallets/:query', destination: '/traders/:query', permanent: true },
      // The Alerts section became Bot: it acts as well as alerts. Old links keep working, in one hop.
      { source: '/alerts', destination: '/bot', permanent: true },
      { source: '/protect', destination: '/bot', permanent: true },
    ];
  },
};

export default config;
