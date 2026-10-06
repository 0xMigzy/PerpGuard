/**
 * Indexer rows -> domain objects. Pure, and the only place scaling happens.
 *
 * Everything here exists because a row off the wire is not a number a person can
 * read, and the conversion has exactly three ways to go wrong:
 *
 *   THE WRONG DECIMALS. Money is AUSD micros, prices are in the market's own
 *   `priceDecimals`, sizes in its `lotDecimals`. None of those may be hard-coded:
 *   mainnet runs priceDecimals 1 (BTC) through 6 (MON, PUMP), so a constant that
 *   is right for BTC is wrong by five orders of magnitude for MON.
 *
 *   THE WRONG SYMBOL. Resolution is BY MARKET ID, never by name. The indexer
 *   stores what the chain said, and mainnet market 31 is `SOL_v2` there while the
 *   venue calls it `SOL`. Matching on a name silently drops that market.
 *
 *   A GUESS WHERE THERE SHOULD BE A GAP. A side we do not recognise THROWS. An
 *   entry price the indexer never saw stays undefined. A market the venue does
 *   not list resolves to an undefined symbol rather than falling back to the
 *   chain's name. Each of those is a case where the plausible-looking default is
 *   worse than the hole, because nobody can see a default.
 *
 * Postgres numerics arrive as STRINGS from node-pg, deliberately: they exceed
 * float64's exact range. So every parser here takes `string | number | bigint`
 * and goes through the integer path in `units.ts`.
 */
import { scaledToNumber, type RawAmount } from '../units.ts';
import type { Side } from '../venues/types.ts';
import type { ForcedExitKind, MarketRef, RescueVerdict } from './types.ts';

/**
 * A count column.
 *
 * Postgres `count(*)` is `bigint` and arrives as a string. A count large enough
 * to lose precision in a float would be a count of more rows than exist, so
 * `Number` is safe here in a way it is not for money.
 */
