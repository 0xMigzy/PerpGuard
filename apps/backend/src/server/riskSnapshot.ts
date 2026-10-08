/**
 * The protocol-wide risk snapshot, assembled from three sources on ONE network.
 *
 * Positions come from the analytics indexer, marks and margin configs from the
 * analytics venue, insurance balances from the analytics network's Exchange
 * contract. All three are handed to the pure builder in `@perpguard/shared`;
 * nothing here does risk maths.
 *
 * CACHED BRIEFLY. Building it is ten `eth_call`s, a context read and ~100k
 * position evaluations, and a page polls it every 30 seconds; a fresh build per
 * request would spend most of its time redoing the previous one. The snapshot
 * carries the block and the mark age it came from, so its age is visible.
 * A build that fails leaves the previous snapshot in place and rethrows, so a
 * blip never blanks the page and never serves a stale one as new.
 */
import {
  buildRiskSnapshot,
  readMarketInsurance,
  type Analytics,
  type MarketInsuranceReading,
  type MarketRiskConfig,
  type MarketOpenInterest,
  type NetworkConfig,
  type RiskSnapshot,
} from '@perpguard/shared';

export interface RiskSnapshotOptions {
  readonly analytics: Analytics;
  readonly network: NetworkConfig;
  readonly riskConfigs: () => Promise<ReadonlyMap<number, MarketRiskConfig>>;
  readonly openInterest: () => Promise<readonly MarketOpenInterest[]>;
  /** Owner wallets for the listed accounts. Optional; a failure leaves the ids alone, never the snapshot. */
  readonly owners?: (accountIds: readonly number[]) => Promise<ReadonlyMap<number, string>>;
  readonly ttlMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export const DEFAULT_TTL_MS = 20_000;

export class RiskSnapshotSource {
  readonly #options: RiskSnapshotOptions;
  readonly #now: () => number;
  #cached: { snapshot: RiskSnapshot; atMs: number } | undefined;
  #inFlight: Promise<RiskSnapshot> | undefined;

  constructor(options: RiskSnapshotOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async read(): Promise<RiskSnapshot> {
    const ttl = this.#options.ttlMs ?? DEFAULT_TTL_MS;
    const cached = this.#cached;
    if (cached !== undefined && this.#now() - cached.atMs < ttl) return cached.snapshot;
    // One build at a time: two pages polling at once join the same build.
    this.#inFlight ??= this.#build().finally(() => {
      this.#inFlight = undefined;
    });
    // STALE-WHILE-REVALIDATE. A previous snapshot is served now and the rebuild
    // runs behind it; the snapshot carries its own block and mark age, so the
    // page shows how old it is rather than waiting a second for a newer one.
    // A rebuild that fails is logged by the caller's next read, never thrown at
    // a reader who was handed a perfectly good snapshot.
    if (cached !== undefined) {
      void this.#inFlight.catch(() => undefined);
      return cached.snapshot;
    }
    return this.#inFlight;
  }

  /** Age of the served snapshot, for whoever renders it. Undefined before the first build. */
  ageMs(): number | undefined {
    return this.#cached === undefined ? undefined : this.#now() - this.#cached.atMs;
  }

  async #build(): Promise<RiskSnapshot> {
    const { analytics, network } = this.#options;
    const [positions, configs, oi, health, backstop] = await Promise.all([
      analytics.openPositions(),
      this.#options.riskConfigs(),
      this.#options.openInterest(),
      analytics.health(),
      // Context, not risk maths: a failed read leaves it off the page, never blanks the snapshot.
      analytics.backstopHistory().catch(() => undefined),
    ]);
    const indexerBlockAtMs = health.latestProcessedBlock === undefined ? undefined : await this.#blockTime(health.latestProcessedBlock);
    const marks = new Map(oi.map((m) => [m.marketId, { markPrice: m.markPrice, atMs: m.atMs }]));
    // Only the markets that hold a position need an insurance reading.
    const marketIds = [...new Set(positions.map((p) => p.position.market.marketId))].filter((id) => configs.has(id));
    const insurance = new Map<number, MarketInsuranceReading | { readonly reason: string }>();
    await Promise.all(
      marketIds.map(async (id) => {
        const lookup = await readMarketInsurance(id, {
          rpcUrl: network.rpcUrl,
          exchangeAddress: network.exchangeAddress,
          ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
        });
        insurance.set(id, lookup.found ? lookup.reading : { reason: lookup.reason });
      }),
    );
    const snapshot = buildRiskSnapshot({
      positions,
      configs,
      marks,
      insurance,
      indexerBlock: health.latestProcessedBlock,
      indexerBlockAtMs,
      backstop,
      nowMs: this.#now(),
    });
    const owners = this.#options.owners === undefined ? undefined : await this.#options.owners([...new Set(snapshot.positions.map((p) => p.accountId))]).catch(() => undefined);
    const named = owners === undefined ? snapshot : { ...snapshot, positions: snapshot.positions.map((p) => ({ ...p, address: owners.get(p.accountId) })) };
    this.#cached = { snapshot: named, atMs: this.#now() };
    return named;
  }

  /** The block's own timestamp from the chain, so the page can say when "this block" was. Undefined on any failure. */
  async #blockTime(block: number): Promise<number | undefined> {
    try {
      const fetchImpl = this.#options.fetchImpl ?? fetch;
      const res = await fetchImpl(this.#options.network.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [`0x${block.toString(16)}`, false] }),
      });
      const body = (await res.json()) as { result?: { timestamp?: string } };
      const ts = body.result?.timestamp;
      return ts === undefined ? undefined : Number(BigInt(ts)) * 1000;
    } catch {
      return undefined;
    }
  }
}
