/**
 * The facts the Data & Methodology page (/status) shows about how PerpGuard
 * runs: static configuration read from the constants the code already uses.
 * NO QUERY: nothing here touches Postgres or the chain.
 *
 * THE RPC URL NEVER LEAVES THIS PROCESS. A provider URL carries its token, and
 * on QuickNode the leading host labels are the endpoint's own identifier, so
 * even the full host is not shown: only the provider's registrable domain
 * ("quiknode.pro"), which names who serves the reads and nothing else.
 */

export interface InfrastructureFacts {
  /** The analytics network: the one every public figure reads. */
  readonly network: { readonly name: string; readonly chainId: number };
  /** The RPC provider's registrable domain, e.g. "quiknode.pro". Never a path, a token or an endpoint label. */
  readonly rpcProvider: string | undefined;
  readonly indexer: string;
  readonly database: string;
  /** How long an indexed answer is served before a refresh runs behind the reader. */
  readonly cacheTtlMs: number;
  /** How often the default views are recomputed ahead of readers. */
  readonly warmIntervalMs: number;
  /** How long the indexer-health verdict is reused. */
  readonly healthTtlMs: number;
  /** The Risk snapshot's reuse window. */
  readonly riskSnapshotTtlMs: number;
  /** The protocol treasury scan's interval. */
  readonly treasuryScanIntervalMs: number;
  /** Hyperliquid and Binance funding are fetched at most this often, and only while read. */
  readonly venueFundingTtlMs: number;
  /** Perpl's market context (marks, open interest, margin parameters) is re-read at most this often. */
  readonly perplContextTtlMs: number;
}

/**
 * "https://<endpoint>.<region>.quiknode.pro/<token>/" -> "quiknode.pro". The
 * last two labels of a domain name; undefined for anything that is not one
 * (an IP, localhost, a malformed URL), rather than a guess.
 */
export function providerDomain(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (/^[0-9.]+$/.test(host) || host.includes(':') || !host.includes('.')) return undefined;
  return host.split('.').slice(-2).join('.');
}
