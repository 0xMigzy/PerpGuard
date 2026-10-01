/**
 * THE CROSS-ACCOUNT TEST. Two live sessions in one registry, and proof that
 * nothing of one reaches the other:
 *
 *   - an action authorised for account A goes out on A's socket and never on
 *     B's; a command naming B handed to A's executor is refused before a
 *     lease, a row or a frame;
 *   - an alert about A's position is delivered to A's recipients and to
 *     nobody else;
 *   - an in-flight lock on A's market does not block B acting on the same
 *     market.
 *
 * Everything below the fake WebSocket is real: real PerplVenue per account,
 * real trading socket sign-in, real position source, real risk loop, real
 * alert engine, real executor with its reconciliation. The venue context is
 * the captured testnet fixture, so market 16 is BTC with its real scaling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiSecret, PerplVenue, loadNetworkConfig, type ActionResult, type PriceUpdate } from '@perpguard/shared';
import { FakeTransport, RecordingLog } from '../alerts/testSupport.ts';
import { InMemoryActionLog } from '../actions/index.ts';
import { MarketFeed } from '../ingest/marketFeed.ts';
import { AccountRegistry } from './registry.ts';
import type { SessionDeps } from './session.ts';

const testnet = loadNetworkConfig('testnet', {});
const context = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../fixtures/context-testnet.json', import.meta.url)), 'utf8')) as unknown;
const secret = ApiSecret.fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const BTC = 16;

/** A websocket the test drives; every instance is recorded so two accounts can be told apart. */
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  readonly sent: Record<string, unknown>[] = [];
  readonly url: string;
  readyState = 0;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  deliver(message: unknown): void {
    const event = new Event('message') as Event & { data: string };
    event.data = JSON.stringify(message);
    this.dispatchEvent(event);
  }
  /** Frames of one type, e.g. the `t: 6` top-ups. */
  frames(t: number): Record<string, unknown>[] {
    return this.sent.filter((f) => f['mt'] === 22 && f['t'] === t);
  }
}

const stubFetch: typeof fetch = (async () => new Response(JSON.stringify(context), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

const wirePosition = (accountId: number, pid: number, margin: string) => ({
  mkt: BTC, acc: accountId, pid, st: 1, sr: 21, sd: 1, c: margin, ep: 833798, s: 1, lv: 1500, fnd: '0', dpnl: '0', fee: '288',
});

const tick = async (): Promise<void> => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

interface Rig {
  readonly registry: AccountRegistry;
  readonly feed: MarketFeed;
  readonly transport: FakeTransport;
  readonly actionLog: InMemoryActionLog;
  readonly alertLog: RecordingLog;
  readonly recipients: Map<number, string[]>;
  readonly logs: string[];
  signIn(accountId: number, positions?: ReadonlyArray<ReturnType<typeof wirePosition>>): Promise<FakeSocket>;
  price(markPrice: number): void;
}

async function rig(options: { readonly maxSessions?: number } = {}): Promise<Rig> {
  FakeSocket.instances = [];
  const marketVenue = new PerplVenue(testnet, { fetchImpl: stubFetch });
  const markets = await marketVenue.getMarkets();
  const riskConfigs = await marketVenue.getRiskConfigs();
  const feed = new MarketFeed('testnet', 10_000);
  const transport = new FakeTransport();
  const actionLog = new InMemoryActionLog();
  const alertLog = new RecordingLog();
  const recipients = new Map<number, string[]>();
  const logs: string[] = [];
  const deps: SessionDeps = {
    network: testnet,
    markets,
    riskConfigs,
    feed,
    feedStatus: () => ({ state: 'connected', reconnectAttempt: 0 }),
    actionLog,
    alertLog,
    transport,
    recipients: (accountId) => (recipients.get(accountId) ?? []).map((userId) => ({ userId, rights: 'act' as const })),
    venueFactory: (credentials) => new PerplVenue(testnet, { credentials, fetchImpl: stubFetch, webSocketImpl: FakeSocket as unknown as typeof WebSocket }),
    evaluateIntervalMs: 60_000,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
    backoffMs: [0],
    sleep: async () => {},
    settleTimeoutMs: 50,
    venueTimeoutMs: 2_000,
  };
  const registry = new AccountRegistry({ deps, ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }) });

  return {
    registry,
    feed,
    transport,
    actionLog,
    alertLog,
    recipients,
    logs,
    async signIn(accountId, positions = []) {
      const before = FakeSocket.instances.length;
      const opened = registry.open(accountId, { apiKey: `key-for-${accountId}`, secret });
      assert.ok(opened.ok, 'opened');
      // The trading session connects on the next turn; drive its socket.
      for (let i = 0; i < 50 && FakeSocket.instances.length === before; i += 1) await tick();
      const socket = FakeSocket.instances[FakeSocket.instances.length - 1]!;
      socket.open();
      await tick();
      socket.deliver({ mt: 19, sn: 100, addr: `0x${String(accountId).padStart(40, '0')}`, as: [{ in: 12, id: accountId, fr: false, fw: true, lfr: 8, b: '10000000000', lb: '0' }] });
      await tick();
      socket.deliver({ mt: 26, sn: 100, d: positions });
      await tick();
      await tick();
      return socket;
    },
    price(markPrice) {
      const update: PriceUpdate = { venue: 'perpl', network: 'testnet', symbol: 'BTC', marketId: BTC, markPrice, oraclePrice: markPrice, midPrice: markPrice, bid: markPrice, ask: markPrice, atBlock: 1, atMs: Date.now(), receivedAtMs: Date.now() };
      feed.record(update);
    },
  };
}

