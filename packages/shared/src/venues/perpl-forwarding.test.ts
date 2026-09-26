import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ForwardingNotAllowedError,
  assertForwardingAllowed,
  forwardingBlockReason,
} from './perpl-forwarding.ts';

const testnet = { network: 'testnet' } as const;

describe('forwardingBlockReason', () => {
  it('allows an account whose fw flag is true', () => {
    assert.equal(
      forwardingBlockReason({ ...testnet, forwardingAllowed: true, accountId: 710 }),
      undefined,
    );
  });

  it('does not block before the snapshot has arrived', () => {
    // Absent is unknown, not off. Blocking here would ground every action on a
    // slow sign-in.
    assert.equal(forwardingBlockReason({ ...testnet, forwardingAllowed: undefined }), undefined);
  });

  it('blocks on a definite false and names the fix', () => {
    const reason = forwardingBlockReason({ ...testnet, forwardingAllowed: false, accountId: 710 });
    assert.ok(reason);
    assert.match(reason, /account 710/);
    assert.match(reason, /allowOrderForwarding\(true\)/);
    assert.match(reason, /OWNER/);
    assert.match(reason, /testnet/);
    assert.match(reason, /sr 34/);
    assert.match(reason, /nothing was submitted/);
  });

  it('still reads sensibly with no account id', () => {
    const reason = forwardingBlockReason({ ...testnet, forwardingAllowed: false });
    assert.ok(reason);
    assert.match(reason, /this account/);
  });
});

describe('assertForwardingAllowed', () => {
  it('returns quietly when forwarding is allowed', () => {
    assert.doesNotThrow(() => assertForwardingAllowed({ ...testnet, forwardingAllowed: true }));
  });

  it('throws a typed error carrying the account and network', () => {
    assert.throws(
      () => assertForwardingAllowed({ ...testnet, forwardingAllowed: false, accountId: 710 }),
      (error: unknown) => {
        assert.ok(error instanceof ForwardingNotAllowedError);
        assert.equal(error.accountId, 710);
        assert.equal(error.network, 'testnet');
        assert.equal(error.venue, 'perpl');
        return true;
      },
    );
  });
});
