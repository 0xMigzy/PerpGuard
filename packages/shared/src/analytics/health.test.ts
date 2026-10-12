/**
 * The distinction this file protects: HALTED is not LAGGING, and neither is
 * SYNCED.
 *
 * Two facts measured against the running mainnet indexer drive these tests,
 * and both are counter-intuitive enough to be worth asserting directly:
 *
 *   - the indexer's own `block_height` is not independent, so a DEAD indexer
 *     reports itself 0 blocks behind;
 *   - `chain_metadata` is written in bursts every 1-3 minutes, so a HEALTHY
 *     indexer shows no progress at all over a 60-second window.
 *
 * Get either wrong and the monitor is confidently wrong in the reassuring
 * direction, which is the one failure mode that matters.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  IndexerHealthMonitor,
  classifyIndexerHealth,
  describeIndexerHealth,
  type IndexerProgress,
} from './health.ts';

const HEAD = 108_790_010;

/**
 * `chainHead` is explicitly nullable so a test can REMOVE it — the case where
 * no independent head is available is one of the things under test, and
 * exactOptionalPropertyTypes distinguishes absent from undefined.
 */
const reading = (
  over: Partial<Omit<IndexerProgress, 'chainHead'>> & { chainHead?: number | undefined } = {},
): IndexerProgress => {
  const { chainHead, ...rest } = { chainHead: HEAD as number | undefined, ...over };
  const base: IndexerProgress = {
    chainId: 143,
    startBlock: 100_000_000,
    latestProcessedBlock: HEAD - 150,
    blockHeight: HEAD - 150,
    eventsProcessed: 20_841_280,
    observedAtMs: 1_000_000,
    ...rest,
  };
  return chainHead === undefined ? base : { ...base, chainHead };
};

describe('synced', () => {
  it('is the only state that may be served as current', () => {
    const health = classifyIndexerHealth(reading(), undefined);
    assert.equal(health.state, 'synced');
    assert.equal(health.serveAsCurrent, true);
    assert.equal(health.reason, undefined, 'a healthy indexer needs no excuse');
  });

  it('tolerates the commit cadence, which is bursty by minutes', () => {
    // MEASURED: chain_metadata is written every 1-3 minutes, so a caught-up
    // indexer is routinely several hundred blocks back in the table. A tighter
    // threshold would flap on a perfectly healthy indexer.
    const health = classifyIndexerHealth(
      reading({ latestProcessedBlock: HEAD - 600 }),
      undefined,
    );
    assert.equal(health.state, 'synced');
    assert.equal(health.blocksBehind, 600);
  });
});

describe('the indexer marking its own homework', () => {
  it('refuses to certify synced without an independent head', () => {
    // THE CASE THAT BREAKS EVERY NAIVE CHECK. The process died while caught
    // up, so latest_processed_block and block_height froze together and the
    // table says 0 blocks behind. Without a real head there is nothing to
    // catch it, so the only honest answer is "I cannot tell".
    const deadAtHead = reading({
      latestProcessedBlock: HEAD,
      blockHeight: HEAD,
      chainHead: undefined,
    });
    const health = classifyIndexerHealth(deadAtHead, undefined);
    assert.equal(health.blocksBehind, 0, 'it looks perfectly caught up');
    assert.notEqual(health.state, 'synced');
    assert.equal(health.state, 'unknown');
    assert.equal(health.serveAsCurrent, false);
    assert.equal(health.headIsIndependent, false);
    assert.match(health.reason ?? '', /marking its own homework/);
  });

  it('catches the same indexer the moment a real head is supplied', () => {
    // Observed live: the indexer reported itself 0 behind while the RPC put it
    // 152 back. One independent number is the whole difference.
    const health = classifyIndexerHealth(
      reading({ latestProcessedBlock: HEAD, blockHeight: HEAD, chainHead: HEAD + 20_000 }),
      undefined,
    );
    assert.equal(health.blocksBehind, 20_000);
    assert.equal(health.state, 'unknown', 'one reading cannot say halted vs lagging');
    assert.equal(health.serveAsCurrent, false, 'but it is certainly not current');
    assert.equal(health.headIsIndependent, true);
  });
});

