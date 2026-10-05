import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inPeriod, periodLabel, windowRange } from './history.ts';

const FEB11 = Date.UTC(2026, 1, 11, 23, 2, 32);

test('All is named from the index start, and claims nothing before that is known', () => {
  assert.equal(periodLabel('all', FEB11), 'since Feb 11, 2026');
  assert.equal(periodLabel('all', undefined), 'all indexed history');
  assert.equal(periodLabel('30d', FEB11), '30 days');
  assert.equal(inPeriod('30d', FEB11), 'in the last 30 days');
  assert.equal(inPeriod('all', FEB11), 'since Feb 11, 2026');
});

test('a window range uses the index start when the window has none', () => {
  assert.equal(windowRange(undefined, Date.UTC(2026, 9, 1), FEB11), 'Feb 11, 2026 – Oct 1, 2026');
  assert.equal(windowRange(Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1), FEB11), 'Sep 1, 2026 – Oct 1, 2026');
});

test('the Traders pages name their 24H window for what it is: yesterday and today, never "today" or "24h"', async () => {
  const { dayPeriodLabel, inDayPeriod, DAY_BUCKET_24H } = await import('./history.ts');
  assert.equal(dayPeriodLabel('24h', undefined), 'yesterday + today');
  assert.equal(inDayPeriod('24h', undefined), 'since yesterday 00:00 UTC');
  assert.equal(DAY_BUCKET_24H.pill, '2D');
  assert.equal(dayPeriodLabel('30d', undefined), '30 days', 'other windows unchanged');
});
