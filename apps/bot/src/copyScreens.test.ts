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
  assert.match(s.html, /3 · already open when the 30 days began/);
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
  const s = copyReplayScreen({ result: { kind: 'too-busy', accountId: 4848, openedInWindow: 36_639, cap: 3_000, fromMs: 0, toMs: 0 }, size: { kind: 'default' }, webUrl: undefined, back: { to: 'top' }, ageMs: 0 });
  assert.match(s.html, /opened <b>36,639 positions<\/b> in 30 days, more than 3,000/);
});

test('the replay route is PUBLIC (it reads the index) and round-trips', () => {
  const route = { to: 'copy-sim', accountId: 4886 } as const;
  assert.equal(isPublicRoute(route), true);
  assert.deepEqual(decodeNav(encodeNav(route)), route);
});
