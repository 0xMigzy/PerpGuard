/**
 * Rendering and delivery, against a fake Telegram.
 *
 * The messages here are the alerts layer's real output for the real fixture
 * position, so the strings asserted below are the engine's numbers. If the risk
 * maths moves, these fail — which is the point: the message is the product.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InlineKeyboard } from 'grammy';
import { DEFAULT_ALERT_CONFIG } from '@perpguard/backend/alerts';
import { buildMessage } from '@perpguard/backend/alerts/render';
import {
  BTC,
  FIXTURE_BTC,
  FIXTURE_BTC_MARK,
  FakeExecutor,
  FakeTelegram,
  TEST_TOKEN,
  assessOne,
  dangerMessage,
  fakeBot,
  newLinks,
  newStore,
  OWNER_CHAT,
  USER_ID,
} from './testSupport.ts';
import { TelegramAlertTransport } from './transport.ts';
import { decodeCallback } from './callback.ts';
import { CUSTOM_BUTTON_LABEL } from './format.ts';
import { InMemoryLinkStore } from './links.ts';

interface Harness {
  readonly transport: TelegramAlertTransport;
  readonly telegram: FakeTelegram;
  readonly executor: FakeExecutor;
  readonly store: ReturnType<typeof newStore>;
  readonly warnings: string[];
}

function harness(links = newLinks()): Harness {
  const { bot, telegram } = fakeBot();
  const executor = new FakeExecutor();
  const store = newStore();
  const warnings: string[] = [];
  const transport = new TelegramAlertTransport({
    api: bot.api,
    token: TEST_TOKEN,
    links,
    store,
    executor,
    logger: { warn: (message) => warnings.push(message) },
  });
  return { transport, telegram, executor, store, warnings };
}

/** The button rows Telegram was actually sent. */
function buttons(telegram: FakeTelegram): Array<{ text: string; callback_data: string }> {
  const markup = telegram.last('sendMessage').payload['reply_markup'] as
    | InlineKeyboard
    | undefined;
  if (markup === undefined) return [];
  return markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
}

// ── rendering ───────────────────────────────────────────────────────────────

test('a DANGER alert is sent as plain text with a button per top-up option', async () => {
  const h = harness();
  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.deepEqual(result, { ok: true });

  const call = h.telegram.last('sendMessage');
  assert.equal(call.payload['chat_id'], OWNER_CHAT);
  assert.equal(
    call.payload['text'],
    [
      'DANGER · BTC long',
      'Buffer 2.7% — liquidation 81,770.1, mark 84,007.3',
      'Isolated margin: your free AUSD is not used to rescue this position automatically.',
      'Top up (AUSD):',
      'Add 562 → buffer 4.0%, liquidation 80,647.1',
      'Add 2,662 → buffer 9.0%, liquidation 76,446.7',
      'First time PerpGuard has seen this position.',
    ].join('\n'),
  );
  // No parse_mode: the text above contains ·, — and → and must arrive verbatim.
  assert.equal(call.payload['parse_mode'], undefined);
});

test('button labels are the action’s own rendered line, never composed here', () => {
  // The button and the sentence above it are literally the same string, so they
  // cannot come to disagree about the amount.
  const message = dangerMessage();
  const h = harness();
  return h.transport.send({ userId: USER_ID, rights: 'act' }, message).then(() => {
    const labels = buttons(h.telegram).map((b) => b.text);
    assert.deepEqual(labels.slice(0, message.actions.length), message.actions.map((a) => a.label));
    // Both computed options, unchanged, then the custom option BELOW them. It is
    // a third choice, never a replacement for either.
    assert.deepEqual(labels, [
      'Add 562 → buffer 4.0%, liquidation 80,647.1',
      'Add 2,662 → buffer 9.0%, liquidation 76,446.7',
      CUSTOM_BUTTON_LABEL,
    ]);
  });
});

test('each button carries the exact amount the text showed', async () => {
  const h = harness();
  const message = dangerMessage();
  await h.transport.send({ userId: USER_ID, rights: 'act' }, message);

  const decoded = buttons(h.telegram).map((b) => decodeCallback(b.callback_data));
  assert.deepEqual(
    decoded.map((d) => (d.ok ? d.payload.amountCNS : undefined)),
    // The custom button carries 0: there is no amount on it yet.
    [562_000_000n, 2_662_000_000n, 0n],
  );
  // And the store holds the same action behind each token.
  for (const [index, d] of decoded.entries()) {
    assert.ok(d.ok);
    const pending = h.store.get(d.payload.token);
    const expected = message.actions[index];
    if (expected === undefined) {
      // The custom marker: this position, no amount, and NOT on message.actions —
      // a zero-amount entry there would land in `action_log` as a top-up of
      // nothing the trader never saw.
      assert.equal(pending?.action.amountCNS, 0n);
      assert.equal(pending?.action.intent, 'custom');
      assert.equal(pending?.action.marketId, message.marketId);
      assert.equal(message.actions.length, 2);
      continue;
    }
    assert.equal(pending?.action.amountCNS, expected.amountCNS);
    assert.equal(pending?.action.label, expected.label);
  }
});

test('an unavailable market still gets its alert, with disabled buttons and the reason', async () => {
  // Monitoring and actionability are separate. The trader whose venue has halted
  // a market is the one who most needs the warning.
  const h = harness();
  h.executor.available = {
    actionable: false,
    network: 'testnet',
    code: 'not-listed-on-acting-network',
    reason: 'BTC is not listed on testnet',
  };

  await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  const text = String(h.telegram.last('sendMessage').payload['text']);

  assert.match(text, /Buffer 2\.7% — liquidation 81,770\.1/);
  assert.match(text, /Add 562 → buffer 4\.0%/);
  assert.match(text, /Actions are unavailable on testnet: BTC is not listed on testnet/);

  // The options stay visible as buttons, but tapping one cannot execute. That
  // includes the custom one: an unavailable market keeps every control it had,
  // disabled and explained, rather than quietly losing one of them.
  const rows = buttons(h.telegram);
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1)?.text, CUSTOM_BUTTON_LABEL);
  for (const row of rows) {
    const decoded = decodeCallback(row.callback_data);
    assert.ok(decoded.ok);
    assert.equal(decoded.payload.kind, 'blocked');
  }
});

