import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeClient, sessionTag } from './client.ts';

test('Telegram\'s Android in-app browser is named; Chrome on the same phone is not mistaken for it', () => {
  assert.equal(describeClient('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 Telegram-Android/11.2.2 (Google Pixel 8; Android 14; SDK 34; HIGH)'), 'Telegram in-app browser (Android)');
  assert.equal(describeClient('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'), 'Chrome (Android)');
  assert.equal(describeClient('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36'), "Android WebView (an app's in-app browser, not Telegram's)");
});

test('on iOS the agent cannot separate Safari from an in-app Safari view, and it says so', () => {
  assert.match(describeClient('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), /indistinguishable/);
  assert.equal(describeClient('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1'), 'Chrome (iOS)');
  assert.equal(describeClient(undefined), 'no user-agent');
});

test('the session tag is short, stable, and not the token', () => {
  assert.equal(sessionTag('abc'), sessionTag('abc'));
  assert.equal(sessionTag('abc').length, 8);
  assert.notEqual(sessionTag('abc'), sessionTag('abd'));
  assert.ok(!'abc'.includes(sessionTag('abc')));
});
