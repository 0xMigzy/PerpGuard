/**
 * Linking policy, with every I/O faked: the token is transport, the proof is
 * a signature or a key, a key is sealed and never comes back, an unlink
 * deletes it and closes the session, and a rotated environment key means a
 * re-link rather than a silent failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiSecret, type AccountLookup } from '@perpguard/shared';
import { InMemoryIdentityStore, InMemoryLinkStore, type TelegramIdentity } from '@perpguard/bot';
import { LinkCodeStore } from '../protect/session.ts';
import { KeyVault } from './crypto.ts';
import { LinkService, RELINK_REASON } from './service.ts';
import { InMemoryKeyStore } from './stores.ts';

const KEY_A = '1'.repeat(64);
const SECRET_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const OWNER_WALLET = '0xb7854953a71e45d1033b3d619e76d56391291765';
const ENV = 710;

interface Rig {
  readonly service: LinkService;
  readonly links: InMemoryLinkStore;
  readonly keys: InMemoryKeyStore;
  readonly identity: TelegramIdentity;
  readonly opened: Array<{ accountId: number; apiKey: string }>;
  readonly closed: number[];
  readonly running: Set<number>;
  readonly notices: Array<{ chatId: number; text: string }>;
  readonly probes: string[];
  probeAccount: number | undefined;
  lookups: Map<string, AccountLookup>;
  readonly logs: string[];
}

function rig(options: { readonly vault?: KeyVault | undefined; readonly keys?: InMemoryKeyStore; readonly maxSessions?: number } = {}): Rig {
  const identities = new InMemoryIdentityStore();
  const identity = identities.register(4242, 5150, 1_000).identity;
  const links = new InMemoryLinkStore({ capacity: 5 });
  const keys = options.keys ?? new InMemoryKeyStore();
  const state = {
    opened: [] as Array<{ accountId: number; apiKey: string }>,
    closed: [] as number[],
    running: new Set<number>([ENV]),
    notices: [] as Array<{ chatId: number; text: string }>,
    probes: [] as string[],
    probeAccount: 711 as number | undefined,
    lookups: new Map<string, AccountLookup>([[OWNER_WALLET, { found: true, accountId: ENV, address: OWNER_WALLET }]]),
    logs: [] as string[],
  };
  const service = new LinkService({
    codes: new LinkCodeStore({ now: () => 1_000 }),
    identities,
    links,
    keys,
    vault: 'vault' in options ? options.vault : new KeyVault(KEY_A),
    registry: {
      open: (accountId, credentials) => {
        if (state.running.size >= (options.maxSessions ?? 20) && !state.running.has(accountId)) return { ok: false, reason: 'PerpGuard is already running 20 linked account sessions, which is its limit on this host.' };
        const already = state.running.has(accountId);
        state.running.add(accountId);
        state.opened.push({ accountId, apiKey: credentials.apiKey });
        return { ok: true, session: {} as never, already };
      },
      close: async (accountId) => {
        state.closed.push(accountId);
        return state.running.delete(accountId);
      },
      get: (accountId) => (state.running.has(accountId) ? { status: () => ({ accountId, trading: { state: 'signed-in', attempt: 1 }, positions: { state: 'live', lastUpdateMs: 1, ageMs: 0 }, assessing: true, tracked: 0 }) } : undefined),
    },
    probe: async (sealed) => {
      state.probes.push(sealed.apiKey);
      return { accountId: state.probeAccount, forwardingAllowed: true };
    },
    lookupAccount: async (address) => state.lookups.get(address) ?? { found: false, address, reason: 'this wallet has no account on the Exchange' },
    secretFromHex: (hex) => ApiSecret.fromHex(hex),
    envAccountId: ENV,
    webUrl: 'https://perpguard.example/',
    notify: async (chatId, text) => {
      state.notices.push({ chatId, text });
    },
    logger: { info: (m) => state.logs.push(m), warn: (m) => state.logs.push(`WARN ${m}`) },
    now: () => 2_000,
  });
  return { service, links, keys, identity, ...state };
}

test('/link mints a one-time URL for the identity; redeeming it once yields that identity, twice yields nothing', () => {
  const r = rig();
  const minted = r.service.mint(r.identity.userId);
  assert.match(minted.url, /^https:\/\/perpguard\.example\/link\?code=[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(r.service.redeem(minted.code)?.userId, 'tg:4242');
  assert.equal(r.service.redeem(minted.code), undefined, 'single use');
  assert.equal(r.service.redeem('NOPE-NOPE'), undefined);
});

test('a wallet that owns the environment account links at once; the token alone never links anything', async () => {
  const r = rig();
  assert.equal(r.service.status(r.identity.userId), undefined, 'redeeming a code linked nothing');
  const proof = await r.service.proveWallet(r.identity, ['0xB7854953A71e45D1033B3d619E76d56391291765']);
  assert.deepEqual(proof, { kind: 'linked', accountId: ENV });
  assert.equal(r.links.byTelegramUserId(4242)?.accountId, ENV);
  assert.equal(r.service.status(r.identity.userId)?.proof, 'wallet');
  assert.match(r.notices[0]!.text, /Linked to Perpl account 710: your wallet proved you own it/);
  assert.deepEqual(r.opened, [], 'no session opened: the environment account already runs');
});

test('a wallet that owns an account PerpGuard does not run proves ownership and asks for a key', async () => {
  const r = rig();
  r.lookups.set('0x' + '1'.repeat(40), { found: true, accountId: 900, address: '0x' + '1'.repeat(40) });
  const proof = await r.service.proveWallet(r.identity, ['0x' + '1'.repeat(40)]);
  assert.equal(proof.kind, 'proven-needs-key');
  assert.equal(proof.kind === 'proven-needs-key' && proof.accountId, 900);
  assert.equal(r.links.byTelegramUserId(4242), undefined, 'not linked yet');
  const none = await r.service.proveWallet(r.identity, ['0x' + '2'.repeat(40)]);
  assert.equal(none.kind, 'refused');
  assert.equal((await r.service.proveWallet(r.identity, [])).kind, 'refused');
});

test('a key is probed once, opens a session, is SEALED in the store, binds the chat, and never appears in any log or reply', async () => {
  const r = rig();
  const proof = await r.service.proveKey(r.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  assert.deepEqual(proof, { kind: 'linked', accountId: 711, forwardingAllowed: true });
  assert.deepEqual(r.probes, ['the-plain-api-key-0123456789'], 'probed once');
  assert.deepEqual(r.opened.map((o) => o.accountId), [711]);
  const stored = r.keys.get(r.identity.userId)!;
  assert.equal(stored.accountId, 711);
  assert.ok(!stored.blob.includes('the-plain-api-key') && !stored.blob.includes(SECRET_HEX.slice(0, 16)), 'sealed, not stored in the clear');
  assert.equal(r.links.byTelegramUserId(4242)?.accountId, 711);
  assert.equal(r.service.status(r.identity.userId)?.proof, 'key');
  const everything = [...r.logs, ...r.notices.map((n) => n.text), JSON.stringify(proof)].join('\n');
  assert.ok(!everything.includes('the-plain-api-key') && !everything.includes(SECRET_HEX.slice(0, 16)), 'the key is in no log line, notice or reply');
});

test('a key for a different account than the wallet proved is refused, and so are malformed inputs, without echoing them', async () => {
  const r = rig();
  const mismatch = await r.service.proveKey(r.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, 900);
  assert.equal(mismatch.kind, 'refused');
  assert.match(mismatch.kind === 'refused' ? mismatch.reason : '', /That key is for account #711, but your wallet owns account #900\. Paste a key for account #900\./);
  assert.deepEqual(r.opened, [], 'nothing opened');
  const badSecret = await r.service.proveKey(r.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: 'not-hex-at-all' }, undefined);
  assert.equal(badSecret.kind, 'refused');
  assert.ok(badSecret.kind === 'refused' && !badSecret.reason.includes('not-hex-at-all'), 'the pasted value is not repeated');
  const short = await r.service.proveKey(r.identity, { apiKey: 'short', secretHex: SECRET_HEX }, undefined);
  assert.equal(short.kind, 'refused');
});

test('the cap passes through as a refusal with the registry’s sentence, and nothing is stored', async () => {
  const r = rig({ maxSessions: 1 });
  const proof = await r.service.proveKey(r.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  assert.equal(proof.kind, 'refused');
  assert.match(proof.kind === 'refused' ? proof.reason : '', /^PerpGuard can't connect another account right now\. Try again later\.$/);
  assert.ok(r.logs.some((l) => /limit on this host/.test(l)), 'the operator detail is in the log');
  assert.equal(r.keys.get(r.identity.userId), undefined);
  assert.equal(r.links.byTelegramUserId(4242), undefined);
});

test('without a vault the key path refuses and says why; wallet proof still works', async () => {
  const r = rig({ vault: undefined });
  const proof = await r.service.proveKey(r.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  assert.equal(proof.kind, 'refused');
  assert.match(proof.kind === 'refused' ? proof.reason : '', /^Connecting with an API key isn't available right now\./);
  assert.ok(!(proof.kind === 'refused' && /PERPGUARD|deployment|operator/.test(proof.reason)), 'no internals in what the person reads');
  assert.equal((await r.service.proveWallet(r.identity, [OWNER_WALLET])).kind, 'linked');
});

test('unlink removes the link, DELETES the key, and closes the session; the environment account is never closed', async () => {
  const r = rig();
  await r.service.proveKey(r.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  const result = await r.service.unlink(r.identity.userId);
  assert.equal(result.ok, true);
  assert.match(result.text, /Unlinked from account 711.*key you pasted has been deleted.*session is closed/s);
  assert.equal(r.keys.get(r.identity.userId), undefined, 'deleted, not unreferenced');
  assert.equal(r.links.byTelegramUserId(4242), undefined);
  assert.deepEqual(r.closed, [711]);

  // The environment account: unlinking its owner closes nothing.
  await r.service.proveWallet(r.identity, [OWNER_WALLET]);
  const env = await r.service.unlink(r.identity.userId);
  assert.equal(env.ok, true);
  assert.deepEqual(r.closed, [711], 'still only 711');
  assert.ok(r.running.has(ENV));
  assert.equal((await r.service.unlink(r.identity.userId)).ok, false);
});

test('at boot, sealed keys reopen their sessions; a key sealed under a rotated environment key marks the user as needing to re-link', async () => {
  const sealedUnderA = new KeyVault(KEY_A).seal({ apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX });
  const keys = new InMemoryKeyStore([{ userId: 'tg:4242', accountId: 711, blob: sealedUnderA, storedAtMs: 1 }]);

  const same = rig({ keys });
  await same.service.reopenAll();
  assert.deepEqual(same.opened.map((o) => o.accountId), [711], 'reopened with the stored key');
  assert.equal(same.service.needsRelink('tg:4242'), undefined);

  const rotated = rig({ keys: new InMemoryKeyStore([{ userId: 'tg:4242', accountId: 711, blob: sealedUnderA, storedAtMs: 1 }]), vault: new KeyVault('2'.repeat(64)) });
  await rotated.service.reopenAll();
  assert.deepEqual(rotated.opened, [], 'nothing reopened');
  assert.equal(rotated.service.needsRelink('tg:4242'), RELINK_REASON, 'the person gets what to do, not key ids');
  assert.ok(rotated.logs.some((l) => /not reopened: the environment key was rotated/.test(l)));
  // A fresh proof clears it and overwrites the blob.
  await rotated.service.proveKey(rotated.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  assert.equal(rotated.service.needsRelink('tg:4242'), undefined);
});

test('one account per user: a new proof replaces the previous link', async () => {
  const r = rig();
  await r.service.proveWallet(r.identity, [OWNER_WALLET]);
  assert.equal(r.links.byTelegramUserId(4242)?.accountId, ENV);
  await r.service.proveKey(r.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  assert.equal(r.links.byTelegramUserId(4242)?.accountId, 711);
  assert.equal(r.links.list().length, 1);
});
