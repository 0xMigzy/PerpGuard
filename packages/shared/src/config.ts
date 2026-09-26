import { ConfigError } from './errors.ts';

export const NETWORKS = ['mainnet', 'testnet'] as const;
export type NetworkName = (typeof NETWORKS)[number];

export const CHAIN_IDS: Record<NetworkName, number> = {
  mainnet: 143,
  testnet: 10143,
};

export interface NetworkConfig {
  readonly name: NetworkName;
  readonly chainId: number;
  /** e.g. https://app.perpl.xyz/api — no trailing slash. */
  readonly restBaseUrl: string;
  /** Public market-data websocket. */
  readonly marketDataWsUrl: string;
  /** Authenticated trading websocket. */
  readonly tradingWsUrl: string;
  readonly rpcUrl: string;
  readonly exchangeAddress: string;
  readonly collateralAddress: string;
  /** Fallback only. Prefer the value from GET /v1/pub/context tokens[]. */
  readonly collateralDecimals: number;
}

export interface AppConfig {
  /** Read-only analytics network. Mainnet by default, so the demo shows real data. */
  readonly analytics: NetworkConfig;
  /** Network all trading actions run against. Testnet by default. */
  readonly trading: NetworkConfig;
  /** Price data older than this is never acted on. */
  readonly staleMs: number;
}

/**
 * Values published at
 * https://docs.perpl.xyz/resources/for-developers/networks-and-configuration.md
 *
 * These exist ONLY so the read-only demo runs without a .env. Every field is
 * overridable per network by env var, and `loadAppConfig(env, { strict: true })`
 * refuses to fall back to this table at all — use strict mode anywhere that
 * signs or sends a transaction.
 */
const DOC_DEFAULTS: Record<NetworkName, Omit<NetworkConfig, 'name'>> = {
  mainnet: {
    chainId: 143,
    restBaseUrl: 'https://app.perpl.xyz/api',
    marketDataWsUrl: 'wss://app.perpl.xyz/ws/v1/market-data',
    tradingWsUrl: 'wss://app.perpl.xyz/ws/v1/trading',
    rpcUrl: 'https://rpc.monad.xyz',
    exchangeAddress: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
    collateralAddress: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
    collateralDecimals: 6,
  },
  testnet: {
    chainId: 10143,
    restBaseUrl: 'https://testnet.perpl.xyz/api',
    marketDataWsUrl: 'wss://testnet.perpl.xyz/ws/v1/market-data',
    tradingWsUrl: 'wss://testnet.perpl.xyz/ws/v1/trading',
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    exchangeAddress: '0x1964C32f0bE608E7D29302AFF5E61268E72080cc',
    collateralAddress: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
    collateralDecimals: 6,
  },
};

export const DEFAULT_STALE_MS = 10_000;

/** A read-only view of the environment. Injected so config loading stays pure. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface LoadOptions {
  /**
   * When true, every network field must come from the environment. Missing
   * vars raise a ConfigError naming all of them at once.
   */
  readonly strict?: boolean;
}

const envPrefix = (name: NetworkName): string => `PERPL_${name.toUpperCase()}`;

