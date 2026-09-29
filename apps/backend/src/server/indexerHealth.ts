/**
 * How far behind the analytics indexer is — polled, not guessed.
 *
 * OPTIONAL BY DESIGN. The indexer runs against MAINNET while this process
 * assesses risk on its own single network, so it is a separate subsystem with a
 * separate database and it is perfectly normal for it not to be configured. An
 * absent probe reports `not-configured`, which does not degrade the process;
 * a configured probe that cannot answer reports degraded, because a probe that
 * failed is not a probe that found nothing wrong.
 *
 * THE CHAIN HEAD COMES FROM THE RPC, NOT FROM THE INDEXER. `chain_metadata`
 * .block_height is the indexer's own reading written by the same process, so a
 * dead indexer reports itself 0 blocks behind — the most reassuring possible
 * answer in exactly the case that matters. `classifyIndexerHealth` already
 * refuses to certify anything without an independent head; this just has to
 * supply one.
 *
 * NO `pg` IMPORT, the same trade `log.pg.ts` makes: it takes a `query` method,
 * which `pg.Client` and `pg.Pool` both satisfy structurally.
 */
import {
  IndexerHealthMonitor,
  type IndexerHealth,
  type IndexerProgress,
} from '@perpguard/shared';

export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

export interface IndexerLagMonitorOptions {
  readonly sql: SqlClient;
  /** The chain the indexer runs against. Mainnet in this project. */
  readonly chainId: number;
  /** An INDEPENDENT view of head. Without it nothing can be certified synced. */
  readonly rpcUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

interface MetadataRow {
  readonly latest_processed_block: string | number;
  readonly num_events_processed: string | number;
  readonly block_height: string | number;
  readonly start_block: string | number;
}

const QUERY = `select latest_processed_block, num_events_processed, block_height, start_block
  from chain_metadata where chain_id = $1`;

export class IndexerLagMonitor {
  readonly #sql: SqlClient;
  readonly #chainId: number;
  readonly #rpcUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  /**
   * Keeps the last reading at which progress was actually MADE, which is what
   * distinguishes halted from merely slow. `chain_metadata` is written in bursts
   * every one to three minutes, so comparing against the previous poll would
   * find only one poll interval of stall and never cross the threshold.
   */
  readonly #monitor = new IndexerHealthMonitor();
  #latest: IndexerHealth | undefined;

  constructor(options: IndexerLagMonitorOptions) {
    this.#sql = options.sql;
    this.#chainId = options.chainId;
    this.#rpcUrl = options.rpcUrl;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** The last verdict, or `unknown` before anything has been observed. */
  health(): IndexerHealth {
    return this.#latest ?? this.#monitor.health();
  }

  /**
   * Take one reading. NEVER THROWS — a probe failure is itself a verdict, and a
   * rejected promise in a health poller is a poller that stops.
   */
  async poll(): Promise<IndexerHealth> {
    try {
      const result = (await this.#sql.query(QUERY, [this.#chainId])) as {
        rows?: readonly MetadataRow[];
      };
      const row = result.rows?.[0];
      if (row === undefined) {
        return this.#record({
          state: 'starting',
          blocksBehind: 0,
          headIsIndependent: false,
          serveAsCurrent: false,
          reason:
            `no chain_metadata row for chain ${this.#chainId}: the indexer has never run ` +
            `against this database`,
          observedAtMs: this.#now(),
        });
      }

      const chainHead = await this.#chainHead();
      const progress: IndexerProgress = {
        chainId: this.#chainId,
        startBlock: Number(row.start_block),
        latestProcessedBlock: Number(row.latest_processed_block),
        blockHeight: Number(row.block_height),
        eventsProcessed: Number(row.num_events_processed),
        ...(chainHead === undefined ? {} : { chainHead }),
        observedAtMs: this.#now(),
      };
      return this.#record(this.#monitor.observe(progress));
    } catch (error) {
      return this.#record({
        state: 'unknown',
        blocksBehind: 0,
        headIsIndependent: false,
        serveAsCurrent: false,
        reason: `could not read the indexer database: ${
          error instanceof Error ? error.message : String(error)
        }`,
        observedAtMs: this.#now(),
      });
    }
  }

  #record(health: IndexerHealth): IndexerHealth {
    this.#latest = health;
    return health;
  }

  /** Real head, from a source that is not the indexer. Undefined on failure. */
  async #chainHead(): Promise<number | undefined> {
    try {
      const response = await this.#fetch(this.#rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const json = (await response.json()) as { result?: string };
      if (json.result === undefined) return undefined;
      const head = Number.parseInt(json.result, 16);
      return Number.isSafeInteger(head) ? head : undefined;
    } catch {
      // Handled, not swallowed: classifyIndexerHealth downgrades to `unknown`
      // without an independent head rather than calling it synced.
      return undefined;
    }
  }
}
