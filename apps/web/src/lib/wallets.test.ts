import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferTier, cumulativePnl, parseWalletQuery } from './wallets.ts';

test('a checksummed address is accepted as an address, in the case it was given', () => {
  assert.deepEqual(parseWalletQuery(' 0x83107A83F5fA8c419F131aa970eb975Bd0225D4D '), {
    kind: 'address',
    address: '0x83107A83F5fA8c419F131aa970eb975Bd0225D4D',
  });
  assert.equal(parseWalletQuery('0x83107a83f5fa8c419f131aa970eb975bd0225d4d').kind, 'address');
});

test('digits are an account id; anything else is refused with a reason', () => {
  assert.deepEqual(parseWalletQuery('4734'), { kind: 'account', accountId: 4734 });
  const short = parseWalletQuery('0x1234');
  assert.equal(short.kind, 'invalid');
  assert.match((short as { reason: string }).reason, /40 hex/);
  assert.equal(parseWalletQuery('vitalik.eth').kind, 'invalid');
  assert.equal(parseWalletQuery('').kind, 'invalid');
});

test('the PnL curve runs oldest first from zero over the trips given', () => {
  const trip = (netPnlAusd: number) => ({ netPnlAusd }) as never;
  assert.deepEqual(cumulativePnl([trip(5), trip(-2), trip(10)]), [10, 8, 13], 'served newest first: 10, then −2, then +5');
  assert.deepEqual(cumulativePnl([]), []);
});

test('a negative buffer is PAST liquidation, never a small buffer', () => {
  assert.equal(bufferTier(-0.01), 'past');
  assert.equal(bufferTier(0.01), 'danger');
  assert.equal(bufferTier(0.05), 'watch');
  assert.equal(bufferTier(0.2), 'safe');
  assert.equal(bufferTier(undefined), 'unknown');
});
