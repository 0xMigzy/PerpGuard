/**
 * The bot end to end: real grammY, real middleware, real command routing, fake
 * Telegram.
 *
 * The authorisation tests here are the ones that matter most in this package. A
 * risk tool that acts on a stranger's tap moves a real trader's collateral at
 * the request of someone who is not them, so "the gate is a pure function and it
 * is tested" is not enough — the bot has to actually ask, on every path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot, InlineKeyboard } from 'grammy';
import { encodeCallback, decodeCallback } from './callback.ts';
import { createBot } from './bot.ts';
import { HELP_TEXT, REFUSAL_TEXT, WRONG_CHAT_TEXT } from './help.ts';
import { InMemoryLinkStore } from './links.ts';
import { PendingActionStore } from './actions.ts';
import {
  CONFIGS,
  FakeExecutor,
  FakeTelegram,
  FakeView,
  OWNER_CHAT,
  OWNER_ID,
  STRANGER_ID,
  TEST_TOKEN,
  USER_ID,
  callbackUpdate,
  countingTokens,
  dangerAssessment,
  dangerMessage,
  fakeBot,
  messageUpdate,
  newLinks,
} from './testSupport.ts';

interface Harness {
  readonly bot: Bot;
  readonly telegram: FakeTelegram;
  readonly executor: FakeExecutor;
  readonly view: FakeView;
  readonly store: PendingActionStore;
  readonly links: InMemoryLinkStore;
  nowMs: number;
}

function harness(options: { readonly links?: InMemoryLinkStore } = {}): Harness {
  const { bot, telegram } = fakeBot();
  const executor = new FakeExecutor();
  const view = new FakeView();
  const links = options.links ?? newLinks();
  const state = { nowMs: 1_000_000 };
  const store = new PendingActionStore({
    now: () => state.nowMs,
    nextToken: countingTokens(),
  });

  const built = createBot({
    config: { token: TEST_TOKEN, userId: USER_ID, ownerTelegramUserId: undefined },
    links,
    store,
    executor,
    view,
    configs: CONFIGS,
    now: () => state.nowMs,
    botInfo: bot.botInfo,
  });
  // The bot under test must talk to the fake, not to Telegram.
  telegram.install(built.api);

  return {
    bot: built,
    telegram,
    executor,
    view,
    store,
    links,
    get nowMs() {
      return state.nowMs;
    },
    set nowMs(value: number) {
      state.nowMs = value;
    },
  };
}

const texts = (telegram: FakeTelegram): string[] =>
  telegram.of('sendMessage').map((call) => String(call.payload['text']));

const answers = (telegram: FakeTelegram): string[] =>
  telegram.of('answerCallbackQuery').map((call) => String(call.payload['text'] ?? ''));

function keyboardOf(call: FakeTelegram['calls'][number]): Array<{ callback_data: string }> {
  const markup = call.payload['reply_markup'] as InlineKeyboard | undefined;
  return markup === undefined ? [] : (markup.inline_keyboard.flat() as Array<{ callback_data: string }>);
}

// ── authorisation ───────────────────────────────────────────────────────────

test('a stranger’s command is flatly refused and no handler runs', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];

  for (const command of ['/positions', '/status', '/help']) {
    await h.bot.handleUpdate(messageUpdate(command, { from: STRANGER_ID, chat: 7_777 }));
  }

  assert.deepEqual(texts(h.telegram), [REFUSAL_TEXT, REFUSAL_TEXT, REFUSAL_TEXT]);
  // No position data, no status, no help leaked.
  for (const text of texts(h.telegram)) {
    assert.doesNotMatch(text, /BTC/);
    assert.doesNotMatch(text, /liquidation/);
  }
});

test('a stranger’s tap is refused and never reaches the executor', async () => {
  const h = harness();
  const pending = h.store.put({
    userId: USER_ID,
    telegramUserId: OWNER_ID,
    action: dangerMessage().actions[0]!,
  });
  const data = encodeCallback({
    kind: 'confirm',
    token: pending.token,
    marketId: pending.action.marketId,
    amountCNS: pending.action.amountCNS,
  });

  await h.bot.handleUpdate(callbackUpdate(data, { from: STRANGER_ID, chat: 7_777 }));

  assert.deepEqual(answers(h.telegram), [REFUSAL_TEXT]);
  assert.equal(h.executor.calls.length, 0, 'the executor must not have been called');
  assert.equal(texts(h.telegram).length, 0);
});

test('a stranger tapping in the OWNER’s chat is still refused', async () => {
  // Same chat, different person. The gate is keyed on the person.
  const h = harness();
  const pending = h.store.put({
    userId: USER_ID,
    telegramUserId: OWNER_ID,
    action: dangerMessage().actions[0]!,
  });
  const data = encodeCallback({
    kind: 'confirm',
    token: pending.token,
    marketId: pending.action.marketId,
    amountCNS: pending.action.amountCNS,
  });

  await h.bot.handleUpdate(callbackUpdate(data, { from: STRANGER_ID, chat: OWNER_CHAT }));

  assert.deepEqual(answers(h.telegram), [REFUSAL_TEXT]);
  assert.equal(h.executor.calls.length, 0);
});

test('a tap is always answered, so a refused button never spins forever', async () => {
  const h = harness();
  await h.bot.handleUpdate(callbackUpdate('a1:t1:1:1', { from: STRANGER_ID, chat: 7_777 }));
  assert.equal(h.telegram.of('answerCallbackQuery').length, 1);
  assert.equal(h.telegram.last('answerCallbackQuery').payload['show_alert'], true);
});

test('the linked user speaking from another chat is refused, so nothing leaks to a group', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  await h.bot.handleUpdate(messageUpdate('/positions', { from: OWNER_ID, chat: -100_999 }));

  assert.deepEqual(texts(h.telegram), [WRONG_CHAT_TEXT]);
});

test('an unlinked chat gets /start and nothing else', async () => {
  const h = harness({ links: new InMemoryLinkStore({ capacity: 1 }) });
  h.view.assessments = [dangerAssessment()];

  await h.bot.handleUpdate(messageUpdate('/positions'));
  await h.bot.handleUpdate(messageUpdate('/status'));
  assert.deepEqual(texts(h.telegram), [REFUSAL_TEXT, REFUSAL_TEXT]);

  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.match(texts(h.telegram).at(-1)!, /^Linked\./);
  assert.equal(h.links.byTelegramUserId(OWNER_ID)?.chatId, OWNER_CHAT);

  // And now the same commands work.
  await h.bot.handleUpdate(messageUpdate('/status'));
  assert.match(texts(h.telegram).at(-1)!, /PerpGuard is watching 1 position/);
});

test('once one user is linked, a second /start is refused and the link is unchanged', async () => {
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('/start', { from: STRANGER_ID, chat: 7_777 }));

  assert.match(texts(h.telegram).at(-1)!, /not accepting this chat/);
  assert.equal(h.links.byTelegramUserId(STRANGER_ID), undefined);
  assert.equal(h.links.byUserId(USER_ID)?.telegramUserId, OWNER_ID);
});

test('/start from the already-linked user is idempotent', async () => {
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.match(texts(h.telegram).at(-1)!, /^Already linked\./);
  assert.equal(h.links.list().length, 1);
});

// ── commands ────────────────────────────────────────────────────────────────

test('/help lists what the bot can do, one sentence each', async () => {
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('/help'));
  const text = texts(h.telegram).at(-1)!;
  assert.equal(text, HELP_TEXT);
  for (const command of ['/positions', '/status', '/start', '/help']) {
    assert.ok(text.includes(command), `${command} should be documented`);
  }
  assert.match(text, /isolated margin/i);
});

test('/positions renders each position with the alert layer’s own words', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];

  await h.bot.handleUpdate(messageUpdate('/positions'));

  const sent = texts(h.telegram);
  assert.equal(sent[0], '1 position, worst first.');
  assert.equal(sent[1], dangerMessage().text);
  assert.deepEqual(
    keyboardOf(h.telegram.of('sendMessage')[1]!).map((b) => {
      const decoded = decodeCallback(b.callback_data);
      return decoded.ok ? decoded.payload.amountCNS : undefined;
    }),
    [562_000_000n, 2_662_000_000n],
  );
});

test('/positions with nothing open, on a healthy monitor, says so', async () => {
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('/positions'));
  assert.deepEqual(texts(h.telegram), ['No open positions.']);
});

test('/positions with nothing open and an untrusted list refuses to call it empty', async () => {
  const h = harness();
  h.view.positions = {
    state: 'awaiting-snapshot',
    reason: 'signed in, no snapshot yet.',
    lastUpdateMs: undefined,
    ageMs: undefined,
  };

  await h.bot.handleUpdate(messageUpdate('/positions'));
  const text = texts(h.telegram)[0]!;
  assert.match(text, /I cannot tell you that means you have no positions/);
  assert.doesNotMatch(text, /No open positions/);
});

test('/positions names a market it has no config for rather than dropping it', async () => {
  const h = harness();
  h.view.assessments = [{ ...dangerAssessment(), marketId: 4_242, symbol: 'TAO' }];

  await h.bot.handleUpdate(messageUpdate('/positions'));
  assert.match(texts(h.telegram).at(-1)!, /no market configuration for TAO \(market 4242\)/);
  assert.match(texts(h.telegram).at(-1)!, /still watching it/);
});

// ── the action flow ─────────────────────────────────────────────────────────

/** Send /positions and return the callback data of the first top-up button. */
async function firstButton(h: Harness): Promise<string> {
  h.view.assessments = [dangerAssessment()];
  await h.bot.handleUpdate(messageUpdate('/positions'));
  const data = keyboardOf(h.telegram.of('sendMessage')[1]!)[0]?.callback_data;
  assert.ok(data !== undefined, 'expected a top-up button');
  return data;
}

