/**
 * The linking routes through Fastify's inject: the code opens a cookie session
 * and nothing more; every proof route needs the cookie; a pasted key is in no
 * reply, whatever the outcome; signing the page out leaves the link alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ApiSecret, type AccountLookup } from '@perpguard/shared';
import { InMemoryIdentityStore, InMemoryLinkStore } from '@perpguard/bot';
import { LinkCodeStore } from '../protect/session.ts';
import { KeyVault } from './crypto.ts';
import { registerLinkRoutes, LINK_COOKIE } from './routes.ts';
import { LinkService } from './service.ts';
import { InMemoryKeyStore } from './stores.ts';
import { hashTypedData, verifyMessage, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { InMemoryFeatureFlags } from '../featureFlags.ts';
import { viemTypedData } from './typedData.ts';
import { WalletKeyFlow } from './walletKey.ts';
import { CHALLENGE_TTL_MS, WalletChallenger } from './walletChallenge.ts';

const SECRET_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const API_KEY = 'pasted-api-key-that-must-never-come-back';
// Throwaway keys, test-only: the OWNER wallet owns account 710; STRANGER owns nothing.
const OWNER_KEY = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const STRANGER_KEY = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const OWNER = OWNER_KEY.address.toLowerCase();
const T0 = Date.parse('2026-10-06T12:00:00Z');

function rig(options: { wallet?: boolean; probeAccount?: number | undefined; chainId?: number; site?: string; strangerOnMainnet?: number; walletKey?: 'on' | 'off' } = {}) {
  const clock = { t: T0 };
  const identities = new InMemoryIdentityStore();
  identities.register(4242, 5150, 1_000);
  identities.register(4343, 5151, 1_000);
  const links = new InMemoryLinkStore({ capacity: 5 });
  const keys = new InMemoryKeyStore();
  const running = new Set<number>([710]);
  const logs: string[] = [];
  const closed: number[] = [];
  const watched: Array<{ identity: string; accountId: number }> = [];
  const service = new LinkService({
    codes: new LinkCodeStore({ purpose: 'link', now: () => 1_000 }),
    identities,
    links,
    keys,
    vault: new KeyVault('3'.repeat(64)),
    registry: {
      open: (accountId) => {
        const already = running.has(accountId);
        running.add(accountId);
        return { ok: true, session: {} as never, already };
      },
      close: async (accountId) => {
        closed.push(accountId);
        return running.delete(accountId);
      },
      get: (accountId) => (running.has(accountId) ? { status: () => ({ accountId, trading: { state: 'signed-in', attempt: 1 }, positions: { state: 'live', lastUpdateMs: 1, ageMs: 0 }, assessing: true, tracked: 0 }) } : undefined),
    },
    probe: async () => ({ accountId: 'probeAccount' in options ? options.probeAccount : 711, forwardingAllowed: true }),
    lookupAccount: async (address): Promise<AccountLookup> => (address === OWNER ? { found: true, accountId: 710, address } : { found: false, address, reason: 'no account' }),
    secretFromHex: (hex) => ApiSecret.fromHex(hex),
    ...(options.strangerOnMainnet !== undefined
      ? { network: 'testnet', lookupElsewhere: async (address: string) => (address === STRANGER_KEY.address.toLowerCase() ? { network: 'mainnet', accountId: options.strangerOnMainnet! } : undefined) }
      : {}),
    envAccountId: 710,
    webUrl: 'https://perpguard.example/',
    notify: async (_chatId, text) => {
      logs.push(`notify ${text}`);
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: () => 2_000,
  });
  const flags = new InMemoryFeatureFlags(options.walletKey === 'on' ? ['wallet-key'] : []);
  const perplCalls: string[] = [];
  const walletKey =
    options.walletKey === undefined
      ? undefined
      : new WalletKeyFlow({
          flags,
          // A fake Perpl: real-shaped typed data for the address; a key for any enrolment that carries a proof.
          post: async (_base, path, body) => {
            perplCalls.push(path);
            const b = body as Record<string, unknown>;
            if (path === '/v1/api-key/payload') {
              const typed_data = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], PerplRegisterApiKey: [{ name: 'signer', type: 'address' }, { name: 'publicKey', type: 'string' }] }, primaryType: 'PerplRegisterApiKey', domain: { name: 'perpl.xyz', chainId: '0x279f' }, message: { signer: b['address'], publicKey: String(b['public_key']) } };
              return { status: 200, body: JSON.stringify({ typed_data, mac: '0xmac' }), sentHeaders: {} };
            }
            return typeof b['pop_signature'] === 'string' ? { status: 200, body: JSON.stringify({ api_key: { api_key: 'wallet-made-token-0123456789' } }), sentHeaders: {} } : { status: 400, body: 'no pop', sentHeaders: {} };
          },
          restBaseUrl: 'https://testnet.perpl.xyz/api',
          chainId: 10143,
          digestOf: (td) => hashTypedData(viemTypedData(td) as never),
          verify: (address, td, signature) => verifyTypedData({ address: address as `0x${string}`, signature: signature as `0x${string}`, ...viemTypedData(td) } as never),
          service,
          log: (l) => logs.push(l),
          now: () => 2_000,
        });
  const app = registerLinkRoutes(Fastify({ logger: false }), {
    ...(walletKey === undefined ? {} : { walletKey }),
    service,
    network: 'testnet',
    envAccountId: 710,
    keyStorageConfigured: true,
    now: () => 2_000,
    watchInstead: async (identity, accountId) => {
      watched.push({ identity: identity.userId, accountId });
      return { ok: true, text: `Watching #${accountId} in your Telegram chat. Alerts are read-only.` };
    },
    ...(options.wallet
      ? { wallet: new WalletChallenger({ publicWebUrl: options.site ?? 'https://perpguard.example', chainId: options.chainId ?? 10143, verifyMessage: (a) => verifyMessage(a), now: () => clock.t }) }
      : {}),
  });
  return { app, service, links, keys, logs, closed, running, clock, watched, flags, perplCalls };
}

const cookieOf = (setCookie: string | string[] | undefined): string => {
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return header.split(';')[0]!;
};

test('a code opens a cookie session that says who is here and that nothing is linked; a bad, used or empty code is a flat 401', async () => {
  const r = rig();
  const { code } = r.service.mint('tg:4242', '@maxwell');
  const opened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  assert.equal(opened.statusCode, 200);
  const body = opened.json();
  assert.deepEqual(body.telegram, { name: '@maxwell' }, 'says which Telegram account, by the name the person knows');
  assert.equal(body.network, 'testnet');
  assert.ok(!('identity' in body) && !('envAccountId' in body), 'no internal id, nothing about which account PerpGuard runs');
  assert.ok(!opened.body.includes('tg:4242') && !opened.body.includes('710'), opened.body);
  assert.equal(body.link, null, 'the token alone links nothing');
  assert.equal(body.provenAccountId, null);
  assert.equal(body.walletSignIn, false);
  const setCookie = opened.headers['set-cookie'];
  assert.match(cookieOf(setCookie), new RegExp(`^${LINK_COOKIE}=[0-9a-f]{64}$`));
  assert.match(String(setCookie), /HttpOnly; SameSite=Lax/);

  const again = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  assert.equal(again.statusCode, 401, 'single use');
  const wrong = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code: 'ZZZZ-ZZZZ' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error, again.json().error, 'wrong and used read the same');
  const empty = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: {} });
  assert.equal(empty.statusCode, 401);
});

test('every proof route needs the cookie', async () => {
  const r = rig({ wallet: true });
  for (const [method, url] of [['GET', '/api/link/me'], ['POST', '/api/link/challenge'], ['POST', '/api/link/wallet'], ['POST', '/api/link/key'], ['POST', '/api/link/unlink']] as const) {
    const res = await r.app.inject(method === 'POST' ? { method, url, payload: { apiKey: API_KEY, secret: SECRET_HEX, address: OWNER, message: 'x', signature: '0x00' } } : { method, url });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
    assert.ok(!JSON.stringify(res.json()).includes(API_KEY));
  }
  assert.equal(r.keys.get('tg:4242'), undefined, 'a cookie-less key post stored nothing');
});

test('the key path links and NEVER echoes the key: not on success, not on refusal, not on a server error, not in /me', async () => {
  const r = rig();
  const { code } = r.service.mint('tg:4242');
  const opened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  const cookie = cookieOf(opened.headers['set-cookie']);

  const linked = await r.app.inject({ method: 'POST', url: '/api/link/key', headers: { cookie }, payload: { apiKey: API_KEY, secret: SECRET_HEX } });
  assert.equal(linked.statusCode, 200);
  assert.deepEqual(linked.json().proof, { kind: 'linked', accountId: 711, forwardingAllowed: true });
  assert.equal(linked.json().me.link.accountId, 711);
  assert.equal(linked.json().me.link.proof, 'key');
  const everything = [linked.body, ...r.logs].join('\n');
  assert.ok(!everything.includes(API_KEY) && !everything.includes(SECRET_HEX.slice(0, 12)), 'key and secret in no reply or log');

  const me = await r.app.inject({ method: 'GET', url: '/api/link/me', headers: { cookie } });
  assert.ok(!me.body.includes(API_KEY) && !me.body.includes(SECRET_HEX.slice(0, 12)));
  assert.ok(!me.body.includes('blob'), '/me does not even carry the sealed blob');

  // Malformed secret: refused with a sentence that repeats nothing pasted.
  const bad = await r.app.inject({ method: 'POST', url: '/api/link/key', headers: { cookie }, payload: { apiKey: API_KEY, secret: 'zz-not-hex' } });
  assert.equal(bad.statusCode, 200);
  assert.equal(bad.json().proof.kind, 'refused');
  assert.ok(!bad.body.includes('zz-not-hex') && !bad.body.includes(API_KEY));

  const missing = await r.app.inject({ method: 'POST', url: '/api/link/key', headers: { cookie }, payload: { apiKey: API_KEY } });
  assert.equal(missing.statusCode, 400);
  assert.ok(!missing.body.includes(API_KEY));
});

test('a server error in the key path answers with a fixed sentence and nothing pasted', async () => {
  const r = rig();
  (r.service as unknown as { proveKey: () => Promise<never> }).proveKey = async () => {
    throw new Error(`exploded while holding ${API_KEY}`);
  };
  const { code } = r.service.mint('tg:4242');
  const opened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  const res = await r.app.inject({ method: 'POST', url: '/api/link/key', headers: { cookie: cookieOf(opened.headers['set-cookie']) }, payload: { apiKey: API_KEY, secret: SECRET_HEX } });
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes(API_KEY) && !res.body.includes('exploded'));
  assert.match(res.json().error, /Nothing you pasted was stored or shown anywhere/);
});

/** A page session for Telegram user 4242, and a helper that gets a challenge for `address`. */
async function page(r: ReturnType<typeof rig>, telegram = 'tg:4242') {
  const { code } = r.service.mint(telegram, '@maxwell');
  const opened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  const cookie = cookieOf(opened.headers['set-cookie']);
  const challenge = async (address: string) => (await r.app.inject({ method: 'POST', url: '/api/link/challenge', headers: { cookie }, payload: { address } })).json().message as string;
  const submit = (message: string, signature: string) => r.app.inject({ method: 'POST', url: '/api/link/wallet', headers: { cookie }, payload: { message, signature } });
  return { cookie, opened, challenge, submit };
}

