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

test('WHOLE-UTC-DAY FIGURES SAY SO: one label per window, never the rolling words', async () => {
  const { wholeDaysLabel, inWholeDays, WHOLE_DAY_PILLS, periodLabel } = await import('./history.ts');
  assert.equal(wholeDaysLabel('24h', undefined), 'yesterday + today');
  assert.equal(wholeDaysLabel('7d', undefined), 'last 7 whole days + today');
  assert.equal(wholeDaysLabel('30d', undefined), 'last 30 whole days + today');
  assert.equal(wholeDaysLabel('all', FEB11), periodLabel('all', FEB11), 'all history is the same either way');
  assert.equal(inWholeDays('24h', undefined), 'since yesterday 00:00 UTC');
  assert.equal(inWholeDays('7d', undefined), 'over the last 7 whole UTC days and today');
  for (const t of ['24h', '7d', '30d'] as const) assert.notEqual(wholeDaysLabel(t, undefined), periodLabel(t, undefined), `${t}: a whole-day figure never carries the rolling label`);
  assert.deepEqual(Object.values(WHOLE_DAY_PILLS).map((p) => p.text), ['24H', '7D', '30D'], 'the same buttons as every other page');
});