const A = 710;
const B = 711;

test('two sessions sign in as two accounts and each holds only its own positions', async () => {
  const r = await rig();
  const socketA = await r.signIn(A, [wirePosition(A, 4001, '417125')]);
  const socketB = await r.signIn(B, [wirePosition(B, 4002, '5000000')]);
  assert.notEqual(socketA, socketB);
  const a = r.registry.get(A)!;
  const b = r.registry.get(B)!;
  assert.equal(a.status().trading.accountId, A);
  assert.equal(b.status().trading.accountId, B);
  assert.deepEqual(a.positionSource.snapshot().map((p) => p.positionId), [4001]);
  assert.deepEqual(b.positionSource.snapshot().map((p) => p.positionId), [4002]);
  await r.registry.closeAll();
});

test('an alert about A reaches A’s recipients only, keyed by A’s account; B hears nothing', async () => {
  const r = await rig();
  r.recipients.set(A, ['tg:owner-a']);
  r.recipients.set(B, ['tg:owner-b']);
  // A is thin on margin — 15x on a 0.83 AUSD notional leaves a ~2.7% buffer
  // against BTC's 4% maintenance, which is DANGER; B is fat (SAFE).
  await r.signIn(A, [wirePosition(A, 4001, '55600')]);
  await r.signIn(B, [wirePosition(B, 4002, '5000000')]);
  r.price(83_379.8);
  r.registry.get(A)!.loop.evaluate();
  r.registry.get(B)!.loop.evaluate();
  await r.registry.get(A)!.engine.drain();
  await r.registry.get(B)!.engine.drain();

  const sent = r.transport.sent;
  assert.equal(
    sent.length,
    1,
    `one alert: A is in danger, B is safe on first sight. A: ${JSON.stringify(r.registry.get(A)!.loop.snapshot().map((a) => [a.state, a.liqBufferPct, a.reason]))}; logs: ${r.logs.filter((l) => /alert|no market/.test(l)).join(' | ')}`,
  );
  assert.equal(sent[0]!.recipient.userId, 'tg:owner-a');
  assert.equal(sent[0]!.message.accountId, A);
  assert.equal(sent[0]!.message.positionId, 4001);
  assert.equal(sent[0]!.message.actions[0]?.accountId, A, 'the button names the account it is for');
  assert.ok(r.alertLog.rows[0]!.alertKey.startsWith(`${A}:${BTC}:`), 'the row is keyed by account and market');
  assert.equal(r.alertLog.rows[0]!.accountId, A);
  // Histories are per account AND per engine: A's says DANGER was sent; B's
  // for the same market has sent nothing, and A's engine knows nothing of B.
  assert.equal(r.registry.get(A)!.engine.historyFor(BTC, A)?.lastAlertedSeverity, 'DANGER');
  assert.equal(r.registry.get(B)!.engine.historyFor(BTC, B)?.lastAlertedSeverity, undefined);
  assert.equal(r.registry.get(A)!.engine.historyFor(BTC, B), undefined);
  await r.registry.closeAll();
});

