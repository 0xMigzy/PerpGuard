import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseAccountId, collectAccountIds } from './perpl-account-scan.ts';

/** A WalletSnapshot shaped as the docs describe: the id lives at as[0].id. */
const walletSnapshot = {
  mt: 19,
  sn: 4711,
  as: [{ in: 12, id: 9001, fr: false, fw: true, lfr: 530, b: '100000000', lb: '0' }],
};

const fillsUpdate = {
  mt: 25,
  at: { b: 65_740_995, t: 1_790_391_305_000 },
  d: [{ mkt: 16, acc: 9001, oid: 55, t: 1, l: 2, p: 420083, s: 1, f: '3' }],
};

describe('collectAccountIds', () => {
  it('finds the id inside the wallet snapshot account array', () => {
    const [candidate, ...rest] = collectAccountIds(walletSnapshot);
    assert.equal(rest.length, 0);
    assert.equal(candidate?.accountId, 9001);
    assert.equal(candidate?.path, 'as[0].id');
    assert.equal(candidate?.source, 'account-object');
    assert.equal(candidate?.mt, 19);
    assert.match(candidate?.detail ?? '', /instance 12/);
    assert.match(candidate?.detail ?? '', /lfr 530/);
  });

  it('finds bare acc references on other frames', () => {
    const [candidate] = collectAccountIds(fillsUpdate);
    assert.equal(candidate?.accountId, 9001);
    assert.equal(candidate?.path, 'd[0].acc');
    assert.equal(candidate?.source, 'acc-field');
    assert.equal(candidate?.mt, 25);
  });

  it('flags an account that cannot forward or is frozen', () => {
    const frozen = { mt: 21, in: 12, id: 9001, fr: true, fw: false, lfr: 0, b: '0', lb: '0' };
    assert.match(collectAccountIds(frozen)[0]?.detail ?? '', /FORWARDING DISABLED/);
    assert.match(collectAccountIds(frozen)[0]?.detail ?? '', /FROZEN/);
  });

  it('ignores ids that are not account ids', () => {
    // Order ids, market ids and subscription ids all use `id`/numeric fields.
    const orders = { mt: 24, d: [{ id: 55, st: 2, sr: 0, r: false }] };
    assert.deepEqual(collectAccountIds(orders), []);
    assert.deepEqual(collectAccountIds({ mt: 6, subs: [{ stream: 'x', sid: 100 }] }), []);
  });

  it('survives frames of any shape', () => {
    assert.deepEqual(collectAccountIds(null), []);
    assert.deepEqual(collectAccountIds('text'), []);
    assert.deepEqual(collectAccountIds({ mt: 100, sn: 1, h: 65_740_995 }), []);
  });

  it('deduplicates repeats but keeps distinct paths', () => {
    const twice = { mt: 24, d: [{ acc: 9001 }, { acc: 9001 }, { acc: 9002 }] };
    const ids = collectAccountIds(twice);
    assert.deepEqual(
      ids.map((c) => `${c.accountId}@${c.path}`),
      ['9001@d[0].acc', '9001@d[1].acc', '9002@d[2].acc'],
    );
  });
});

describe('chooseAccountId', () => {
  it('prefers the authoritative account object', () => {
    const candidates = [...collectAccountIds(walletSnapshot), ...collectAccountIds(fillsUpdate)];
    assert.equal(chooseAccountId(candidates), 9001);
  });

  it('accepts a single id seen only as acc', () => {
    assert.equal(chooseAccountId(collectAccountIds(fillsUpdate)), 9001);
  });

  it('refuses to guess when accounts disagree', () => {
    const two = [
      ...collectAccountIds({ mt: 19, as: [{ id: 1, lfr: 0 }] }),
      ...collectAccountIds({ mt: 19, as: [{ id: 2, lfr: 0 }] }),
    ];
    assert.equal(chooseAccountId(two), undefined);
    assert.equal(chooseAccountId(collectAccountIds({ mt: 24, d: [{ acc: 1 }, { acc: 2 }] })), undefined);
    assert.equal(chooseAccountId([]), undefined);
  });
});
