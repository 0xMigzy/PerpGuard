import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionCommand, ActionOutcome } from '../actions/types.ts';
import { CloseEverything, type CloseAllAccount } from './closeAll.ts';
import { InMemoryCloseAllRunStore } from './store.ts';
import type { OpenPosition } from './verify.ts';

const pos = (symbol: string, marketId: number, positionId: number, sizeLNS: bigint, pnl: bigint | undefined = -10_000_000n): OpenPosition => ({ marketId, symbol, positionId, side: 'long', sizeLNS, lotDecimals: 3, unrealisedPnlCNS: pnl });

/** An exchange: closes act on the list by default; a test can make one partial, ignored or invisible. */
class Exchange implements CloseAllAccount {
  list: OpenPosition[] | undefined;
  events: string[] = [];
  /** By positionId: how much of a close fills (default all), and what the receipt says (default applied). */
  fill = new Map<number, bigint>();
  receipt = new Map<number, ActionOutcome['kind']>();
  constructor(positions: OpenPosition[]) {
    this.list = positions;
  }
  openPositions(): readonly OpenPosition[] | undefined {
    return this.list;
  }
  async execute(c: ActionCommand): Promise<ActionOutcome> {
    this.events.push(`close ${c.symbol} ${c.idempotencyKey}`);
    await new Promise((r) => setTimeout(r, 2));
    const p = this.list?.find((x) => x.positionId === c.positionId);
    const filled = this.fill.get(c.positionId!) ?? (c.kind === 'reduce-position' ? c.sizeLNS : p?.sizeLNS) ?? 0n;
    if (p !== undefined && this.list !== undefined) {
      const left = p.sizeLNS - filled;
      this.list = left <= 0n ? this.list.filter((x) => x !== p) : this.list.map((x) => (x === p ? { ...x, sizeLNS: left } : x));
    }
    const kind = this.receipt.get(c.positionId!) ?? 'applied';
    if (kind === 'refused') return { kind: 'refused', command: c, at: 0, code: 'not-actionable', detail: 'market closed' };
    const reported = { status: 'confirmed' as const, reason: undefined, venueRef: 'r1' };
    const rec = { verdict: 'applied' as const, field: 'size' as const, requested: 0n, before: 0n, after: 0n, delta: 0n, detail: '' };
    if (kind === 'unknown') return { kind, command: c, at: 0, detail: '', reported, reconciliation: rec, nextStep: 'check' };
    return { kind: kind as 'applied' | 'not-applied', command: c, at: 0, detail: '', reported, reconciliation: rec };
  }
  exitPrice(): number | undefined {
    return 85_102;
  }
  /** What the reduced position's row reports as the fill; a test sets it, or leaves it unreported. */
  reported: { closedLNS: bigint; exitPricePNS: bigint; feeCNS: bigint | undefined } | undefined;
  reduceFill(): { fill: { exitPricePNS: bigint; closedLNS: bigint; feeCNS: bigint | undefined }; entryPricePNS: bigint; scale: { priceDecimals: number; lotDecimals: number; collateralDecimals: number } } | undefined {
    return this.reported === undefined ? undefined : { fill: this.reported, entryPricePNS: 840_000n, scale: { priceDecimals: 1, lotDecimals: 3, collateralDecimals: 6 } };
  }
}

