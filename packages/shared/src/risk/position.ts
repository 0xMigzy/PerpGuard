/**
 * The inputs the risk engine works on, and the one place a venue's position is
 * converted into them.
 *
 * Everything below the adapter is raw integers in the market's own scaling —
 * `...PNS` prices, `...LNS` lots, `...CNS` AUSD micros — because money maths
 * must not drift. `VenuePosition` is human numbers, so `fromVenuePosition` is
 * the documented boundary between the two.
 */
import { numberToScaled } from '../units.ts';
import type { Side } from '../venues/types.ts';
import type { MarketScale } from './liquidation.ts';

/**
 * The market parameters the risk maths needs, exactly as `GET /v1/pub/context`
 * reports them.
 *
 * `maintenanceMargin` is the raw `markets[].config.maintenance_margin`:
 * hundredths of a leverage multiple, NOT a ratio. 2500 means maintained at 25x,
 * i.e. a ratio of 100/2500 = 0.04. It is per market and does not step with
 * leverage tier — BTC 2500, ETH/SOL/MON 2000, ZEC 1800, LIT/VVV/PUMP 1000 — so
 * 0.04 is a BTC fact and is never hard-coded anywhere in this engine.
 */
export interface MarketRiskConfig {
  readonly marketId: number;
  readonly symbol: string;
  readonly priceDecimals: number;
  readonly lotDecimals: number;
  /** AUSD decimals. Read from the context `tokens[]` entry, not assumed to be 6. */
  readonly collateralDecimals: number;
  /** Raw `config.maintenance_margin`. See the note above. */
  readonly maintenanceMargin: number;
  /** Raw `config.initial_margin`, which sets max leverage. */
  readonly initialMargin: number;
}

/** One isolated position, in raw integers. */
export interface RiskPosition {
  readonly marketId: number;
  readonly symbol: string;
  readonly side: Side;
  readonly lotLNS: bigint;
  readonly entryPricePNS: bigint;
  /**
   * Collateral posted to THIS position. Perpl is isolated margin: free account
   * balance is never pulled in to rescue it.
   *
   * Always the venue's reported figure, NEVER notional / leverage. On the
   * ground-truth fixture the posted margin exceeds notional / leverage by
   * 2.22 bps of notional, and what that excess is made of is still unexplained.
   */
  readonly depositCNS: bigint;
  /** Accrued funding, with the sign the venue reports. Subtracted from margin. */
  readonly fundingCNS: bigint;
}

export function scaleOf(config: MarketRiskConfig): MarketScale {
  return {
    priceDecimals: config.priceDecimals,
    lotDecimals: config.lotDecimals,
    collateralDecimals: config.collateralDecimals,
  };
}

/** `maintenance_margin` as the contract's own hundredths-of-leverage integer. */
export function maintMarginFracHdths(config: MarketRiskConfig): bigint {
  if (!Number.isInteger(config.maintenanceMargin) || config.maintenanceMargin <= 0) {
    throw new RangeError(
      `maintenance_margin must be a positive integer, got ${config.maintenanceMargin}`,
    );
  }
  return BigInt(config.maintenanceMargin);
}

/**
 * Maintenance margin as a fraction of notional: 2500 -> 0.04.
 *
 * FLOAT BOUNDARY. A ratio has no integer representation, and this value is for
 * display and for comparing against caller-supplied thresholds. No money figure
 * is ever computed from it — `maintenanceMarginCNS` divides the integer notional
 * by the integer `maintenanceMargin` instead.
 */
export function maintenanceMarginRatio(config: MarketRiskConfig): number {
  return 100 / Number(maintMarginFracHdths(config));
}

/**
 * Human numbers -> raw integers.
 *
 * FLOAT BOUNDARY, and the only one on the way in. Each field is rounded to the
 * precision the market can actually represent, so the integers below are exact
 * from here on.
 */
export function fromVenuePosition(
  position: {
    readonly marketId: number;
    readonly symbol: string;
    readonly side: Side;
    readonly size: number;
    readonly entryPrice: number;
    readonly margin: number;
    readonly fundingAccrued: number;
  },
  config: MarketRiskConfig,
): RiskPosition {
  return {
    marketId: position.marketId,
    symbol: position.symbol,
    side: position.side,
    lotLNS: numberToScaled(position.size, config.lotDecimals),
    entryPricePNS: numberToScaled(position.entryPrice, config.priceDecimals),
    depositCNS: numberToScaled(position.margin, config.collateralDecimals),
    fundingCNS: numberToScaled(position.fundingAccrued, config.collateralDecimals),
  };
}

/** A human price -> the market's own price units. FLOAT BOUNDARY. */
export function priceToPNS(price: number, config: MarketRiskConfig): bigint {
  return numberToScaled(price, config.priceDecimals);
}