test('tapping a top-up shows a confirmation with the exact amount and liquidation price', async () => {
  const h = harness();
  const data = await firstButton(h);
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  const confirmation = texts(h.telegram).at(-1)!;
  assert.equal(
    confirmation,
    [
      'Confirm — add margin to BTC',
      'Add 562 → buffer 4.0%, liquidation 80,647.1',
      'Exact amount sent: 562.000000 AUSD.',
      'This is the cheaper option: it buys exactly enough room to leave the danger band, and no more.',
      'Isolated margin: this collateral goes to this position only.',
      'Nothing has been sent yet.',
    ].join('\n'),
  );
  // Nothing was executed by merely tapping.
  assert.equal(h.executor.calls.length, 0);
});

test('the confirm button carries the same amount the confirmation quoted', async () => {
  const h = harness();
  const data = await firstButton(h);
  h.telegram.calls.length = 0;
  await h.bot.handleUpdate(callbackUpdate(data));

  const confirm = keyboardOf(h.telegram.last('sendMessage'))[0]!;
  const decoded = decodeCallback(confirm.callback_data);
  assert.ok(decoded.ok);
  assert.equal(decoded.payload.kind, 'confirm');
  assert.equal(decoded.payload.amountCNS, 562_000_000n);
  assert.equal(decoded.payload.marketId, 1);
});