describe('halted versus lagging', () => {
  const behind = { latestProcessedBlock: HEAD - 90_000 };

  it('calls it LAGGING when the processed block is advancing', () => {
    const before = reading({ ...behind, observedAtMs: 0 });
    const after = reading({
      latestProcessedBlock: HEAD - 40_000,
      observedAtMs: 600_000,
    });
    const health = classifyIndexerHealth(after, before);
    assert.equal(health.state, 'lagging');
    assert.equal(health.serveAsCurrent, false);
    assert.match(health.reason ?? '', /still catching up/);
  });

  it('calls it HALTED when it is not advancing but is still fetching', () => {
    const lastProgress = reading({ ...behind, blockHeight: HEAD - 90_000, observedAtMs: 0 });
    const now = reading({
      ...behind,
      blockHeight: HEAD - 200, // still polling: its own head moved on
      observedAtMs: 600_000,
    });
    const health = classifyIndexerHealth(now, lastProgress);
    assert.equal(health.state, 'halted');
    assert.equal(health.serveAsCurrent, false);
    assert.equal(health.stalledForMs, 600_000);
    assert.match(health.reason ?? '', /stopped, not slow/);
    assert.match(health.reason ?? '', new RegExp(`frozen at block ${HEAD - 90_000}`));
    assert.match(health.reason ?? '', /handler that\s+threw/);
  });

  it('says the process is dead when its own head froze too', () => {
    const lastProgress = reading({ ...behind, blockHeight: HEAD - 90_000, observedAtMs: 0 });
    const now = reading({ ...behind, blockHeight: HEAD - 90_000, observedAtMs: 600_000 });
    const health = classifyIndexerHealth(now, lastProgress);
    assert.equal(health.state, 'halted');
    assert.match(health.reason ?? '', /process itself is very likely dead/);
  });

  it('does not mistake the commit cadence for a halt', () => {
    // MEASURED: zero change over 60s on a healthy indexer. Anything that calls
    // this halted is a false alarm, and a false alarm during judging is its
    // own kind of failure.
    const lastProgress = reading({ observedAtMs: 0 });
    const now = reading({ observedAtMs: 60_000 });
    const health = classifyIndexerHealth(now, lastProgress);
    assert.equal(health.state, 'synced');
    assert.equal(health.serveAsCurrent, true);
  });

  it('does not call a caught-up indexer halted just for standing still', () => {
    // At head with nothing to do, progress legitimately pauses. Only an
    // indexer that is BOTH behind and not moving is halted.
    const lastProgress = reading({ observedAtMs: 0 });
    const now = reading({ observedAtMs: 3_600_000 });
    assert.equal(classifyIndexerHealth(now, lastProgress).state, 'synced');
  });
});

describe('starting', () => {
  it('reports a fresh indexer as starting, not synced', () => {
    const health = classifyIndexerHealth(
      reading({ latestProcessedBlock: 0, eventsProcessed: 0 }),
      undefined,
    );
    assert.equal(health.state, 'starting');
    assert.equal(health.serveAsCurrent, false);
  });
});

describe('IndexerHealthMonitor', () => {
  it('is not healthy before it has looked', () => {
    const health = new IndexerHealthMonitor().health();
    assert.equal(health.state, 'unknown');
    assert.equal(health.serveAsCurrent, false);
    assert.match(health.reason ?? '', /not been checked/);
  });

  it('measures the stall from the last real progress, not the last reading', () => {
    const monitor = new IndexerHealthMonitor();
    const stuck = { latestProcessedBlock: HEAD - 90_000, blockHeight: HEAD - 200 };

    monitor.observe(reading({ ...stuck, observedAtMs: 0 }));
    // Polled every two minutes. Comparing to the PREVIOUS reading would find
    // only two minutes of stall each time and never cross the threshold, so
    // the halt would stay invisible forever.
    monitor.observe(reading({ ...stuck, observedAtMs: 120_000 }));
    monitor.observe(reading({ ...stuck, observedAtMs: 240_000 }));
    const health = monitor.observe(reading({ ...stuck, observedAtMs: 420_000 }));

    assert.equal(health.state, 'halted');
    assert.equal(health.stalledForMs, 420_000);
  });

  it('clears once progress resumes', () => {
    const monitor = new IndexerHealthMonitor();
    const stuck = { latestProcessedBlock: HEAD - 90_000, blockHeight: HEAD - 200 };
    monitor.observe(reading({ ...stuck, observedAtMs: 0 }));
    assert.equal(monitor.observe(reading({ ...stuck, observedAtMs: 420_000 })).state, 'halted');

    const recovered = monitor.observe(reading({ observedAtMs: 500_000 }));
    assert.equal(recovered.state, 'synced');
    assert.equal(recovered.serveAsCurrent, true);
  });
});

describe('describeIndexerHealth', () => {
  it('leads with the state so it cannot be skimmed past', () => {
    const halted = classifyIndexerHealth(
      reading({ latestProcessedBlock: HEAD - 90_000, observedAtMs: 600_000 }),
      reading({ latestProcessedBlock: HEAD - 90_000, observedAtMs: 0 }),
    );
    assert.match(describeIndexerHealth(halted), /^HALTED: /);
    assert.match(describeIndexerHealth(classifyIndexerHealth(reading(), undefined)), /^synced/);
  });
});
