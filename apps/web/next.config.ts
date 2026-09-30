import type { NextConfig } from 'next';

/**
 * THE BROWSER TALKS ONLY TO THE BACKEND. Every `/api/*` and `/health` request
 * the pages make is rewritten to it here, so the web app never learns a database
 * URL, an indexer endpoint or a venue host. Set BACKEND_URL to point elsewhere.
 */
const backend = process.env['BACKEND_URL'] ?? 'http://127.0.0.1:8080';

const config: NextConfig = {
  reactStrictMode: true,
  // Types only: the web app imports the analytics and health TYPES from shared
  // and never its runtime, but the bundler still has to be able to read them.
  transpilePackages: ['@perpguard/shared'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/health', destination: `${backend}/health` },
    ];
  },
};

export default config;
