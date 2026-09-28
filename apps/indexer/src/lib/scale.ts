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
 * Where a `positionType` came from, so a failure to decode it is a two-minute
 * fix rather than an investigation.
 *
 * Every field is optional because not every event publishes every one —
 * `PositionInverted` has no account on some paths — but the block and tx
 * always come from EventMeta and are what actually locate the log.
 */
export interface SideContext {
  /** The event name, e.g. "PositionOpenedV2". */
  readonly event: string;
  readonly perpId?: bigint;
  readonly accountId?: bigint;
  readonly blockNumber?: bigint;
  readonly txHash?: string;
}

function describeSideContext(where: SideContext): string {
  const parts = [where.event];
  if (where.perpId !== undefined) parts.push(`market ${where.perpId}`);
  if (where.accountId !== undefined) parts.push(`account ${where.accountId}`);
  if (where.blockNumber !== undefined) parts.push(`block ${where.blockNumber}`);
  if (where.txHash !== undefined) parts.push(`tx ${where.txHash}`);
  return parts.join(", ");
}

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
 * An unrecognised value throws rather than falling through to SHORT, which
 * HALTS THE INDEXER. That is the intended trade: halting is recoverable,
 * because the indexer re-runs and the data is on chain either way, whereas
 * silently recording every unknown position as short corrupts open interest,
 * win rates and the whole liquidation analysis, invisibly and permanently.
 *
 * Because a halt has a real cost, the error carries everything needed to fix
 * it: the value, the market, the account, and the block and transaction the
 * log is in. Look the tx up, see what the contract actually emitted, and add
 * the case here.
 */
export function sideOf(positionType: bigint, where: SideContext): "LONG" | "SHORT" {
  if (positionType === 0n) return "LONG";
  if (positionType === 1n) return "SHORT";
  throw new RangeError(
    `unrecognised positionType ${positionType} on ${describeSideContext(where)} — ` +
      `expected 0 (LONG) or 1 (SHORT).\n` +
      `The indexer has HALTED rather than record a side it did not read: guessing ` +
      `would invert this position and silently corrupt open interest, win rates ` +
      `and the liquidation analysis.\n` +
      `To fix: look up the transaction above, confirm what the contract emitted, ` +
      `and add the case to sideOf in apps/indexer/src/lib/scale.ts. Do NOT widen ` +
      `the fallback.`,
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
