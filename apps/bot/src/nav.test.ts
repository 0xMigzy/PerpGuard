import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeNav, decodeNavTap, encodeNav, isNavShaped, isPublicRoute, type Route } from './nav.ts';
import { decodeCallback } from './callback.ts';

const ALL: Route[] = [
  { to: 'home' }, { to: 'watch-menu' }, { to: 'watch-ask' }, { to: 'watch-id', accountId: 710 }, { to: 'watchlist' },
  { to: 'wallet', accountId: 3388 }, { to: 'unwatch', accountId: 3388 }, { to: 'account' }, { to: 'connect' }, { to: 'connect-go' },
  { to: 'positions' }, { to: 'margin' }, { to: 'position', marketId: 16 }, { to: 'settings' }, { to: 'warn-ask' },
  { to: 'warn-set', level: 5 }, { to: 'disconnect-ask' }, { to: 'disconnect' },
];

test('every route round-trips, fits in 64 bytes, and is never readable as an action button', () => {
  for (const route of ALL) {
    const data = encodeNav(route);
    assert.deepEqual(decodeNav(data), route);
    assert.ok(new TextEncoder().encode(data).length <= 64);
    assert.equal(decodeCallback(data).ok, false, `${data} must not decode as an action`);
  }
});

test('the public set is exactly the screens a watcher needs, and nothing that reads an account', () => {
  assert.deepEqual(ALL.filter(isPublicRoute).map((r) => r.to), ['home', 'watch-menu', 'watch-ask', 'watch-id', 'watchlist', 'wallet', 'unwatch', 'account', 'connect', 'connect-go']);
});

test('the decoder rejects anything it did not write', () => {
  for (const bad of ['', 'n1', 'n1:', 'n2:h', 'n1:h:1', 'n1:w', 'n1:w:', 'n1:w:-1', 'n1:w:1.5', 'n1:w:1:2', 'n1:zz', 'a1:tok:1:100', 'n1:w:9999999999999']) {
    assert.equal(decodeNav(bad), undefined, bad);
  }
});

test('a fresh tap decodes to the same route with the flag; the gate\u2019s decoder reads it as that route', () => {
  for (const route of ALL) {
    const data = encodeNav(route, { fresh: true });
    assert.deepEqual(decodeNavTap(data), { route, fresh: true });
    assert.deepEqual(decodeNav(data), route);
    assert.deepEqual(decodeNavTap(encodeNav(route)), { route, fresh: false });
  }
  for (const bad of ['n1:+', 'n1:h++', 'n1:w+', 'n1:+h']) assert.equal(decodeNavTap(bad), undefined, bad);
});

test('the retired kill switch codes decode to NOTHING, and are recognised as an old menu button', () => {
  for (const old of ['n1:kq', 'n1:kx:123456', 'n1:kx+:123456']) {
    assert.equal(decodeNav(old), undefined, old);
    assert.equal(isNavShaped(old), true, old);
  }
  assert.equal(isNavShaped('a1:tok:1:100'), false);
});
