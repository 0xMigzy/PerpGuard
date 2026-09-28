/**
 * Entity id builders, in one place so nothing constructs an id by hand.
 *
 * This indexer is single-chain, so ids are not chain-prefixed. Adding a second
 * chain means prefixing every id here.
 */

export const exchangeId = (chainId: number): string => String(chainId);

export const marketId = (perpId: bigint): string => perpId.toString();

export const traderId = (accountId: bigint): string => accountId.toString();

export const positionId = (perpId: bigint, accountId: bigint, epoch: number): string =>
  `${perpId}-${accountId}-${epoch}`;

export const positionCursorId = (perpId: bigint, accountId: bigint): string =>
  `${perpId}-${accountId}`;

/** Feed rows are one per log, so the log's own coordinates are the id. */
export const logId = (txHash: string, logIndex: number): string => `${txHash}-${logIndex}`;

export const fundingEventId = (perpId: bigint, fundingBlock: bigint): string =>
  `${perpId}-${fundingBlock}`;

const MS_PER_DAY = 86_400_000;

/** UTC midnight of the day a block timestamp (in seconds) falls in. */
export function dayStart(blockTimestampSec: number): Date {
  return new Date(Math.floor((blockTimestampSec * 1000) / MS_PER_DAY) * MS_PER_DAY);
}

/** "YYYY-MM-DD" of a day bucket, used as the suffix of every daily id. */
export const dayKey = (day: Date): string => day.toISOString().slice(0, 10);

export const marketDayId = (perpId: bigint, day: Date): string => `${perpId}-${dayKey(day)}`;

export const traderDayId = (accountId: bigint, day: Date): string =>
  `${accountId}-${dayKey(day)}`;

export const marketDayTraderId = (perpId: bigint, day: Date, accountId: bigint): string =>
  `${perpId}-${dayKey(day)}-${accountId}`;
