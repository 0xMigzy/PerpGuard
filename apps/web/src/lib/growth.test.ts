import { test } from 'node:test';
import assert from 'node:assert/strict';
import { biggestStep, formatMonth } from './growth.ts';

const m = (month: number, trades: number, partial = false) => ({ monthMs: Date.UTC(2026, month, 1), trades, volumeAusd: 0, newAccounts: 0, partial });

test('the biggest step is between whole months only; a partial month is never compared', () => {
  const step = biggestStep([m(5, 520_893), m(6, 8_638_872), m(7, 7_296_691), m(9, 67_145, true)]);
  assert.equal(formatMonth(step!.to.monthMs), 'Jul 2026');
  assert.equal(Math.round(step!.factor), 17);
  assert.equal(biggestStep([m(1, 0), m(2, 10, true)]), undefined);
});
