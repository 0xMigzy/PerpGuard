import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_CAP, mayHaveMore, nextLimit, splitLiquidationDays } from './liquidations.ts';

test('days split into rescuable and everything else, with a quiet day kept as zero', () => {
  const split = splitLiquidationDays([
    { dayMs: 1, liquidationCount: 5, rescuableLiquidationCount: 3 } as never,
    { dayMs: 2, liquidationCount: 0, rescuableLiquidationCount: 0 } as never,
  ]);
  assert.deepEqual(split, [
    { dayMs: 1, rescuable: 3, other: 2, total: 5 },
    { dayMs: 2, rescuable: 0, other: 0, total: 0 },
  ]);
});

test('load more steps by 50 and stops at the reader cap', () => {
  assert.equal(nextLimit(50), 100);
  assert.equal(nextLimit(480), LIST_CAP);
  assert.equal(nextLimit(LIST_CAP), LIST_CAP);
});

test('there may be more only when the page came back full and the cap is not reached', () => {
  assert.equal(mayHaveMore(50, 50), true);
  assert.equal(mayHaveMore(37, 50), false, 'a short page is the end');
  assert.equal(mayHaveMore(500, 500), false, 'at the cap the list stops and says so');
});