test('a signed challenge from the owner of the env account links at once; the message says it moves no funds', async () => {
  const r = rig({ wallet: true });
  const p = await page(r);
  assert.equal(p.opened.json().walletSignIn, true);
  const message = await p.challenge(OWNER);
  assert.match(message, /^perpguard\.example wants you to sign in with your Ethereum account:/);
  assert.match(message, /moves no funds and places no trade/);
  assert.match(message, /Chain ID: 10143/);
  assert.match(message, /URI: https:\/\/perpguard\.example\/link/);
  const res = await p.submit(message, await OWNER_KEY.signMessage({ message }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().proof, { kind: 'linked', accountId: 710 });
  assert.equal(r.links.byTelegramUserId(4242)?.accountId, 710);
});

test('ATTACK 1, replay: the same message and signature posted twice; the second is refused', async () => {
  const r = rig({ wallet: true });
  const p = await page(r);
  const message = await p.challenge(OWNER);
  const signature = await OWNER_KEY.signMessage({ message });
  assert.equal((await p.submit(message, signature)).statusCode, 200);
  const again = await p.submit(message, signature);
  assert.equal(again.statusCode, 401, 'the challenge was consumed by the first use');
});

test('ATTACK 2, cross-session: a challenge minted for user A, signed, and posted with user B\'s cookie links nobody', async () => {
  const r = rig({ wallet: true });
  const a = await page(r, 'tg:4242');
  const b = await page(r, 'tg:4343');
  const message = await a.challenge(OWNER);
  await b.challenge(OWNER); // B holds an outstanding challenge of its own, for the same wallet
  const res = await b.submit(message, await OWNER_KEY.signMessage({ message }));
  assert.equal(res.statusCode, 401, 'A\'s message is not B\'s challenge');
  assert.equal(r.links.byTelegramUserId(4343), undefined, 'B linked nothing');
  assert.equal(r.links.byTelegramUserId(4242), undefined, 'and neither did A, yet');
  const stillA = await a.submit(message, await OWNER_KEY.signMessage({ message }));
  assert.equal(stillA.statusCode, 200, 'and A\'s own challenge was untouched by B\'s attempt');
});

test('ATTACK 3, expired: a valid signature on the right nonce, posted after five minutes, is refused', async () => {
  const r = rig({ wallet: true });
  const p = await page(r);
  const message = await p.challenge(OWNER);
  const signature = await OWNER_KEY.signMessage({ message });
  r.clock.t += CHALLENGE_TTL_MS + 1;
  const res = await p.submit(message, signature);
  assert.equal(res.statusCode, 401);
  assert.match(res.json().error, /expired/);
  assert.equal(r.links.byTelegramUserId(4242), undefined);
});

test('ATTACK 4, phishing reuse: a correctly signed message for another site or another chain is refused', async () => {
  // The victim signed a challenge on evil.example (or for chain 143); it is posted here.
  for (const other of [rig({ wallet: true, site: 'https://evil.example' }), rig({ wallet: true, chainId: 143 })]) {
    const elsewhere = await page(other);
    const foreign = await elsewhere.challenge(OWNER);
    const signature = await OWNER_KEY.signMessage({ message: foreign });
    const r = rig({ wallet: true });
    const p = await page(r);
    await p.challenge(OWNER); // this session has its own outstanding challenge
    const res = await p.submit(foreign, signature);
    assert.equal(res.statusCode, 401);
    assert.equal(r.links.byTelegramUserId(4242), undefined);
  }
});

test('ATTACK 5, forged signer: a challenge for the owner, signed by someone else, or garbage, is refused; the address used is never a body field', async () => {
  const r = rig({ wallet: true });
  const p = await page(r);
  let message = await p.challenge(OWNER);
  assert.equal((await p.submit(message, await STRANGER_KEY.signMessage({ message }))).statusCode, 401, 'signature recovers to another wallet');
  message = await p.challenge(OWNER);
  assert.equal((await p.submit(message, 'not-hex')).statusCode, 401, 'malformed');
  // A stranger proving their own wallet gets an honest "owns no account", never the owner's account.
  message = await p.challenge(STRANGER_KEY.address);
  const res = await p.submit(message, await STRANGER_KEY.signMessage({ message }));
  assert.equal(res.statusCode, 200);
  assert.notEqual(res.json().proof.kind, 'linked');
  assert.equal(r.links.byTelegramUserId(4242), undefined);
});

test('wallet routes without wallet sign-in configured are a 503, not a silent pass', async () => {
  const r = rig();
  const p = await page(r);
  const res = await r.app.inject({ method: 'POST', url: '/api/link/challenge', headers: { cookie: p.cookie }, payload: { address: OWNER } });
  assert.equal(res.statusCode, 503);
  assert.equal((await p.submit('m', '0x00')).statusCode, 503);
  assert.equal(r.links.byTelegramUserId(4242), undefined);
});

test('unlink through the page deletes the key and closes the session; signing the page out leaves a link alone', async () => {
  const r = rig();
  const { code } = r.service.mint('tg:4242');
  const opened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  const cookie = cookieOf(opened.headers['set-cookie']);
  await r.app.inject({ method: 'POST', url: '/api/link/key', headers: { cookie }, payload: { apiKey: API_KEY, secret: SECRET_HEX } });
  assert.ok(r.keys.get('tg:4242'));

  const out = await r.app.inject({ method: 'DELETE', url: '/api/link/session', headers: { cookie } });
  assert.equal(out.json().signedOut, true);
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
  assert.equal(r.links.byTelegramUserId(4242)?.accountId, 711, 'still linked');
  assert.equal((await r.app.inject({ method: 'GET', url: '/api/link/me', headers: { cookie } })).statusCode, 401, 'cookie revoked');

  const reopened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code: r.service.mint('tg:4242').code } });
  const cookie2 = cookieOf(reopened.headers['set-cookie']);
  const unlinked = await r.app.inject({ method: 'POST', url: '/api/link/unlink', headers: { cookie: cookie2 } });
  assert.equal(unlinked.json().ok, true);
  assert.equal(unlinked.json().me.link, null);
  assert.equal(r.keys.get('tg:4242'), undefined, 'key deleted');
  assert.deepEqual(r.closed, [711]);
});