export function count(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`expected a numeric count, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** An integer column that may be null, as an exact bigint. */
export function bigintOrZero(value: unknown): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw new RangeError(`expected an integer column, got ${JSON.stringify(value)}`);
  }
  return BigInt(text);
}

/** The same, but absence stays absence. */
export function bigintOrUndefined(value: unknown): bigint | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return bigintOrZero(value);
}

/** AUSD micros -> AUSD. FLOAT BOUNDARY, and the last one: display only. */
export function toAusd(micros: unknown, collateralDecimals: number): number {
  return scaledToNumber(bigintOrZero(micros) as RawAmount, collateralDecimals);
}

/** A price in the market's own units -> a human price. */
export function toPrice(pns: unknown, priceDecimals: number): number | undefined {
  const raw = bigintOrUndefined(pns);
  return raw === undefined ? undefined : scaledToNumber(raw as RawAmount, priceDecimals);
}

/** Lots in the market's own units -> a human size. */
export function toLots(lns: unknown, lotDecimals: number): number {
  return scaledToNumber(bigintOrZero(lns) as RawAmount, lotDecimals);
}

/**
 * A funding rate, per settlement, in PERCENT.
 *
 * The contract's `ratePct100k` is the rate as a FRACTION × 100,000 ("per
 * 100k"), so 4 is 0.00004 of notional = 0.004% per settlement, and the percent
 * is the stored value ÷ 1,000. MEASURED, 6 Oct 2026, against what positions
 * actually paid: for closed positions held across exactly one settlement,
 * funding ÷ (size × funding price) ÷ (stored / 100,000) has a median of
 * 0.97-1.00 on all 11 markets (90th percentile 0.95-1.00; below 1 only where
 * a position shrank before the settlement). Until that date this divided by
 * 100,000 and called the result a percent: every rate on the site was 100×
 * too small. (The API's undocumented `funding.rate` is 10× the stored value:
 * fraction × 1,000,000.)
 */
export const FUNDING_UNITS_PER_PERCENT = 1_000;

export function fundingUnitsToPct(units: number): number {
  return units / FUNDING_UNITS_PER_PERCENT;
}

export function toRatePct(pct100k: unknown): number | undefined {
  const raw = bigintOrUndefined(pct100k);
  return raw === undefined ? undefined : fundingUnitsToPct(Number(raw));
}

/**
 * A `Timestamp` column -> epoch milliseconds.
 *
 * Envio's `Timestamp` comes back as a `Date` from node-pg, or as an ISO string
 * depending on the driver's parser settings. Both are handled; anything else
 * throws rather than becoming `NaN`, because a NaN timestamp renders as "Invalid
 * Date" in one place and sorts unpredictably everywhere else.
 */
export function toMs(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new RangeError(`expected a timestamp column, got ${JSON.stringify(value)}`);
}

/** The same, for a column that cannot be null. */
export function requireMs(value: unknown): number {
  const ms = toMs(value);
  if (ms === undefined) throw new RangeError('expected a non-null timestamp');
  return ms;
}

/**
 * The indexer's `Side` enum -> the domain `Side`.
 *
 * THROWS on anything else. It never defaults to long. The indexer writes `LONG`
 * or `SHORT` and nothing else, so an unrecognised value means the schema moved
 * under us — and a silently inverted side turns every PnL, skew and rescue figure
 * for that row into a confident lie. Same rule as `sideOf` on contract events,
 * for the same reason.
 */
export function sideFromRow(value: unknown): Side {
  if (value === 'LONG') return 'long';
  if (value === 'SHORT') return 'short';
  throw new RangeError(
    `unrecognised side ${JSON.stringify(value)}: the indexer writes LONG or SHORT. ` +
      `Refusing to guess — an inverted side corrupts every derived figure invisibly.`,
  );
}

/** The indexer's `ForcedExitKind` enum -> the domain kind. THROWS on anything else, like `sideFromRow`. */
export function forcedExitKindFromRow(value: unknown): ForcedExitKind {
  switch (value) {
    case 'LIQUIDATION':
      return 'liquidation';
    case 'BUY_TO_LIQUIDATE':
      return 'buy-to-liquidate';
    case 'DELEVERAGE':
      return 'deleverage';
    case 'UNWIND':
      return 'unwind';
    case 'UNWIND_UNPAID':
      return 'unwind-unpaid';
    default:
      throw new RangeError(`unrecognised forced exit kind ${JSON.stringify(value)}: refusing to file it under a guess.`);
  }
}

/**
 * `wasRescuable` -> a verdict. NULL IS NOT FALSE: it is a position opened before
 * the start block, and the answer is "cannot know", stated as such.
 */
export function verdictFromRow(value: unknown): RescueVerdict {
  if (value === true) return 'rescuable';
  if (value === false) return 'not-rescuable';
  if (value === null || value === undefined) return 'unknown';
  throw new RangeError(`expected a nullable boolean for wasRescuable, got ${JSON.stringify(value)}`);
}

/** Where canonical tickers come from: the venue's context, keyed by market id. */
export type SymbolResolver = (marketId: number) => string | undefined;

/**
 * Build a resolver from the venue's markets.
 *
 * KEYED ON `marketId`, and the whole point of the indirection. The context is
 * what a trader can see and touch today; the chain is the history. A market in
 * the index but absent from the context — mainnet 80, TAO — resolves to
 * undefined, which {@link toMarketRef} carries through as an explicit unknown.
 */
export function symbolResolver(
  markets: readonly { readonly marketId: number; readonly symbol: string }[],
): SymbolResolver {
  const byId = new Map(markets.map((m) => [m.marketId, m.symbol]));
  return (marketId) => byId.get(marketId);
}

/**
 * A market id plus the indexer's name -> a {@link MarketRef}.
 *
 * The indexer's name goes in `indexerName` and NEVER into `symbol`. That is the
 * guard: a caller that wants something printable calls `describeMarket`, and a
 * caller that matches on `symbol` gets undefined for an unlisted market instead of
 * a string that looks canonical and is not.
 */
export function toMarketRef(
  marketId: unknown,
  indexerName: unknown,
  resolve: SymbolResolver,
): MarketRef {
  const id = count(marketId);
  return {
    marketId: id,
    symbol: resolve(id),
    indexerName: indexerName === null || indexerName === undefined ? '' : String(indexerName),
  };
}

/**
 * The rescuable rate, over the denominator we can actually judge.
 *
 * `unknown` liquidations are positions opened before the indexer's start block.
 * They are EXCLUDED, never counted as failures: dividing by the full count would
 * understate the finding, and counting them as not-rescuable would be an
 * assertion about rows we cannot see. Undefined when nothing is judgeable, rather
 * than 0 — no data and a zero rate are different claims.
 */
export function rescueRate(
  rescuableCount: number,
  totalCount: number,
  unknownCount: number,
): { readonly judgeableCount: number; readonly rate: number | undefined } {
  const judgeableCount = Math.max(0, totalCount - unknownCount);
  return {
    judgeableCount,
    rate: judgeableCount === 0 ? undefined : rescuableCount / judgeableCount,
  };
}

/**
 * Gross profit over gross loss.
 *
 * Undefined when there are no losses: the ratio is unbounded there, and
 * `Infinity` in a UI reads as a bug rather than as a flawless record. Both inputs
 * are magnitudes.
 */
export function profitFactor(grossProfit: number, grossLoss: number): number | undefined {
  if (grossLoss <= 0) return undefined;
  return grossProfit / grossLoss;
}

/** A fraction, or undefined when the denominator is zero. */
export function share(part: number, whole: number): number | undefined {
  return whole === 0 ? undefined : part / whole;
}

/**
 * The window a timeframe covers, as epoch milliseconds.
 *
 * ROLLING FROM `nowMs`, to the millisecond. The bug this whole layer was built to
 * fix was a 24h window implemented as "day buckets since now minus 24h", which on
 * UTC-midnight buckets is between 0 and 26 hours of data depending on the time of
 * day — measured at 0.23x on mainnet at 05:04 UTC. The window is computed here,
 * once, and the SQL filters raw event timestamps with it.
 */
export function windowFor(
  timeframe: import('./types.ts').Timeframe,
  nowMs: number,
): { readonly sinceMs: number | undefined; readonly untilMs: number } {
  const span = (
    { '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000, '30d': 30 * 24 * 3_600_000, all: undefined } as const
  )[timeframe];
  return { sinceMs: span === undefined ? undefined : nowMs - span, untilMs: nowMs };
}
