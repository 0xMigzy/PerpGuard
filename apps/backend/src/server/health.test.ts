/**
 * `/health` under every way of going blind.
 *
 * One rule, asserted from every angle: a monitor that cannot see must not report
 * OK. Each case takes an otherwise-perfect process and breaks exactly one input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IndexerHealth } from '@perpguard/shared';
import { buildHealth, type HealthInput } from './health.ts';
import { assessOne, FIXTURE_BTC, FIXTURE_BTC_MARK } from '../alerts/testSupport.ts';

const healthy: HealthInput = {
  network: 'testnet',
  startedAtMs: 1_000_000,
  nowMs: 1_060_000,
  feed: { state: 'connected', reconnectAttempt: 0 },
  positions: { state: 'live', lastUpdateMs: 1_059_500, ageMs: 500 },
  assessments: [assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK).change.assessment],
  trading: { state: 'signed-in', attempt: 1, accountId: 710, forwardingAllowed: true },
  alerts: { transportConfigured: true, durableLog: true, delivered: 3, failed: 0 },
  indexer: undefined,
  assessing: true,
};

/** Every degraded component must also explain itself in `reasons`. */
function degradedBecause(input: HealthInput, component: string, pattern: RegExp): void {
  const report = buildHealth(input);
  assert.equal(report.status, 'DEGRADED');
  assert.equal(
    report.components[component as keyof typeof report.components]?.state,
    'degraded',
    `${component} should be degraded`,
  );
  assert.ok(
    report.reasons.some((reason) => reason.startsWith(`${component}: `) && pattern.test(reason)),
    `expected a ${component} reason matching ${pattern}, got ${JSON.stringify(report.reasons)}`,
  );
}

test('a process with every input healthy reports OK and gives no reasons', () => {
  const report = buildHealth(healthy);
  assert.equal(report.status, 'OK');
  assert.deepEqual(report.reasons, []);
  assert.equal(report.network, 'testnet');
  assert.equal(report.uptimeMs, 60_000);
  assert.equal(report.components.risk['tracked'], 1);
  assert.deepEqual(report.components.risk['states'], { DANGER: 1 });
});

test('a disconnected price feed degrades the whole report and says prices are frozen', () => {
  degradedBecause(
    {
      ...healthy,
      feed: {
        state: 'disconnected',
        reason: 'the socket closed with 1006 and has not reopened',
        reconnectAttempt: 5,
        downForMs: 42_000,
      },
    },
    'feed',
    /1006/,
  );
});

test('a reconnecting feed degrades too: frozen is frozen', () => {
  const report = buildHealth({
    ...healthy,
    feed: { state: 'reconnecting', reconnectAttempt: 2 },
  });
  assert.equal(report.status, 'DEGRADED');
  assert.match(String(report.components.feed['detail']), /frozen/);
});

test('an untrusted position set degrades, and is not blamed on the feed', () => {
  const report = buildHealth({
    ...healthy,
    positions: {
      state: 'stale',
      reason: 'a heartbeat sequence gap means a position update may have been missed',
      lastUpdateMs: 1_000_000,
      ageMs: 60_000,
    },
  });
  assert.equal(report.status, 'DEGRADED');
  assert.equal(report.components.positions.state, 'degraded');
  // The two blind causes have different fixes; naming the wrong one is a lie.
  assert.equal(report.components.feed.state, 'ok');
  assert.match(report.reasons.join('\n'), /sequence gap/);
});

test('awaiting-snapshot degrades rather than reading as an empty portfolio', () => {
  degradedBecause(
    {
      ...healthy,
      assessments: [],
      positions: { state: 'awaiting-snapshot', lastUpdateMs: undefined, ageMs: undefined },
    },
    'positions',
    /not been told what is open/,
  );
});

test('a trading session that cannot sign in degrades but is never fatal', () => {
  degradedBecause(
    {
      ...healthy,
      trading: {
        state: 'retrying',
        reason: 'sign-in failed: websocket closed with 3401',
        attempt: 7,
      },
    },
    'trading',
    /3401/,
  );
});

test('absent credentials are not-configured, which is reported but does not degrade', () => {
  const report = buildHealth({
    ...healthy,
    trading: { state: 'not-configured', attempt: 0 },
  });
  assert.equal(report.components.trading.state, 'not-configured');
  assert.equal(report.status, 'OK');
  assert.match(String(report.components.trading['detail']), /no Perpl API credentials/);
});

test('an account with forwarding off degrades, because every action would fail', () => {
  degradedBecause(
    {
      ...healthy,
      trading: { state: 'signed-in', attempt: 1, accountId: 710, forwardingAllowed: false },
    },
    'trading',
    /allowOrderForwarding/,
  );
});

test('no alert transport degrades: a warning with nowhere to go is not a warning', () => {
  degradedBecause(
    {
      ...healthy,
      alerts: {
        transportConfigured: false,
        transportReason: 'TELEGRAM_BOT_TOKEN is not set',
        durableLog: true,
        delivered: 0,
        failed: 0,
      },
    },
    'alerts',
    /TELEGRAM_BOT_TOKEN/,
  );
});

