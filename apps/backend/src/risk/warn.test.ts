import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextState } from './state.ts';
import { DEFAULT_THRESHOLDS } from './types.ts';
import { WARN_LEVELS, thresholdsFor, warnLevelByIndex } from './warn.ts';

const first = (buffer: number, level: Parameters<typeof thresholdsFor>[0]) =>
  nextState({ current: undefined, enteredAtMs: undefined, liqBufferPct: buffer, priceIsOld: false, nowMs: 1, thresholds: thresholdsFor(level) }).state;

test('no level ever moves DANGER: it is 3% in, 4% out, for every choice', () => {
  for (const { level } of WARN_LEVELS) {
    const t = thresholdsFor(level);
    assert.equal(t.dangerEnterPct, DEFAULT_THRESHOLDS.dangerEnterPct);
    assert.equal(t.dangerExitPct, DEFAULT_THRESHOLDS.dangerExitPct);
    assert.ok(t.watchEnterPct >= t.dangerEnterPct && t.watchExitPct >= t.dangerExitPct, `${level} keeps the ordering`);
    assert.equal(first(0.029, level), 'DANGER');
  }
});

test('early warns at 9.5%, normal does not; normal is exactly today’s default', () => {
  assert.equal(first(0.095, 'early'), 'WATCH');
  assert.equal(first(0.095, 'normal'), 'SAFE');
  assert.deepEqual(thresholdsFor('normal'), DEFAULT_THRESHOLDS);
});

test('last minute has no WATCH band: 5% is quiet, 2.9% is DANGER', () => {
  assert.equal(first(0.05, 'last-minute'), 'SAFE');
  assert.equal(first(0.031, 'last-minute'), 'SAFE');
  assert.equal(first(0.029, 'last-minute'), 'DANGER');
});

test('levels round-trip through their button index', () => {
  for (const l of WARN_LEVELS) assert.equal(warnLevelByIndex(l.index), l.level);
  assert.equal(warnLevelByIndex(7), undefined);
});
