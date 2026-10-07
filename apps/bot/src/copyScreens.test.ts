/**
 * 🔁 The copy replay screen: totals, skips by reason with the markets named,
 * the latest copied trades, the limits every time, and NO action on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReplayResult } from '@perpguard/backend/copy/replay';
import { copyReplayScreen } from './copyScreens.ts';
import { decodeNav, encodeNav, isPublicRoute } from './nav.ts';

const T0 = Date.parse('2026-09-07T00:00:00Z');
const AUSD = 1_000_000n;

const replayed: ReplayResult = {
  kind: 'replayed',
  accountId: 4886,
  fromMs: T0,
  toMs: T0 + 30 * 86_400_000,
  actingNetwork: 'testnet',
  collateralDecimals: 6,
  followerStartCNS: 1_000n * AUSD,
  leaderStartCNS: 97_776n * AUSD,
  curve: [],
  books: { rebuiltCNS: 97_776n * AUSD, indexCNS: 97_776n * AUSD, gapCNS: 0n, reconciled: true },
  trades: [
    { key: 'a', symbol: 'BTC', side: 'long', status: 'closed', openedAtMs: T0 + 1, closedAtMs: T0 + 2, leader: { peakLotLNS: 1n, lotDecimals: 5, peakMarginCNS: 1n, netPnlCNS: 1n, leverage: 10 }, copy: { kind: 'copied', actingMarketId: 16, sizeUnits: 2_000n, sizeDecimals: 5, marginCNS: 200n * AUSD, feeCNS: 1n, resultCNS: -64_800_000n, estimate: false, scale: 0.01 } },
    { key: 'b', symbol: 'HYPE', side: 'short', status: 'closed', openedAtMs: T0 + 3, closedAtMs: T0 + 4, leader: { peakLotLNS: 1n, lotDecimals: 5, peakMarginCNS: 1n, netPnlCNS: 1n, leverage: 10 }, copy: { kind: 'skipped', reason: 'not-listed', text: 'HYPE is not listed on testnet.' } },
  ],
  totals: {
    copied: 1, skipped: 4, skippedBy: { 'not-listed': 1, 'open-at-start': 3 }, notListed: [{ symbol: 'HYPE', count: 1 }],
    closedResultCNS: -64_800_000n, openEstimateCNS: 0n, feesCNS: 1n, forcedExits: 0, wins: 0, losses: 1,
    leaderResultOnCopiedCNS: 1n, followerEndEquityCNS: 935_200_000n, lowestFreeCNS: 800n * AUSD,
  },
};

test('the replay screen: the totals, a loss as a loss, the skips named, the limits, and a link to every trade', () => {
  const s = copyReplayScreen({ result: replayed, size: { kind: 'default' }, webUrl: 'https://perpguard.app/', back: { to: 'trader', accountId: 4886 }, ageMs: 0 });
  assert.match(s.html, /^🔁 <b>WHAT IF YOU'D COPIED #4886\?<\/b> · last 30 days\n<i>A replay from indexed data\. Nothing was or will be sent\.<\/i>/);
  assert.match(s.html, /Sized to an account of <b>1,000\.00 AUSD<\/b>\. Link your account and this uses yours\./);
  assert.match(s.html, /📊 <b>−64\.80 AUSD<\/b> on closed copies/);
  assert.match(s.html, /1 · market not on testnet: HYPE ×1/);
  assert.match(s.html, /3 · already open when the window began/);
  assert.match(s.html, /• 09\/07 BTC long · margin 200\.00 AUSD → <b>−64\.80 AUSD<\/b>/);
  assert.match(s.html, /prices and timing differ/);
  assert.match(s.html, /Past results do not predict future returns\./);
  const flat = s.buttons.flat();
  assert.ok(flat.every((b) => !('data' in b)), 'NO ACTION on a replay: nothing here can send');
  assert.deepEqual(flat[0], { text: '📋 Every trade, on the site', url: 'https://perpguard.app/copy/4886?size=1000' });
});

test('a linked reader is told the size is their own account\'s', () => {
  const s = copyReplayScreen({ result: replayed, size: { kind: 'linked', accountId: 710, network: 'testnet' }, webUrl: undefined, back: { to: 'top' }, ageMs: 0 });
  assert.match(s.html, /Sized to your account #710 on testnet: <b>1,000\.00 AUSD<\/b>/);
});

test('a leader too busy to replay is refused whole, in words', () => {
  const s = copyReplayScreen({ result: { kind: 'too-busy', accountId: 4848, openedInWindow: 36_639, cap: 3_000, fromMs: 0, toMs: 30 * 86_400_000 }, size: { kind: 'default' }, webUrl: undefined, back: { to: 'top' }, ageMs: 0 });
  assert.match(s.html, /opened <b>36,639 positions<\/b> in 30 days, more than 3,000/);
});

test('the replay route is PUBLIC (it reads the index) and round-trips', () => {
  const route = { to: 'copy-sim', accountId: 4886 } as const;
  assert.equal(isPublicRoute(route), true);
  assert.deepEqual(decodeNav(encodeNav(route)), route);
});

test('NOT RECONCILED is said with the gap, before any figure', () => {
  const s = copyReplayScreen({ result: { ...replayed, books: { rebuiltCNS: 2_007_404_211n, indexCNS: 4_211n, gapCNS: 2_007_400_000n, reconciled: false } }, size: { kind: 'default' }, webUrl: undefined, back: { to: 'top' }, ageMs: 0 });
  assert.match(s.html, /⚠️ <b>NOT RECONCILED<\/b>: this trader's balance rebuilt from deposits, withdrawals, results and fees is <b>2,007\.40 AUSD<\/b> off the index's own \(2,007\.40 AUSD against 0\.00 AUSD\)/);
  assert.ok(s.html.indexOf('NOT RECONCILED') < s.html.indexOf('📊'), 'said before the result');
  const ok = copyReplayScreen({ result: replayed, size: { kind: 'default' }, webUrl: undefined, back: { to: 'top' }, ageMs: 0 });
  assert.match(ok.html, /✅ Books reconciled: .* to within 0\.00 AUSD\./);
});

test('30 DAYS AND 7, TOGGLED: the screen names its window, marks it, and links the site to the same one', () => {
  const week = copyReplayScreen({ result: { ...replayed, fromMs: replayed.toMs - 7 * 86_400_000 }, size: { kind: 'default' }, webUrl: 'https://perpguard.app', back: { to: 'top' }, ageMs: 0 });
  assert.match(week.html, /· last 7 days/);
  const flat = week.buttons.flat();
  assert.ok(flat.some((b) => b.text === '✅ 7 days'));
  assert.ok(flat.some((b) => b.text === '30 days'));
  assert.ok(flat.some((b) => 'url' in b && b.url.endsWith('&days=7')));
});

test('THE TRADER CARD shows activity and both windows side by side; a week of silence is said', async () => {
  const { traderCardScreen } = await import('./watchScreens.ts');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const card = traderCardScreen({
    stats: { accountId: 5213, month: undefined, lifetime: undefined }, watching: false, starred: false, webUrl: undefined, back: { to: 'top' },
    activity: { lastOpenedAtMs: now - 3 * 3_600_000, opened24h: 4, opened7d: 31 }, nowMs: now,
    copied: { d30: '<b>+730.95 AUSD</b>', d7: '<b>−12.40 AUSD</b>', size: '1,000.00 AUSD' },
  });
  assert.match(card.html, /Activity: last opened a position <b>3 h ago<\/b> · <b>4<\/b> opened in 24 h · <b>31<\/b> in 7 days/);
  assert.match(card.html, /🔁 If copied at 1,000\.00 AUSD, after fees: 30D <b>\+730\.95 AUSD<\/b> · 7D <b>−12\.40 AUSD<\/b>/);
  assert.doesNotMatch(card.html, /24 ?h (P&amp;L|PnL)/, 'no 24-hour P&L');
  const quiet = traderCardScreen({ stats: { accountId: 1, month: undefined, lifetime: undefined }, watching: false, starred: false, webUrl: undefined, back: { to: 'top' }, activity: { lastOpenedAtMs: now - 9 * 86_400_000, opened24h: 0, opened7d: 0 }, nowMs: now });
  assert.match(quiet.html, /⚠️ Nothing opened in over a week: copying would copy nothing\./);
});
