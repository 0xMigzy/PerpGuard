import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountLookup, WalletLookup, WalletProfile } from '@perpguard/shared';
import { createWatchResolver } from './resolve.ts';

const OWNER = '0xB7854953A71e45D1033B3d619E76d56391291765';
const profile = (accountId: number, address = ''): WalletProfile => ({ accountId, address } as unknown as WalletProfile);

function fakeAnalytics(options: { readonly byAddress?: WalletLookup; readonly byId?: WalletProfile }) {
  const asked: string[] = [];
  return {
    asked,
    analytics: {
      async wallet(address: string): Promise<WalletLookup> {
        asked.push(`wallet:${address}`);
        return options.byAddress ?? { kind: 'not-linked', address, reason: `no account is linked to ${address} in the index.` };
      },
      async walletByAccountId(accountId: number): Promise<WalletProfile | undefined> {
        asked.push(`account:${accountId}`);
        return options.byId;
      },
    },
  };
}

test('an address the index links resolves from the index, lowercased', async () => {
  const f = fakeAnalytics({ byAddress: { kind: 'found', profile: profile(5293, OWNER.toLowerCase()), resolvedBy: 'index' } });
  const r = createWatchResolver({ analytics: f.analytics });
  const out = await r.resolve({ kind: 'address', address: OWNER });
  assert.deepEqual(out, { accountId: 5293, address: OWNER.toLowerCase(), resolvedBy: 'index' });
  assert.deepEqual(f.asked, [`wallet:${OWNER.toLowerCase()}`], 'the chain was not needed');
});

test('an address the index cannot place is asked of the Exchange contract, and a chain answer is watchable', async () => {
  const f = fakeAnalytics({});
  const chain: AccountLookup = { found: true, accountId: 5293, address: OWNER.toLowerCase() };
  const r = createWatchResolver({ analytics: f.analytics, lookupOnChain: async () => chain });
  const out = await r.resolve({ kind: 'address', address: OWNER });
  assert.deepEqual(out, { accountId: 5293, address: OWNER.toLowerCase(), resolvedBy: 'chain' });
});

test('an address neither knows is refused with both reasons', async () => {
  const f = fakeAnalytics({});
  const r = createWatchResolver({ analytics: f.analytics, lookupOnChain: async (address) => ({ found: false, address, reason: 'this wallet has no account on the Exchange' }) });
  const out = await r.resolve({ kind: 'address', address: OWNER });
  assert.ok('error' in out);
  assert.match(out.error, /no account is linked/);
  assert.match(out.error, /Exchange contract was asked too: this wallet has no account/);
});

test('without a chain lookup the index is the only source, and the reply says so', async () => {
  const f = fakeAnalytics({});
  const out = await createWatchResolver({ analytics: f.analytics }).resolve({ kind: 'address', address: OWNER });
  assert.ok('error' in out && /not wired for lookups/.test(out.error));
});

test('an account id resolves from the index, or is refused with what would work instead', async () => {
  const known = fakeAnalytics({ byId: profile(710, '') });
  assert.deepEqual(await createWatchResolver({ analytics: known.analytics }).resolve({ kind: 'account', accountId: 710 }), { accountId: 710, address: undefined, resolvedBy: 'index' });
  const unknown = fakeAnalytics({});
  const out = await createWatchResolver({ analytics: unknown.analytics }).resolve({ kind: 'account', accountId: 999_999 });
  assert.ok('error' in out && /not in the index/.test(out.error) && /\/watch that instead/.test(out.error));
});
