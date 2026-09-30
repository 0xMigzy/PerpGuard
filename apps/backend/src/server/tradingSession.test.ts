/**
 * The session that retries forever and never takes the process with it.
 *
 * Two properties matter here and neither is obvious from reading the class: a
 * sign-in failure must not escape to the caller, and the reason must be logged
 * ONCE rather than on every retry. A socket retrying every few seconds against a
 * revoked key would otherwise bury the one different line that mattered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PerplTradingSocket, PerplVenue } from '@perpguard/shared';
import { TradingSession } from './tradingSession.ts';

class RecordingLogger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  info(message: string): void {
    this.infos.push(message);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
}

/** Just enough venue to fail or succeed at connectTrading. */
function venueThat(behaviour: () => Promise<unknown>): PerplVenue {
  return { connectTrading: behaviour } as unknown as PerplVenue;
}

const network = { name: 'testnet', chainId: 10143 } as never;

/** A socket the test can close from the server side. */
function fakeSocket(accountId: number): PerplTradingSocket & { drop(reason: string): void } {
  const waiters = new Set<(error: Error) => void>();
  let closed = false;
  const fake = {
    accountId,
    forwardingAllowed: true,
    accountFrozen: false,
    get closed() {
      return closed;
    },
    onClose(listener: (error: Error) => void) {
      waiters.add(listener);
      return () => waiters.delete(listener);
    },
    close() {
      fake.drop('socket closed locally');
    },
    drop(reason: string) {
      if (closed) return;
      closed = true;
      for (const waiter of [...waiters]) waiter(new Error(reason));
    },
  };
  return fake as unknown as PerplTradingSocket & { drop(reason: string): void };
}