/** Env var names read for a network, in the order they appear in NetworkConfig. */
export function envVarNames(name: NetworkName): string[] {
  const p = envPrefix(name);
  return [
    `${p}_CHAIN_ID`,
    `${p}_REST_URL`,
    `${p}_WS_MARKET_DATA_URL`,
    `${p}_WS_TRADING_URL`,
    `${p}_RPC_URL`,
    `${p}_EXCHANGE`,
    `${p}_COLLATERAL`,
    `${p}_COLLATERAL_DECIMALS`,
  ];
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function parseIntStrict(raw: string, varName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`${varName} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Build the config for one network. Env always wins; DOC_DEFAULTS fills the
 * gaps unless `strict`.
 */
export function loadNetworkConfig(
  name: NetworkName,
  env: Env,
  options: LoadOptions = {},
): NetworkConfig {
  const defaults = DOC_DEFAULTS[name];
  const missing: string[] = [];

  const read = (varName: string): string | undefined => {
    const raw = env[varName]?.trim();
    if (raw !== undefined && raw !== '') return raw;
    if (options.strict === true) missing.push(varName);
    return undefined;
  };

  const p = envPrefix(name);
  const chainIdRaw = read(`${p}_CHAIN_ID`);
  const restBaseUrl = read(`${p}_REST_URL`);
  const marketDataWsUrl = read(`${p}_WS_MARKET_DATA_URL`);
  const tradingWsUrl = read(`${p}_WS_TRADING_URL`);
  const rpcUrl = read(`${p}_RPC_URL`);
  const exchangeAddress = read(`${p}_EXCHANGE`);
  const collateralAddress = read(`${p}_COLLATERAL`);
  const collateralDecimalsRaw = read(`${p}_COLLATERAL_DECIMALS`);

  if (missing.length > 0) {
    throw new ConfigError(
      `strict config for ${name} is missing required env vars: ${missing.join(', ')}`,
    );
  }

  const chainId =
    chainIdRaw === undefined
      ? defaults.chainId
      : parseIntStrict(chainIdRaw, `${p}_CHAIN_ID`);

  // A chain id that disagrees with the network name means an override went to
  // the wrong place. Fail here rather than signing against the wrong chain.
  if (chainId !== CHAIN_IDS[name]) {
    throw new ConfigError(
      `${p}_CHAIN_ID is ${chainId} but ${name} is chain ${CHAIN_IDS[name]}`,
    );
  }

  return {
    name,
    chainId,
    restBaseUrl: stripTrailingSlash(restBaseUrl ?? defaults.restBaseUrl),
    marketDataWsUrl: stripTrailingSlash(marketDataWsUrl ?? defaults.marketDataWsUrl),
    tradingWsUrl: stripTrailingSlash(tradingWsUrl ?? defaults.tradingWsUrl),
    rpcUrl: stripTrailingSlash(rpcUrl ?? defaults.rpcUrl),
    exchangeAddress: exchangeAddress ?? defaults.exchangeAddress,
    collateralAddress: collateralAddress ?? defaults.collateralAddress,
    collateralDecimals:
      collateralDecimalsRaw === undefined
        ? defaults.collateralDecimals
        : parseIntStrict(collateralDecimalsRaw, `${p}_COLLATERAL_DECIMALS`),
  };
}

function parseNetworkName(raw: string | undefined, varName: string, fallback: NetworkName): NetworkName {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  const match = NETWORKS.find((n) => n === value);
  if (match === undefined) {
    throw new ConfigError(
      `${varName} must be one of ${NETWORKS.join(' | ')}, got ${JSON.stringify(raw)}`,
    );
  }
  return match;
}

/**
 * Resolve the whole app config from the environment.
 *
 * Defaults follow the project rule: analytics read from mainnet so the demo
 * shows real data, trading actions go to testnet. Both are selectable via
 * ANALYTICS_NETWORK / TRADING_NETWORK.
 */
export function loadAppConfig(env: Env, options: LoadOptions = {}): AppConfig {
  const analyticsNetwork = parseNetworkName(env['ANALYTICS_NETWORK'], 'ANALYTICS_NETWORK', 'mainnet');
  const tradingNetwork = parseNetworkName(env['TRADING_NETWORK'], 'TRADING_NETWORK', 'testnet');

  const staleRaw = env['STALE_MS']?.trim();
  const staleMs = staleRaw === undefined || staleRaw === '' ? DEFAULT_STALE_MS : parseIntStrict(staleRaw, 'STALE_MS');
  if (staleMs <= 0) throw new ConfigError(`STALE_MS must be positive, got ${staleMs}`);

  return {
    analytics: loadNetworkConfig(analyticsNetwork, env, options),
    trading: loadNetworkConfig(tradingNetwork, env, options),
    staleMs,
  };
}
