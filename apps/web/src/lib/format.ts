/**
 * Formatting, and nothing else. No I/O, no React. Every rule the pages share
 * about how a number is shown lives here so it is shown the same way everywhere.
 *
 * MONEY NEVER GOES THROUGH `Number()` WHEN IT ARRIVES AS A STRING. The API sends
 * exact collateral micros as decimal strings alongside its float display
 * figures; `formatDecimalString` renders those by splitting the text, so a
 * figure past float64's exact range comes out as the digits it was.
 */

const EN = 'en-US';

/** Grouped, fixed decimals. For AUSD figures the API already serves as floats. */
export function formatAusd(value: number, decimals = 2): string {
  return value.toLocaleString(EN, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Up to six decimals, no padding: the exact figure for a hover. */
export function formatAusdExact(value: number): string {
  return value.toLocaleString(EN, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/**
 * A tile figure: compact above a million, so "16.45M" rather than a wall of
 * digits, and full 2dp below it. The exact figure goes on hover.
 */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toLocaleString(EN, { maximumFractionDigits: 2 })}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toLocaleString(EN, { maximumFractionDigits: 2 })}M`;
  if (abs >= 1e4) return `${sign}${(abs / 1e3).toLocaleString(EN, { maximumFractionDigits: 1 })}K`;
  return `${sign}${formatAusd(abs)}`;
}

/**
 * Compact dollars, at most two decimals: $5.31M, $428.52K, $146.5. FLOORED, not
 * rounded: it prints a LOSS, and a figure that rounds up claims more than
 * happened. AUSD is a dollar stablecoin, so $ is the unit.
 */
export function formatUsdCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const floor2 = (v: number) => Math.floor(v * 100 + 1e-9) / 100;
  const [div, suffix] = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  const shown = floor2(abs / div).toLocaleString(EN, suffix === '' ? { maximumFractionDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${shown}${suffix}`;
}

/** An integer count, grouped. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString(EN);
}

/** A price at the market's own precision. Never a hard-coded number of places. */
export function formatPrice(value: number, priceDecimals: number): string {
  return value.toLocaleString(EN, {
    minimumFractionDigits: priceDecimals,
    maximumFractionDigits: priceDecimals,
  });
}

/** A signed percentage, e.g. "+22.7%" or "−4.8%". The minus is a real minus sign. */
export function formatSignedPct(fraction: number, decimals = 1): string {
  const pct = fraction * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toLocaleString(EN, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`;
}

/** An unsigned percentage, e.g. "74.4%". */
export function formatPct(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toLocaleString(EN, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`;
}

/** A signed AUSD amount for a flow: "+55,022.10" / "−33,958.00". */
export function formatSignedAusd(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatAusd(Math.abs(value), decimals)}`;
}

/**
 * A decimal STRING, grouped, without ever parsing it as a float.
 *
 * `decimals` truncates (never rounds) the fraction for display; pass undefined
 * to show every digit. Truncation is deliberate: a display of an exact amount
 * must never print a digit the amount does not have.
 */
export function formatDecimalString(text: string, decimals?: number): string {
  const trimmed = text.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(unsigned)) return text;
  const [whole, fraction = ''] = unsigned.split('.') as [string, string?];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const shown =
    decimals === undefined ? fraction : fraction.slice(0, decimals).padEnd(decimals, '0');
  const body = shown.length === 0 ? grouped : `${grouped}.${shown}`;
  return negative ? `−${body}` : body;
}

/** Collateral micros as a decimal string -> an AUSD decimal string, exactly. */
export function microsToAusdString(micros: string, collateralDecimals: number): string {
  const trimmed = micros.trim();
  const negative = trimmed.startsWith('-');
  const digits = (negative ? trimmed.slice(1) : trimmed).replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(digits)) return micros;
  const padded = digits.padStart(collateralDecimals + 1, '0');
  const whole = padded.slice(0, padded.length - collateralDecimals);
  const fraction = padded.slice(padded.length - collateralDecimals);
  const body = collateralDecimals === 0 ? whole : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/** "16 Sep" for a chart axis. UTC, because the buckets are UTC days. */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(EN, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "16 Sep 2026" for a tooltip. */
export function formatDayLong(ms: number): string {
  return new Date(ms).toLocaleDateString(EN, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "14 Sep · 03:12" in UTC for a table row. */
export function formatWhen(ms: number): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString(EN, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = date.toLocaleTimeString(EN, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${day} · ${time}`;
}

/** How old something is, in the coarsest unit that still says something. */
export function formatAge(ms: number): string {
  // NEVER NEGATIVE. Callers pass Date.now() − a server timestamp, so a visitor
  // whose clock runs behind sees a timestamp "in the future"; that is skew, not
  // news, and it must not print as "−1386000 ms ago".
  if (!(ms >= 0)) return 'under 1 s';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toLocaleString(EN, { maximumFractionDigits: 1 })} h`;
  return `${(ms / 86_400_000).toLocaleString(EN, { maximumFractionDigits: 1 })} d`;
}

/**
 * Roughly how far behind in TIME a block lag is. Monad blocks are ~300 ms, so
 * this is an estimate for a sentence, never a figure anything acts on.
 */
export function blocksToApproxMs(blocks: number): number {
  return blocks * 300;
}

/** "0x8310…f3aC" for a heading. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * A price at the precision the API SERVED it, up to six places. The market's
 * own price decimals are not on the analytics payloads, and the float the API
 * sends already carries them (83225.3, 0.026889), so rendering the digits it
 * has is the honest choice; padding would invent precision.
 */
export function formatPriceAsServed(value: number): string {
  return value.toLocaleString(EN, { maximumFractionDigits: 6 });
}

/** A funding rate in PERCENT units, signed, to six places: real values are that small. */
export function formatFundingPct(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  // A settled rate is a whole number of 0.00001%, but a MEAN over a day or week is
  // not: one that is non-zero yet rounds to nothing says so, rather than printing
  // a signed zero that reads as a rate of exactly 0.
  if (pct !== 0 && Math.abs(pct) < 0.0000005) return `${sign}<0.000001%`;
  return `${sign}${Math.abs(pct).toLocaleString(EN, { minimumFractionDigits: 6, maximumFractionDigits: 6 })}%`;
}

/** A duration as "3h 12m", "45s", "2d 4h": two units at most, the largest first. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** A multiple, "187×" or "1.4×": one decimal only below 10, where it still says something. */
export function formatMultiple(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return ratio >= 10 ? `${Math.round(ratio).toLocaleString(EN)}×` : `${ratio.toFixed(1)}×`;
}
