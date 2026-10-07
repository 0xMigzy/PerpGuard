/**
 * THE ALERT DISTANCE (Part 2, owner, 7 Oct 2026): ONE number per account, how
 * far from liquidation a position may get before the bot says so. MANUAL mode
 * alerts at it; AUTO top-up, when a person arms it on a position, acts at the
 * SAME distance. Percent of the price, like every distance on the screens.
 *
 * Presets 2 / 3 / 5 / 8 / 10, or custom from 0.5 to 20. New accounts start at
 * 5. Accounts that chose a "Warn me at" level keep the distance of its first
 * warning (Early 10, Normal 8, Last minute 3), so nobody's alerts move under
 * them.
 */
export const ALERT_DISTANCE_PRESETS = [2, 3, 5, 8, 10] as const;
export const DEFAULT_ALERT_DISTANCE_PCT = 5;
export const MIN_ALERT_DISTANCE_PCT = 0.5;
export const MAX_ALERT_DISTANCE_PCT = 20;

/** The distance an existing "Warn me at" level warned at first. */
export const ALERT_DISTANCE_FROM_WARN_LEVEL: Readonly<Record<string, number>> = { early: 10, normal: 8, 'last-minute': 3 };

export const isAlertDistance = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= MIN_ALERT_DISTANCE_PCT && n <= MAX_ALERT_DISTANCE_PCT;

/** "4", "4%", "3.5" -> 4 / 3.5. One decimal at most. */
export function parseAlertDistance(text: string): { readonly pct: number } | { readonly error: string } {
  const m = /^\s*(\d+(?:\.\d)?)\s*%?\s*$/.exec(text);
  const v = m === null ? NaN : Number(m[1]);
  if (!isAlertDistance(v)) return { error: `Send a distance between ${MIN_ALERT_DISTANCE_PCT} and ${MAX_ALERT_DISTANCE_PCT}, like 4 or 3.5.` };
  return { pct: v };
}

/** "5%", "3.5%". */
export const distanceLabel = (pct: number): string => `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
