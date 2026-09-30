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
  /** Mark price 24h ago, same scaling as `mrk`. */
  prv: int,
  /**
   * Open interest, in the market's SIZE units (scaled by `size_decimals`), the
   * same scaling as `dv`, which the docs call "Daily volume (size)". This is
   * the LEVEL the indexer cannot produce: it starts partway through history, so
   * its own figure is a delta. Read this for the absolute number.
   */
  oi: int,
  /** Daily traded amount in collateral micros, as a decimal string. */
  dva: z.string(),
});

export const MarketSchema = z.looseObject({
  id: int,
  instance_id: int,
  perpetual_id: int,
  /**
   * Upper bound on how far past the head block an order's `lb` may reach.
   * 20 on testnet BTC — about ten seconds of Monad blocks, so a resting test
   * order expires on its own well before a human would notice.
   */
  order_ttl_blocks: int,
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
  /**
   * Gas stats, which also carry `h`, the head block. Optional because we only
   * use it to seed `lb` before the first websocket heartbeat arrives, and a
   * missing field must not break every read of the context.
   */
  gas: z
    .looseObject({
      h: int.optional(),
      at: AtSchema.optional(),
    })
    .optional(),
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