function rig(positions: OpenPosition[]) {
  const ex = new Exchange(positions);
  const store = new InMemoryCloseAllRunStore();
  const logs: string[] = [];
  const service = new CloseEverything({
    killSwitch: { stop: async (id) => (ex.events.push(`STOP ${id}`), { accountId: id, alreadyStopped: false, rescueStopped: [], modeBefore: 'NONE', inFlight: 'none', inFlightDetail: undefined, atMs: 0 }) },
    account: () => ex,
    store,
    log: (l) => logs.push(l),
    settleMs: 50,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  return { ex, store, logs, service };
}

const BTC = () => pos('BTC', 16, 1, 2_000n);
const ETH = () => pos('ETH', 32, 2, 310n);
const SOL = () => pos('SOL', 48, 3, 14_200n, 31_000_000n);

test('THE STOP HAPPENS BEFORE ANY ORDER, and every position closes, one at a time, each with its own key', async () => {
  const r = rig([BTC(), ETH(), SOL()]);
  const report = await r.service.closeAll(710, 'req1', 'tg:1');
  assert.equal(r.ex.events[0], 'STOP 710', 'stopped first');
  assert.deepEqual(r.ex.events.slice(1), ['close BTC closeall:710:req1:1', 'close ETH closeall:710:req1:2', 'close SOL closeall:710:req1:3']);
  assert.ok(report.kind === 'ran');
  assert.equal(report.verified.complete, true);
  assert.ok(report.verified.results.every((x) => x.kind === 'closed'));
  assert.equal(r.store.runs.length, 1, 'the run is recorded');
});

test('A PARTIAL CLOSE REPORTS WHAT REMAINS, and the run is not complete', async () => {
  const r = rig([BTC(), ETH()]);
  r.ex.fill.set(2, 230n); // ETH: 0.230 of 0.310 fills
  const report = await r.service.closeAll(710, 'req1', 'tg:1');
  assert.ok(report.kind === 'ran');
  assert.equal(report.verified.complete, false);
  const eth = report.verified.results.find((x) => x.position.symbol === 'ETH')!;
  assert.ok(eth.kind === 'partial');
  assert.equal(eth.remainingLNS, 80n);
  assert.equal(eth.closedLNS, 230n);
});

test('THE RECEIPT LIES, THE POSITION TELLS THE TRUTH: a close that "filled" but is still on the list is STILL OPEN', async () => {
  const r = rig([BTC()]);
  r.ex.fill.set(1, 0n); // nothing actually filled
  const report = await r.service.closeAll(710, 'req1', 'tg:1');
  assert.ok(report.kind === 'ran');
  const btc = report.verified.results[0]!;
  assert.equal(btc.kind, 'still-open');
  assert.equal(report.verified.complete, false);
});

test('A POSITION THE BOT CANNOT SEE IS NEVER REPORTED CLOSED: a list that drops out after the closes makes every one NOT SEEN', async () => {
  const r = rig([BTC(), ETH()]);
  const execute = r.ex.execute.bind(r.ex);
  r.ex.execute = async (c) => {
    const o = await execute(c);
    r.ex.list = undefined; // the socket went blind while the closes ran
    return o;
  };
  const report = await r.service.closeAll(710, 'req1', 'tg:1');
  assert.ok(report.kind === 'ran');
  assert.ok(report.verified.results.every((x) => x.kind === 'not-seen'));
  assert.equal(report.verified.complete, false);
});

test('A list that cannot be seen at the start: stopped, nothing sent', async () => {
  const r = rig([]);
  r.ex.list = undefined;
  const report = await r.service.closeAll(710, 'req1', 'tg:1');
  assert.deepEqual([report.kind, report.kind === 'nothing-sent' ? report.why : ''], ['nothing-sent', 'cannot-see']);
  assert.deepEqual(r.ex.events, ['STOP 710']);
});

test('EVERYTHING ALREADY FLAT: says so and sends nothing', async () => {
  const r = rig([]);
  const report = await r.service.closeAll(710, 'req1', 'tg:1');
  assert.ok(report.kind === 'nothing-sent' && report.why === 'already-flat');
  assert.equal(r.ex.events.filter((e) => e.startsWith('close')).length, 0);
});

test('TWO TAPS IN A ROW SEND ONE SET OF ORDERS: the same request twice at once, and again afterwards', async () => {
  const r = rig([BTC(), ETH()]);
  const [a, b] = await Promise.all([r.service.closeAll(710, 'req1', 'tg:1'), r.service.closeAll(710, 'req1', 'tg:1')]);
  assert.equal(r.ex.events.filter((e) => e.startsWith('close')).length, 2, 'two positions, two closes, once');
  assert.deepEqual([a.kind, b.kind].sort(), ['already-running', 'ran']);
  const again = await r.service.closeAll(710, 'req1', 'tg:1');
  assert.ok(again.kind === 'ran' && again.replayed);
  assert.equal(r.ex.events.filter((e) => e.startsWith('close')).length, 2, 'the replay sent nothing');
});

test('a refused close is STILL OPEN, with the refusal as the reason', async () => {
  const r = rig([BTC()]);
  r.ex.receipt.set(1, 'refused');
  r.ex.fill.set(1, 0n);
  const report = await r.service.closeAll(710, 'req1', 'tg:1');
  assert.ok(report.kind === 'ran');
  const btc = report.verified.results[0]!;
  assert.ok(btc.kind === 'still-open');
  assert.match(btc.why, /not sent: market closed/);
});

test('retrying one position closes only that position, as its own request', async () => {
  const r = rig([BTC(), ETH()]);
  r.ex.fill.set(2, 230n);
  await r.service.closeAll(710, 'req1', 'tg:1');
  r.ex.fill.delete(2);
  const retry = await r.service.closeOne(710, 32, 'req2', 'tg:1');
  assert.ok(retry.kind === 'ran');
  assert.deepEqual(retry.verified.results.map((x) => [x.position.symbol, x.kind]), [['ETH', 'closed']]);
  assert.equal(r.ex.events.at(-1), 'close ETH closeall:710:req2:2');
});

function positionRig(positions: OpenPosition[], autoOn: boolean) {
  const r = rig(positions);
  const service = new CloseEverything({
    killSwitch: { stop: async (id) => (r.ex.events.push(`STOP ${id}`), { accountId: id, alreadyStopped: false, rescueStopped: [], modeBefore: 'NONE', inFlight: 'none', inFlightDetail: undefined, atMs: 0 }) },
    stopPositionAutomation: async (id, marketId) => (r.ex.events.push(`AUTO OFF ${id}:${marketId}`), autoOn),
    account: () => r.ex,
    store: r.store,
    log: (l) => r.logs.push(l),
    settleMs: 50,
    sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 5))),
  });
  return { ...r, service };
}

