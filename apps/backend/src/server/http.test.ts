/**
 * The health endpoint, through Fastify's own inject — no port, no socket.
 *
 * The status code is the assertion that matters. Most things that poll a health
 * endpoint read it and nothing else, so a DEGRADED process answering 200 would
 * look healthy to every one of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthApp } from './http.ts';
import { buildHealth, type HealthInput, type HealthReport } from './health.ts';

const base: HealthInput = {
  network: 'testnet',
  startedAtMs: 1_000_000,
  nowMs: 1_060_000,
  feed: { state: 'connected', reconnectAttempt: 0 },
  positions: { state: 'live', lastUpdateMs: 1_059_500, ageMs: 500 },
  assessments: [],
  trading: { state: 'signed-in', attempt: 1, accountId: 710, forwardingAllowed: true },
  alerts: { transportConfigured: true, durableLog: true, delivered: 0, failed: 0 },
  indexer: undefined,
  assessing: true,
};

test('a healthy process answers 200 with status OK', async () => {
  const app = createHealthApp({ health: () => buildHealth(base) });
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as HealthReport;
    assert.equal(body.status, 'OK');
    assert.equal(body.network, 'testnet');
  } finally {
    await app.close();
  }
});

test('a blind process answers 503, so a probe that reads only the code is not fooled', async () => {
  const app = createHealthApp({
    health: () =>
      buildHealth({
        ...base,
        feed: { state: 'disconnected', reason: 'socket closed', reconnectAttempt: 3 },
      }),
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 503);
    const body = response.json() as HealthReport;
    assert.equal(body.status, 'DEGRADED');
    assert.match(body.reasons.join('\n'), /^feed: /m);
  } finally {
    await app.close();
  }
});

test('the report is rebuilt per request, never cached', async () => {
  // A cached report is a snapshot of how things were, which is the same mistake
  // as serving a frozen price.
  let connected = true;
  const app = createHealthApp({
    health: () =>
      buildHealth({
        ...base,
        feed: connected
          ? { state: 'connected', reconnectAttempt: 0 }
          : { state: 'disconnected', reconnectAttempt: 1 },
      }),
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
    connected = false;
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 503);
  } finally {
    await app.close();
  }
});

test('GET / points at the health endpoint and carries the same verdict', async () => {
  const app = createHealthApp({
    health: () => buildHealth({ ...base, assessing: false }),
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      service: 'perpguard-backend',
      status: 'DEGRADED',
      health: '/health',
    });
  } finally {
    await app.close();
  }
});

test('SECURITY: through a proxy /health gives the verdict and counts, never an account id; on the box, the detail', async () => {
  const report = buildHealth(base);
  const withSessions: HealthReport = {
    ...report,
    reasons: ['account 4242: socket dropped'],
    components: {
      ...report.components,
      trading: { ...report.components.trading, accountId: 710, forwardingAllowed: true },
      sessions: { state: 'degraded', count: 2, accounts: { '710': { state: 'ok' }, '4242': { state: 'degraded' } }, detail: 'account 4242: socket dropped' },
    },
  };
  const app = createHealthApp({ health: () => withSessions });
  for (const headers of [{ 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-proto': 'https' }, { via: '1.1 Caddy' }, { forwarded: 'for=203.0.113.9' }]) {
    const r = await app.inject({ method: 'GET', url: '/health', headers });
    assert.equal(r.statusCode, 200, 'the code is the same verdict either way');
    assert.doesNotMatch(r.body, /710|4242|forwardingAllowed|accounts|reasons/, JSON.stringify(headers));
    assert.deepEqual(r.json().components.sessions, { state: 'degraded', count: 2 });
  }
  const local = await app.inject({ method: 'GET', url: '/health' });
  assert.match(local.body, /"4242"/, 'straight to the port on the box: the full report');
});
