/**
 * `/status` — the command whose only job is to never lie about being healthy.
 *
 * The two down cases are the point of the file. A monitor that has gone blind
 * must say so in its first line, because the first line is all most people read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDuration, renderStatus, type StatusInput } from './status.ts';
import { dangerAssessment } from './testSupport.ts';

const healthy: StatusInput = {
  network: 'mainnet',
  feed: { state: 'connected', reconnectAttempt: 0 },
  positions: { state: 'live', lastUpdateMs: 999_500, ageMs: 500 },
  assessments: [dangerAssessment()],
  nowMs: 1_000_000,
};

test('a healthy monitor says what it is watching', () => {
  const text = renderStatus(healthy);
  assert.match(text, /^PerpGuard is watching 1 position\.$/m);
  assert.match(text, /Network: mainnet\./);
  assert.match(text, /Price feed: connected\./);
  assert.match(text, /Positions: live\./);
  assert.match(text, /Current: BTC DANGER\./);
  assert.match(text, /BTC: 0 ms old/);
  // Nothing qualifies the numbers, because nothing needs to.
  assert.doesNotMatch(text, /not current ones/);
});

test('a down feed says BLIND in the first line, and says the prices are frozen', () => {
  const text = renderStatus({
    ...healthy,
    feed: {
      state: 'disconnected',
      reason: 'the socket closed with 1006 and has not reopened.',
      reconnectAttempt: 4,
      downForMs: 95_000,
    },
  });

  assert.match(text.split('\n')[0]!, /^PerpGuard is BLIND: the price feed is down\.$/);
  assert.match(text, /Price feed: DISCONNECTED for 1 minute\./);
  assert.match(text, /frozen at whatever it was when the connection dropped/);
  assert.match(text, /will not act/);
  assert.match(text, /4 reconnect attempt\(s\)/);
  assert.match(text, /the socket closed with 1006/);
  assert.match(text, /not current ones/);
});

test('an untrusted position list is reported as itself, not as a feed problem', () => {
  // The two have different causes and different fixes. Naming the wrong one is a
  // confident false explanation from a tool whose whole job is to be believed.
  const text = renderStatus({
    ...healthy,
    positions: {
      state: 'stale',
      reason: 'a sequence gap means an update may have been missed.',
      lastUpdateMs: 940_000,
      ageMs: 60_000,
    },
  });

  assert.match(text.split('\n')[0]!, /cannot trust your position list right now/);
  assert.match(text, /Positions: UNTRUSTED\./);
  assert.match(text, /may already be closed and one that is open may be missing/);
  assert.match(text, /Last confirmed 1 minute ago\./);
  assert.match(text, /a sequence gap/);
  // The feed is fine and is not blamed.
  assert.match(text, /Price feed: connected\./);
});

test('both down names both, and neither hides the other', () => {
  const text = renderStatus({
    ...healthy,
    feed: { state: 'reconnecting', reconnectAttempt: 2, downForMs: 3_000 },
    positions: { state: 'stale', lastUpdateMs: 900_000, ageMs: 100_000 },
  });

  assert.match(
    text.split('\n')[0]!,
    /BLIND: I cannot trust your position list and the price feed is down/,
  );
  assert.match(text, /Price feed: RECONNECTING/);
  assert.match(text, /Positions: UNTRUSTED/);
});

test('awaiting-snapshot is never rendered as an empty portfolio', () => {
  // "I have not been told what is open" is not "you have nothing open".
  const text = renderStatus({
    ...healthy,
    assessments: [],
    positions: { state: 'awaiting-snapshot', lastUpdateMs: undefined, ageMs: undefined },
  });

  assert.match(text.split('\n')[0]!, /BLIND/);
  assert.match(text, /Positions: AWAITING SNAPSHOT/);
  assert.match(text, /not the same as having no positions/);
  assert.doesNotMatch(text, /No open positions/);
});

test('a genuinely empty portfolio on a healthy monitor says so plainly', () => {
  const text = renderStatus({ ...healthy, assessments: [] });
  assert.match(text.split('\n')[0]!, /^PerpGuard is watching\. No open positions\.$/);
});

test('a quiet market is reported by age, never as a fault', () => {
  const assessment = { ...dangerAssessment(), priceAgeMs: 92_000, priceIsOld: true };
  const text = renderStatus({ ...healthy, assessments: [assessment] });

  assert.match(text.split('\n')[0]!, /watching 1 position/);
  assert.match(text, /BTC: 1 minute old/);
  assert.doesNotMatch(text, /BLIND/);
  assert.doesNotMatch(text, /not current ones/);
});

test('a market that has never had a price says so rather than showing nothing', () => {
  const assessment = { ...dangerAssessment(), priceAgeMs: undefined };
  const text = renderStatus({ ...healthy, assessments: [assessment] });
  assert.match(text, /BTC: no price has ever arrived/);
});

test('durations read as a person would say them', () => {
  assert.equal(describeDuration(undefined), 'unknown');
  assert.equal(describeDuration(0), '0 ms');
  assert.equal(describeDuration(999), '999 ms');
  assert.equal(describeDuration(1_000), '1 second');
  assert.equal(describeDuration(59_999), '59 seconds');
  assert.equal(describeDuration(60_000), '1 minute');
  assert.equal(describeDuration(3_600_000), '1 hour');
});