test('a venue that throws disables the buttons and still delivers the alert', async () => {
  const h = harness();
  h.executor.availabilityError = new Error('venue lookup exploded');

  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.deepEqual(result, { ok: true });
  assert.match(
    String(h.telegram.last('sendMessage').payload['text']),
    /Actions are unavailable: PerpGuard has not been told/,
  );
  for (const row of buttons(h.telegram)) {
    const decoded = decodeCallback(row.callback_data);
    assert.ok(decoded.ok && decoded.payload.kind === 'blocked');
  }
  assert.equal(h.warnings.length, 1);
});

test('a blind alert carries no keyboard and no availability note', async () => {
  // We cannot vouch for a price, so we do not invite anyone to act on one.
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  const blind = buildMessage(
    { ...change.assessment, state: 'FEED_DOWN', topUp: undefined },
    'feed-down',
    { alerts: DEFAULT_ALERT_CONFIG, market: BTC },
  );

  const h = harness();
  await h.transport.send({ userId: USER_ID, rights: 'act' }, blind);
  const call = h.telegram.last('sendMessage');
  assert.equal(call.payload['reply_markup'], undefined);
  assert.doesNotMatch(String(call.payload['text']), /Actions are unavailable/);
  // Nothing was asked of the venue, because there was nothing to act on.
  assert.equal(h.executor.calls.length, 0);
});

// ── delivery results ────────────────────────────────────────────────────────

test('an unlinked user is a permanent failure, and nothing is sent', async () => {
  const h = harness(new InMemoryLinkStore({ capacity: 1 }));
  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.reason ?? '', /nobody has run \/start/);
  assert.equal(h.telegram.of('sendMessage').length, 0);
});

test('a 429 is retryable, and reports the wait Telegram asked for', async () => {
  const h = harness();
  h.telegram.reply(FakeTelegram.error(429, 'Too Many Requests: retry after 7', 7));

  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.reason ?? '', /Telegram 429/);
  assert.match(result.reason ?? '', /retry after 7s/);
});

test('a 403 blocked-by-user is NOT retryable', async () => {
  // Three attempts against a blocked chat is three ways of failing the same way.
  const h = harness();
  h.telegram.reply(FakeTelegram.error(403, 'Forbidden: bot was blocked by the user'));

  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.reason ?? '', /bot was blocked by the user/);
});

test('a 400 chat-not-found is NOT retryable', async () => {
  const h = harness();
  h.telegram.reply(FakeTelegram.error(400, 'Bad Request: chat not found'));

  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(result.retryable, false);
});

test('a 5xx and a dropped socket are both retryable', async () => {
  const h = harness();
  h.telegram.reply(FakeTelegram.error(502, 'Bad Gateway'), FakeTelegram.network('socket hang up'));

  const first = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(first.retryable, true);
  assert.match(first.reason ?? '', /Telegram 502/);

  const second = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(second.retryable, true);
  assert.match(second.reason ?? '', /network failure talking to Telegram/);
});

test('an error of no recognised class is retryable, and is not mistaken for a send', async () => {
  const h = harness();
  h.telegram.reply(new Error('something nobody has met before'));

  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.reason ?? '', /unexpected send failure/);
});

test('an unrecognised error code is retryable, because losing the alert is worse', async () => {
  const h = harness();
  h.telegram.reply(FakeTelegram.error(418, "I'm a teapot"));

  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(result.retryable, true);
});

test('a retried send succeeds on the second attempt', async () => {
  const h = harness();
  h.telegram.reply(FakeTelegram.error(429, 'Too Many Requests', 1));

  const first = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(first.ok, false);
  const second = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.deepEqual(second, { ok: true });
});

test('the bot token never appears in a failure reason', async () => {
  // A reason ends up in an alert_log row and an error-level log line.
  const h = harness();
  h.telegram.reply(
    FakeTelegram.network(
      `connect ECONNREFUSED https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`,
    ),
  );

  const result = await h.transport.send({ userId: USER_ID, rights: 'act' }, dangerMessage());
  assert.equal(result.ok, false);
  assert.ok(!(result.reason ?? '').includes(TEST_TOKEN));
  assert.match(result.reason ?? '', /<redacted>/);
});

// ── watchers ────────────────────────────────────────────────────────────────

test('a watch recipient gets the words at its chat, NO keyboard, and no token is minted', async () => {
  const h = harness();
  const before = h.store.size;
  const result = await h.transport.send({ userId: 'watch:777', rights: 'watch', chatId: 777 }, dangerMessage());
  assert.deepEqual(result, { ok: true });
  const call = h.telegram.last('sendMessage');
  assert.equal(call.payload['chat_id'], 777);
  assert.equal(call.payload['reply_markup'], undefined, 'no keyboard at all, not a disabled one');
  assert.equal(h.store.size, before, 'nothing parked: there is nothing a crafted tap could find');
  assert.equal(h.executor.calls.length, 0);
});

test('a watch recipient without a chat is a permanent failure, not a retry', async () => {
  const h = harness();
  const result = await h.transport.send({ userId: 'watch:nowhere', rights: 'watch' }, dangerMessage());
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.reason ?? '', /names no chat/);
  assert.equal(h.telegram.of('sendMessage').length, 0);
});
