import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWindow, utcDaysIn } from './windowSplit.ts';

const t = (s: string) => Date.parse(s);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const show = (s: ReturnType<typeof splitWindow>) => ({
  days: s.days === undefined ? undefined : [iso(s.days.fromMs), iso(s.days.toMs)],
  edges: s.edges.map((e) => [iso(e.fromMs), iso(e.toMs)]),
});

const NOW = t('2026-10-08T09:40:00Z');

test('30 days: the ragged first day and today are scanned, the 29 whole days between come from per-day sums', () => {
  assert.deepEqual(show(splitWindow(t('2026-09-08T09:40:00Z'), NOW, NOW)), {
    days: ['2026-09-09T00:00:00.000Z', '2026-10-08T00:00:00.000Z'],
    edges: [
      ['2026-09-08T09:40:00.000Z', '2026-09-09T00:00:00.000Z'],
      ['2026-10-08T00:00:00.000Z', '2026-10-08T09:40:00.000Z'],
    ],
  });
});

test('THE ROLLING 24 HOURS STAYS ROLLING: no whole day fits, so it is one exact scan', () => {
  assert.deepEqual(show(splitWindow(t('2026-10-07T09:40:00Z'), NOW, NOW)), {
    days: undefined,
    edges: [['2026-10-07T09:40:00.000Z', '2026-10-08T09:40:00.000Z']],
  });
});

test('a previous window ending mid-day keeps its tail exact', () => {
  assert.deepEqual(show(splitWindow(t('2026-08-09T09:40:00Z'), t('2026-09-08T09:40:00Z'), NOW)), {
    days: ['2026-08-10T00:00:00.000Z', '2026-09-08T00:00:00.000Z'],
    edges: [
      ['2026-08-09T09:40:00.000Z', '2026-08-10T00:00:00.000Z'],
      ['2026-09-08T00:00:00.000Z', '2026-09-08T09:40:00.000Z'],
    ],
  });
});

test('all: every closed day from the start, then today so far', () => {
  assert.deepEqual(show(splitWindow(undefined, NOW, NOW)), {
    days: [undefined, '2026-10-08T00:00:00.000Z'],
    edges: [['2026-10-08T00:00:00.000Z', '2026-10-08T09:40:00.000Z']],
  });
});

test('a day the index has not finished stays in the scanned tail', () => {
  // 00:03 and the index is still in yesterday: yesterday is not final.
  const now = t('2026-10-08T00:03:00Z');
  assert.deepEqual(show(splitWindow(t('2026-09-08T00:03:00Z'), now, t('2026-10-07T23:59:50Z'))), {
    days: ['2026-09-09T00:00:00.000Z', '2026-10-07T00:00:00.000Z'],
    edges: [
      ['2026-09-08T00:03:00.000Z', '2026-09-09T00:00:00.000Z'],
      ['2026-10-07T00:00:00.000Z', '2026-10-08T00:03:00.000Z'],
    ],
  });
});

test('nothing known final: the whole window is scanned, exactly as before', () => {
  assert.deepEqual(show(splitWindow(t('2026-09-08T09:40:00Z'), NOW, undefined)), {
    days: undefined,
    edges: [['2026-09-08T09:40:00.000Z', '2026-10-08T09:40:00.000Z']],
  });
});

test('a window starting exactly at midnight has no leading edge', () => {
  const s = splitWindow(t('2026-09-08T00:00:00Z'), NOW, NOW);
  assert.equal(iso(s.days?.fromMs), '2026-09-08T00:00:00.000Z');
  assert.equal(s.edges.length, 1);
});

test('the parts tile the window: no instant twice, none missed', () => {
  for (const [since, until, closed] of [
    [t('2026-09-08T09:40:00Z'), NOW, NOW],
    [t('2026-10-07T23:00:00Z'), t('2026-10-08T01:00:00Z'), NOW],
    [t('2026-09-01T12:00:00Z'), t('2026-10-08T00:00:00Z'), t('2026-10-02T05:00:00Z')],
  ] as const) {
    const s = splitWindow(since, until, closed);
    const parts = [...(s.days === undefined ? [] : [s.days]), ...s.edges].map((r) => [r.fromMs!, r.toMs] as const).sort((a, b) => a[0] - b[0]);
    assert.equal(parts[0]![0], since);
    assert.equal(parts.at(-1)![1], until);
    for (let i = 1; i < parts.length; i += 1) assert.equal(parts[i]![0], parts[i - 1]![1]);
  }
});

test('utcDaysIn lists day starts', () => {
  assert.deepEqual(utcDaysIn(t('2026-10-06T00:00:00Z'), t('2026-10-08T00:00:00Z')).map((d) => iso(d)), ['2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z']);
});
