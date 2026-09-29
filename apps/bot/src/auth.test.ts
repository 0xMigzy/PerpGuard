/**
 * The gate.
 *
 * A risk tool that acts on a stranger's tap moves someone else's collateral, so
 * these are the tests that matter most in this package. They cover the pure
 * verdict; `bot.test.ts` covers that the bot actually asks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorise } from './auth.ts';
import { REFUSAL_TEXT, WRONG_CHAT_TEXT } from './help.ts';
import { InMemoryLinkStore } from './links.ts';
import { OWNER_CHAT, OWNER_ID, OWNER_LINK, STRANGER_ID, USER_ID, newLinks } from './testSupport.ts';

test('the linked user in the linked chat is allowed through', () => {
  const verdict = authorise(newLinks(), OWNER_ID, OWNER_CHAT);
  assert.equal(verdict.ok, true);
  assert.ok(verdict.ok);
  assert.equal(verdict.link.userId, USER_ID);
});

test('a stranger is refused, whatever chat they are in', () => {
  for (const chat of [OWNER_CHAT, 1, -100_123]) {
    const verdict = authorise(newLinks(), STRANGER_ID, chat);
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok);
    assert.equal(verdict.code, 'not-linked');
    assert.equal(verdict.text, REFUSAL_TEXT);
  }
});

test('the linked user speaking from a different chat is refused', () => {
  // Otherwise adding the bot to a group and typing /positions publishes a
  // trader's liquidation prices to everyone in it.
  const verdict = authorise(newLinks(), OWNER_ID, -100_999);
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok);
  assert.equal(verdict.code, 'wrong-chat');
  assert.equal(verdict.text, WRONG_CHAT_TEXT);
});

test('an update with no user at all is refused, not passed', () => {
  const verdict = authorise(newLinks(), undefined, OWNER_CHAT);
  assert.equal(verdict.ok, false);
});

test('an empty store refuses everyone, including the eventual owner', () => {
  const verdict = authorise(new InMemoryLinkStore({ capacity: 1 }), OWNER_ID, OWNER_CHAT);
  assert.equal(verdict.ok, false);
});

test('the refusal text is identical for every rejected user', () => {
  // A refusal that varied would tell a stranger whether the slot is still free.
  const links = newLinks();
  const a = authorise(links, STRANGER_ID, OWNER_CHAT);
  const b = authorise(links, 7_777, OWNER_CHAT);
  assert.ok(!a.ok && !b.ok);
  assert.equal(a.text, b.text);
});

// ── the link store's own policy ─────────────────────────────────────────────

test('the second user to arrive is refused at capacity', () => {
  const links = new InMemoryLinkStore({ capacity: 1 });
  assert.equal(links.link(OWNER_LINK).ok, true);
  const second = links.link({ ...OWNER_LINK, telegramUserId: STRANGER_ID, chatId: 9 });
  assert.equal(second.ok, false);
  assert.ok(!second.ok);
  assert.equal(second.refusal, 'at-capacity');
});

test('raising capacity is all a second user needs: the shape does not change', () => {
  const links = new InMemoryLinkStore({ capacity: 2 });
  assert.equal(links.link(OWNER_LINK).ok, true);
  assert.equal(
    links.link({ userId: 'trader-2', telegramUserId: STRANGER_ID, chatId: 9, linkedAtMs: 1 }).ok,
    true,
  );
  assert.equal(links.list().length, 2);
  assert.equal(links.byUserId('trader-2')?.telegramUserId, STRANGER_ID);
  assert.equal(links.byTelegramUserId(OWNER_ID)?.userId, USER_ID);
});

test('an owner id pins the link to one person, and says which refusal it is', () => {
  const links = new InMemoryLinkStore({ capacity: 1, ownerTelegramUserId: OWNER_ID });
  const wrong = links.link({ ...OWNER_LINK, telegramUserId: STRANGER_ID });
  assert.ok(!wrong.ok);
  assert.equal(wrong.refusal, 'not-the-owner');
  assert.equal(links.list().length, 0);
  assert.equal(links.link(OWNER_LINK).ok, true);
});

test('the two lookups answer in opposite directions', () => {
  const links = newLinks();
  assert.equal(links.byTelegramUserId(OWNER_ID)?.chatId, OWNER_CHAT);
  assert.equal(links.byUserId(USER_ID)?.telegramUserId, OWNER_ID);
  assert.equal(links.byUserId('nobody'), undefined);
});