/** Let the background retry loop run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test('no credentials is not-configured, and nothing is attempted', async () => {
  const logger = new RecordingLogger();
  const session = new TradingSession({
    venue: venueThat(async () => {
      throw new Error('should never be called');
    }),
    network,
    apiKey: undefined,
    logger,
    sleep: async () => {},
  });

  session.start();
  await settle();

  const status = session.status();
  assert.equal(status.state, 'not-configured');
  assert.match(status.reason ?? '', /no Perpl API credentials/);
  assert.equal(status.attempt, 0);
  // Not the retry message: nothing is being retried, and saying otherwise would
  // have someone waiting for a connection that will never be attempted.
  assert.equal(logger.warnings.length, 1);
  assert.doesNotMatch(logger.warnings[0]!, /retry/i);
});

test('a successful sign-in reports the account and hands over the socket once', async () => {
  const socket = fakeSocket(710);

  const handed: PerplTradingSocket[] = [];
  const session = new TradingSession({
    venue: venueThat(async () => socket),
    network,
    apiKey: 'a'.repeat(64),
    logger: new RecordingLogger(),
    sleep: async () => {},
  });
  session.onSignedIn((s) => void handed.push(s));

  session.start();
  await settle();

  assert.equal(session.status().state, 'signed-in');
  assert.equal(session.status().accountId, 710);
  assert.equal(session.status().forwardingAllowed, true);
  assert.deepEqual(handed, [socket]);
});

test('a sign-in failure never escapes, and the session stays retrying', async () => {
  // The price feed and /health are exactly what somebody needs when the account
  // socket is down.
  const logger = new RecordingLogger();
  const session = new TradingSession({
    venue: venueThat(async () => {
      throw new Error('websocket closed with 3401');
    }),
    network,
    apiKey: 'a'.repeat(64),
    logger,
    backoffMs: [0],
    sleep: async () => {},
  });

  session.start();
  await settle();

  assert.equal(session.status().state, 'retrying');
  assert.match(session.status().reason ?? '', /3401/);
  assert.ok(session.attempts > 1, 'it should still be retrying');
  await session.stop();
});

test('the same failure is logged once, not once per retry', async () => {
  const logger = new RecordingLogger();
  const session = new TradingSession({
    venue: venueThat(async () => {
      throw new Error('websocket closed with 3401');
    }),
    network,
    apiKey: 'a'.repeat(64),
    logger,
    backoffMs: [0],
    sleep: async () => {},
  });

  session.start();
  await settle();
  const attempts = session.attempts;
  await session.stop();

  assert.ok(attempts > 3, `expected several attempts, got ${attempts}`);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0]!, /3401/);
  assert.match(logger.warnings[0]!, /keeps retrying/);
});

test('a changed reason is logged again, so a new problem is not swallowed', async () => {
  const logger = new RecordingLogger();
  let reason = 'websocket closed with 3401';
  const session = new TradingSession({
    venue: venueThat(async () => {
      throw new Error(reason);
    }),
    network,
    apiKey: 'a'.repeat(64),
    logger,
    backoffMs: [0],
    sleep: async () => {
      reason = 'getaddrinfo ENOTFOUND testnet.perpl.xyz';
    },
  });

  session.start();
  await settle();
  await session.stop();

  assert.equal(logger.warnings.length, 2);
  assert.match(logger.warnings[1]!, /ENOTFOUND/);
});

test('the API key is only ever rendered masked', async () => {
  const logger = new RecordingLogger();
  const apiKey = 'SECRETKEY'.repeat(7);
  const session = new TradingSession({
    venue: venueThat(async () => {
      throw new Error('nope');
    }),
    network,
    apiKey,
    logger,
    backoffMs: [0],
    sleep: async () => {},
  });

  session.start();
  await settle();
  await session.stop();

  const everything = [...logger.infos, ...logger.warnings].join('\n');
  assert.ok(!everything.includes(apiKey), 'the key must never be logged in full');
  assert.match(everything, /SECR…TKEY \(63 chars\)/);
});

test('a socket that drops after sign-in is replaced: retrying meanwhile, then signed in again with the new one', async () => {
  // The trading socket never reconnects itself. The session must notice the
  // close, say so while it lasts, and hand the NEXT socket to whoever builds
  // the position source — a source left on the dead socket is a frozen set.
  const logger = new RecordingLogger();
  const sockets = [fakeSocket(710), fakeSocket(710)];
  let opened = 0;
  // The backoff sleep is held open by the test, so the retrying state can be
  // observed before the reconnect goes through.
  let release: (() => void) | undefined;
  const session = new TradingSession({
    venue: venueThat(async () => sockets[opened++]),
    network,
    apiKey: 'a'.repeat(64),
    logger,
    backoffMs: [1_000],
    sleep: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  const handed: PerplTradingSocket[] = [];
  session.onSignedIn((s) => void handed.push(s));

  session.start();
  await settle();
  assert.equal(session.status().state, 'signed-in');
  assert.equal(handed.length, 1);
  assert.equal(release, undefined, 'a successful sign-in never sleeps');

  sockets[0]!.drop('socket closed with 1006');
  await settle();
  assert.equal(session.status().state, 'retrying');
  assert.match(session.status().reason ?? '', /closed \(socket closed with 1006\); signing in again/);
  assert.equal(logger.warnings.length, 1, 'the drop is logged once');
  assert.match(logger.warnings[0]!, /1006/);
  assert.equal(handed.length, 1, 'nothing new is handed over during the backoff');

  release?.();
  await settle();
  assert.equal(session.status().state, 'signed-in');
  assert.equal(session.signIns, 2);
  assert.deepEqual(handed, sockets, 'the second sign-in hands over the second socket');
  assert.equal(session.socket, sockets[1]);
  assert.match(logger.infos.at(-1) ?? '', /signed in again/);
  await session.stop();
});

test('stopping while signed in closes the socket and does not reconnect', async () => {
  let opened = 0;
  const session = new TradingSession({
    venue: venueThat(async () => {
      opened += 1;
      return fakeSocket(710);
    }),
    network,
    apiKey: 'a'.repeat(64),
    logger: new RecordingLogger(),
    backoffMs: [0],
    sleep: async () => {},
  });
  session.start();
  await settle();
  assert.equal(opened, 1);
  await session.stop();
  await settle();
  assert.equal(opened, 1, 'a local close is not a drop to recover from');
});
