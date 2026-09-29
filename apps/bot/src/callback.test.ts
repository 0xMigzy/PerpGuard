/**
 * What a button carries.
 *
 * The round trip is the contract: whatever `encodeCallback` writes,
 * `decodeCallback` has to read back as the same market and the same amount. A
 * bigint that came back as a Number would be the kind of bug that only shows up
 * on a large top-up, which is the one that matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLBACK_DATA_MAX_BYTES,
  decodeCallback,
  encodeCallback,
  type CallbackPayload,
} from './callback.ts';

const payload: CallbackPayload = {
  kind: 'act',
  token: 't1',
  marketId: 1,
  amountCNS: 562_000_000n,
};

test('a payload survives the round trip exactly, amount included', () => {
  for (const kind of ['act', 'confirm', 'blocked'] as const) {
    const data = encodeCallback({ ...payload, kind });
    const decoded = decodeCallback(data);
    assert.equal(decoded.ok, true, `${kind} should decode`);
    assert.ok(decoded.ok);
    assert.deepEqual(decoded.payload, { ...payload, kind });
    assert.equal(typeof decoded.payload.amountCNS, 'bigint');
  }
});

test('a large amount round-trips without losing precision', () => {
  // Past Number.MAX_SAFE_INTEGER: 9_007_199_254_740_993 micros. A Number would
  // come back as ...992.
  const big = 9_007_199_254_740_993n;
  const decoded = decodeCallback(encodeCallback({ ...payload, amountCNS: big }));
  assert.ok(decoded.ok);
  assert.equal(decoded.payload.amountCNS, big);
});

test('every payload fits Telegram’s 64-byte callback_data limit', () => {
  const data = encodeCallback({ ...payload, token: 'abcdefgh', amountCNS: 9_007_199_254_740_993n });
  assert.ok(new TextEncoder().encode(data).length <= CALLBACK_DATA_MAX_BYTES, data);
});

test('an oversized payload throws rather than being truncated', () => {
  // Truncation would produce a payload that decodes to a DIFFERENT amount, and
  // the button would then send something the user never read.
  assert.throws(
    () =>
      encodeCallback({
        ...payload,
        token: 'abcdefgh',
        marketId: Number.MAX_SAFE_INTEGER,
        amountCNS: 10n ** 40n,
      }),
    /over Telegram's 64-byte limit/,
  );
});

test('a token with a separator in it is refused at encode time', () => {
  assert.throws(() => encodeCallback({ ...payload, token: 'a:b' }), /must be 1-16 lowercase/);
});

test('a button from an older payload version is refused, and says so', () => {
  const decoded = decodeCallback('a0:t1:1:562000000');
  assert.equal(decoded.ok, false);
  assert.ok(!decoded.ok);
  assert.match(decoded.reason, /older version of the bot/);
});

test('malformed payloads are refused rather than guessed at', () => {
  const cases = [
    '',
    'a1:t1:1',
    'a1:t1:1:562000000:extra',
    'q1:t1:1:562000000',
    'a1:t1:one:562000000',
    'a1:t1:1:-5',
    'a1:t1:1:5.5',
    'a1::1:5',
  ];
  for (const data of cases) {
    const decoded = decodeCallback(data);
    assert.equal(decoded.ok, false, `${JSON.stringify(data)} should not decode`);
  }
});