test('confirming reaches the executor with the amount verbatim, and reports honestly', async () => {
  const h = harness();
  const data = await firstButton(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  const confirm = keyboardOf(h.telegram.last('sendMessage'))[0]!;
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(confirm.callback_data));

  assert.equal(h.executor.calls.length, 1);
  const request = h.executor.calls[0]!;
  assert.equal(request.userId, USER_ID);
  // Sent, not recomputed: the same bigint the message and the button carried.
  assert.equal(request.action.amountCNS, 562_000_000n);
  assert.equal(request.action.label, 'Add 562 → buffer 4.0%, liquidation 80,647.1');
  assert.equal(request.action.positionId, 4_242);
  assert.match(request.idempotencyKey, new RegExp(`^${USER_ID}:1:clear-danger:`));

  // Nothing claims success. Execution is not wired, and the reply says so.
  const reply = texts(h.telegram).at(-1)!;
  assert.match(reply, /^Not sent\./);
  assert.match(reply, /lands in the next piece of work/);
});

test('a confirm token is single use, so a double tap cannot submit twice', async () => {
  // One in-flight action per position.
  const h = harness();
  const data = await firstButton(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  const confirm = keyboardOf(h.telegram.last('sendMessage'))[0]!;

  await h.bot.handleUpdate(callbackUpdate(confirm.callback_data));
  h.telegram.calls.length = 0;
  await h.bot.handleUpdate(callbackUpdate(confirm.callback_data));

  assert.equal(h.executor.calls.length, 1, 'the second tap must not execute');
  assert.match(answers(h.telegram).at(-1)!, /expired/);
});

test('an expired button refuses rather than sending a stale amount', async () => {
  const h = harness();
  const data = await firstButton(h);
  h.nowMs += 16 * 60_000;
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  assert.equal(h.executor.calls.length, 0);
  assert.match(answers(h.telegram).at(-1)!, /expired/);
  assert.match(answers(h.telegram).at(-1)!, /Run \/positions/);
});

test('a button whose amount disagrees with the stored action is discarded', async () => {
  const h = harness();
  const pending = h.store.put({
    userId: USER_ID,
    telegramUserId: OWNER_ID,
    action: dangerMessage().actions[0]!,
  });
  const tampered = encodeCallback({
    kind: 'confirm',
    token: pending.token,
    marketId: pending.action.marketId,
    amountCNS: pending.action.amountCNS + 1n,
  });

  await h.bot.handleUpdate(callbackUpdate(tampered));

  assert.equal(h.executor.calls.length, 0);
  assert.match(answers(h.telegram).at(-1)!, /does not match the action I have on file/);
  assert.equal(h.store.get(pending.token), undefined, 'the token must be discarded');
});

test('a button for the wrong market is discarded even with a valid token', async () => {
  const h = harness();
  const pending = h.store.put({
    userId: USER_ID,
    telegramUserId: OWNER_ID,
    action: dangerMessage().actions[0]!,
  });
  const tampered = encodeCallback({
    kind: 'confirm',
    token: pending.token,
    marketId: 20,
    amountCNS: pending.action.amountCNS,
  });

  await h.bot.handleUpdate(callbackUpdate(tampered));
  assert.equal(h.executor.calls.length, 0);
  assert.match(answers(h.telegram).at(-1)!, /does not match the action I have on file/);
});

test('a disabled button reports the venue’s reason and executes nothing', async () => {
  const h = harness();
  h.executor.available = {
    actionable: false,
    network: 'testnet',
    code: 'market-closed',
    reason: 'the venue has BTC closed',
  };

  const data = await firstButton(h);
  const decoded = decodeCallback(data);
  assert.ok(decoded.ok && decoded.payload.kind === 'blocked');
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  assert.equal(h.executor.calls.length, 0);
  assert.match(answers(h.telegram).at(-1)!, /Not actionable on testnet: the venue has BTC closed/);
});

test('a market that closed between the alert and the tap is refused at tap time', async () => {
  // Availability is re-asked on every tap, not trusted from render time.
  const h = harness();
  const data = await firstButton(h);
  h.executor.available = {
    actionable: false,
    network: 'testnet',
    code: 'market-closed',
    reason: 'the venue has BTC closed',
  };
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  assert.equal(h.executor.calls.length, 0);
  assert.match(answers(h.telegram).at(-1)!, /Not actionable on testnet/);
  assert.equal(texts(h.telegram).length, 0, 'no confirmation screen for an unavailable market');
});

test('a venue that throws at tap time refuses rather than assuming permission', async () => {
  const h = harness();
  const data = await firstButton(h);
  h.executor.availabilityError = new Error('venue lookup exploded');
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  assert.equal(h.executor.calls.length, 0);
  assert.match(answers(h.telegram).at(-1)!, /could not check whether this market can be acted on/);
});

test('an unreadable button says so rather than guessing at what it meant', async () => {
  const h = harness();
  await h.bot.handleUpdate(callbackUpdate('a0:t1:1:562000000'));
  assert.equal(h.executor.calls.length, 0);
  assert.match(answers(h.telegram).at(-1)!, /older version of the bot/);
});
