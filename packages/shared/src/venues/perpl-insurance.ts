/**
 * Per-market insurance fund, read off the Exchange contract.
 *
 * ONE `eth_call` PER MARKET to `getPerpetualInfoV2(perpId)`, which returns the
 * `PerpetualInfoV2` struct. Only three words of it are read: the insurance
 * balance, the position balance (collateral posted to positions on that
 * market) and the mark. Nothing indexed carries the insurance LEVEL — the
 * indexer sees credits to it on liquidations, never the balance — so this is a
 * chain read, like TVL, and it lives in `venues/` because the struct layout is
 * Perpl's.
 *
 * DECODED BY WORD INDEX, NOT BY ABI LIBRARY. The struct's first two members
 * are dynamic strings, so their head slots hold offsets and every static
 * member sits at a fixed word after them. Word 0 is the tuple offset; the head
 * begins at word 1. Measured on mainnet and pinned by the test against a
 * captured reply. Both `getPerpetualInfo` and its V2 share this head layout;
 * V2 is called because it is the current form.
 */

/** keccak256("getPerpetualInfoV2(uint256)")[0..4]. Checked against the ABI in the test. */
export const GET_PERPETUAL_INFO_V2_SELECTOR = '0x9b335b9e';

/** Word indexes into the reply, counting the tuple-offset word as 0. */
const WORD = {
  positionBalanceCNS: 10,
  insuranceBalanceCNS: 11,
  markPNS: 12,
  markTimestampSec: 13,
  longOpenInterestLNS: 18,
  shortOpenInterestLNS: 19,
} as const;

export interface MarketInsuranceReading {
  readonly marketId: number;
  /** The insurance fund for this market, in collateral micros. */
  readonly insuranceBalanceCNS: bigint;
  /** Collateral posted to open positions on this market, in micros. */
  readonly positionBalanceCNS: bigint;
  /** The contract's mark, in the market's own price units. */
  readonly markPNS: bigint;
  readonly markAtMs: number;
  readonly longOpenInterestLNS: bigint;
  readonly shortOpenInterestLNS: bigint;
}

export type MarketInsuranceLookup =
  | { readonly found: true; readonly reading: MarketInsuranceReading }
  | { readonly found: false; readonly marketId: number; readonly reason: string };

export interface InsuranceLookupOptions {
  readonly rpcUrl: string;
  readonly exchangeAddress: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function readMarketInsurance(marketId: number, options: InsuranceLookupOptions): Promise<MarketInsuranceLookup> {
  if (!Number.isSafeInteger(marketId) || marketId < 0) {
    return { found: false, marketId, reason: `${marketId} is not a market id` };
  }
  const data = `${GET_PERPETUAL_INFO_V2_SELECTOR}${marketId.toString(16).padStart(64, '0')}`;
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: options.exchangeAddress, data }, 'latest'] }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    if (!response.ok) return { found: false, marketId, reason: `the RPC answered ${response.status}` };
    const json = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error !== undefined) {
      return { found: false, marketId, reason: `the Exchange reverted: ${json.error.message ?? 'no such market'}` };
    }
    return decodeMarketInsurance(json.result, marketId);
  } catch (error) {
    return { found: false, marketId, reason: `could not reach the RPC: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The fixed words of the struct. Exported for the tests. */
export function decodeMarketInsurance(result: unknown, marketId: number): MarketInsuranceLookup {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) {
    return { found: false, marketId, reason: `the RPC returned ${JSON.stringify(result)}, which is not hex` };
  }
  const body = result.slice(2);
  const needed = (WORD.shortOpenInterestLNS + 1) * 64;
  if (body.length < needed) {
    return { found: false, marketId, reason: `the RPC returned ${body.length / 2} bytes, fewer than the ${needed / 2} the struct head needs` };
  }
  const word = (i: number): bigint => BigInt(`0x${body.slice(i * 64, i * 64 + 64)}`);
  // The first word must be the offset to the tuple (0x20): anything else is
  // not this struct, and reading balances off it would be reading noise.
  if (word(0) !== 32n) {
    return { found: false, marketId, reason: `the reply does not start with a tuple offset (got ${word(0)}), so it is not a PerpetualInfo struct` };
  }
  return {
    found: true,
    reading: {
      marketId,
      insuranceBalanceCNS: word(WORD.insuranceBalanceCNS),
      positionBalanceCNS: word(WORD.positionBalanceCNS),
      markPNS: word(WORD.markPNS),
      markAtMs: Number(word(WORD.markTimestampSec)) * 1000,
      longOpenInterestLNS: word(WORD.longOpenInterestLNS),
      shortOpenInterestLNS: word(WORD.shortOpenInterestLNS),
    },
  };
}