test('an action for A goes out on A’s socket and never B’s; a command naming B is refused by A’s executor before anything', async () => {
  const r = await rig();
  const socketA = await r.signIn(A, [wirePosition(A, 4001, '417125')]);
  const socketB = await r.signIn(B, [wirePosition(B, 4002, '417125')]);
  r.price(83_379.8);

  // Wrong account: refused with no lease, no row, no frame.
  const wrong = await r.registry.get(A)!.executor.execute({
    kind: 'add-margin', idempotencyKey: 'x-wrong', userId: 'tg:owner-b', accountId: B, marketId: BTC, symbol: 'BTC', positionId: 4002, amountCNS: 1_000_000n,
  });
  assert.equal(wrong.kind, 'refused');
  assert.equal(wrong.kind === 'refused' && wrong.code, 'wrong-account');
  assert.equal(socketA.frames(6).length, 0);
  assert.equal(socketB.frames(6).length, 0);
  assert.equal(r.actionLog.rows.length, 0, 'no row opened');

  // Right account: the frame appears on A's socket, addressed to A's position.
  const running = r.registry.get(A)!.executor.execute({
    kind: 'add-margin', idempotencyKey: 'x-right', userId: 'tg:owner-a', accountId: A, marketId: BTC, symbol: 'BTC', positionId: 4001, amountCNS: 1_000_000n,
  });
  for (let i = 0; i < 50 && socketA.frames(6).length === 0; i += 1) await tick();
  assert.equal(socketA.frames(6).length, 1);
  assert.equal(socketA.frames(6)[0]!['lp'], 4001);
  assert.equal(socketA.frames(6)[0]!['acc'], A);
  assert.equal(socketB.frames(6).length, 0, 'B’s socket saw nothing');
  // Let it settle: ack, the venue's usual "failed" report, and the margin landing on A.
  const frame = socketA.frames(6)[0]!;
  socketA.deliver({ mt: 3, sid: 0, cid: frame['sn'], status: { code: 0, error: '' } });
  await tick();
  socketA.deliver({ mt: 24, sn: 101, d: [{ oid: 9, scid: 1, id: 9, rq: frame['rq'], st: 7, sr: 32, r: '' }] });
  socketA.deliver({ mt: 27, sn: 102, d: [wirePosition(A, 4001, '1417125')] });
  const outcome = await running;
  assert.equal(outcome.kind, 'applied', 'reconciled against A’s own position');
  assert.equal(r.actionLog.rows.length, 1);
  assert.equal(r.actionLog.rows[0]!.row.accountId, A);
  assert.deepEqual(r.registry.get(B)!.positionSource.snapshot().map((p) => p.margin), [0.417125], 'B’s position is untouched');
  await r.registry.closeAll();
});

