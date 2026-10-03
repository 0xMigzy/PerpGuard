/**
 * The figures the footer's "Data & methodology" note quotes.
 *
 * Static on purpose: the note is a reading of how the numbers are made, not a
 * live panel. Each figure here is pinned by `methodology.test.ts` to the code or
 * the fixture it came from, so the prose cannot drift from what is served.
 */

/** The Exchange proxy on Monad mainnet: the only contract the index reads. */
export const EXCHANGE_MAINNET = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
/** The Exchange's deployment block, where the index starts. */
export const INDEX_START_BLOCK = 54_773_010;
export const INDEX_START_LABEL = 'Feb 11, 2026';

/** Mirrors `MIN_ROUND_TRIPS_FOR_RATIOS` in packages/shared; the test holds them equal. */
export const RATIO_FLOOR = 10;

/** The skew proof, read off `fixtures/open-positions-mainnet.json`; the test re-derives it. */
export const SKEW_PROOF = {
  block: 110_176_799,
  market: 'BTC',
  marketId: 1,
  lots: 887_454,
  lotDecimals: 5,
  longs: 153,
  shorts: 112,
} as const;

export const METHODOLOGY_DOC_URL = 'https://github.com/0xMigzy/PerpGuard/blob/main/docs/methodology.md';
