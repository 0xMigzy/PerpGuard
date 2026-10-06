import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIGS, dangerAssessment } from '@perpguard/bot/test-support';
import type { RiskAssessment } from '../risk/types.ts';
import { DEFAULT_PREFERENCES, type AlertPreferences } from './preferences.ts';
import { InMemoryWarningState, WatchWarnings } from './watchWarnings.ts';

const base = dangerAssessment();
const watched = (bufferPct: number, over: Partial<RiskAssessment> = {}): RiskAssessment => ({
  ...base,
  liqBufferPct: bufferPct / 100,
  watch: { accountId: 4088, label: '#4088', indexerBlock: 111_000_000, blocksBehind: 140, indexerState: 'synced', freeBalanceCNS: 500_000_000n },
  ...over,
});

function rig(options: { addedAtMs?: number; prefs?: Partial<AlertPreferences> } = {}) {
  const clock = { t: 10_000_000 };
  const sent: Array<{ chatId: number; html: string }> = [];
  const state = new InMemoryWarningState();
  const w = new WatchWarnings({
    watchersOf: (id) => (id === 4088 ? [{ chatId: 5150, accountId: 4088, label: '#4088', addedAtMs: options.addedAtMs ?? 0 }] : []),
    preferencesFor: () => ({ ...DEFAULT_PREFERENCES, ...options.prefs }),
    state,
    sender: { send: async (chatId, m) => (sent.push({ chatId, html: m.html }), { ok: true }) },
    render: { webUrl: 'https://perpguard.app', watchEveryMs: 30_000 },
    logger: { warn() {} },
    now: () => clock.t,
  });
  const pass = (assessments: RiskAssessment[], reads: number[] = [4088]) =>
    w.observe({ seenAtMs: clock.t, indexerBlock: 1, blocksBehind: 1, watched: [4088], reads: new Map(reads.map((id) => [id, []])), assessments, configs: CONFIGS });
  return { w, sent, state, pass, clock };
}

test('a watched position falling through 10% then 5% warns twice, once each, in the chat that set them', async () => {
  const r = rig();
  for (const d of [12, 9, 8.5, 4.5, 4]) await r.pass([watched(d)]);
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[0]!.html, /^⚠️ <b>RISK WARNING — HIGH<\/b> 🟠\n<b>#4088<\/b> reached your 10% level\./);
  assert.match(r.sent[1]!.html, /^⚠️ <b>RISK WARNING — CRITICAL<\/b> 🔴\n<b>#4088<\/b> reached your 5% level\./);
  assert.match(r.sent[1]!.html, /You warn at 10% \/ 5%\. Each level warns once/);
  assert.match(r.sent[1]!.html, /Positions as of block 111,000,000, 140 blocks behind the chain/);
});

test('HELD WHILE BLIND: no warning from a position it cannot see, and the state stands', async () => {
  const r = rig();
  await r.pass([watched(4, { state: 'POSITIONS_UNTRUSTED' })]);
  assert.equal(r.sent.length, 0);
  await r.pass([watched(4)]);
  assert.equal(r.sent.length, 1, 'once it can see again, the warning goes');
});

test('a subscription under two minutes old takes the position as its baseline: no warning on first sight', async () => {
  const r = rig({ addedAtMs: 10_000_000 - 30_000 });
  await r.pass([watched(4)]);
  assert.equal(r.sent.length, 0);
  r.clock.t += 120_000;
  await r.pass([watched(3.9)]);
  assert.equal(r.sent.length, 0, 'already below both levels when it was watched: nothing new crossed');
});

test('warnings off, or wallet alerts off, sends nothing and forgets the state', async () => {
  const off = rig({ prefs: { warningLevels: [] } });
  await off.pass([watched(1)]);
  assert.equal(off.sent.length, 0);
  const quiet = rig({ prefs: { walletAlerts: false } });
  await quiet.pass([watched(1)]);
  assert.equal(quiet.sent.length, 0);
  assert.deepEqual(quiet.state.keys(), []);
});

test('a closed position is forgotten, so a new one on the same market warns afresh; a failed read keeps the state', async () => {
  const r = rig();
  await r.pass([watched(4)]);
  assert.equal(r.sent.length, 1);
  await r.pass([], []);
  assert.deepEqual(r.state.keys(), [`5150:4088:${base.marketId}`], 'the read failed: nothing is known, nothing is forgotten');
  await r.pass([], [4088]);
  assert.deepEqual(r.state.keys(), [], 'read, and gone: closed');
  await r.pass([watched(4)]);
  assert.equal(r.sent.length, 2);
});
