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

test('WHOLE-UTC-DAY FIGURES: the picked window on the label, the whole days on its hover', async () => {
  const { wholeDaysLabel, wholeDaysTitle, inWholeDays, WHOLE_DAY_PILLS, periodLabel } = await import('./history.ts');
  // 9 Oct 2026 (owner): the VISIBLE label is the picked window, the same words as its neighbours; the whole-day span is the hover.
  for (const t of ['24h', '7d', '30d', 'all'] as const) assert.equal(wholeDaysLabel(t, FEB11), periodLabel(t, FEB11), `${t}: the same visible words as a rolling neighbour`);
  assert.equal(wholeDaysLabel('30d', undefined), '30 days');
  assert.equal(wholeDaysTitle('24h', undefined), 'Yesterday and today so far, in whole UTC days');
  assert.equal(wholeDaysTitle('30d', undefined), 'The last 30 whole UTC days and today so far');
  assert.match(wholeDaysTitle('all', FEB11), /^Every whole UTC day since Feb 11, 2026, and today so far$/);
  assert.equal(inWholeDays('24h', undefined), 'since yesterday 00:00 UTC');
  assert.equal(inWholeDays('7d', undefined), 'over the last 7 whole UTC days and today');
  assert.deepEqual(Object.values(WHOLE_DAY_PILLS).map((p) => p.text), ['24H', '7D', '30D'], 'the same buttons as every other page');
});
