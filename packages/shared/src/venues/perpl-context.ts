import { z } from 'zod';

/**
 * Schemas for GET /v1/pub/context.
 * https://docs.perpl.xyz/resources/for-developers/api/rest.md
 *
 * Strict about the fields we read, loose about everything else: the response
 * also carries features/geo_block/rewards/competitions/incentive_tokens that we
 * ignore, and upstream should be free to add more without breaking us. A field
 * we DO read changing type must fail here rather than silently produce NaN.
 */

const int = z.number().int();

/** Block/time stamp attached to most sub-objects. */
const AtSchema = z.looseObject({
  b: int,
  t: int,
});

export const MarketConfigSchema = z.looseObject({
  is_open: z.boolean(),
  /** Decimal places for prices on this market. */
  price_decimals: int,
  /** Decimal places for sizes. */
  size_decimals: int,
  /** Hundredths of max leverage. See maxLeverageFromConfig. */
  initial_margin: int,
  /** Hundredths of the maintenance leverage. See maintenanceMarginRatioFromConfig. */
  maintenance_margin: int,
  /** Basis points. */
  maker_fee: int,
  taker_fee: int,
});

export const MarketStateSchema = z.looseObject({
  at: AtSchema,
  /** Oracle price, scaled by price_decimals. */
  orl: int,
  /** Mark price. */
  mrk: int,
  /** Last trade price. */
  lst: int,
  mid: int,
  bid: int,
  ask: int,
});

export const MarketSchema = z.looseObject({
  id: int,
  instance_id: int,
  perpetual_id: int,
  /** Empty string on every market today — do not use it. */
  symbol: z.string(),
  /** Display name. Differs by network: 'BTC' on mainnet, 'BTC Perp' on testnet. */
  name: z.string(),
  /** Canonical asset ticker, stable across networks. This is the join key. */
  size_units: z.string().min(1),
  funding_interval_sec: int,
  config: MarketConfigSchema,
  state: MarketStateSchema,
});

export const TokenSchema = z.looseObject({
  id: int,
  address: z.string(),
  symbol: z.string(),
  decimals: int,
  display_precision: int,
});

export const ProtocolInstanceSchema = z.looseObject({
  id: int,
  address: z.string(),
  collateral_token_id: int,
});

export const ChainSchema = z.looseObject({
  chain_id: int,
  name: z.string(),
});

export const ContextSchema = z.looseObject({
  chain: ChainSchema,
  instances: z.array(ProtocolInstanceSchema).min(1),
  tokens: z.array(TokenSchema).min(1),
  markets: z.array(MarketSchema),
});

export type PerplContext = z.output<typeof ContextSchema>;
export type PerplMarket = z.output<typeof MarketSchema>;
export type PerplMarketConfig = z.output<typeof MarketConfigSchema>;
export type PerplToken = z.output<typeof TokenSchema>;
export type PerplProtocolInstance = z.output<typeof ProtocolInstanceSchema>;
