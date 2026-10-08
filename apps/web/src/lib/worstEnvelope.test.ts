import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Envelope } from './api.ts';
import { worstOf } from './worstEnvelope.ts';

const env = (ageMs: number, stale = false, blocksBehind = 0) => ({ ageMs, stale, health: { blocksBehind } }) as unknown as Envelope<unknown>;

test('a page speaks for its OLDEST answer, never its freshest', () => {
  assert.equal(worstOf([env(60_000), env(55 * 60_000), undefined, env(0)])?.ageMs, 55 * 60_000);
});

test('an answer that is not current wins over any age', () => {
  const behind = env(0, true, 400);
  assert.equal(worstOf([env(55 * 60_000), behind, env(0, true, 10)]), behind);
});

test('nothing loaded yet says nothing', () => {
  assert.equal(worstOf([undefined, undefined]), undefined);
});
