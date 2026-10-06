import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWarning, levelsLabel, parseCustomLevels, presetOf, rearmAt, severityOf, WARNING_PRESETS } from './warnings.ts';

const walk = (levels: readonly number[], path: number[]) => {
  let disarmed: readonly number[] = [];
  const fired: Array<number | undefined> = [];
  for (const d of path) {
    const r = evaluateWarning(levels, d, disarmed);
    fired.push(r.fire);
    disarmed = r.disarmed;
  }
  return fired;
};

test('each level fires once on the way down; a wobble around a line sends nothing more', () => {
  assert.deepEqual(walk([10, 5], [12, 9.9, 9.5, 10.1, 9.8, 6, 4.9, 5.1, 4.8]), [undefined, 10, undefined, undefined, undefined, undefined, 5, undefined, undefined]);
});

test('a fall through several levels at once is ONE warning, at the most severe', () => {
  assert.deepEqual(walk([20, 10, 5], [25, 4]), [undefined, 5]);
  assert.deepEqual(walk([20, 10, 5], [25, -1]), [undefined, 5], 'past the closing price crosses every level');
});

test('a level re-arms only after recovering past it by a quarter (at least half a point)', () => {
  assert.equal(rearmAt(5), 6.25);
  assert.equal(rearmAt(1), 1.5);
  assert.deepEqual(walk([5], [4.9, 6.2, 4.9]), [5, undefined, undefined], 'not far enough back up');
  assert.deepEqual(walk([5], [4.9, 6.3, 4.9]), [5, undefined, 5], 'recovered: armed again');
});

test('changing the levels drops state for levels no longer chosen', () => {
  const r = evaluateWarning([10, 5], 4, [20, 10]);
  assert.equal(r.fire, 5);
  assert.deepEqual(r.disarmed, [10, 5]);
});

test('custom levels: up to five, above 0 and at most 100, distinct, sorted highest first', () => {
  assert.deepEqual(parseCustomLevels('3 15% 8'), { levels: [15, 8, 3] });
  assert.deepEqual(parseCustomLevels('2.5, 50'), { levels: [50, 2.5] });
  assert.match((parseCustomLevels('1 2 3 4 5 6') as { error: string }).error, /At most 5/);
  assert.match((parseCustomLevels('0 5') as { error: string }).error, /above 0/);
  assert.match((parseCustomLevels('101') as { error: string }).error, /at most 100/);
  assert.match((parseCustomLevels('5 5') as { error: string }).error, /twice/);
  assert.match((parseCustomLevels('ten') as { error: string }).error, /not a number/);
  assert.match((parseCustomLevels('  ') as { error: string }).error, /one to five/);
});

test('presets are named back; the label is the levels; severity follows the chat\'s own levels', () => {
  assert.equal(presetOf(WARNING_PRESETS.early), 'early');
  assert.equal(presetOf([10, 5]), 'standard');
  assert.equal(presetOf([]), 'off');
  assert.equal(presetOf([15, 8]), 'custom');
  assert.equal(levelsLabel([10, 5]), '10% / 5%');
  assert.equal(levelsLabel([]), 'Off');
  assert.equal(severityOf(5, [20, 10, 5], 4).word, 'CRITICAL');
  assert.equal(severityOf(10, [20, 10, 5], 9).word, 'HIGH');
  assert.equal(severityOf(20, [20, 10, 5], 19).word, 'MEDIUM');
  assert.equal(severityOf(20, [20, 10, 5], -1).word, 'CRITICAL', 'past the closing price is critical whatever the level');
});
