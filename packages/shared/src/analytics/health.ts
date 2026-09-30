/**
 * Is the indexer alive, behind, or dead? — pure classification, no I/O.
 *
 * This exists because HALTED AND LAGGING LOOK IDENTICAL FROM THE OUTSIDE, and
 * because the obvious ways of telling them apart are all wrong. We deliberately
 * throw rather than guess — `sideOf` halts on a positionType it does not
 * recognise, because recording the wrong side corrupts every downstream number
 * invisibly. That trade is only safe if the halt is VISIBLE. An indexer that
 * has stopped and looks like it is catching up is the analytics equivalent of a
 * frozen price on a dead feed, and CLAUDE.md is explicit: a monitor that has
 * gone blind must never look healthy.
 *
 * TWO MEASURED FACTS SHAPE EVERYTHING BELOW, both learned the hard way against
 * the running mainnet indexer.
 *
 * 1. `chain_metadata.block_height` IS NOT AN INDEPENDENT VIEW OF THE CHAIN. It
 *    is the indexer's own reading, written by the same process. When that
 *    process dies both columns freeze together, so `block_height -
 *    latest_processed_block` reads ZERO for a dead indexer — the most
 *    reassuring possible answer, in exactly the case that matters most. Real
 *    head has to come from somewhere else. Observed: the indexer reported
 *    itself 0 blocks behind while the RPC put it 152 blocks back.
 *
 * 2. `chain_metadata` IS WRITTEN IN BURSTS, ROUGHLY EVERY ONE TO THREE MINUTES,
 *    not continuously. A healthy caught-up indexer shows no change at all over
 *    a 60-second window. So "it did not advance in the last few seconds" means
 *    nothing, and any liveness window shorter than the commit cadence produces
 *    a confident false alarm.
 *
 * Hence: freshness is measured against an INDEPENDENT chain head and is
 * instant; liveness is measured across readings and needs a window longer than
 * the commit cadence. Freshness is the safety property, so it is the one that
 * gates `serveAsCurrent`.
 */

/**
 * REAL chain head, from a source that is not the indexer. Undefined on failure.
 *
 * Its own function because three callers need it and the answer must be the same
 * in all three: the lag monitor, the analytics reader, and the indexer's own
 * `verify` script. Two of them previously had their own copy.
 *
 * NEVER THROWS, and undefined is meaningful. Without an independent head
 * {@link classifyIndexerHealth} downgrades its verdict to `unknown` rather than
 * calling the indexer synced — `chain_metadata.block_height` is the indexer's own
 * reading, written by the same process, so when that process dies both columns
 * freeze together and the table reports zero blocks behind. An RPC we could not
 * reach must therefore reduce confidence, not silently leave it at maximum.
 */
