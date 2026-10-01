/**
 * The watch loop: indexed positions, venue marks, the owner's state machine.
 *
 * The fixtures are the alert layer's own — the same BTC position and mark that
 * drive the owner's tests — rebuilt as the index would serve them, so a
 * watched DANGER is the engine's DANGER, not a second opinion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IndexerHealth, MarketOpenInterest, OpenPosition, WalletProfile } from '@perpguard/shared';
import { BTC, CONFIGS, FIXTURE_BTC, FIXTURE_BTC_MARK, SAFE_BTC } from '../alerts/testSupport.ts';
import type { RiskChange } from '../risk/types.ts';
import { WatchLoop, labelOf } from './loop.ts';

const T0 = 9_000_000;
const OWNER = '0xb7854953a71e45d1033b3d619e76d56391291765';

const open = (margin: number): OpenPosition => ({
  market: { marketId: BTC.marketId, symbol: 'BTC', indexerName: 'BTC' },
  side: 'long',
  sizeLots: FIXTURE_BTC.size,
  entryPrice: FIXTURE_BTC.entryPrice,
  marginAusd: margin,
  leverage: 15,
  openedAtMs: T0 - 60_000,
  marginAddedAusd: 0,
});

const profileOf = (accountId: number, positions: readonly OpenPosition[], address = OWNER): WalletProfile =>
  ({ accountId, address, openPositions: positions }) as unknown as WalletProfile;

const synced: IndexerHealth = { state: 'synced', blocksBehind: 12, headIsIndependent: true, latestProcessedBlock: 109_000_000, serveAsCurrent: true, observedAtMs: T0 } as IndexerHealth;
const mark = (price: number, atMs = T0): MarketOpenInterest => ({
  venue: 'perpl',
  network: 'mainnet',
  marketId: BTC.marketId,
  symbol: 'BTC',
  openInterestSize: 1,
  markPrice: price,
  openInterestNotional: price,
  atBlock: 1,
  atMs,
});

interface Rig {
  readonly loop: WatchLoop;
  readonly changes: RiskChange[];
  profiles: Map<number, WalletProfile | undefined>;
  health: IndexerHealth;
  marks: MarketOpenInterest[];
  now: number;
  watched: number[];
  profileError: Error | undefined;
  readonly infos: string[];
}

function rig(): Rig {
  const state: Rig = {
    loop: undefined as unknown as WatchLoop,
    changes: [],
    profiles: new Map([[5293, profileOf(5293, [open(FIXTURE_BTC.margin)])]]),
    health: synced,
    marks: [mark(FIXTURE_BTC_MARK)],
    now: T0,
    watched: [5293],
    profileError: undefined,
    infos: [],
  };
  const loop = new WatchLoop({
    subscriptions: { accountIds: () => state.watched },
    profile: async (id) => {
      if (state.profileError !== undefined) throw state.profileError;
      return state.profiles.get(id);
    },
    health: async () => state.health,
    marks: async () => state.marks,
    configs: async () => CONFIGS,
    staleMs: 10_000,
    now: () => state.now,
    logger: { info: (m) => state.infos.push(m), warn: (m) => state.infos.push(`WARN ${m}`) },
  });
  loop.onChange((c) => state.changes.push(c));
  (state as { loop: WatchLoop }).loop = loop;
  return state;
}

test('a watched position is classified with the owner’s thresholds, scoped to its account, with no top-up', async () => {
  const r = rig();
  const produced = await r.loop.evaluate();
  assert.equal(produced.length, 1);
  const a = produced[0]!;
  assert.equal(a.state, 'DANGER');
  assert.equal(a.symbol, 'BTC');
  assert.equal(a.side, 'long');
  assert.equal(a.topUp, undefined, 'a watcher is never offered an action');
  assert.equal(a.positionId, undefined);
  assert.deepEqual(a.watch, { accountId: 5293, label: '#5293 (0xb785…1765)', indexerBlock: 109_000_000, blocksBehind: 12, indexerState: 'synced', sizeUnits: FIXTURE_BTC.size, toClearDangerCNS: 561_460_000n });
  assert.equal(a.priceIsOld, false);
  assert.equal(a.heldOnStalePrice, false);
  assert.equal(r.changes.length, 1, 'first sight is a change');
  assert.equal(r.changes[0]!.previousState, undefined);
  // A second pass with nothing moved is not a change.
  r.now += 1_000;
  await r.loop.evaluate();
  assert.equal(r.changes.length, 1);
});

test('an index that is not serving current figures HOLDS the severity: no all-clear from an old position set', async () => {
  const r = rig();
  await r.loop.evaluate();
  // The account tops up (as the index will eventually show), but the index is behind.
  r.profiles.set(5293, profileOf(5293, [open(SAFE_BTC.margin)]));
  r.health = { ...synced, state: 'lagging', blocksBehind: 5_000, serveAsCurrent: false };
  r.now += 120_000;
  r.marks = [mark(FIXTURE_BTC_MARK, r.now)];
  const [a] = await r.loop.evaluate();
  assert.equal(a!.state, 'DANGER', 'held');
  assert.equal(a!.heldOnStalePrice, true);
  assert.equal(a!.positions, 'stale');
  assert.match(a!.reason, /index 5000 blocks behind/);
  assert.equal(r.changes.length, 1, 'no change was emitted while held');
  // Once the index is current again, the recovery goes through (dwell long served).
  r.health = synced;
  r.now += 1_000;
  r.marks = [mark(FIXTURE_BTC_MARK, r.now)];
  const [b] = await r.loop.evaluate();
  assert.equal(b!.state, 'SAFE');
  assert.equal(r.changes.at(-1)!.assessment.state, 'SAFE');
});

test('a halted index makes the watched position blind, keeps its last severity, and names the cause', async () => {
  const r = rig();
  await r.loop.evaluate();
  r.health = { ...synced, state: 'halted', serveAsCurrent: false, reason: 'the indexer has stopped' };
  r.now += 1_000;
  const [a] = await r.loop.evaluate();
  assert.equal(a!.state, 'POSITIONS_UNTRUSTED');
  assert.equal(a!.lastKnownState, 'DANGER');
  assert.equal(a!.topUp, undefined);
  assert.match(a!.reason, /the indexer has stopped/);
  assert.equal(a!.watch?.indexerState, 'halted');
  assert.equal(r.changes.at(-1)!.assessment.state, 'POSITIONS_UNTRUSTED');
});

test('a mark the venue does not report makes the position blind as FEED_DOWN, not silently skipped', async () => {
  const r = rig();
  await r.loop.evaluate();
  r.marks = [];
  r.now += 1_000;
  const [a] = await r.loop.evaluate();
  assert.equal(a!.state, 'FEED_DOWN');
  assert.match(a!.reason, /reports no mark for BTC/);
});

test('an unreadable index for one account goes blind with the error, and never throws out of the loop', async () => {
  const r = rig();
  await r.loop.evaluate();
  r.profileError = new Error('connection refused');
  r.now += 1_000;
  const [a] = await r.loop.evaluate();
  assert.equal(a!.state, 'POSITIONS_UNTRUSTED');
  assert.match(a!.reason, /could not be read for account 5293: connection refused/);
});

test('a position without an entry price is not assessed, and is said once rather than per pass', async () => {
  const r = rig();
  r.profiles.set(5293, profileOf(5293, [{ ...open(FIXTURE_BTC.margin), entryPrice: undefined }]));
  assert.deepEqual(await r.loop.evaluate(), []);
  await r.loop.evaluate();
  assert.equal(r.infos.filter((m) => /entry price predates the index/.test(m)).length, 1);
});

test('unwatching an account drops it; a position that closes is dropped when the index can be believed', async () => {
  const r = rig();
  await r.loop.evaluate();
  r.profiles.set(5293, profileOf(5293, []));
  r.now += 1_000;
  assert.deepEqual(await r.loop.evaluate(), []);
  assert.deepEqual(r.loop.snapshot(5293), []);
  r.profiles.set(5293, profileOf(5293, [open(FIXTURE_BTC.margin)]));
  await r.loop.evaluate();
  r.watched = [];
  assert.deepEqual(await r.loop.evaluate(), []);
  assert.deepEqual(r.loop.snapshot(), []);
});

test('labels name the account and the owner when there is one', () => {
  assert.equal(labelOf(5293, OWNER), '#5293 (0xb785…1765)');
  assert.equal(labelOf(710, ''), '#710');
});

test('a watched DANGER position carries free balance, size and the climb-out amount as words, never as a top-up', async () => {
  const r = rig();
  r.profiles.set(5293, { ...profileOf(5293, [open(FIXTURE_BTC.margin)]), freeBalanceAusd: 2_910.123456 } as WalletProfile);
  const [a] = await r.loop.evaluate();
  assert.equal(a!.state, 'DANGER');
  assert.equal(a!.topUp, undefined, 'still no top-up: a watcher cannot act');
  assert.equal(a!.watch?.freeBalanceCNS, 2_910_123_456n, 'exact micros recovered from the indexed AUSD');
  assert.equal(a!.watch?.sizeUnits, FIXTURE_BTC.size);
  // The owner's own "clear danger" option for this exact position is 562 AUSD (ceiled);
  // the exact amount sits just under it.
  const need = a!.watch?.toClearDangerCNS ?? -1n;
  assert.ok(need > 561_000_000n && need <= 562_000_000n, `toClearDanger ${need}`);
});

test('a watched position already clear of DANGER needs nothing to climb out', async () => {
  const r = rig();
  r.profiles.set(5293, profileOf(5293, [open(SAFE_BTC.margin)]));
  const [a] = await r.loop.evaluate();
  assert.equal(a!.watch?.toClearDangerCNS, 0n);
  assert.equal(a!.watch?.freeBalanceCNS, undefined, 'unknown free balance stays unknown');
});

test('account facts say "no open positions" apart from "never looked", and drop with the subscription', async () => {
  const r = rig();
  r.watched = [5293, 7000];
  r.profiles.set(7000, { ...profileOf(7000, []), freeBalanceAusd: 12.5 } as WalletProfile);
  assert.equal(r.loop.accountFacts(7000), undefined, 'before any pass: never looked');
  await r.loop.evaluate();
  assert.deepEqual(r.loop.accountFacts(7000), { atMs: T0, found: true, openPositions: 0, unassessable: 0, freeBalanceAusd: 12.5 });
  assert.equal(r.loop.accountFacts(5293)?.openPositions, 1);
  assert.equal(r.loop.marketConfigs?.get(BTC.marketId)?.symbol, 'BTC');
  r.watched = [5293];
  await r.loop.evaluate();
  assert.equal(r.loop.accountFacts(7000), undefined);
});
