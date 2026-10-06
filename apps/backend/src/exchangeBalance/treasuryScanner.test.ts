import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CollateralTotalsAtBlock, TreasuryMovement } from '@perpguard/shared';
import { describeScanError, TreasuryScanner } from './treasuryScanner.ts';
import { InMemoryTreasuryStore } from './treasuryStore.ts';

const mv = (block: number, direction: 'in' | 'out', amountCNS: bigint): TreasuryMovement => ({ block, txHash: `0x${block}`, logIndex: 0, atMs: block * 1000, direction, amountCNS });

/** A chain whose finalized head, logs and balance the test controls. */
function harness(opts: { head: number; logs?: TreasuryMovement[]; balanceCNS: bigint; indexBlock: number; deposited: bigint; withdrawn: bigint; seedThrough?: number; seed?: TreasuryMovement[] }) {
  const state = { ...opts, scans: [] as [number, number][], fail: false, hang: undefined as Promise<void> | undefined };
  const store = new InMemoryTreasuryStore({ throughBlock: opts.seedThrough ?? 100, movements: opts.seed ?? [] });
  const warns: string[] = [];
  let now = 1_000;
  const scanner = new TreasuryScanner({
    store,
    rpc: { rpcUrl: 'http://rpc?token=SECRET', exchangeAddress: '0xex' },
    collateralAtIndexHead: async (): Promise<CollateralTotalsAtBlock> => ({ block: state.indexBlock, collateralToken: '0xausd', depositedCNS: state.deposited, withdrawnCNS: state.withdrawn, collateralDecimals: 6 }),
    now: () => now,
    warn: (l) => warns.push(l),
    chain: {
      finalizedBlock: async () => {
        if (state.hang !== undefined) await state.hang;
        if (state.fail) throw new Error('eth_getBlockByNumber: HTTP 503 at http://rpc?token=SECRET');
        return state.head;
      },
      scan: async (from, to) => {
        state.scans.push([from, to]);
        return (state.logs ?? []).filter((l) => l.block >= from && l.block <= to);
      },
      balanceAt: async () => state.balanceCNS,
    },
  });
  return { scanner, store, state, warns, tick: (ms: number) => (now += ms) };
}

test('each run scans ONLY from the cursor to the finalized block, and stores both together', async () => {
  const h = harness({ head: 150, logs: [mv(120, 'out', 5_000_000n)], balanceCNS: 0n, indexBlock: 140, deposited: 0n, withdrawn: 0n });
  assert.equal(await h.scanner.runOnce(), 'ran');
  h.state.head = 180;
  await h.scanner.runOnce();
  await h.scanner.runOnce();
  assert.deepEqual(h.state.scans, [[101, 150], [151, 180]], 'nothing rescanned; no scan when the head has not moved');
  assert.equal((await h.store.load()).throughBlock, 180);
  assert.equal(h.scanner.status().throughBlock, 180);
  assert.equal(h.scanner.movements().length, 1);
});

test('two runs never overlap: the second is skipped while the first holds the lock', async () => {
  const h = harness({ head: 150, balanceCNS: 0n, indexBlock: 140, deposited: 0n, withdrawn: 0n });
  let open!: () => void;
  h.state.hang = new Promise((r) => (open = r));
  const first = h.scanner.runOnce();
  assert.equal(await h.scanner.runOnce(), 'skipped');
  open();
  assert.equal(await first, 'ran');
  assert.equal(h.state.scans.length, 1);
});

test('a failed run is logged, kept as the status (never with the RPC URL), and the next interval tries again', async () => {
  const h = harness({ head: 150, balanceCNS: 0n, indexBlock: 140, deposited: 0n, withdrawn: 0n });
  h.state.fail = true;
  assert.equal(await h.scanner.runOnce(), 'failed');
  assert.equal(h.scanner.status().lastError, 'the RPC answered HTTP 503');
  assert.equal(h.warns.length, 1);
  assert.ok(!h.warns[0]!.includes('SECRET') && !JSON.stringify(h.scanner.status()).includes('SECRET'), 'the token in the URL never leaves');
  h.state.fail = false;
  assert.equal(await h.scanner.runOnce(), 'ran');
  assert.equal(h.scanner.status().lastError, undefined, 'cleared by the next success');
});

test('reconciled at the index\'s block: inside 27.70 ± 1 is quiet; outside it warns and says so', async () => {
  // deposits 1,000 − withdrawals 400 − treasury out 178.6 (at block 120 ≤ 140) = 421.4; the contract holds 27.700465 more.
  const base = { head: 150, logs: [mv(120, 'out', 178_600_000n), mv(145, 'out', 999_000_000n)], indexBlock: 140, deposited: 1_000_000_000n, withdrawn: 400_000_000n };
  const ok = harness({ ...base, balanceCNS: 421_400_000n + 27_700_465n });
  await ok.scanner.runOnce();
  const r = ok.scanner.status().reconciliation!;
  assert.equal(r.atBlock, 140);
  assert.equal(r.rebuiltAusd, 421.4, 'the movement at block 145 is after the compared block and is not counted');
  assert.equal(r.gapAusd, 27.700465);
  assert.equal(r.withinExpected, true);
  assert.equal(ok.warns.length, 0);

  const off = harness({ ...base, balanceCNS: 421_400_000n + 27_700_465n + 5_000_000n });
  await off.scanner.runOnce();
  assert.equal(off.scanner.status().reconciliation!.withinExpected, false);
  assert.match(off.warns[0]!, /32\.700465 AUSD apart, outside the known 27\.700465 ± 1/);
});

test('no reconciliation while the index is ahead of the scan: a movement in between would read as a gap', async () => {
  const h = harness({ head: 150, balanceCNS: 0n, indexBlock: 151, deposited: 0n, withdrawn: 0n });
  await h.scanner.runOnce();
  assert.equal(h.scanner.status().reconciliation, undefined);
});

test('scan errors are short and renderable', () => {
  const t = new Error('x');
  t.name = 'TimeoutError';
  assert.equal(describeScanError(new Error('The operation was aborted due to timeout')), 'the RPC timed out');
  assert.equal(describeScanError(new TypeError('fetch failed')), 'could not reach the RPC');
  assert.equal(describeScanError(new Error('eth_call: Block requested not found. historical state')), 'the RPC no longer holds that block’s state');
});
