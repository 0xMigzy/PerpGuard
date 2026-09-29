/**
 * Read-only: measure how the account stream's `sn` actually advances.
 *
 * The gap detector in perpl-trading-socket.ts expects heartbeat `sn` to be
 * exactly lastSn + 1. The captured frames show `sn` == `at.b`, the block
 * number, so that expectation only holds if a heartbeat is emitted on every
 * block. If it is not, the detector fires against a healthy socket.
 *
 * Signs in and listens. Places nothing.
 */
import {
  PerplTradingSocket,
  loadNetworkConfig,
  loadPerplCredentials,
  maskApiKey,
} from '@perpguard/shared';

const network = loadNetworkConfig('testnet', process.env);
const credentials = loadPerplCredentials(process.env);
console.log(`Perpl testnet (chain ${network.chainId}), key ${maskApiKey(credentials.apiKey)}`);

const socket = new PerplTradingSocket({
  network,
  apiKey: credentials.apiKey,
  secret: credentials.secret,
});

interface Row {
  readonly tMs: number;
  readonly mt: number;
  readonly sn: number | undefined;
  readonly h: number | undefined;
  readonly atB: number | undefined;
}
const rows: Row[] = [];
const t0 = Date.now();

socket.onMessage((message) => {
  const at = message['at'];
  rows.push({
    tMs: Date.now() - t0,
    mt: Number(message['mt']),
    sn: typeof message['sn'] === 'number' ? message['sn'] : undefined,
    h: typeof message['h'] === 'number' ? message['h'] : undefined,
    atB:
      at !== null && typeof at === 'object' && typeof (at as Record<string, unknown>)['b'] === 'number'
        ? ((at as Record<string, unknown>)['b'] as number)
        : undefined,
  });
});

await socket.connect();
console.log(`signed in: account ${socket.accountId}, fw ${socket.forwardingAllowed}, frozen ${socket.accountFrozen}`);

const listenMs = Number(process.env['LISTEN_MS'] ?? 45_000);
await new Promise((r) => setTimeout(r, listenMs));
socket.close();

// --- sign-in frames: do they share one sn? ---
const signIn = rows.filter((r) => r.tMs < 2000 && r.mt !== 100);
console.log('\n=== sign-in frames (first 2s, non-heartbeat) ===');
for (const r of signIn) console.log(`  t+${r.tMs}ms  mt=${r.mt}  sn=${r.sn}  at.b=${r.atB}`);
const snSet = new Set(signIn.map((r) => r.sn).filter((s) => s !== undefined));
console.log(`  distinct sn across sign-in frames: ${[...snSet].join(', ')} (${snSet.size})`);

// --- heartbeats: is sn strictly +1, and does it equal h? ---
const beats = rows.filter((r) => r.mt === 100 && r.sn !== undefined);
console.log(`\n=== heartbeats (mt 100): ${beats.length} over ${listenMs}ms ===`);
const deltas = new Map<number, number>();
let snEqualsH = 0;
let hDeltaSum = 0;
for (let i = 0; i < beats.length; i += 1) {
  const b = beats[i]!;
  if (b.sn === b.h) snEqualsH += 1;
  if (i > 0) {
    const prev = beats[i - 1]!;
    const d = b.sn! - prev.sn!;
    deltas.set(d, (deltas.get(d) ?? 0) + 1);
    if (b.h !== undefined && prev.h !== undefined) hDeltaSum += b.h - prev.h;
  }
  if (i < 12) console.log(`  t+${b.tMs}ms  sn=${b.sn}  h=${b.h}  sn-h=${b.sn! - (b.h ?? 0)}`);
}
console.log(`  sn delta histogram: ${[...deltas].sort((a, b2) => a[0] - b2[0]).map(([d, n]) => `${d}x${n}`).join(' ')}`);
console.log(`  heartbeats where sn === h: ${snEqualsH}/${beats.length}`);
console.log(`  total head-block advance over the window: ${hDeltaSum}`);
console.log(`  sequence gap detected by the socket: ${socket.sequenceGapDetected}`);

// --- every non-heartbeat frame: did any advance sn? ---
console.log('\n=== all frames by mt ===');
const byMt = new Map<number, number[]>();
for (const r of rows) {
  if (r.sn === undefined) continue;
  const list = byMt.get(r.mt) ?? [];
  list.push(r.sn);
  byMt.set(r.mt, list);
}
for (const [mt, sns] of [...byMt].sort((a, b) => a[0] - b[0])) {
  console.log(`  mt ${mt}: ${sns.length} frame(s), sn range ${Math.min(...sns)}..${Math.max(...sns)}`);
}

// --- the pong (mt 2): what is its `sn`? ---
// Our `mt: 1` ping carries no `sn`, so whatever the pong carries is the
// server's own, not an echo. Worth pinning down: a tracker that reads it
// would compute a gap of tens of millions against a healthy socket.
const pongs = rows.filter((r) => r.mt === 2);
console.log(`\n=== pongs (mt 2): ${pongs.length} ===`);
for (const p of pongs) console.log(`  t+${p.tMs}ms  sn=${p.sn}  h=${p.h}  at.b=${p.atB}`);