test('🚪 CLOSE POSITION: that position’s automation off FIRST, never the account’s kill switch; only that position closes, under its own key', async () => {
  const { ex, service } = positionRig([BTC(), ETH()], true);
  const report = await service.closePosition(710, 16, 'req-1', 'tg:1');
  assert.deepEqual(ex.events, ['AUTO OFF 710:16', 'close BTC close:710:req-1:1'], 'automation off before the close; no STOP; ETH untouched');
  assert.equal(report.kind === 'ran' && report.automationOff, true);
  assert.equal(report.kind === 'ran' && report.verified.complete, true);
  assert.deepEqual(ex.list?.map((p) => p.symbol), ['ETH']);
});

test('🚪 CLOSE POSITION is sent ONCE: the same request again sends nothing, and a partial close reports what remains', async () => {
  const { ex, service } = positionRig([BTC()], false);
  ex.fill.set(1, 500n);
  const first = await service.closePosition(710, 16, 'req-2', 'tg:1');
  assert.equal(first.kind === 'ran' && first.verified.results[0]!.kind, 'partial');
  assert.equal(first.kind === 'ran' && first.verified.results[0]!.kind === 'partial' && first.verified.results[0]!.remainingLNS, 1_500n);
  assert.equal(first.kind === 'ran' && first.verified.complete, false, 'never "closed" with 1.5 left');
  assert.equal(first.kind === 'ran' && first.automationOff, false, 'nothing was on, and the report says so');
  const again = await service.closePosition(710, 16, 'req-2', 'tg:1');
  assert.equal(again.kind === 'ran' && again.replayed, true);
  assert.equal(ex.events.filter((e) => e.startsWith('close')).length, 1, 'never re-sent');
});

test('🚪 CLOSE POSITION judges by the LIST, never the receipt: an "applied" receipt with the position still there is still open', async () => {
  const { ex, service } = positionRig([BTC()], false);
  ex.fill.set(1, 0n);
  const report = await service.closePosition(710, 16, 'req-3', 'tg:1');
  assert.equal(report.kind === 'ran' && report.verified.results[0]!.kind, 'still-open');
  assert.match(report.kind === 'ran' && report.verified.results[0]!.kind === 'still-open' ? report.verified.results[0]!.why : '', /reported a fill, but the position is still there/);
});

// ── 🚪 close part of a position (owner, 10 Oct 2026) ────────────────────────

const HALF = { positionId: 1, sizeLNS: 2_000n };

test('CLOSE PART: one reduce for exactly the size asked, with its own key; automation is NOT stopped; the new size is read back from the position', async () => {
  const r = rig([BTC(), ETH()]);
  r.ex.reported = { closedLNS: 1_000n, exitPricePNS: 830_000n, feeCNS: 286_350n };
  const report = await r.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1');
  assert.deepEqual(r.ex.events, ['close BTC reduce:710:p1:1'], 'no STOP, one order');
  assert.ok(report.kind === 'ran');
  assert.deepEqual(report.result, { kind: 'reduced', beforeLNS: 2_000n, afterLNS: 1_000n, closedLNS: 1_000n, asAsked: true });
  // Long from 84,000.0 out at 83,000.0 on 1.000: −1,000 AUSD, from the exchange's own fill.
  assert.equal(report.realisedCNS, -1_000_000_000n);
  assert.equal(report.feeCNS, 286_350n);
  assert.equal(r.ex.list!.find((x) => x.positionId === 2)!.sizeLNS, 310n, 'the other position is untouched');
  assert.equal(r.store.runs.length, 1, 'recorded');
});