test('every page outcome leaves a log line naming who and why, never the code, message or signature', async () => {
  const lines: string[] = [];
  const r = rig({ wallet: true });
  const app = registerLinkRoutes(Fastify({ logger: false }), {
    service: r.service, network: 'testnet', envAccountId: 710, keyStorageConfigured: true, now: () => 2_000, logger: { info: (m) => lines.push(m) },
    wallet: new WalletChallenger({ publicWebUrl: 'https://perpguard.example', chainId: 10143, verifyMessage: (a) => verifyMessage(a), now: () => r.clock.t }),
  });
  await app.inject({ method: 'POST', url: '/api/link/session', payload: { code: 'NOPE-NOPE' } });
  const { code } = r.service.mint('tg:4242', '@maxwell');
  const opened = await app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  const cookie = cookieOf(opened.headers['set-cookie']);
  const c = await app.inject({ method: 'POST', url: '/api/link/challenge', headers: { cookie }, payload: { address: OWNER } });
  const message = (c.json() as { message: string }).message;
  const signature = await STRANGER_KEY.signMessage({ message });
  await app.inject({ method: 'POST', url: '/api/link/wallet', headers: { cookie }, payload: { message, signature } });
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^link page: a code was refused \(wrong, used or expired\); from /);
  assert.match(lines[1]!, /^link page: tg:4242 opened the page with a code: session [0-9a-f]{8}; from /);
  const tag = /session ([0-9a-f]{8})/.exec(lines[1]!)![1]!;
  assert.match(lines[2]!, new RegExp(`^link page: tg:4242 was issued a wallet challenge \\(session ${tag};`), 'the same session, strung together');
  assert.match(lines[3]!, new RegExp(`^link page: tg:4242 sent a wallet signature that was refused: bad-signature \\(session ${tag};`));
  // A request with no cookie at all is now said, not silently refused.
  await app.inject({ method: 'POST', url: '/api/link/challenge', payload: { address: OWNER }, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36 Telegram-Android/11.2.2' } });
  assert.match(lines.at(-1)!, /^link page: POST \/api\/link\/challenge refused: NO session cookie was sent; from Telegram in-app browser \(Android\)/);
  const all = lines.join('\n');
  for (const secret of [code, signature, message.slice(0, 40)]) assert.ok(!all.includes(secret), 'nothing secret in the log');
});

test('WATCH IT INSTEAD: a wallet that owns a MAINNET account is refused for acting and offered a watch; the watch takes only the account the session proved', async () => {
  const r = rig({ wallet: true, strangerOnMainnet: 4855 });
  const p = await page(r);
  const before = await r.app.inject({ method: 'POST', url: '/api/link/watch-instead', headers: { cookie: p.cookie }, payload: { accountId: 1 } });
  assert.equal(before.statusCode, 400, 'nothing proven yet: nothing to watch, and a body account id is never read');
  assert.deepEqual(r.watched, []);

  const message = await p.challenge(STRANGER_KEY.address.toLowerCase());
  const res = await p.submit(message, await STRANGER_KEY.signMessage({ message }));
  const proof = res.json().proof;
  assert.equal(proof.kind, 'refused');
  assert.deepEqual(proof.watchInstead, { network: 'mainnet', accountId: 4855 });
  assert.match(proof.reason, /Actions are testnet only for now/);
  assert.equal(r.links.byTelegramUserId(4242), undefined, 'nothing linked');

  const watch = await r.app.inject({ method: 'POST', url: '/api/link/watch-instead', headers: { cookie: p.cookie }, payload: { accountId: 1 } });
  assert.equal(watch.statusCode, 200);
  assert.equal(watch.json().accountId, 4855);
  assert.deepEqual(r.watched, [{ identity: 'tg:4242', accountId: 4855 }], 'the proven account, never the posted one');
  assert.equal(r.links.byTelegramUserId(4242), undefined, 'watching links nothing');

  const noCookie = await r.app.inject({ method: 'POST', url: '/api/link/watch-instead', payload: {} });
  assert.equal(noCookie.statusCode, 401);
});


test('🔗 THE SWITCH IS READ NOW: /features and /me say whether one wallet signature can create the key', async () => {
  for (const [mode, expected] of [[undefined, false], ['off', false], ['on', true]] as const) {
    const r = rig(mode === undefined ? {} : { walletKey: mode });
    const features = await r.app.inject({ method: 'GET', url: '/api/link/features' });
    assert.deepEqual(features.json(), { walletKey: expected }, `features, ${mode}`);
    const { cookie } = await page(r);
    assert.equal((await r.app.inject({ method: 'GET', url: '/api/link/me', headers: { cookie } })).json().walletKey, expected, `me, ${mode}`);
  }
  const r = rig({ walletKey: 'on' });
  r.flags.set('wallet-key', false);
  assert.deepEqual((await r.app.inject({ method: 'GET', url: '/api/link/features' })).json(), { walletKey: false }, 'thrown off at run time, no restart');
});

test('🔗 SWITCH OFF: the wallet routes refuse and point at pasting a key, Perpl is never asked, and PASTING A KEY STILL LINKS', async () => {
  const r = rig({ walletKey: 'off' });
  const { cookie } = await page(r);
  const start = await r.app.inject({ method: 'POST', url: '/api/link/wallet-key/start', headers: { cookie }, payload: { address: privateKeyToAccount(generatePrivateKey()).address } });
  assert.equal(start.statusCode, 404);
  assert.match(start.json().error, /Paste an API key you already have instead/);
  assert.deepEqual(r.perplCalls, []);
  const pasted = await r.app.inject({ method: 'POST', url: '/api/link/key', headers: { cookie }, payload: { apiKey: API_KEY, secret: SECRET_HEX } });
  assert.equal(pasted.statusCode, 200);
  assert.deepEqual(pasted.json().proof, { kind: 'linked', accountId: 711, forwardingAllowed: true });
});

test('🔗 SWITCH ON, THROUGH THE ROUTES: connect, one signature, the key is created, sealed like a pasted one and linked; the secret is in no reply or log', async () => {
  const r = rig({ walletKey: 'on' });
  const { cookie } = await page(r);
  const w = privateKeyToAccount(generatePrivateKey());
  const start = await r.app.inject({ method: 'POST', url: '/api/link/wallet-key/start', headers: { cookie }, payload: { address: w.address } });
  assert.equal(start.statusCode, 200);
  const typed = start.json().typedData;
  assert.equal(typed.message.signer, w.address);
  const signature = await w.signTypedData(viemTypedData(typed) as never);
  const finish = await r.app.inject({ method: 'POST', url: '/api/link/wallet-key/finish', headers: { cookie }, payload: { signature } });
  assert.equal(finish.statusCode, 200);
  assert.equal(finish.json().result.kind, 'linked');
  assert.equal(finish.json().me.link.accountId, 711);
  assert.equal(finish.json().me.link.proof, 'key', 'execution by a sealed key, as a pasted one');
  assert.deepEqual(r.perplCalls, ['/v1/api-key/payload', '/v1/api-key/enroll']);
  const stored = r.keys.get('tg:4242');
  assert.ok(stored !== undefined && stored.accountId === 711, 'sealed in the same key store');
  const everything = [start.body, finish.body, ...r.logs].join('\n');
  assert.ok(!everything.includes('wallet-made-token-0123456789'), 'the token is in no reply or log');
  // A second finish has nothing to finish: the pending request was spent.
  const again = await r.app.inject({ method: 'POST', url: '/api/link/wallet-key/finish', headers: { cookie }, payload: { signature } });
  assert.equal(again.statusCode, 400);
  assert.match(again.json().error, /expired/);
});

test('🔗 the wallet routes need the page\u2019s cookie, like every proof route', async () => {
  const r = rig({ walletKey: 'on' });
  for (const url of ['/api/link/wallet-key/start', '/api/link/wallet-key/finish']) {
    assert.equal((await r.app.inject({ method: 'POST', url, payload: {} })).statusCode, 401, url);
  }
});
