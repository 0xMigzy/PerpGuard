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

const SECRET_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const API_KEY = 'pasted-api-key-that-must-never-come-back';
const OWNER = '0xb7854953a71e45d1033b3d619e76d56391291765';

function rig(options: { dynamic?: boolean; probeAccount?: number | undefined } = {}) {
  const identities = new InMemoryIdentityStore();
  identities.register(4242, 5150, 1_000);
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
    ...(options.dynamic ? { dynamic: { verify: async (token: string) => (token === 'good-jwt' ? { sub: 'dyn', email: undefined, wallets: [OWNER], expiresAtMs: 9_999_999_999_999 } : Promise.reject(new Error('bad signature'))) } } : {}),
  });
  return { app, service, links, keys, logs, closed, running };
}

const cookieOf = (setCookie: string | string[] | undefined): string => {
  const header = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return header.split(';')[0]!;
};

test('a code opens a cookie session that says who is here and that nothing is linked; a bad, used or empty code is a flat 401', async () => {
  const r = rig();
  const { code } = r.service.mint('tg:4242');
  const opened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  assert.equal(opened.statusCode, 200);
  const body = opened.json();
  assert.equal(body.identity.userId, 'tg:4242');
  assert.equal(body.link, null, 'the token alone links nothing');
  assert.equal(body.provenAccountId, null);
  assert.equal(body.dynamicConfigured, false);
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
  const r = rig({ dynamic: true });
  for (const [method, url] of [['GET', '/api/link/me'], ['POST', '/api/link/wallet'], ['POST', '/api/link/key'], ['POST', '/api/link/unlink']] as const) {
    const res = await r.app.inject(method === 'POST' ? { method, url, payload: { apiKey: API_KEY, secret: SECRET_HEX, dynamicToken: 'good-jwt' } } : { method, url });
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
  assert.match(res.json().error, /Nothing you pasted has been stored or shown anywhere/);
});

test('the wallet path verifies the Dynamic token server-side; a rejected token is a 401; the owner of the env account links at once', async () => {
  const r = rig({ dynamic: true });
  const { code } = r.service.mint('tg:4242');
  const opened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  const cookie = cookieOf(opened.headers['set-cookie']);
  assert.equal(opened.json().dynamicConfigured, true);

  const forged = await r.app.inject({ method: 'POST', url: '/api/link/wallet', headers: { cookie }, payload: { dynamicToken: 'forged' } });
  assert.equal(forged.statusCode, 401);
  assert.equal(r.links.byTelegramUserId(4242), undefined);

  const good = await r.app.inject({ method: 'POST', url: '/api/link/wallet', headers: { cookie }, payload: { dynamicToken: 'good-jwt' } });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json().proof, { kind: 'linked', accountId: 710 });
  assert.equal(r.links.byTelegramUserId(4242)?.accountId, 710);
});

test('wallet route without Dynamic configured is a 503, not a silent pass', async () => {
  const r = rig();
  const { code } = r.service.mint('tg:4242');
  const opened = await r.app.inject({ method: 'POST', url: '/api/link/session', payload: { code } });
  const res = await r.app.inject({ method: 'POST', url: '/api/link/wallet', headers: { cookie: cookieOf(opened.headers['set-cookie']) }, payload: { dynamicToken: 'good-jwt' } });
  assert.equal(res.statusCode, 503);
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
