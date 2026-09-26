/**
 * Unit conversion for Perpl's scaled-integer wire format.
 *
 * Every numeric field on the wire is an integer plus a decimals exponent that
 * lives in market config. Nothing here may hard-code an exponent: callers pass
 * the decimals they read from GET /v1/pub/context.
 *
 * All functions are pure, with no I/O.
 */

/** Raw on-chain/wire amounts arrive as integers, sometimes as decimal strings. */
export type RawAmount = bigint | number | string;

const DIGITS = /^-?\d+$/;

function toBigInt(raw: RawAmount, label: string): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) {
      throw new RangeError(`${label} must be an integer, got ${raw}`);
    }
    return BigInt(raw);
  }
  const trimmed = raw.trim();
  if (!DIGITS.test(trimmed)) {
    throw new RangeError(`${label} must be an integer string, got ${JSON.stringify(raw)}`);
  }
  return BigInt(trimmed);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new RangeError(`decimals must be an integer in 0..30, got ${decimals}`);
  }
}

/**
 * Scaled integer -> human number. `decimals` is a count of decimal places, so
 * this divides: 839877 at 1 decimal is 83987.7.
 *
 * Goes via a decimal string rather than dividing by 10**decimals so the result
 * is the nearest double to the exact decimal value, not to a float quotient.
 */
export function scaledToNumber(raw: RawAmount, decimals: number): number {
  assertDecimals(decimals);
  const value = toBigInt(raw, 'raw amount');
  if (decimals === 0) return Number(value);

  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  return Number(`${negative ? '-' : ''}${whole}.${frac}`);
}

/**
 * Human number -> scaled integer, rounding to the representable precision.
 * Round-trips with scaledToNumber for any value the venue can represent.
 */
export function numberToScaled(value: number, decimals: number): bigint {
  assertDecimals(decimals);
  if (!Number.isFinite(value)) {
    throw new RangeError(`value must be finite, got ${value}`);
  }
  // toFixed rounds for us; stripping the point then yields the scaled integer.
  const fixed = value.toFixed(decimals);
  const negative = fixed.startsWith('-');
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [whole = '0', frac = ''] = unsigned.split('.');
  const digits = `${whole}${frac.padEnd(decimals, '0')}`;
  const magnitude = BigInt(digits === '' ? '0' : digits);
  return negative ? -magnitude : magnitude;
}

/** Anything carrying the two scaling exponents from market config. */
export interface Scaling {
  readonly priceDecimals: number;
  readonly sizeDecimals: number;
}

export function priceFromRaw(raw: RawAmount, scaling: Scaling): number {
  return scaledToNumber(raw, scaling.priceDecimals);
}

export function priceToRaw(price: number, scaling: Scaling): bigint {
  return numberToScaled(price, scaling.priceDecimals);
}

export function sizeFromRaw(raw: RawAmount, scaling: Scaling): number {
  return scaledToNumber(raw, scaling.sizeDecimals);
}

export function sizeToRaw(size: number, scaling: Scaling): bigint {
  return numberToScaled(size, scaling.sizeDecimals);
}

/**
 * Collateral is AUSD. Decimals come from the context `tokens[]` entry rather
 * than being assumed, though it is 6 on both networks today:
 * raw 100000000 is 100.0 AUSD.
 */
export function ausdFromRaw(raw: RawAmount, decimals: number): number {
  return scaledToNumber(raw, decimals);
}

export function ausdToRaw(value: number, decimals: number): bigint {
  return numberToScaled(value, decimals);
}

/** Display-only. Two decimal places, matching the token's display_precision. */
export function formatAusd(value: number, displayPrecision = 2): string {
  return `${value.toFixed(displayPrecision)} AUSD`;
}

/**
 * Fee fields (`maker_fee`, `taker_fee`) are Micros — 10^-6 fractions — per the
 * docs' type glossary, NOT basis points. `taker_fee: 345` is 0.0345%, i.e.
 * 3.45 bps. Reading it as bps overstates fees by 1000x.
 * https://docs.perpl.xyz/resources/for-developers/api/types-and-errors.md
 */
export function microsToFraction(micros: number): number {
  return micros / 1_000_000;
}

export function fractionToMicros(fraction: number): number {
  return fraction * 1_000_000;
}

/** Micros to basis points, for display: 345 micros is 3.45 bps. */
export function microsToBps(micros: number): number {
  return micros / 100;
}

export function bpsToFraction(bps: number): number {
  return bps / 10_000;
}

export function fractionToBps(fraction: number): number {
  return fraction * 10_000;
}

/**
 * Market config encodes margin requirements as a leverage multiple in
 * hundredths, NOT as a ratio:
 *
 *   initial_margin: 1500     -> 15x max leverage      -> 6.67% initial margin
 *   maintenance_margin: 2500 -> maintained at 25x     -> 4.00% maintenance margin
 *
 * The docs' type glossary says margins and ratios use `Fraction`, which is
 * hundredths, so the raw ints divide by 100 to give 15 and 25:
 * https://docs.perpl.xyz/resources/for-developers/api/types-and-errors.md
 *
 * Two independent checks agree. `maintenance_margin` exceeds `initial_margin`
 * on every market, so neither field can itself be a ratio. And BTC mainnet
 * carries 1500/2500 while fixtures/position1.json derives mmr = 0.04 from a real
 * BTC position at exactly 15x. venues/perpl.test.ts asserts that match, so this
 * fails loudly if it ever stops holding.
 */
export function maxLeverageFromConfig(initialMargin: number): number {
  if (initialMargin <= 0) {
    throw new RangeError(`initial_margin must be positive, got ${initialMargin}`);
  }
  return initialMargin / 100;
}

/** Initial margin as a fraction of notional, i.e. 1 / maxLeverage. */
export function initialMarginRatioFromConfig(initialMargin: number): number {
  return 1 / maxLeverageFromConfig(initialMargin);
}

/** Maintenance margin as a fraction of notional. See maxLeverageFromConfig. */
export function maintenanceMarginRatioFromConfig(maintenanceMargin: number): number {
  if (maintenanceMargin <= 0) {
    throw new RangeError(`maintenance_margin must be positive, got ${maintenanceMargin}`);
  }
  return 100 / maintenanceMargin;
}
