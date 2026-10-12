/**
 * WHICH NETWORK THIS SITE'S BOT ACTS ON (12 Oct 2026). Two deployments, one
 * codebase: perpguard.app with @PerpGuardBot on MAINNET, and
 * testnet.perpguard.app with @PerpGuardTestnetBot on TESTNET. Each is its own
 * Vercel project and sets `NEXT_PUBLIC_TRADING_NETWORK` at build time; every
 * sentence that names the acting network, its chain, its Perpl site or its bot
 * reads from here, so the two sites cannot drift into different wording.
 *
 * Unset is TESTNET: what the one deployment was until the split, so a build
 * with no setting says nothing false. The ANALYTICS are mainnet on both sites.
 *
 * The chain ids and RPCs are Monad's public values, the same as
 * `packages/shared/src/config.ts` (whose root the browser bundle cannot import).
 */
export type TradingNetwork = 'mainnet' | 'testnet';

export function tradingNetworkFrom(value: string | undefined): TradingNetwork {
  return value?.trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
}

export interface NetworkFacts {
  readonly network: TradingNetwork;
  /** "Monad mainnet" / "Monad testnet". */
  readonly chainName: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  /** Perpl's own site for this network, without the scheme. */
  readonly perplSite: string;
  /** "Real funds" / "Test funds only". */
  readonly funds: string;
  readonly botHandle: string;
  readonly botUrl: string;
  /** This deployment's own site. */
  readonly siteUrl: string;
}

const FACTS: Readonly<Record<TradingNetwork, NetworkFacts>> = {
  mainnet: {
    network: 'mainnet',
    chainName: 'Monad mainnet',
    chainId: 143,
    rpcUrl: 'https://rpc.monad.xyz',
    perplSite: 'app.perpl.xyz',
    funds: 'Real funds',
    botHandle: '@PerpGuardBot',
    botUrl: 'https://t.me/PerpGuardBot',
    siteUrl: 'https://perpguard.app',
  },
  testnet: {
    network: 'testnet',
    chainName: 'Monad testnet',
    chainId: 10143,
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    perplSite: 'testnet.perpl.xyz',
    funds: 'Test funds only',
    botHandle: '@PerpGuardTestnetBot',
    botUrl: 'https://t.me/PerpGuardTestnetBot',
    siteUrl: 'https://testnet.perpguard.app',
  },
};

export const networkFacts = (network: TradingNetwork): NetworkFacts => FACTS[network];
export const otherNetwork = (network: TradingNetwork): TradingNetwork => (network === 'mainnet' ? 'testnet' : 'mainnet');

/** This build's network. */
export const TRADING: NetworkFacts = FACTS[tradingNetworkFrom(process.env['NEXT_PUBLIC_TRADING_NETWORK'])];
/** The other deployment: where someone whose account is on the other network should go. */
export const PEER: NetworkFacts = FACTS[otherNetwork(TRADING.network)];

/** The one line under the heading on Overview and /bot. */
export const networkSplit = (n: NetworkFacts): string => `Analytics: Monad mainnet, every block since launch. Actions: ${n.chainName}.`;
