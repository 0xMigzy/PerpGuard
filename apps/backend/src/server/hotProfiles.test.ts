import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotProfileIds, ProfileWarmer } from './hotProfiles.ts';

test('the hot set: busiest, then the leaderboard, then watched, each once; a failed source adds nothing', async () => {
  assert.deepEqual(await hotProfileIds({ busiest: async () => [10, 4638], leaderboard: async () => [4638, 1, 2], watched: () => [2, 99] }), [10, 4638, 1, 2, 99]);
  assert.deepEqual(await hotProfileIds({ busiest: async () => Promise.reject(new Error('db')), leaderboard: async () => [1], watched: () => { throw new Error('x'); } }), [1]);
});

test('one at a time, never two cycles at once, and one failing profile never stops the rest', async () => {
  const order: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const warmer = new ProfileWarmer({
    sources: { busiest: async () => [1, 2, 3], leaderboard: async () => [], watched: () => [] },
    warm: async (id) => {
      if (id === 1) await gate;
      order.push(id);
      if (id === 2) throw new Error('boom');
    },
  });
  const first = warmer.run();
  assert.equal(await warmer.run(), 'skipped');
  release();
  assert.equal(await first, 2, 'profiles 1 and 3 warmed; 2 failed and the cycle went on');
  assert.deepEqual(order, [1, 2, 3]);
});