export async function fetchChainHead(
  rpcUrl: string,
  options: { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number } = {},
): Promise<number | undefined> {
  const send = options.fetchImpl ?? fetch;
  try {
    const response = await send(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const json = (await response.json()) as { result?: string };
    if (typeof json.result !== 'string') return undefined;
    const head = Number.parseInt(json.result, 16);
    return Number.isSafeInteger(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/** How a reader should treat the indexer's numbers right now. */
export type IndexerState =
  /** Caught up to real head. Numbers may be presented as current. */
  | 'synced'
  /** Behind real head, but making progress. Numbers are real but out of date. */
  | 'lagging'
  /**
   * Behind real head and not advancing. Either it threw, or it died.
   * Numbers are frozen at whatever the last processed block saw.
   */
  | 'halted'
  /** Has not processed anything yet. */
  | 'starting'
  /** Not enough evidence to say. Never treated as healthy. */
  | 'unknown';

/** One reading of the indexer's progress, from `chain_metadata`. */
export interface IndexerProgress {
  readonly chainId: number;
  readonly startBlock: number;
  readonly latestProcessedBlock: number;
  /**
   * Chain head AS THE INDEXER LAST SAW IT. Not independent — see the note at
   * the top of this file. Useful only for saying why something stalled, never
   * for deciding whether it did.
   */
  readonly blockHeight: number;
  readonly eventsProcessed: number;
  /**
   * REAL chain head, from a source that is not the indexer — an RPC call.
   * Without it, a dead indexer cannot be distinguished from a healthy one, so
   * its absence downgrades the verdict to `unknown` rather than `synced`.
   */
  readonly chainHead?: number;
  /** When this reading was taken. */
  readonly observedAtMs: number;
}

export interface IndexerHealth {
  readonly state: IndexerState;
  /** Against real head when we have it, the indexer's own otherwise. */
  readonly blocksBehind: number;
  /** Whether `blocksBehind` was measured against an independent source. */
  readonly headIsIndependent: boolean;
  /**
   * WHETHER THE NUMBERS MAY BE SHOWN AS CURRENT. True only when synced against
   * an independent head. A lagging indexer's figures are real but out of date;
   * a halted one's are frozen; an unverified one's are unknown. None of the
   * three may be served as "now" without saying so.
   */
  readonly serveAsCurrent: boolean;
  /** Human-readable and safe to render directly. Absent only when synced. */
  readonly reason?: string;
  /** How long progress has been stuck, when it is known to be. */
  readonly stalledForMs?: number;
  readonly observedAtMs: number;
}

export interface IndexerHealthOptions {
  /**
   * Within this many blocks of REAL head counts as synced.
   *
   * This has to exceed the `chain_metadata` commit cadence or a healthy
   * indexer flaps: it writes in bursts every one to three minutes, and Monad
   * produces roughly 3.3 blocks a second, so a caught-up indexer is routinely
   * several hundred blocks back in the table. 1000 blocks is about five
   * minutes — comfortably past the cadence, and still far tighter than any
   * lag a person would notice in the product.
   */
  readonly syncedWithinBlocks?: number;
  /**
   * No progress for this long means halted rather than slow. Must also exceed
   * the commit cadence, for the same reason.
   */
  readonly haltedAfterMs?: number;
}

export const DEFAULT_HEALTH_OPTIONS: Required<IndexerHealthOptions> = {
  syncedWithinBlocks: 1000,
  haltedAfterMs: 300_000,
};

/**
 * Classify one reading, optionally against the last one at which progress was
 * actually observed.
 *
 * `lastProgress` must be the last reading whose processed block DIFFERED, not
 * simply the reading before this one — {@link IndexerHealthMonitor} maintains
 * that. Polling every 30 seconds and comparing to the previous poll would find
 * only 30 seconds of stall each time and never cross the threshold, so a halt
 * would stay invisible forever.
 */
export function classifyIndexerHealth(
  current: IndexerProgress,
  lastProgress: IndexerProgress | undefined,
  options: IndexerHealthOptions = {},
): IndexerHealth {
  const { syncedWithinBlocks, haltedAfterMs } = { ...DEFAULT_HEALTH_OPTIONS, ...options };

  const headIsIndependent = current.chainHead !== undefined;
  const head = current.chainHead ?? current.blockHeight;
  const blocksBehind = Math.max(0, head - current.latestProcessedBlock);
  const base = { blocksBehind, headIsIndependent, observedAtMs: current.observedAtMs };

  if (current.latestProcessedBlock <= 0 || current.eventsProcessed <= 0) {
    return {
      ...base,
      state: 'starting',
      serveAsCurrent: false,
      reason: 'the indexer has not processed any events yet, so there is nothing to report',
    };
  }

  const stalledForMs =
    lastProgress === undefined ? undefined : current.observedAtMs - lastProgress.observedAtMs;
  const notAdvancing =
    lastProgress !== undefined &&
    current.latestProcessedBlock === lastProgress.latestProcessedBlock &&
    (stalledForMs ?? 0) >= haltedAfterMs;

  const caughtUp = blocksBehind <= syncedWithinBlocks;

  if (notAdvancing && !caughtUp) {
    // Which column froze says WHY, and the two need different fixes. This is
    // the only thing the indexer's own `blockHeight` is good for.
    const ownHeadFrozen = current.blockHeight <= (lastProgress?.blockHeight ?? 0);
    const diagnosis = ownHeadFrozen
      ? 'It is not even polling for new blocks, so the process itself is very likely ' +
        'dead or stopped — check that it is running at all.'
      : 'It is still fetching blocks but processing none, which is what a handler that ' +
        'threw looks like — check the indexer log. The handlers throw rather than ' +
        'guessing at data they do not recognise.';
    return {
      ...base,
      state: 'halted',
      serveAsCurrent: false,
      ...(stalledForMs === undefined ? {} : { stalledForMs }),
      reason:
        `the indexer is ${blocksBehind} blocks behind head and has processed nothing for ` +
        `${Math.round((stalledForMs ?? 0) / 1000)}s. It is stopped, not slow: every figure ` +
        `is frozen at block ${current.latestProcessedBlock}. ${diagnosis}`,
    };
  }

  if (!headIsIndependent) {
    // Without a real head we cannot certify anything. The indexer's own
    // reading says zero blocks behind whether it is healthy or dead, so
    // calling this synced would be the one mistake this module exists to
    // prevent.
    return {
      ...base,
      state: 'unknown',
      serveAsCurrent: false,
      reason:
        'no independent chain head was supplied, so this is the indexer marking its own ' +
        'homework: a dead indexer reports itself 0 blocks behind. Pass chainHead from an ' +
        'RPC call to get a real answer.',
    };
  }

  if (caughtUp) return { ...base, state: 'synced', serveAsCurrent: true };

  if (lastProgress === undefined) {
    return {
      ...base,
      state: 'unknown',
      serveAsCurrent: false,
      reason:
        `the indexer is ${blocksBehind} blocks behind real head, and with only one reading ` +
        `there is no way to tell whether it is catching up or stopped. Either way these ` +
        `figures are not current.`,
    };
  }

  return {
    ...base,
    state: 'lagging',
    serveAsCurrent: false,
    ...(stalledForMs === undefined ? {} : { stalledForMs }),
    reason:
      `the indexer is ${blocksBehind} blocks behind real head and still catching up; ` +
      `figures are real but not current`,
  };
}

/** A one-line summary safe to print or render. */
export function describeIndexerHealth(health: IndexerHealth): string {
  if (health.state === 'synced') return `synced (${health.blocksBehind} blocks behind head)`;
  return `${health.state.toUpperCase()}: ${health.reason ?? 'no detail'}`;
}

/**
 * Keeps the last reading at which progress was actually made, so a stall is
 * measured rather than inferred.
 *
 * Deliberately tiny and synchronous: whoever owns the database connection and
 * the RPC feeds it readings, and it answers. It does no I/O of its own, so the
 * same logic serves the verify script, the backend and anything else.
 */
export class IndexerHealthMonitor {
  readonly #options: IndexerHealthOptions;
  #lastProgress: IndexerProgress | undefined;
  #latest: IndexerHealth | undefined;

  constructor(options: IndexerHealthOptions = {}) {
    this.#options = options;
  }

  /** Feed a fresh reading and get the verdict. */
  observe(progress: IndexerProgress): IndexerHealth {
    const health = classifyIndexerHealth(progress, this.#lastProgress, this.#options);
    if (
      this.#lastProgress === undefined ||
      progress.latestProcessedBlock > this.#lastProgress.latestProcessedBlock
    ) {
      this.#lastProgress = progress;
    }
    this.#latest = health;
    return health;
  }

  /**
   * The last verdict. Reports `unknown` before anything has been observed —
   * never `synced`, because not having looked is not the same as being fine.
   */
  health(): IndexerHealth {
    return (
      this.#latest ?? {
        state: 'unknown',
        blocksBehind: 0,
        headIsIndependent: false,
        serveAsCurrent: false,
        reason: 'the indexer has not been checked yet',
        observedAtMs: 0,
      }
    );
  }
}
