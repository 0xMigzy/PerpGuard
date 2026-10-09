import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwrCache } from './responseCache.ts';

/** A clock the test moves by hand, and a loader it can resolve by hand. */
function harness() {
  let now = 1_000_000;
  const cache = new SwrCache({ now: () => now, onRefreshError: (key, error) => errors.push(`${key}: ${String(error)}`) });
  const errors: string[] = [];
  let loads = 0;
  let value = 'a';
  const load = async () => {
    loads += 1;
    return `${value}#${loads}`;
  };
  return { cache, load, errors, advance: (ms: number) => (now += ms), setValue: (v: string) => (value = v), loads: () => loads };
}

test('a missing key is loaded once, and concurrent callers share the load', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.cache.get('k', 1000, h.load), h.cache.get('k', 1000, h.load)]);
  assert.equal(a.value, 'a#1');
  assert.equal(b.value, 'a#1');
  assert.equal(h.loads(), 1);
  assert.equal(a.ageMs, 0);
});

test('within the TTL the cached value is served and nothing is loaded', async () => {
  const h = harness();
  await h.cache.get('k', 1000, h.load);
  h.advance(500);
  const entry = await h.cache.get('k', 1000, h.load);
  assert.equal(entry.value, 'a#1');
  assert.equal(entry.ageMs, 500);
  assert.equal(entry.revalidating, false);
  assert.equal(h.loads(), 1);
});

test('past the TTL the OLD value is served immediately and ONE refresh runs behind it', async () => {
  const h = harness();
  await h.cache.get('k', 1000, h.load);
  h.advance(1500);
  h.setValue('b');
  const [stale1, stale2] = await Promise.all([h.cache.get('k', 1000, h.load), h.cache.get('k', 1000, h.load)]);
  assert.equal(stale1.value, 'a#1', 'served without waiting');
  assert.equal(stale1.ageMs, 1500);
  assert.equal(stale2.value, 'a#1');
  // Let the background refresh settle.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.loads(), 2, 'exactly one refresh for two stale readers');
  const fresh = await h.cache.get('k', 1000, h.load);
  assert.equal(fresh.value, 'b#2');
  assert.equal(fresh.ageMs, 0);
});

test('a failed refresh keeps the old value, reports the error, and is retried next time', async () => {
  const h = harness();
  await h.cache.get('k', 1000, h.load);
  h.advance(2000);
  let fail = true;
  const flaky = async () => {
    if (fail) throw new Error('db down');
    return h.load();
  };
  const served = await h.cache.get('k', 1000, flaky);
  assert.equal(served.value, 'a#1');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.errors, ['k: Error: db down']);
  assert.equal((await h.cache.get('k', 1000, flaky)).value, 'a#1', 'still the old value, still served');
  fail = false;
  await new Promise((r) => setTimeout(r, 0));
  h.advance(1);
  await h.cache.get('k', 1000, flaky);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((await h.cache.get('k', 1000, flaky)).value, 'a#2');
});

test('a load that fails with nothing cached throws to the caller and leaves no empty slot behind', async () => {
  const h = harness();
  await assert.rejects(
    h.cache.get('k', 1000, async () => {
      throw new Error('nope');
    }),
    /nope/,
  );
  assert.equal(h.cache.size, 0);
  assert.equal((await h.cache.get('k', 1000, h.load)).value, 'a#1');
});

test('warm computes now, and recentlyRead names the hot set', async () => {
  const h = harness();
  await h.cache.warm('w', h.load);
  assert.equal(h.cache.ageOf('w'), 0);
  await h.cache.get('r', 1000, h.load);
  h.advance(10_000);
  await h.cache.get('r', 1000, h.load);
  assert.deepEqual(h.cache.recentlyRead(5_000), ['r']);
});

test('entries nobody has read for a long time are evicted', async () => {
  const h = harness();
  await h.cache.get('old', 1000, h.load);
  h.advance(31 * 60_000);
  await h.cache.get('new', 1000, h.load);
  assert.equal(h.cache.ageOf('old'), undefined);
  assert.equal(h.cache.size, 1);
});

test('REGRESSION 9 Oct: a re-warmed default read 50 minutes ago is not swept by the next unrelated request', async () => {
  const h = harness();
  await h.cache.warm('metrics:30d', h.load);
  h.advance(10 * 60_000);
  await h.cache.get('metrics:30d', 65 * 60_000, h.load);
  h.advance(50 * 60_000);
  await h.cache.warm('metrics:30d', h.load); // the hourly pass
  h.advance(60_000);
  await h.cache.get('health', 2000, async () => 'h'); // any request sweeps
  h.advance(60_000);
  const hit = await h.cache.get('metrics:30d', 65 * 60_000, h.load);
  assert.equal(hit.value, 'a#2', 'served the warm answer, not a cold load');
  assert.equal(h.loads(), 2);
});

test('a pinned key is never evicted for idleness; an unpinned one still is', async () => {
  const h = harness();
  h.cache.pin(['markets:30d']);
  await h.cache.warm('markets:30d', h.load);
  await h.cache.warm('account:42', h.load);
  h.advance(59 * 60_000);
  await h.cache.get('health', 2000, async () => 'h');
  assert.notEqual(h.cache.ageOf('markets:30d'), undefined);
  assert.equal(h.cache.ageOf('account:42'), undefined);
});
