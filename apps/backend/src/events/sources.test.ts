import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityFeed, FeedLiquidation, OpenPosition, TakerFill } from '@perpguard/shared';
import { FeedPoller, PositionChanges } from './sources.ts';
import { InMemoryLedger } from './ledger.ts';
import type { PerpEvent } from './types.ts';

const BTC = { marketId: 1, symbol: 'BTC', indexerName: 'BTC' };
const recorder = () => {
  const got: PerpEvent[] = [];
  return { got, publisher: { publish: async (events: readonly PerpEvent[]) => void got.push(...events) } };
};

test('position changes: first pass is a baseline; an unwatched account is forgotten, so re-watching starts fresh', async () => {
  const r = recorder();
  const changes = new PositionChanges(r.publisher);
  const pos = (sizeLots: number): OpenPosition => ({ market: BTC, side: 'long', sizeLots, entryPrice: 1, marginAusd: 1, leverage: 1, openedAtMs: 1, marginAddedAusd: 0 });
  const pass = (watched: number[], reads: [number, OpenPosition[]][]) => ({ seenAtMs: 1, indexerBlock: 5, blocksBehind: 2, watched, reads: new Map(reads) });
  await changes.observe(pass([7], [[7, [pos(1)]]]));
  assert.equal(r.got.length, 0, 'baseline');
  await changes.observe(pass([7], [[7, [pos(2)]]]));
  assert.deepEqual(r.got.map((e) => e.kind), ['position-increased']);
  await changes.observe(pass([], []));
  await changes.observe(pass([7], [[7, [pos(5)]]]));
  assert.equal(r.got.length, 1, 'watched again: a new baseline, not "increased" across the gap');
  await changes.observe(pass([7], []));
  assert.equal(r.got.length, 1, 'an account whose read failed is not reported closed');
});

function feed(state: { liqs: FeedLiquidation[]; fills: TakerFill[]; asked: number[] }): ActivityFeed {
  return {
    liquidationsSince: async (since) => (state.asked.push(since), state.liqs.filter((l) => l.atMs >= since)),
    takerFillsSince: async (since) => state.fills.filter((f) => f.atMs >= since),
  };
}
const liq = (id: string, atMs: number) => ({ id, atMs, accountId: 9, market: BTC, notionalAusd: 12_000 }) as FeedLiquidation;
const fill = (tx: string, atMs: number, notionalAusd: number) => ({ id: `${tx}-1`, txHash: tx, blockNumber: 1, atMs, market: BTC, takerAccountId: 9, sizeLots: 1, price: 1, notionalAusd }) as TakerFill;

test('the feed starts NOW on first run, then resumes from its stored cursor with an overlap', async () => {
  const state = { liqs: [liq('old', 500_000)], fills: [], asked: [] as number[] };
  const ledger = new InMemoryLedger();
  const r = recorder();
  const clock = { t: 1_000_000 };
  const poller = new FeedPoller({ feed: feed(state), cursor: ledger, publisher: r.publisher, freshness: async () => ({ indexerBlock: 1, blocksBehind: 1 }), direction: async () => undefined, minLargeTradeAusd: 10_000, logger: { info() {}, warn() {} }, now: () => clock.t, overlapMs: 60_000 });
  await poller.poll();
  assert.equal(r.got.length, 0, 'a liquidation from before we started is history, not news');
  assert.deepEqual(state.asked, [940_000]);
  state.liqs.push(liq('new', 1_005_000));
  await poller.poll();
  assert.deepEqual(r.got.map((e) => e.id), ['new']);
  assert.equal(await ledger.get('index-feed'), 1_005_000, 'the cursor is the index\'s own time');
  await poller.poll();
  assert.equal(r.got.length, 1, 'the overlap re-reads it; it is not published again');
});

test('large trades: fills grouped into orders, below the smallest threshold ignored, direction from the receipt', async () => {
  const state = { liqs: [], fills: [fill('0xa', 1_001_000, 6_000), fill('0xa', 1_001_000, 6_000), fill('0xb', 1_002_000, 4_000)], asked: [] as number[] };
  const ledger = new InMemoryLedger();
  await ledger.set('index-feed', 1_000_000);
  const r = recorder();
  const asked: string[] = [];
  const poller = new FeedPoller({ feed: feed(state), cursor: ledger, publisher: r.publisher, freshness: async () => ({ indexerBlock: 1, blocksBehind: 1 }), direction: async (tx) => (asked.push(tx), { action: 'open', side: 'short' }), minLargeTradeAusd: 10_000, logger: { info() {}, warn() {} } });
  await poller.poll();
  assert.equal(r.got.length, 1);
  const e = r.got[0]!;
  assert.ok(e.kind === 'large-trade');
  assert.equal(e.order.notionalAusd, 12_000, 'two 6K fills of one order are one 12K trade');
  assert.deepEqual(e.direction, { action: 'open', side: 'short' });
  assert.deepEqual(asked, ['0xa'], 'only orders worth alerting on are resolved');
});

test('a feed that cannot be read is logged, publishes nothing, and does not move the cursor', async () => {
  const ledger = new InMemoryLedger();
  await ledger.set('index-feed', 1_000_000);
  const logs: string[] = [];
  const poller = new FeedPoller({ feed: { liquidationsSince: async () => { throw new Error('db down'); }, takerFillsSince: async () => [] }, cursor: ledger, publisher: recorder().publisher, freshness: async () => ({ indexerBlock: 1, blocksBehind: 1 }), direction: async () => undefined, minLargeTradeAusd: 10_000, logger: { info() {}, warn: (m) => logs.push(m) } });
  assert.deepEqual(await poller.poll(), []);
  assert.match(logs[0]!, /could not be read \(db down\)/);
  assert.equal(await ledger.get('index-feed'), 1_000_000);
});
