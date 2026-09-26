import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadNetworkConfig } from '../config.ts';
import { ActionTimeoutError, VenueAuthError } from '../errors.ts';
import { matchPlacement, orderIdOf, reconcileOrderState } from './perpl-orders.ts';
import { ApiSecret, wsSignInCanonical } from './perpl-signing.ts';
import { PerplTradingSocket } from './perpl-trading-socket.ts';

const testnet = loadNetworkConfig('testnet', {});
const secret = ApiSecret.fromHex(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
);

/** A websocket the test drives by hand. */
class FakeSocket extends EventTarget {
  static last: FakeSocket | undefined;

  readonly url: string;
  readonly sent: Record<string, unknown>[] = [];
  readyState = 0;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.last = this;
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

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    const event = new Event('close') as Event & { code: number; reason: string };
    event.code = code;
    event.reason = reason;
    this.dispatchEvent(event);
  }
}

const walletSnapshot = {
  mt: 19,
  sn: 100,
  as: [{ in: 12, id: 9001, fr: false, fw: true, lfr: 530, b: '100000000', lb: '0' }],
};

interface Harness {
  socket: PerplTradingSocket;
  fake: FakeSocket;
}

/** Connect a socket, driving the fake through open + sign-in. */
async function connected(options: { skipSnapshot?: boolean } = {}): Promise<Harness> {
  const socket = new PerplTradingSocket({
    network: testnet,
    apiKey: 'opaque-token',
    secret,
    webSocketImpl: FakeSocket as unknown as typeof WebSocket,
    signInTimeoutMs: 50,
    pingIntervalMs: 10_000,
  });

  const connecting = socket.connect();
  const fake = FakeSocket.last as FakeSocket;
  fake.open();
  if (options.skipSnapshot !== true) {
    await Promise.resolve();
    fake.deliver(walletSnapshot);
  }
  await connecting;
  return { socket, fake };
}

/** A minimal placement frame plus the matcher the venue would pair with it. */
function placeFrame(socket: PerplTradingSocket) {
  return {
    mt: 22 as const,
    sn: socket.nextSequenceNumber(),
    rq: socket.reserveRequestId(),
    mkt: 16,
    acc: 9001,
    t: 1 as const,
    p: 420000,
    s: 1,
    fl: 1 as const,
    lv: 200,
    lb: 65_741_015,
  };
}

describe('sign-in', () => {
  it('sends a signed mt 29 as the very first frame', async () => {
    const { fake } = await connected();
    const first = fake.sent[0];
    assert.equal(first?.['mt'], 29);
    assert.equal(first?.['chain_id'], 10143);
    assert.equal(first?.['api_key'], 'opaque-token');
    assert.equal(
      first?.['signature'],
      secret.signBase64Url(
        wsSignInCanonical(10143, String(first?.['timestamp']), String(first?.['nonce'])),
      ),
    );
  });

  it('never puts key material on the wire', async () => {
    const { fake } = await connected();
    assert.ok(!JSON.stringify(fake.sent).includes('9d61b19d'));
  });

  it('reads the account id and lfr from the wallet snapshot', async () => {
    const { socket } = await connected();
    assert.equal(socket.accountId, 9001);
    assert.equal(socket.lastForwardedRequestId, 530);
    // rq must be strictly greater than the account's last forwarded id.
    assert.equal(socket.reserveRequestId(), 531);
    assert.equal(socket.reserveRequestId(), 532);
  });

  it('surfaces close 3401 as an auth failure', async () => {
    const socket = new PerplTradingSocket({
      network: testnet,
      apiKey: 'opaque-token',
      secret,
      webSocketImpl: FakeSocket as unknown as typeof WebSocket,
      signInTimeoutMs: 1000,
    });
    const connecting = socket.connect();
    const fake = FakeSocket.last as FakeSocket;
    fake.open();
    await Promise.resolve();
    fake.serverClose(3401);
    await assert.rejects(connecting, (error: unknown) => {
      assert.ok(error instanceof VenueAuthError);
      assert.equal(error.closeCode, 3401);
      return true;
    });
  });

  it('connects without an account when no snapshot arrives', async () => {
    const { socket } = await connected({ skipSnapshot: true });
    assert.equal(socket.accountId, undefined);
  });
});

