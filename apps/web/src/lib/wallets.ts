/**
 * Pure helpers for the wallet pages. No I/O, no React, unit tested.
 */
import type { RoundTrip } from '@perpguard/shared';

/** What a search box was given: an address, an account id, or neither. */
export type WalletQuery =
  | { readonly kind: 'address'; readonly address: string }
  | { readonly kind: 'account'; readonly accountId: number }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Addresses are accepted IN ANY CASE (CLAUDE.md): a block explorer hands the
 * user a checksummed one and the backend compares case-insensitively. A bare
 * run of digits is an account id, which is the handle that works when the
 * owner was never recorded. Anything else is refused with a reason rather
 * than sent as a lookup that could only come back empty.
 */
export function parseWalletQuery(raw: string): WalletQuery {
  const q = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { kind: 'address', address: q };
  if (/^\d{1,12}$/.test(q)) return { kind: 'account', accountId: Number(q) };
  if (/^0x/i.test(q)) return { kind: 'invalid', reason: 'an address is 0x followed by 40 hex characters' };
  return { kind: 'invalid', reason: 'enter a 0x address or a numeric account id' };
}

/**
 * Cumulative net PnL over round trips, OLDEST FIRST, for a sparkline.
 *
 * The API serves round trips most recent first, so the list is reversed here.
 * The curve is only over the trips loaded, and it starts at zero, so it reads
 * as "how the last N went", never as the account's lifetime.
 */
export function cumulativePnl(roundTrips: readonly RoundTrip[]): readonly number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = roundTrips.length - 1; i >= 0; i -= 1) {
    total += roundTrips[i]!.netPnlAusd;
    out.push(total);
  }
  return out;
}

/** The buffer as a UI verdict. Negative is PAST liquidation, not a small buffer. */
export function bufferTier(liqBufferPct: number | undefined): 'past' | 'danger' | 'watch' | 'safe' | 'unknown' {
  if (liqBufferPct === undefined) return 'unknown';
  if (liqBufferPct < 0) return 'past';
  if (liqBufferPct < 0.03) return 'danger';
  if (liqBufferPct < 0.08) return 'watch';
  return 'safe';
}
