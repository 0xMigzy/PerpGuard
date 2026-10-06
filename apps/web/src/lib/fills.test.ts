import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountFill } from '@perpguard/shared';
import { FILLS_CSV_HEADER, FILLS_LIST_CAP, fillsCsv, moreFills, nextFillsLimit } from './fills.ts';

const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC Perp' };
const fill = (role: 'maker' | 'taker', over: Partial<AccountFill> = {}): AccountFill => ({
  id: '0xabc-3', atMs: Date.UTC(2026, 9, 6, 10, 0, 0), txHash: '0xabc', market: BTC, role, sizeLots: 0.5, price: 84805,
  notionalAusd: 42402.5, makerFeeAusd: role === 'maker' ? 4.24025 : undefined, ...over,
});

test('the CSV names the role, leaves a taker\'s fee EMPTY (never 0), and keeps every figure exact', () => {
  const csv = fillsCsv(4734, [fill('taker'), fill('maker', { price: undefined })]);
  const [head, taker, maker] = csv.trimEnd().split('\r\n');
  assert.equal(head, FILLS_CSV_HEADER.join(','));
  assert.equal(taker, '2026-10-06T10:00:00.000Z,4734,BTC,,taker,0.5,84805,42402.5,,0xabc', 'no matched position event: an empty direction');
  assert.equal(maker, '2026-10-06T10:00:00.000Z,4734,BTC,,maker,0.5,,42402.5,4.24025,0xabc', 'an unknown price is an empty cell');
  const withDir = fillsCsv(1, [fill('maker', { direction: { action: 'reduce', side: 'short' } })]);
  assert.match(withDir, /,BTC,Reduce short,maker,/);
  assert.ok(csv.endsWith('\r\n'));
});

test('a market name with a comma is quoted, not split', () => {
  const csv = fillsCsv(1, [fill('maker', { market: { marketId: 9, symbol: 'A,B', indexerName: 'A,B' } })]);
  assert.match(csv, /,"A,B",,maker,/);
});

test('"Show more" follows the backend, up to the on-screen cap', () => {
  assert.equal(moreFills(50, true), true);
  assert.equal(moreFills(50, false), false);
  assert.equal(moreFills(FILLS_LIST_CAP, true), false, 'past the cap, the CSV is the way to more');
  assert.equal(nextFillsLimit(50), 100);
  assert.equal(nextFillsLimit(480), FILLS_LIST_CAP);
});

test('direction labels: the action and the side, a flip named by the side it lands on', async () => {
  const { directionLabel } = await import('./fills.ts');
  assert.equal(directionLabel({ action: 'open', side: 'long' }), 'Open long');
  assert.equal(directionLabel({ action: 'add', side: 'short' }), 'Add short');
  assert.equal(directionLabel({ action: 'reduce', side: 'long' }), 'Reduce long');
  assert.equal(directionLabel({ action: 'close', side: 'short' }), 'Close short');
  assert.equal(directionLabel({ action: 'flip', side: 'long' }), 'Flip to long');
  assert.equal(directionLabel(undefined), undefined);
});
