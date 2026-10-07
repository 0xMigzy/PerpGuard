import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CopySourcePosition } from '@perpguard/shared';
import { decideOpen, plan, type OpenInput } from './decide.ts';
import type { CopyLeg } from './store.ts';

const AUSD = 1_000_000n;
const T0 = Date.parse('2026-10-07T12:00:00Z');

const leader = (o: Partial<CopySourcePosition> = {}): CopySourcePosition => ({
  key: '1-5213-1',
  market: { marketId: 1, symbol: 'BTC', indexerName: 'BTC' },
  side: 'long',
  status: 'open',
  lotDecimals: 5,
  priceDecimals: 1,
  peakLotLNS: 100_000n,
  lotLNS: 100_000n, // 1 BTC
  entryPricePNS: 1_000_000n, // 100,000.0
  peakMarginCNS: 10_000n * AUSD, // 10x
  netPnlCNS: 0n,
  leverageHdths: 1000n,
  openedAtMs: T0 + 1_000,
  closedAtMs: undefined,
  ...o,
});

const leg = (o: Partial<CopyLeg> = {}): CopyLeg => ({
  ruleId: 1, leaderKey: '1-5213-1', leaderMarketId: 1, symbol: 'BTC', side: 'long', leaderOpenedAtMs: T0 + 1_000, status: 'open', reason: undefined,
  actingMarketId: 16, sizeLNS: 1_000n, leverageHundredths: 1000, positionId: 77, openKey: 'copy:710:1-5213-1:open', closeKey: undefined, openedAtMs: T0 + 2_000, closedAtMs: undefined, ...o,
});

const input = (o: Partial<OpenInput> = {}): OpenInput => ({
  leader: leader(),
  leaderEquityCNS: 100_000n * AUSD,
  followerEquityCNS: 1_000n * AUSD,
  followerFreeCNS: 900n * AUSD,
  keepFreeCNS: 500n * AUSD,
  acting: { marketId: 16, symbol: 'BTC', sizeDecimals: 5, maxLeverage: 15, markPrice: 100_000 },
  actingNetwork: 'testnet',
  followerHoldsMarket: false,
  collateralDecimals: 6,
  ...o,
});

test('PLAN: new opens after the start are opened, older ones never; a leader close closes an open copy; a position opened and closed between looks is recorded as missed', () => {
  const rule = { startedAtMs: T0 };
  const steps = plan(rule, [leg({ leaderKey: 'b', status: 'open' })], [
    leader({ key: 'old', openedAtMs: T0 - 1 }),
    leader({ key: 'a' }),
    leader({ key: 'b', status: 'closed', closedAtMs: T0 + 9_000 }),
    leader({ key: 'c', status: 'closed', openedAtMs: T0 + 3_000, closedAtMs: T0 + 4_000 }),
  ]);
  assert.deepEqual(steps.map((s) => `${s.kind}:${s.kind === 'close' ? s.leg.leaderKey : s.leader.key}`), ['open:a', 'missed:c', 'close:b']);
  // A leg already claimed is never planned again, whatever its status.
  assert.deepEqual(plan(rule, [leg({ leaderKey: 'a', status: 'not-opened' })], [leader({ key: 'a' })]), []);
});

test('2% -> 2% BY NOTIONAL: a 1,000 AUSD follower of a 100,000 AUSD leader opens 1% of the position\'s value at the ACTING mark', () => {
  const d = decideOpen(input());
  assert.equal(d.kind, 'send');
  if (d.kind !== 'send') return;
  assert.equal(d.sizeLNS, 1_000n, '0.01 BTC: 1,000 AUSD of value at 100,000');
  assert.equal(d.leverageHundredths, 1000);
  assert.equal(d.marginCNS, 100n * AUSD);
  assert.equal(d.share, 0.01);
  // Prices differ across networks: at a testnet mark of 50,000 the same value is twice the lots.
  const cheap = decideOpen(input({ acting: { marketId: 16, symbol: 'BTC', sizeDecimals: 5, maxLeverage: 15, markPrice: 50_000 } }));
  assert.ok(cheap.kind === 'send' && cheap.sizeLNS === 2_000n);
});

test('NO CAPS: the only limit is the free balance kept, and going under it is SKIPPED AND SAID with the figures', () => {
  const d = decideOpen(input({ followerFreeCNS: 550n * AUSD }));
  assert.equal(d.kind, 'skip');
  assert.ok(d.kind === 'skip' && d.reason === 'floor');
  assert.match(d.kind === 'skip' ? d.text : '', /^Not copied: it needs about 100\.00 AUSD of margin, and your free balance \(550\.00 AUSD\) would fall below the 500\.00 AUSD you keep free\.$/);
  assert.equal(decideOpen(input({ followerFreeCNS: 550n * AUSD, keepFreeCNS: 0n })).kind, 'send', 'keep free 0 is allowed');
});

test('a leverage above the acting maximum opens at the maximum (same size, more margin), and says so', () => {
  const d = decideOpen(input({ leader: leader({ leverageHdths: 4000n }) }));
  assert.ok(d.kind === 'send');
  if (d.kind !== 'send') return;
  assert.equal(d.leverageHundredths, 1500);
  assert.equal(d.leverageCapped, true);
  assert.equal(d.marginCNS, 66_666_667n, '1,000 AUSD at 15x, rounded up');
});

test('skips are named: market not on testnet, a position already held there, no price, too small, balance unknown', () => {
  const by = (o: Partial<OpenInput>) => {
    const d = decideOpen(input(o));
    return d.kind === 'skip' ? `${d.reason}: ${d.text}` : 'send';
  };
  assert.equal(by({ acting: undefined, leader: leader({ market: { marketId: 60, symbol: 'HYPE', indexerName: 'HYPE' } }) }), 'not-listed: HYPE is not listed on testnet, so it cannot be copied.');
  assert.match(by({ followerHoldsMarket: true }), /^holds-market: You already hold a BTC position on testnet/);
  assert.match(by({ acting: { marketId: 16, symbol: 'BTC', sizeDecimals: 5, maxLeverage: 15, markPrice: undefined } }), /^no-price/);
  assert.match(by({ leader: leader({ lotLNS: 1n }) }), /^too-small/);
  assert.match(by({ followerFreeCNS: undefined }), /^balance-unknown/);
});
