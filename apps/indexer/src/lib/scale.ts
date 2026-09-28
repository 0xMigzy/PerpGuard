/**
 * Bridge between the contract's raw integers and the shared risk maths.
 *
 * The scaling exponents are per market and are read from chain, never
 * hard-coded — see CLAUDE.md. Collateral is AUSD; its decimals come off the
 * Exchange entity, which reads them from `ExchangeInitialized` or from
 * `getExchangeInfo()` at bootstrap.
 */
import type { Market } from "envio";
import { type MarketScale, notionalCNS, type Side } from "@perpguard/shared/risk";

/** Perpl's on-chain `positionType`: 0 = LONG, 1 = SHORT. Measured, not assumed. */
export function sideOf(positionType: bigint): "LONG" | "SHORT" {
  return positionType === 0n ? "LONG" : "SHORT";
}

export const flipSide = (side: "LONG" | "SHORT"): "LONG" | "SHORT" =>
  side === "LONG" ? "SHORT" : "LONG";

/** The GraphQL enum is uppercase; the shared risk maths uses the venue-agnostic Side. */
export const toRiskSide = (side: "LONG" | "SHORT"): Side =>
  side === "LONG" ? "long" : "short";

export function scaleOf(market: Market, collateralDecimals: number): MarketScale {
  return {
    priceDecimals: market.priceDecimals,
    lotDecimals: market.lotDecimals,
    collateralDecimals,
  };
}

/** price * lots, in AUSD micros, at this market's scaling. */
export function notional(
  market: Market,
  collateralDecimals: number,
  pricePNS: bigint,
  lotLNS: bigint,
): bigint {
  return notionalCNS(pricePNS, lotLNS, scaleOf(market, collateralDecimals));
}

export const abs = (v: bigint): bigint => (v < 0n ? -v : v);