test('CLOSE PART IS JUDGED BY THE POSITION, NOT THE RECEIPT: a "confirmed" receipt with an unchanged position is not a success', async () => {
  const r = rig([BTC()]);
  r.ex.fill.set(1, 0n);
  const report = await r.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1');
  assert.ok(report.kind === 'ran');
  assert.equal(report.result.kind, 'unchanged');
  assert.equal(report.realisedCNS, undefined);
});

test('CLOSE PART: a different amount landed than was asked: said as it is, and the fill is only quoted when it matches what the position shows', async () => {
  const r = rig([BTC()]);
  r.ex.fill.set(1, 400n);
  r.ex.reported = { closedLNS: 1_000n, exitPricePNS: 830_000n, feeCNS: 1n };
  const report = await r.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1');
  assert.ok(report.kind === 'ran');
  assert.deepEqual(report.result, { kind: 'reduced', beforeLNS: 2_000n, afterLNS: 1_600n, closedLNS: 400n, asAsked: false });
  assert.equal(report.realisedCNS, undefined, 'a fill of another size is not this reduce’s fill');
});

test('CLOSE PART: no fill reported (a reconnect erased the row’s event): the new size is still reported, the realised figure is not invented', async () => {
  const r = rig([BTC()]);
  const report = await r.service.reducePosition(710, 16, 500n, HALF, 'p1', 'tg:1');
  assert.ok(report.kind === 'ran' && report.result.kind === 'reduced');
  assert.equal(report.result.afterLNS, 1_500n);
  assert.equal(report.realisedCNS, undefined);
});

test('CLOSE PART RUNS ONCE: the same request again sends nothing and replays the result; a run in flight blocks another', async () => {
  const r = rig([BTC()]);
  const [first, second] = await Promise.all([r.service.reducePosition(710, 16, 500n, HALF, 'p1', 'tg:1'), r.service.reducePosition(710, 16, 500n, HALF, 'p2', 'tg:1')]);
  assert.equal(first.kind, 'ran');
  assert.equal(second.kind, 'already-running');
  const again = await r.service.reducePosition(710, 16, 500n, HALF, 'p1', 'tg:1');
  assert.ok(again.kind === 'ran' && again.replayed);
  assert.equal(r.ex.events.length, 1, 'one order in all');
});

test('CLOSE PART SENDS NOTHING when the position changed since the confirmation, is gone, cannot be seen, or the size is not a partial close', async () => {
  const changed = rig([pos('BTC', 16, 1, 1_500n)]);
  assert.deepEqual(await changed.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1'), { kind: 'nothing-sent', why: 'changed' });
  const reopened = rig([pos('BTC', 16, 9, 2_000n)]);
  assert.deepEqual(await reopened.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1'), { kind: 'nothing-sent', why: 'changed' });
  const flat = rig([ETH()]);
  assert.deepEqual(await flat.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1'), { kind: 'nothing-sent', why: 'already-flat' });
  const blind = rig([BTC()]);
  blind.ex.list = undefined;
  assert.deepEqual(await blind.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1'), { kind: 'nothing-sent', why: 'cannot-see' });
  for (const size of [0n, 2_000n, 2_500n]) {
    const r = rig([BTC()]);
    assert.deepEqual(await r.service.reducePosition(710, 16, size, HALF, 'p1', 'tg:1'), { kind: 'nothing-sent', why: 'too-small' });
    assert.equal(r.ex.events.length, 0);
  }
  for (const r of [changed, reopened, flat, blind]) assert.equal(r.ex.events.length, 0, 'nothing sent');
});

test('CLOSE PART: a refusal never went out, so it is reported unchanged at once; the position going entirely is said as gone, never as a partial close', async () => {
  const refused = rig([BTC()]);
  refused.ex.receipt.set(1, 'refused');
  refused.ex.fill.set(1, 0n);
  const a = await refused.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1');
  assert.ok(a.kind === 'ran' && a.result.kind === 'unchanged');
  assert.match((a.result as { why: string }).why, /did not go out/);
  const gone = rig([BTC()]);
  gone.ex.fill.set(1, 2_000n);
  const b = await gone.service.reducePosition(710, 16, 1_000n, HALF, 'p1', 'tg:1');
  assert.ok(b.kind === 'ran');
  assert.deepEqual(b.result, { kind: 'gone', beforeLNS: 2_000n });
});
