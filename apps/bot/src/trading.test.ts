import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionState, networkLabel } from './trading.ts';

const live = { trading: { state: 'signed-in', forwardingAllowed: true } };

test('execution is green ONLY for a signed-in session that allows forwarded orders', () => {
  assert.deepEqual(executionState({ session: live }), { dot: '🟢', label: 'Authorized' });
  // forwardingAllowed unknown (no snapshot yet) is not "off": the executor's pre-flight still checks it.
  assert.equal(executionState({ session: { trading: { state: 'signed-in' } } }).dot, '🟢');
});

test('every way it cannot act is named, with what to do, and never reads as authorized', () => {
  const cases = [
    [undefined, '🟠', /Not running/],
    [{}, '🟠', /Not running/],
    [{ needsRelink: 'rotated', session: live }, '🔴', /no longer be used/],
    [{ session: { ...live, mismatch: 'signed in as #711' } }, '🔴', /another account/],
    [{ session: { trading: { state: 'connecting' } } }, '🟠', /Connecting/],
    [{ session: { trading: { state: 'signed-in', forwardingAllowed: false } } }, '🟡', /forwarding is off/],
  ] as const;
  for (const [facts, dot, label] of cases) {
    const s = executionState(facts);
    assert.equal(s.dot, dot, JSON.stringify(facts));
    assert.match(s.label, label);
    assert.ok(s.next !== undefined && s.next.length > 0, 'says what to do');
  }
});

test('the network is always named', () => {
  assert.equal(networkLabel('testnet'), 'Monad testnet');
  assert.equal(networkLabel('mainnet'), 'Monad mainnet');
});