test('an in-memory alert log degrades, because the record does not survive a restart', () => {
  degradedBecause(
    { ...healthy, alerts: { ...healthy.alerts, durableLog: false } },
    'alerts',
    /in memory/,
  );
});

test('an unreachable Postgres is distinguished from an unconfigured one', () => {
  // "Alert history is in memory" is the symptom. A database that refused the
  // connection and one that was never configured need different fixes, and a
  // report that cannot tell them apart sends someone to edit an env var that is
  // already correct.
  const unconfigured = buildHealth({
    ...healthy,
    alerts: { ...healthy.alerts, durableLog: false, durableReason: 'DATABASE_URL is not set' },
  });
  assert.match(String(unconfigured.components.alerts['detail']), /DATABASE_URL is not set/);

  const refused = buildHealth({
    ...healthy,
    alerts: {
      ...healthy.alerts,
      durableLog: false,
      durableReason: 'Postgres was configured but could not be reached: ECONNREFUSED',
    },
  });
  assert.match(String(refused.components.alerts['detail']), /could not be reached: ECONNREFUSED/);
  assert.notEqual(
    unconfigured.components.alerts['detail'],
    refused.components.alerts['detail'],
  );
});

test('a durable log on a reachable database is simply ok', () => {
  // The green case is green because the rows actually persist, not because the
  // check is lenient.
  const report = buildHealth({
    ...healthy,
    alerts: { ...healthy.alerts, durableLog: true, delivered: 2 },
  });
  assert.equal(report.components.alerts.state, 'ok');
  assert.equal(report.status, 'OK');
});

test('a failed last delivery degrades and quotes the failure', () => {
  degradedBecause(
    {
      ...healthy,
      alerts: {
        ...healthy.alerts,
        failed: 1,
        lastFailureAtMs: 1_050_000,
        lastFailure: 'BTC DANGER: Telegram 403: bot was blocked by the user',
      },
    },
    'alerts',
    /blocked by the user/,
  );
});

test('the last alert sent is reported, so a quiet process can be told from a dead one', () => {
  const report = buildHealth({
    ...healthy,
    alerts: {
      ...healthy.alerts,
      lastDeliveredAtMs: 1_055_000,
      lastDelivered: 'BTC DANGER',
    },
  });
  assert.equal(report.status, 'OK');
  assert.equal(report.components.alerts['lastDelivered'], 'BTC DANGER');
  assert.equal(report.components.alerts['lastDeliveredAt'], new Date(1_055_000).toISOString());
});

test('an indexer that is behind degrades; one that is synced does not', () => {
  const lagging: IndexerHealth = {
    state: 'lagging',
    blocksBehind: 9_512,
    headIsIndependent: true,
    serveAsCurrent: false,
    reason: 'the indexer is 9512 blocks behind real head and still catching up',
    observedAtMs: 1_060_000,
  };
  degradedBecause({ ...healthy, indexer: lagging }, 'indexer', /9512 blocks behind/);

  const synced: IndexerHealth = {
    state: 'synced',
    blocksBehind: 12,
    headIsIndependent: true,
    serveAsCurrent: true,
    observedAtMs: 1_060_000,
  };
  assert.equal(buildHealth({ ...healthy, indexer: synced }).status, 'OK');
});

test('an unverified indexer degrades: marking its own homework is not evidence', () => {
  const unknown: IndexerHealth = {
    state: 'unknown',
    blocksBehind: 0,
    headIsIndependent: false,
    serveAsCurrent: false,
    reason: 'no independent chain head was supplied',
    observedAtMs: 1_060_000,
  };
  degradedBecause({ ...healthy, indexer: unknown }, 'indexer', /independent chain head/);
});

test('no indexer configured is reported without degrading anything', () => {
  const report = buildHealth(healthy);
  assert.equal(report.components.indexer.state, 'not-configured');
  assert.equal(report.status, 'OK');
});

test('a loop that has not begun assessing degrades, however healthy its inputs look', () => {
  // The whole stack can be up while the gate has not opened. Reporting OK then
  // would be saying it about a loop that has never run.
  degradedBecause({ ...healthy, assessing: false }, 'risk', /has not begun assessing/);
});

test('several blind inputs at once are all named, not just the first', () => {
  const report = buildHealth({
    ...healthy,
    feed: { state: 'disconnected', reconnectAttempt: 3 },
    positions: { state: 'stale', lastUpdateMs: 1, ageMs: 9 },
    trading: { state: 'retrying', reason: 'sign-in failed', attempt: 3 },
  });
  assert.equal(report.status, 'DEGRADED');
  assert.equal(report.reasons.length, 3);
  assert.ok(report.reasons.some((r) => r.startsWith('feed: ')));
  assert.ok(report.reasons.some((r) => r.startsWith('positions: ')));
  assert.ok(report.reasons.some((r) => r.startsWith('trading: ')));
});
