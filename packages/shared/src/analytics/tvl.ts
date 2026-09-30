/**
 * Total value locked: the collateral token's balance of the Exchange proxy.
 *
 * ONE `eth_call`, AND A CHAIN READ RATHER THAN AN INDEXER READ. That distinction
 * is the reason this file exists at all. Deposits and withdrawals ARE indexed, but
 * accounts held collateral before the indexer's start block, so the net over our
 * window is a FLOW and on mainnet it is negative — 1,183,018 deposited against
 * 2,435,946 withdrawn. Summing what we can see and calling it a level would be
 * wrong by however much was already there.
 *
 * `balanceOf` sidesteps the whole problem: it is the current truth regardless of
 * when we started watching. So the two figures stay side by side and answer
 * different questions — {@link CollateralFlowStats} is "what moved in this
 * window", this is "what is in there now".
 *
 * NO NEW DEPENDENCY. `balanceOf(address)` is a four-byte selector and one padded
 * argument, and the reply is a single 32-byte word. Pulling in an ABI library to
 * encode 36 bytes would be the larger cost, and `packages/shared` stays free of a
 * chain client.
 *
 * THE PROXY, NOT THE IMPLEMENTATION. Collateral sits in the proxy's storage
 * because that is the address users transfer to; the implementation holds nothing.
 * Same rule as indexing events from the proxy.
 */

/** `balanceOf(address)`. keccak256("balanceOf(address)")[0..4]. */
const BALANCE_OF_SELECTOR = '0x70a08231';

/** An EVM address, checked before it is padded into calldata. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface TvlProbeOptions {
  readonly rpcUrl: string;
  /** The ERC-20 holding collateral — AUSD. From the indexer's Exchange row. */
  readonly tokenAddress: string;
  /** The Exchange PROXY. Collateral sits here, never in the implementation. */
  readonly exchangeAddress: string;
  readonly collateralDecimals: number;
  /**
   * How long a reading stays fresh.
   *
   * SHORT, because TVL is a level and a stale level is a wrong number rather than
   * an old one. Long enough that a dashboard refresh does not hit the RPC on every
   * request — the figure moves on deposits and withdrawals, which on mainnet is a
   * few thousand events in a month.
   */
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * A TVL reading.
 *
 * `known: false` IS A FIRST-CLASS ANSWER, and it is never zero. An RPC that timed
 * out and a treasury that is empty are different facts, and zero is the one a
 * dashboard would render as a headline figure without hesitating.
 */
export type TvlReading =
  | {
      readonly known: true;
      readonly totalValueLockedAusd: number;
      /** Exact micros, for anything that must not round. */
      readonly totalValueLockedCNS: bigint;
      /** When the call was made. A level, so its age matters. */
      readonly asOfMs: number;
      /** Where it came from. Always the chain — never derived from indexed flow. */
      readonly source: 'chain';
    }
  | { readonly known: false; readonly reason: string; readonly asOfMs: number };

/**
 * Reads the collateral balance of the Exchange proxy, with a short cache.
 *
 * Errors NEVER throw out of {@link read}: a dashboard asking for TVL must not fail
 * because an RPC hiccuped, and the honest answer is a reading that says it does not
 * know. The last good value is not served past its TTL either — see
 * {@link TvlProbeOptions.ttlMs} on why a stale level is worse than no level.
 */
export class TvlProbe {
  readonly #options: TvlProbeOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #cached: { readonly reading: TvlReading; readonly atMs: number } | undefined;
  /** Coalesces concurrent callers onto one in-flight call. */
  #inFlight: Promise<TvlReading> | undefined;

  constructor(options: TvlProbeOptions) {
    for (const [label, value] of [
      ['tokenAddress', options.tokenAddress],
      ['exchangeAddress', options.exchangeAddress],
    ] as const) {
      if (!ADDRESS.test(value)) {
        throw new RangeError(`${label} must be a 0x-prefixed 20-byte address, got ${JSON.stringify(value)}`);
      }
    }
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async read(): Promise<TvlReading> {
    const nowMs = this.#now();
    if (this.#cached !== undefined && nowMs - this.#cached.atMs < this.#ttlMs) {
      return this.#cached.reading;
    }
    // One call even under concurrent readers: a dashboard rendering several tiles
    // should not produce several eth_calls.
    this.#inFlight ??= this.#probe().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #probe(): Promise<TvlReading> {
    const asOfMs = this.#now();
    try {
      const data = `${BALANCE_OF_SELECTOR}${this.#options.exchangeAddress.slice(2).toLowerCase().padStart(64, '0')}`;
      const response = await this.#fetch(this.#options.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: this.#options.tokenAddress, data }, 'latest'],
        }),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) {
        return this.#miss(`the RPC answered ${response.status} ${response.statusText}`, asOfMs);
      }
      const json = (await response.json()) as {
        result?: unknown;
        error?: { message?: string };
      };
      if (json.error !== undefined) {
        return this.#miss(`the RPC returned an error: ${json.error.message ?? 'no message'}`, asOfMs);
      }
      const reading = decodeBalance(json.result, this.#options.collateralDecimals, asOfMs);
      this.#cached = { reading, atMs: asOfMs };
      return reading;
    } catch (error) {
      // A timeout or a dropped socket. Reported as unknown, never as zero.
      return this.#miss(error instanceof Error ? error.message : String(error), asOfMs);
    }
  }

  #miss(detail: string, asOfMs: number): TvlReading {
    const reading: TvlReading = {
      known: false,
      reason: `could not read the Exchange's collateral balance from the chain: ${detail}`,
      asOfMs,
    };
    // A failure is cached too, briefly: a dashboard refreshing every second must
    // not hammer an RPC that is already struggling.
    this.#cached = { reading, atMs: asOfMs };
    return reading;
  }
}

/**
 * A 32-byte `uint256` word -> a reading.
 *
 * Exported for the tests, because this is where a wrong answer would be silent: a
 * short reply, an empty `0x`, or a word parsed as a float would all produce a
 * number rather than an error.
 */
export function decodeBalance(
  result: unknown,
  collateralDecimals: number,
  asOfMs: number,
): TvlReading {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) {
    return {
      known: false,
      reason: `the RPC returned ${JSON.stringify(result)}, which is not a hex word`,
      asOfMs,
    };
  }
  const body = result.slice(2);
  if (body.length === 0) {
    // What an eth_call to a non-contract, or to the wrong address, returns. It is
    // NOT a balance of zero, and treating it as one would put a confident 0.00 on
    // a dashboard.
    return {
      known: false,
      reason:
        'the RPC returned empty data (0x), which means the call did not reach an ERC-20 — ' +
        'check the collateral token address, not the balance',
      asOfMs,
    };
  }

  const totalValueLockedCNS = BigInt(result);
  // The one float, at the end, for display. The exact micros travel alongside.
  const scale = 10 ** collateralDecimals;
  return {
    known: true,
    totalValueLockedCNS,
    totalValueLockedAusd: Number(totalValueLockedCNS) / scale,
    asOfMs,
    source: 'chain',
  };
}
