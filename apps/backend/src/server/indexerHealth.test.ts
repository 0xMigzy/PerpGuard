/**
 * The indexer lag probe.
 *
 * A PROBE FAILURE IS A VERDICT, not an exception. A health poller that rejects
 * is a health poller that stops, and the thing it stopped reporting on is the
 * one nobody would then notice was behind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexerLagMonitor } from './indexerHealth.ts';

const metadata = (latest: number, height: number) => ({
  rows: [
    {
      latest_processed_block: String(latest),
      num_events_processed: '123456',
      block_height: String(height),
      start_block: '1000',
    },
  ],
});

/** An RPC that answers with a head, or refuses to. */
const rpc = (head: number | undefined): typeof fetch =>
  (async () => {
    if (head === undefined) throw new Error('RPC unreachable');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${head.toString(16)}` }));
  }) as unknown as typeof fetch;

test('caught up against an independent head is synced and may be served as current', async () => {
  const monitor = new IndexerLagMonitor({
    sql: { async query() { return metadata(1_000_000, 1_000_000); } },
    chainId: 143,
    rpcUrl: 'http://rpc.test',
    fetchImpl: rpc(1_000_010),
  });

  const health = await monitor.poll();
  assert.equal(health.state, 'synced');
  assert.equal(health.serveAsCurrent, true);
  assert.equal(health.headIsIndependent, true);
  assert.equal(monitor.health().state, 'synced');
});

test('without an independent head nothing is certified, however good it looks', async () => {
  // A dead indexer reports itself 0 blocks behind, because block_height is its
  // own reading written by the same process.
  const monitor = new IndexerLagMonitor({
    sql: { async query() { return metadata(1_000_000, 1_000_000); } },
    chainId: 143,
    rpcUrl: 'http://rpc.test',
    fetchImpl: rpc(undefined),
  });

  const health = await monitor.poll();
  assert.equal(health.state, 'unknown');
  assert.equal(health.serveAsCurrent, false);
  assert.match(health.reason ?? '', /marking its own homework/);
});

test('a database that cannot be read reports unknown rather than throwing', async () => {
  const monitor = new IndexerLagMonitor({
    sql: {
      async query() {
        throw new Error('connection refused');
      },
    },
    chainId: 143,
    rpcUrl: 'http://rpc.test',
    fetchImpl: rpc(1_000_010),
  });

  const health = await monitor.poll();
  assert.equal(health.state, 'unknown');
  assert.equal(health.serveAsCurrent, false);
  assert.match(health.reason ?? '', /connection refused/);
});

test('a database with no chain_metadata row says the indexer has never run', async () => {
  const monitor = new IndexerLagMonitor({
    sql: { async query() { return { rows: [] }; } },
    chainId: 143,
    rpcUrl: 'http://rpc.test',
    fetchImpl: rpc(1_000_010),
  });

  const health = await monitor.poll();
  assert.equal(health.state, 'starting');
  assert.match(health.reason ?? '', /never run against this database/);
});

test('before the first poll it is unknown, never synced', async () => {
  const monitor = new IndexerLagMonitor({
    sql: { async query() { return metadata(1, 1); } },
    chainId: 143,
    rpcUrl: 'http://rpc.test',
  });
  assert.equal(monitor.health().state, 'unknown');
  assert.equal(monitor.health().serveAsCurrent, false);
});