test('an in-flight lock on A’s market does not block B on the same market', async () => {
  const r = await rig();
  const socketA = await r.signIn(A, [wirePosition(A, 4001, '417125')]);
  const socketB = await r.signIn(B, [wirePosition(B, 4002, '417125')]);
  r.price(83_379.8);
  const a = r.registry.get(A)!;
  const b = r.registry.get(B)!;

  const inFlightA = a.executor.execute({ kind: 'add-margin', idempotencyKey: 'a-1', userId: 'u', accountId: A, marketId: BTC, symbol: 'BTC', positionId: 4001, amountCNS: 1_000n });
  for (let i = 0; i < 50 && socketA.frames(6).length === 0; i += 1) await tick();
  assert.notEqual(a.executor.inFlightOn(BTC), undefined, 'A holds its lease');
  assert.equal(b.executor.inFlightOn(BTC), undefined, 'B does not');

  // A second action on A is refused (one in flight per position) ...
  const secondA = await a.executor.execute({ kind: 'add-margin', idempotencyKey: 'a-2', userId: 'u', accountId: A, marketId: BTC, symbol: 'BTC', positionId: 4001, amountCNS: 1_000n });
  assert.equal(secondA.kind === 'refused' && secondA.code, 'already-in-flight');
  // ... while B on the same market goes straight out.
  const onB = b.executor.execute({ kind: 'add-margin', idempotencyKey: 'b-1', userId: 'u', accountId: B, marketId: BTC, symbol: 'BTC', positionId: 4002, amountCNS: 1_000n });
  for (let i = 0; i < 50 && socketB.frames(6).length === 0; i += 1) await tick();
  assert.equal(socketB.frames(6).length, 1, 'B’s frame went out while A’s was in flight');

  // Settle both as not-applied (no ack ever comes; the venue timeout is short).
  await r.registry.closeAll();
  const [oa, ob] = await Promise.all([inFlightA, onB]);
  assert.notEqual(oa.kind, 'applied');
  assert.notEqual(ob.kind, 'applied');
});

test('the cap refuses a new link with a sentence, and closing a session frees its slot and its socket', async () => {
  const r = await rig({ maxSessions: 2 });
  const socketA = await r.signIn(A);
  await r.signIn(B);
  const third = r.registry.open(712, { apiKey: 'k', secret });
  assert.ok(!third.ok);
  assert.match(third.reason, /already running 2 linked account sessions/);
  assert.equal(r.registry.size, 2);

  assert.equal(await r.registry.close(A), true);
  assert.equal(r.registry.get(A), undefined);
  assert.equal(r.registry.forAccount(A), undefined, 'the bot can no longer route to it');
  assert.equal(socketA.readyState, 3, 'its socket is closed');
  assert.equal(r.registry.get(B)!.status().trading.state, 'signed-in', 'B is untouched');
  assert.ok(r.registry.open(712, { apiKey: 'k', secret }).ok, 'the slot is free again');
  await r.registry.closeAll();
});

test('a key that signs in as a different account than the session was opened for is torn down, not attributed', async () => {
  const r = await rig();
  const opened = r.registry.open(999, { apiKey: 'k', secret });
  assert.ok(opened.ok);
  for (let i = 0; i < 50 && FakeSocket.instances.length === 0; i += 1) await tick();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  await tick();
  socket.deliver({ mt: 19, sn: 1, as: [{ in: 12, id: 123, fr: false, fw: true, lfr: 1, b: '1', lb: '0' }] });
  for (let i = 0; i < 100 && r.registry.get(999) !== undefined; i += 1) await tick();
  assert.equal(r.registry.get(999), undefined, 'closed by the registry');
  assert.equal(socket.readyState, 3);
  assert.ok(r.logs.some((l) => /signed in as account 123, not account 999/.test(l)));
});

test('health reports every session on its own', async () => {
  const r = await rig();
  await r.signIn(A);
  await r.signIn(B);
  const statuses = r.registry.statuses();
  assert.deepEqual(statuses.map((s) => [s.accountId, s.trading.state, s.positions.state]), [[A, 'signed-in', 'live'], [B, 'signed-in', 'live']]);
  await r.registry.closeAll();
});

test.after(() => {
  // Nothing: sockets are fakes. Kept so the file reads as a suite with a teardown.
});

/** Silence an unused-import complaint while the venue's ActionResult stays a documented shape here. */
export type _Result = ActionResult;
