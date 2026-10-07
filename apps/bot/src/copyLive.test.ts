import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copySetupScreen, copyStatusScreen } from './copyLive.ts';
import { isPublicRoute } from './nav.ts';

const base = { leaderAccountId: 4532, network: 'testnet', keepFreeCNS: 500_000_000n, activityLine: undefined, copiedLine: undefined, copyingOther: undefined, stopped: false };
const labels = (s: { buttons: readonly (readonly { text: string }[])[] }) => s.buttons.flat().map((b) => b.text);

test('SETUP states the rule, the one number and the limits before anything starts', () => {
  const s = copySetupScreen({ ...base, verified: { ok: true, text: '' } });
  assert.match(s.html, /PerpGuard copies when they open and when they close, not every adjustment in between\./);
  assert.match(s.html, /No limit on how many: if they open ten, you copy ten\. It never spends the last <b>500 AUSD<\/b> of your free balance; an open that would is skipped, and you are told\./);
  assert.match(s.html, /Past profit predicts nothing\. Stopping leaves copied positions open; it never moves money\./);
  assert.match(s.html, /Prices and timing differ/);
  assert.ok(labels(s).includes('✅ Start copying #4532'));
  assert.ok(labels(s).includes('✅ 500') && labels(s).includes('0'), 'keep free settable, 0 included');
});

test('SETUP for a trader whose books do not reconcile says so and offers no start', () => {
  const s = copySetupScreen({ ...base, verified: { ok: false, text: "PerpGuard won't copy a trader whose books it can't verify against the chain." } });
  assert.match(s.html, /⛔ <b>PerpGuard won't copy a trader whose books it can't verify against the chain\.<\/b>/);
  assert.ok(!labels(s).some((t) => t.startsWith('✅ Start')));
});

test('STATUS shows what is open, what was skipped and why, with a one-tap stop', () => {
  const s = copyStatusScreen({
    rule: { leaderAccountId: 4532, keepFreeCNS: 500_000_000n, enabled: true, pausedReason: undefined, startedAtMs: Date.parse('2026-10-07T12:00:00Z') },
    legs: [
      { symbol: 'BTC', side: 'long', status: 'open', reason: undefined, leaderOpenedAtMs: 1 },
      { symbol: 'HYPE', side: 'short', status: 'skipped', reason: 'HYPE is not listed on testnet, so it cannot be copied.', leaderOpenedAtMs: 2 },
    ],
  });
  assert.match(s.html, /🔁 <b>COPYING #4532<\/b> · 🟢 ON/);
  assert.match(s.html, /• BTC long · open/);
  assert.match(s.html, /• HYPE short · skipped: HYPE is not listed on testnet/);
  assert.ok(labels(s).includes('⛔ Stop copying'));
});

test('COPY ROUTES ARE LINKED ONLY: a watcher can never reach one', () => {
  for (const r of [{ to: 'copy-setup', accountId: 1 }, { to: 'copy-start' }, { to: 'copy-stop' }, { to: 'copy-status' }, { to: 'copy-resume' }, { to: 'copy-keep', level: 0 }, { to: 'copy-keep-set', level: 0 }] as const) {
    assert.equal(isPublicRoute(r), false, r.to);
  }
});