describe('submit', () => {
  it('reports mt 3 as forwarded and resolves only on mt 24', async () => {
    const { socket, fake } = await connected();
    const frame = placeFrame(socket);
    const seen: string[] = [];

    const submitted = socket.submit({
      frame,
      intent: 'place',
      idempotencyKey: 'key-1',
      matches: matchPlacement(frame, socket.knownOrderIds),
      onForwarded: () => seen.push('forwarded'),
      ackTimeoutMs: 500,
      resultTimeoutMs: 500,
    });

    fake.deliver({ mt: 3, sid: 100, sn: 1, cid: frame.sn, status: { code: 0, error: '' } });
    await new Promise((r) => setTimeout(r, 5));

    // The acknowledgement is visible, but the action has NOT completed.
    assert.deepEqual(seen, ['forwarded']);
    let settled = false;
    void submitted.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(settled, false, 'must not resolve on mt 3');

    fake.deliver({ mt: 24, at: { b: 1, t: 2 }, d: [{ oid: 777, st: 2, sr: 0, r: false }] });
    const result = await submitted;
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.orderId, 777);
    assert.match(result.reason, /st: 2 Open/);
  });

  it('stops waiting when the gateway rejects the frame', async () => {
    const { socket, fake } = await connected();
    const frame = placeFrame(socket);
    const submitted = socket.submit({
      frame,
      intent: 'place',
      idempotencyKey: 'key-2',
      matches: matchPlacement(frame, socket.knownOrderIds),
      ackTimeoutMs: 500,
      resultTimeoutMs: 500,
    });

    // Documented: a non-zero code means no mt 24 will ever follow.
    fake.deliver({
      mt: 3,
      sid: 100,
      sn: 2,
      cid: frame.sn,
      status: { code: 400, error: 'last exec block already expired' },
    });

    const result = await submitted;
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /code 400/);
    assert.match(result.reason, /last exec block already expired/);
  });

  it('ignores a non-definitive status and settles on the definitive one', async () => {
    const { socket, fake } = await connected();
    const frame = placeFrame(socket);
    const submitted = socket.submit({
      frame,
      intent: 'place',
      idempotencyKey: 'key-3',
      matches: matchPlacement(frame, socket.knownOrderIds),
      ackTimeoutMs: 500,
      resultTimeoutMs: 500,
    });
    fake.deliver({ mt: 3, sid: 100, cid: frame.sn, status: { code: 0, error: '' } });
    await new Promise((r) => setTimeout(r, 5));

    fake.deliver({ mt: 24, d: [{ oid: 778, st: 1, sr: 0, r: false }] });
    fake.deliver({ mt: 24, d: [{ oid: 778, st: 4, sr: 43, r: true }] });

    const result = await submitted;
    assert.equal(result.outcome, 'confirmed');
    assert.match(result.reason, /st: 4 Filled/);
  });

  it('does not claim someone else’s order', async () => {
    const { socket, fake } = await connected();
    // An order already open at sign-in must never be mistaken for ours.
    fake.deliver({ mt: 23, d: [{ oid: 555, st: 2 }] });
    const frame = placeFrame(socket);
    const submitted = socket.submit({
      frame,
      intent: 'place',
      idempotencyKey: 'key-4',
      matches: matchPlacement(frame, socket.knownOrderIds),
      ackTimeoutMs: 500,
      resultTimeoutMs: 60,
    });
    fake.deliver({ mt: 3, sid: 100, cid: frame.sn, status: { code: 0, error: '' } });
    await new Promise((r) => setTimeout(r, 5));

    fake.deliver({ mt: 24, d: [{ oid: 555, st: 5, sr: 28, r: true }] });
    fake.deliver({ mt: 24, d: [{ oid: 999, st: 2, mkt: 99, r: false }] });

    await assert.rejects(submitted, ActionTimeoutError);
  });

  it('times out rather than guessing, and says the order may be live', async () => {
    const { socket, fake } = await connected();
    const frame = placeFrame(socket);
    const submitted = socket.submit({
      frame,
      intent: 'place',
      idempotencyKey: 'key-5',
      matches: matchPlacement(frame, socket.knownOrderIds),
      ackTimeoutMs: 500,
      resultTimeoutMs: 40,
    });
    fake.deliver({ mt: 3, sid: 100, cid: frame.sn, status: { code: 0, error: '' } });

    await assert.rejects(submitted, (error: unknown) => {
      assert.ok(error instanceof ActionTimeoutError);
      assert.equal(error.stage, 'result');
      assert.equal(error.idempotencyKey, 'key-5');
      assert.equal(error.requestId, frame.rq);
      assert.match(error.message, /may still be live/);
      return true;
    });
  });

  it('times out on a missing acknowledgement', async () => {
    const { socket } = await connected();
    const frame = placeFrame(socket);
    await assert.rejects(
      socket.submit({
        frame,
        intent: 'place',
        idempotencyKey: 'key-6',
        matches: matchPlacement(frame, socket.knownOrderIds),
        ackTimeoutMs: 30,
        resultTimeoutMs: 500,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ActionTimeoutError);
        assert.equal(error.stage, 'ack');
        return true;
      },
    );
  });

  it('fails everything in flight when the server closes', async () => {
    const { socket, fake } = await connected();
    const frame = placeFrame(socket);
    const submitted = socket.submit({
      frame,
      intent: 'place',
      idempotencyKey: 'key-7',
      matches: matchPlacement(frame, socket.knownOrderIds),
      ackTimeoutMs: 5000,
      resultTimeoutMs: 5000,
    });

    // 1011 arrives instead of any mt 3 — waiting for one would hang forever.
    fake.serverClose(1011, 'failed to process');
    await assert.rejects(submitted, /failed to process/);
  });
});

