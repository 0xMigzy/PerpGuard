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

test('the launch month is not a whole month: Feb (from Feb 11) to Mar is not the step, Jun to Jul is', () => {
  const months = [m(1, 12_576), m(2, 245_917), m(5, 520_893), m(6, 8_638_872), m(9, 72_435, true)];
  assert.equal(formatMonth(biggestStep(months)!.to.monthMs), 'Mar 2026', 'without the start, Feb counts');
  const step = biggestStep(months, Date.UTC(2026, 1, 11, 23, 2));
  assert.equal(formatMonth(step!.to.monthMs), 'Jul 2026');
  assert.equal(Math.round(step!.factor), 17);
});
