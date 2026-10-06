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
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHALLENGE_TTL_MS, WalletChallenger } from './walletChallenge.ts';

const SECRET_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const API_KEY = 'pasted-api-key-that-must-never-come-back';
// Throwaway keys, test-only: the OWNER wallet owns account 710; STRANGER owns nothing.
const OWNER_KEY = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const STRANGER_KEY = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const OWNER = OWNER_KEY.address.toLowerCase();
const T0 = Date.parse('2026-10-06T12:00:00Z');

function rig(options: { wallet?: boolean; probeAccount?: number | undefined; chainId?: number; site?: string } = {}) {
  const clock = { t: T0 };
  const identities = new InMemoryIdentityStore();
  identities.register(4242, 5150, 1_000);
  identities.register(4343, 5151, 1_000);
  const links = new InMemoryLinkStore({ capacity: 5 });
  const keys = new InMemoryKeyStore();
  const running = new Set<number>([710]);
  const logs: string[] = [];
  const closed: number[] = [];
  const service = new LinkService({
    codes: new LinkCodeStore({ now: () => 1_000 }),
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
    envAccountId: 710,
    webUrl: 'https://perpguard.example/',
    notify: async (_chatId, text) => {
      logs.push(`notify ${text}`);
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: () => 2_000,
  });
  const app = registerLinkRoutes(Fastify({ logger: false }), {
    service,
    network: 'testnet',
    envAccountId: 710,
    keyStorageConfigured: true,
    now: () => 2_000,
    ...(options.wallet
      ? { wallet: new WalletChallenger({ publicWebUrl: options.site ?? 'https://perpguard.example', chainId: options.chainId ?? 10143, verifyMessage: (a) => verifyMessage(a), now: () => clock.t }) }
      : {}),
  });
  return { app, service, links, keys, logs, closed, running, clock };
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
