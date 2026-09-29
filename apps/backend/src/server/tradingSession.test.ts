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
  const socket = {
    accountId: 710,
    forwardingAllowed: true,
    accountFrozen: false,
    close: () => {},
  } as unknown as PerplTradingSocket;

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
