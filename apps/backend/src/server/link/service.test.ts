/**
 * Linking policy, with every I/O faked: the token is transport, the proof is
 * a signature or a key, a key is sealed and never comes back, an unlink
 * deletes it and closes the session, and a rotated environment key means a
 * re-link rather than a silent failure.
 */
import { test } from 'node:test';
import { instanceFullText } from '../../sessions/registry.ts';
import assert from 'node:assert/strict';
import { ApiSecret, type AccountLookup } from '@perpguard/shared';
import { InMemoryIdentityStore, InMemoryLinkStore, type TelegramIdentity } from '@perpguard/bot';
import { LinkCodeStore } from '../protect/session.ts';
import { KeyVault } from './crypto.ts';
import { LinkService, RELINK_REASON } from './service.ts';
import { InMemoryWalletProofStore } from './proofs.ts';
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

function rig(options: { readonly vault?: KeyVault | undefined; readonly keys?: InMemoryKeyStore; readonly maxSessions?: number; readonly proofs?: InMemoryWalletProofStore; readonly elsewhere?: Map<string, number>; readonly probeAccount?: number } = {}): Rig {
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
    probeAccount: (options.probeAccount ?? 711) as number | undefined,
    lookups: new Map<string, AccountLookup>([[OWNER_WALLET, { found: true, accountId: ENV, address: OWNER_WALLET }]]),
    logs: [] as string[],
  };
  const service = new LinkService({
    codes: new LinkCodeStore({ purpose: 'link', now: () => 1_000 }),
    identities,
    links,
    keys,
    vault: 'vault' in options ? options.vault : new KeyVault(KEY_A),
    registry: {
      open: (accountId, credentials) => {
        if (state.running.size >= (options.maxSessions ?? 20) && !state.running.has(accountId)) return { ok: false, reason: instanceFullText(options.maxSessions ?? 20), code: 'full' as const };
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
    ...(options.proofs === undefined ? {} : { proofs: options.proofs }),
    lookupElsewhere: async (address) => {
      const id = options.elsewhere?.get(address);
      return id === undefined ? undefined : { network: 'mainnet', accountId: id };
    },
    network: 'testnet',
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
  assert.match(r.notices[0]!.text, /^Connected \w+ #710\. Alerts here now come with buttons to add margin\.$/);
  assert.deepEqual(r.opened, [], 'no session opened: the environment account already runs');
});

test('a wallet that owns an account PerpGuard does not run proves ownership and asks for a key', async () => {
  const r = rig();
  r.lookups.set('0x' + '1'.repeat(40), { found: true, accountId: 900, address: '0x' + '1'.repeat(40) });
  const proof = await r.service.proveWallet(r.identity, ['0x' + '1'.repeat(40)]);
  assert.equal(proof.kind, 'proven-needs-key');
  assert.equal(proof.kind === 'proven-needs-key' && proof.accountId, 900);
  assert.equal(r.links.byTelegramUserId(4242), undefined, 'not linked yet');
  assert.match(r.logs.join('\n'), /proved account 900 by wallet; no session for it yet, so it needs an API key \(nothing linked\)/, 'every outcome leaves a line to check against');
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
  // The person is told the instance is full and that they can run their own.
  assert.match(proof.kind === 'refused' ? proof.reason : '', /^This PerpGuard instance is full: it is already watching 1 linked accounts/);
  assert.match(proof.kind === 'refused' ? proof.reason : '', /self-hostable \(https:\/\/github\.com\/0xMigzy\/PerpGuard\)/);
  assert.ok(r.logs.some((l) => /instance is full/.test(l)), 'and the log has it too');
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
  assert.equal(result.text, 'Disconnected #711. Your key is deleted.');
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
  assert.equal(env.text, 'Disconnected #710.', 'no key was stored for the owner link, so no sentence about one');
});

test('DISCONNECT NEVER CLAIMS A KEY IS GONE THAT IS NOT: if storage cannot confirm the delete, nothing changes and the reply says so', async () => {
  const keys = new InMemoryKeyStore();
  const r = rig({ keys });
  await r.service.proveKey(r.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  keys.deleteConfirmed = async () => {
    throw new Error('connection terminated');
  };
  const result = await r.service.unlink(r.identity.userId);
  assert.equal(result.ok, false);
  assert.equal(result.text, "I couldn't delete your API key just now, so nothing changed: you're still connected. Try Disconnect again in a minute.");
  assert.doesNotMatch(result.text, /is deleted/);
  assert.ok(keys.get(r.identity.userId) !== undefined, 'the key is still stored, and nothing said otherwise');
  assert.equal(r.links.byTelegramUserId(4242)?.accountId, 711, 'still connected');
  assert.deepEqual(r.closed, [], 'the session was not closed');
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


// ── Phases 10-11: three states, kept ────────────────────────────────────────

test('OWNERSHIP IS KEPT: a wallet proven without a key survives the page closing, and binds the key that follows', async () => {
  const proofs = new InMemoryWalletProofStore();
  const first = rig({ proofs });
  first.lookups.set('0x' + '1'.repeat(40), { found: true, accountId: 711, address: '0x' + '1'.repeat(40) });
  const proof = await first.service.proveWallet(first.identity, ['0x' + '1'.repeat(40)]);
  assert.equal(proof.kind, 'proven-needs-key');
  // A later visit: a new page session, so no proof in the page. The record remains.
  const keyFor712 = rig({ proofs, probeAccount: 712 });
  assert.deepEqual(keyFor712.service.walletProof(keyFor712.identity.userId), { userId: keyFor712.identity.userId, address: '0x' + '1'.repeat(40), accountId: 711, network: 'testnet', provedAtMs: 2_000 });
  const wrong = await keyFor712.service.proveKey(keyFor712.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  assert.match((wrong as { reason: string }).reason, /That key is for account #712, but your wallet owns account #711/);
  const later = rig({ proofs, probeAccount: 711 });
  const right = await later.service.proveKey(later.identity, { apiKey: 'the-plain-api-key-0123456789', secretHex: SECRET_HEX }, undefined);
  assert.equal(right.kind, 'linked');
  const status = later.service.status(later.identity.userId)!;
  assert.equal(status.proof, 'key');
  assert.deepEqual(status.wallet, { address: '0x' + '1'.repeat(40), provedAtMs: 2_000 }, 'ownership and execution, both on record, separately');
});

test('A WALLET WHOSE ACCOUNT IS ON THE OTHER NETWORK IS TOLD SO BY NAME, never "you own no account"', async () => {
  const wallet = '0x169e49ece0d4f19b92de549482d1562ddd235251';
  const r = rig({ elsewhere: new Map([[wallet, 4855]]) });
  const proof = await r.service.proveWallet(r.identity, [wallet]);
  assert.equal(proof.kind, 'refused');
  assert.match((proof as { reason: string }).reason, /^This wallet owns Perpl account #4855 on mainnet\. Actions are testnet only for now, so it cannot be linked to act on\. You can watch it instead/);
  assert.deepEqual((proof as { watchInstead?: unknown }).watchInstead, { network: 'mainnet', accountId: 4855 }, 'offered as a watch, by the account the signature proved');
  assert.equal(r.service.walletProof(r.identity.userId), undefined, 'nothing was proven on the trading network, so nothing is kept');
  const none = await rig().service.proveWallet(r.identity, ['0x' + '9'.repeat(40)]);
  assert.match((none as { reason: string }).reason, /^That wallet doesn't own a Perpl account on testnet\./);
});

test('status is FROM RECORDS: wallet-linked, key-linked and owner-linked read differently; unlink deletes the proof', async () => {
  const r = rig();
  await r.service.proveWallet(r.identity, [OWNER_WALLET]);
  assert.equal(r.service.status(r.identity.userId)!.proof, 'wallet');
  assert.equal(r.service.status(r.identity.userId)!.wallet?.address, OWNER_WALLET.toLowerCase());
  await r.service.unlink(r.identity.userId);
  assert.equal(r.service.walletProof(r.identity.userId), undefined);
  // Linked as the deployment's owner, with no proof and no key: said as such, not as "your wallet".
  r.links.link({ userId: r.identity.userId, accountId: ENV, telegramUserId: 4242, chatId: 5150, linkedAtMs: 1 });
  assert.equal(r.service.status(r.identity.userId)!.proof, 'owner');
  assert.equal(r.service.status(r.identity.userId)!.wallet, undefined);
});
