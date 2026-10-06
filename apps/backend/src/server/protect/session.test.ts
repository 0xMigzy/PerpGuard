import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkCodeStore, SessionStore, WebPendingActionStore, clearSessionCookie, normaliseCode, parseCookies, sessionCookie } from './session.ts';

test('a link code redeems ONCE, in any case and with or without its dash, and expires', () => {
  let now = 1_000_000;
  const codes = new LinkCodeStore({ purpose: 'protect', now: () => now, nextCode: () => 'ABCD-EFGH' });
  const minted = codes.mint('trader-1');
  assert.equal(minted.code, 'ABCD-EFGH');
  assert.equal(codes.redeem(' abcdefgh ')?.userId, 'trader-1');
  assert.equal(codes.redeem('ABCD-EFGH'), undefined, 'spent');
  codes.mint('trader-1');
  now += 5 * 60_000 + 1;
  assert.equal(codes.redeem('ABCD-EFGH'), undefined, 'expired');
  assert.equal(normaliseCode('ab-cd ef.gh'), 'ABCDEFGH');
});

test('a session is an opaque token that expires and can be revoked', () => {
  let now = 1_000_000;
  const sessions = new SessionStore({ now: () => now, nextToken: () => 'tok' });
  const s = sessions.create('trader-1');
  assert.equal(sessions.get('tok')?.userId, 'trader-1');
  assert.equal(sessions.get(undefined), undefined);
  assert.equal(sessions.get('other'), undefined);
  sessions.revoke('tok');
  assert.equal(sessions.get('tok'), undefined);
  sessions.create('trader-1');
  now = s.expiresAtMs + 1;
  assert.equal(sessions.get('tok'), undefined, 'expired');
});

test('the cookie is HttpOnly and SameSite, Secure only over https, and parses back', () => {
  const set = sessionCookie('abc def', { secure: false, maxAgeSec: 60 });
  assert.match(set, /^pg_session=abc%20def; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60$/);
  assert.match(sessionCookie('x', { secure: true, maxAgeSec: 1 }), /; Secure$/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
  assert.deepEqual(parseCookies('a=1; pg_session=abc%20def;  b = 2'), { a: '1', pg_session: 'abc def', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('a pending web action is spent on take and belongs to one user', () => {
  let now = 1_000_000;
  const store = new WebPendingActionStore({ now: () => now, nextToken: () => 't1' });
  store.put('trader-1', { kind: 'kill-switch' });
  assert.equal(store.take('t1', 'someone-else'), undefined, 'not theirs, and NOT spent by the attempt');
  assert.equal(store.take('t1', 'trader-1')?.intent.kind, 'kill-switch');
  assert.equal(store.take('t1', 'trader-1'), undefined, 'spent');
  store.put('trader-1', { kind: 'kill-switch' });
  now += 15 * 60_000 + 1;
  assert.equal(store.size, 0, 'expired on the bot\'s fifteen minutes');
});
