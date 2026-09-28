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

/**
 * Perpl's on-chain `positionType`: 0 = LONG, 1 = SHORT. Measured over 496 real
 * mainnet round trips, not assumed from the field order.
 *
 * FOR CONTRACT EVENTS ONLY. The API wire uses a DIFFERENT encoding for the
 * same idea — `sd` 1 = Long, 2 = Short — so `1` is SHORT here and Long there.
 * Decode wire data with `sideFromWire` from @perpguard/shared and never with
 * this. The two are deliberately separate; src/tests/side-encodings.test.ts
 * asserts the asymmetry so they cannot be quietly merged.
 *
 * An unrecognised value throws rather than falling through to SHORT. Halting
 * on data we do not understand is recoverable — the indexer re-runs. Silently
 * recording every unknown position as short is not: it corrupts open interest,
 * win rates and the liquidation analysis, invisibly and permanently.
 */
export function sideOf(positionType: bigint): "LONG" | "SHORT" {
  if (positionType === 0n) return "LONG";
  if (positionType === 1n) return "SHORT";
  throw new RangeError(
    `unrecognised positionType ${positionType}; expected 0 (LONG) or 1 (SHORT)`,
  );
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
