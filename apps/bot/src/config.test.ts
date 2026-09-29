/**
 * Config, and the one rule that outranks the rest: the token never leaves here
 * as text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '@perpguard/shared';
import { loadBotConfig, redactToken } from './config.ts';
import { TEST_TOKEN } from './testSupport.ts';

test('the token comes from the environment and nowhere else', () => {
  const config = loadBotConfig({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  assert.equal(config.token, TEST_TOKEN);
  assert.equal(config.userId, 'default');
  assert.equal(config.ownerTelegramUserId, undefined);
});

test('a missing token fails loudly, naming the variable and nothing else', () => {
  for (const env of [{}, { TELEGRAM_BOT_TOKEN: '' }, { TELEGRAM_BOT_TOKEN: '   ' }]) {
    assert.throws(() => loadBotConfig(env), ConfigError);
  }
});

test('the error for a bad owner id does not quote the token', () => {
  // An error message is a thing that ends up in a CI log.
  try {
    loadBotConfig({ TELEGRAM_BOT_TOKEN: TEST_TOKEN, TELEGRAM_OWNER_ID: 'nope' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.ok(!error.message.includes(TEST_TOKEN));
    assert.match(error.message, /TELEGRAM_OWNER_ID/);
  }
});

test('an owner id is read when it is a positive integer, and refused otherwise', () => {
  assert.equal(
    loadBotConfig({ TELEGRAM_BOT_TOKEN: TEST_TOKEN, TELEGRAM_OWNER_ID: '4242' })
      .ownerTelegramUserId,
    4242,
  );
  for (const raw of ['0', '-1', '1.5', 'abc']) {
    assert.throws(
      () => loadBotConfig({ TELEGRAM_BOT_TOKEN: TEST_TOKEN, TELEGRAM_OWNER_ID: raw }),
      ConfigError,
    );
  }
});

test('redaction removes every occurrence, wherever it appears', () => {
  const text = `GET https://api.telegram.org/bot${TEST_TOKEN}/sendMessage failed; retry bot${TEST_TOKEN}`;
  const redacted = redactToken(text, TEST_TOKEN);
  assert.ok(!redacted.includes(TEST_TOKEN));
  assert.equal(redacted.split('<redacted>').length - 1, 2);
});

test('redaction with an empty token leaves the text alone rather than mangling it', () => {
  // Replacing '' would splice a marker between every character.
  assert.equal(redactToken('nothing to hide', ''), 'nothing to hide');
});