describe('session tracking', () => {
  it('follows the head block and flags a heartbeat gap', async () => {
    const { socket, fake } = await connected();
    fake.deliver({ mt: 100, sn: 101, h: 65_740_995 });
    assert.equal(socket.headBlock, 65_740_995);
    assert.equal(socket.sequenceGapDetected, false);

    fake.deliver({ mt: 100, sn: 103, h: 65_740_997 });
    assert.equal(socket.sequenceGapDetected, true, 'a skipped sn means lost messages');
  });
});

describe('lastOrderState', () => {
  it('knows nothing about an order it never heard of', async () => {
    const { socket } = await connected();
    assert.equal(socket.lastOrderState(4312150769680), undefined);
  });

  it('records the sign-in snapshot, marked as coming from one', async () => {
    const { socket, fake } = await connected();
    fake.deliver({ mt: 23, d: [{ oid: 4312150769680, st: 2, sr: 0 }] });
    assert.deepEqual(socket.lastOrderState(4312150769680), {
      orderId: 4312150769680,
      st: 2,
      sr: 0,
      source: 'snapshot',
    });
  });

  it('keeps the latest update, which is how a TTL expiry is found later', async () => {
    const { socket, fake } = await connected();
    fake.deliver({ mt: 24, d: [{ oid: 4312150769680, st: 2, sr: 0, r: false }] });
    fake.deliver({ mt: 24, d: [{ oid: 4312150769680, st: 6, sr: 14, r: true }] });

    const last = socket.lastOrderState(4312150769680);
    assert.equal(last?.st, 6, 'Expired');
    assert.equal(last?.sr, 14, 'ExceedsLastExecutionBlock');
    assert.equal(last?.source, 'update');
  });

  it('never lets a late snapshot overwrite what a live update said', async () => {
    const { socket, fake } = await connected();
    fake.deliver({ mt: 24, d: [{ oid: 777, st: 5, sr: 28, r: true }] });
    fake.deliver({ mt: 23, d: [{ oid: 777, st: 2, sr: 0 }] });
    assert.equal(socket.lastOrderState(777)?.st, 5, 'the update still wins');
  });

  it('records orders that were never ours, so any id can be reconciled', async () => {
    const { socket, fake } = await connected();
    fake.deliver({ mt: 24, d: [{ oid: 999, st: 2, mkt: 99, r: false }] });
    assert.equal(socket.lastOrderState(999)?.st, 2);
  });
});

