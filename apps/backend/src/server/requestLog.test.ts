import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loggableUrl, requestLine } from './requestLog.ts';

test('one line per request: method, path, status, milliseconds', () => {
  assert.equal(requestLine('GET', '/api/analytics/copy/2399?size=1000&days=30', 200, 21.4), 'http GET /api/analytics/copy/2399?size=1000&days=30 200 21ms');
});

test('NOTHING PRIVATE REACHES THE LOG: a query string survives only on the public analytics routes', () => {
  assert.equal(loggableUrl('/api/link/redeem?code=ABCD-EFGH'), '/api/link/redeem');
  assert.equal(loggableUrl('/link?code=ABCD-EFGH'), '/link');
  assert.equal(loggableUrl('/api/protect/session?code=secret'), '/api/protect/session');
  assert.equal(loggableUrl('/health?x=1'), '/health');
  assert.equal(loggableUrl('/api/analytics/traders?timeframe=24h&q=0x12'), '/api/analytics/traders?timeframe=24h&q=0x12');
  assert.equal(loggableUrl('/api/analytics/health'), '/api/analytics/health');
});
