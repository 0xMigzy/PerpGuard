/**
 * An account's fills: the CSV and the paging rule. Pure.
 *
 * A fill records the account's ROLE (maker or taker), never its side or
 * action, and only the maker's fee: the taker's fee and realised PnL belong to
 * the position, on the round trip. So the CSV leaves those cells EMPTY rather
 * than zero, the same rule every export here follows.
 */
import type { AccountFill } from '@perpguard/shared';
import { marketName } from './markets.ts';
import { csvField } from './traders.ts';

/** Most fills the export downloads: the backend's per-request cap. Said on the button. */
export const FILLS_CSV_CAP = 10_000;

/** On screen, "Show more" adds this many, up to `FILLS_LIST_CAP`; the CSV goes further. */
export const FILLS_STEP = 50;
export const FILLS_LIST_CAP = 500;

export const FILLS_CSV_HEADER = ['time_utc', 'account_id', 'market', 'role', 'size', 'price', 'notional_ausd', 'maker_fee_ausd', 'tx_hash'] as const;

export function fillsCsv(accountId: number, fills: readonly AccountFill[]): string {
  const lines = [FILLS_CSV_HEADER.join(',')];
  for (const f of fills) {
    lines.push(
      [
        new Date(f.atMs).toISOString(),
        accountId,
        marketName(f.market),
        f.role,
        f.sizeLots,
        f.price,
        f.notionalAusd,
        f.role === 'maker' ? f.makerFeeAusd : undefined,
        f.txHash,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Whether "Show more" is offered: the backend says there is more, and the screen has room. */
export function moreFills(shown: number, hasMore: boolean): boolean {
  return hasMore && shown < FILLS_LIST_CAP;
}

export function nextFillsLimit(limit: number): number {
  return Math.min(FILLS_LIST_CAP, limit + FILLS_STEP);
}