describe('cancel', () => {
  /** What PerplVenue.cancelOrder pairs with a cancel frame: match on `oid`. */
  const cancelMatches = (orderId: number) => (order: Record<string, unknown>) =>
    orderIdOf(order) === orderId;

  function cancelFrame(socket: PerplTradingSocket, orderId: number) {
    return {
      mt: 22 as const,
      sn: socket.nextSequenceNumber(),
      rq: socket.reserveRequestId(),
      mkt: 16,
      acc: 9001,
      oid: orderId,
      t: 5 as const,
      s: 0,
      fl: 0 as const,
      lv: 0,
      lb: 65_741_015,
    };
  }

  it('confirms on the Canceled update for that oid', async () => {
    const { socket, fake } = await connected();
    const frame = cancelFrame(socket, 4312150769680);
    const submitted = socket.submit({
      frame,
      intent: 'cancel',
      idempotencyKey: 'cancel-1',
      matches: cancelMatches(4312150769680),
      ackTimeoutMs: 500,
      resultTimeoutMs: 500,
    });
    fake.deliver({ mt: 3, sid: 100, cid: frame.sn, status: { code: 0, error: '' } });
    await new Promise((r) => setTimeout(r, 5));
    fake.deliver({ mt: 24, d: [{ oid: 4312150769680, scid: 65, st: 5, sr: 28, r: true }] });

    const result = await submitted;
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.orderId, 4312150769680);
  });

  it('would never confirm if the outcome were matched on `id` — the real bug', async () => {
    const { socket, fake } = await connected();
    const frame = cancelFrame(socket, 4312150769680);
    const submitted = socket.submit({
      frame,
      intent: 'cancel',
      idempotencyKey: 'cancel-2',
      // The old matcher. The wire sends no `id`, so this matches nothing and
      // the wait runs to its timeout even though the answer did arrive.
      matches: (order) => order['id'] === 4312150769680,
      ackTimeoutMs: 500,
      resultTimeoutMs: 40,
    });
    fake.deliver({ mt: 3, sid: 100, cid: frame.sn, status: { code: 0, error: '' } });
    await new Promise((r) => setTimeout(r, 5));
    fake.deliver({ mt: 24, d: [{ oid: 4312150769680, scid: 65, st: 5, sr: 28, r: true }] });

    await assert.rejects(submitted, ActionTimeoutError);
  });

  it('leaves the expiry behind for reconciliation when the cancel times out', async () => {
    const { socket, fake } = await connected();
    const frame = cancelFrame(socket, 4312150769680);
    const submitted = socket.submit({
      frame,
      intent: 'cancel',
      idempotencyKey: 'cancel-3',
      // Nothing will ever match: the order expired before the cancel landed,
      // which is the run recorded in docs/evidence.md.
      matches: () => false,
      ackTimeoutMs: 500,
      resultTimeoutMs: 40,
    });
    fake.deliver({ mt: 3, sid: 100, cid: frame.sn, status: { code: 0, error: '' } });
    await new Promise((r) => setTimeout(r, 5));
    fake.deliver({ mt: 24, d: [{ oid: 4312150769680, st: 6, sr: 14, r: true }] });

    await assert.rejects(submitted, ActionTimeoutError);
    // The timeout is not the end of the story: the expiry is still on record.
    assert.equal(reconcileOrderState(socket.lastOrderState(4312150769680)).state, 'gone');
  });

  it('reports a cancel of an order that is gone as rejected, not confirmed', async () => {
    const { socket, fake } = await connected();
    const frame = cancelFrame(socket, 4312150769680);
    const submitted = socket.submit({
      frame,
      intent: 'cancel',
      idempotencyKey: 'cancel-4',
      matches: cancelMatches(4312150769680),
      ackTimeoutMs: 500,
      resultTimeoutMs: 500,
    });
    fake.deliver({ mt: 3, sid: 100, cid: frame.sn, status: { code: 0, error: '' } });
    await new Promise((r) => setTimeout(r, 5));
    fake.deliver({ mt: 24, d: [{ oid: 4312150769680, st: 6, sr: 14, r: true }] });

    const result = await submitted;
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /last execution block before the cancel landed/);
  });
});
