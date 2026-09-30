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
import { CONFIRM_BUTTON_LABEL } from './confirm.ts';
import { PendingAmountStore } from './custom.ts';
import { CUSTOM_BUTTON_LABEL } from './format.ts';
import {
  CONFIGS,
  FakeBalance,
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
  dangerScenario,
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
  readonly amounts: PendingAmountStore;
  readonly balance: FakeBalance;
  readonly links: InMemoryLinkStore;
  nowMs: number;
}

function harness(options: { readonly links?: InMemoryLinkStore } = {}): Harness {
  const { bot, telegram } = fakeBot();
  const executor = new FakeExecutor();
  const view = new FakeView();
  const balance = new FakeBalance();
  const links = options.links ?? newLinks();
  const state = { nowMs: 1_000_000 };
  const store = new PendingActionStore({
    now: () => state.nowMs,
    nextToken: countingTokens(),
  });
  // The same clock as the action store, so the two expiries can be tested against
  // one advance of one number — which is also how they are meant to behave.
  const amounts = new PendingAmountStore({ now: () => state.nowMs });

  const built = createBot({
    config: { token: TEST_TOKEN, userId: USER_ID, ownerTelegramUserId: undefined },
    links,
    store,
    amounts,
    balance,
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
    amounts,
    balance,
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

function keyboardOf(
  call: FakeTelegram['calls'][number],
): Array<{ text: string; callback_data: string }> {
  const markup = call.payload['reply_markup'] as InlineKeyboard | undefined;
  return markup === undefined
    ? []
    : (markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>);
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
    // The two computed amounts, then the custom marker, which carries none.
    [562_000_000n, 2_662_000_000n, 0n],
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

// ── the custom amount ───────────────────────────────────────────────────────

/**
 * Send /positions with the real loop behind the view, and return the callback
 * data of the "Custom amount" button.
 */
async function customTap(h: Harness): Promise<string> {
  const scenario = dangerScenario();
  h.view.assessments = [scenario.assessment];
  h.view.loop = scenario.loop;
  await h.bot.handleUpdate(messageUpdate('/positions'));
  const rows = keyboardOf(h.telegram.of('sendMessage')[1]!);
  const last = rows.at(-1);
  assert.ok(last !== undefined, 'expected a keyboard');
  assert.equal(last.text, CUSTOM_BUTTON_LABEL);
  return last.callback_data;
}

/** Tap Custom amount, then reply with `amount`. Returns the last message sent. */
async function typeAmount(h: Harness, amount: string): Promise<string> {
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  await h.bot.handleUpdate(messageUpdate(amount));
  return texts(h.telegram).at(-1)!;
}

test('/positions offers Custom amount below both computed options, never instead of one', async () => {
  const h = harness();
  await customTap(h);
  assert.deepEqual(
    keyboardOf(h.telegram.of('sendMessage')[1]!).map((b) => b.text),
    [
      'Add 562 → buffer 4.0%, liquidation 80,647.1',
      'Add 2,662 → buffer 9.0%, liquidation 76,446.7',
      'Custom amount',
    ],
  );
});

test('tapping Custom amount asks for a figure and states where the position stands', async () => {
  const h = harness();
  const data = await customTap(h);
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  const prompt = texts(h.telegram).at(-1)!;
  assert.equal(
    prompt,
    [
      'Custom amount — add margin to BTC long',
      'Now: buffer 2.7%, liquidation 81,770.1, mark 84,007.3.',
      'Position size at the mark: 42,003.65 AUSD.',
      'At least 10,000 AUSD free — a floor, not your balance.',
      'Reply with an amount in AUSD and I will show you the buffer and liquidation price it buys.',
      'Smallest increment 0.000001 AUSD. /cancel to drop this.',
      'Nothing has been sent, and nothing will be until you confirm.',
    ].join('\n'),
  );
  // The prompt is open, and it knows which position it is for.
  const pending = h.amounts.get(OWNER_ID);
  assert.equal(pending?.marketId, 1);
  assert.equal(pending?.positionId, 4_242);
  // Nothing was executed and no amount was parked by merely asking.
  assert.equal(h.executor.calls.length, 0);
});

test('a custom amount gets the outcome computed for it, on the computed options’ screen', async () => {
  const h = harness();
  const confirmation = await typeAmount(h, '1000');

  assert.equal(
    confirmation,
    [
      'Confirm — add margin to BTC',
      'Add 1,000 → buffer 5.0%, liquidation 79,770.1',
      'Exact amount sent: 1000.000000 AUSD.',
      'This is your own amount. The buffer and liquidation price above are what it buys.',
      'Isolated margin: this collateral goes to this position only.',
      'Nothing has been sent yet.',
    ].join('\n'),
  );
  assert.equal(h.executor.calls.length, 0, 'the confirmation screen executes nothing');
  // The question is answered, so it is closed.
  assert.equal(h.amounts.get(OWNER_ID), undefined);
});

test('the custom confirmation screen is the computed one’s shape, line for line', async () => {
  // The two screens have to be the same screen with a different number in it.
  // Divergence here is how a trader ends up comparing two layouts and trusting
  // neither.
  const computed = harness();
  const data = await firstButton(computed);
  await computed.bot.handleUpdate(callbackUpdate(data));
  const computedLines = texts(computed.telegram).at(-1)!.split('\n');

  const custom = harness();
  const customLines = (await typeAmount(custom, '1000')).split('\n');

  assert.equal(customLines.length, computedLines.length);
  assert.equal(customLines[0], computedLines[0]);
  for (const lines of [computedLines, customLines]) {
    assert.match(lines[1]!, /^Add [\d,.]+ → buffer \d+\.\d%, liquidation [\d,.]+$/);
    assert.match(lines[2]!, /^Exact amount sent: \d+\.\d{6} AUSD\.$/);
    assert.equal(lines[4], 'Isolated margin: this collateral goes to this position only.');
    assert.equal(lines.at(-1), 'Nothing has been sent yet.');
  }
  // Only the sentence that says WHICH option this is differs.
  assert.notEqual(customLines[3], computedLines[3]);
});

test('confirming a custom amount sends exactly the figure that was shown', async () => {
  const h = harness();
  await typeAmount(h, '1000.5');
  const confirm = keyboardOf(h.telegram.last('sendMessage'))[0]!;
  assert.equal(confirm.text, CONFIRM_BUTTON_LABEL);
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(confirm.callback_data));

  assert.equal(h.executor.calls.length, 1);
  const request = h.executor.calls[0]!;
  // The exact typed figure, in micros, neither ceiled nor rounded: the user chose
  // it, so it is not ours to adjust.
  assert.equal(request.action.amountCNS, 1_000_500_000n);
  assert.equal(request.action.label, 'Add 1,000.5 → buffer 5.0%, liquidation 79,769.1');
  assert.equal(request.action.intent, 'custom');
  assert.equal(request.action.positionId, 4_242);
  assert.match(request.idempotencyKey, new RegExp(`^${USER_ID}:1:custom:`));
  assert.match(texts(h.telegram).at(-1)!, /^Not sent\./);
});

test('typing something that is not a number leaves the prompt open rather than stuck', async () => {
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(messageUpdate('a hundred quid'));

  const reply = texts(h.telegram).at(-1)!;
  assert.match(reply, /I need a number of AUSD/);
  assert.match(reply, /\/cancel/);
  assert.ok(h.amounts.get(OWNER_ID) !== undefined, 'the prompt must survive a typo');

  // And the retry works, without going back through /positions.
  await h.bot.handleUpdate(messageUpdate('1000'));
  assert.match(texts(h.telegram).at(-1)!, /^Confirm — add margin to BTC$/m);
});

test('each validation path answers with its own message', async () => {
  for (const [input, pattern] of [
    ['-5', /has to be more than zero/],
    ['0', /has to be more than zero/],
    ['0.0000004', /smaller than the smallest amount BTC collateral can take/],
    ['1.0000004', /finer than that/],
  ] as const) {
    const h = harness();
    const data = await customTap(h);
    await h.bot.handleUpdate(callbackUpdate(data));
    h.telegram.calls.length = 0;
    await h.bot.handleUpdate(messageUpdate(input));
    assert.match(texts(h.telegram).at(-1)!, pattern, input);
    assert.equal(h.executor.calls.length, 0);
  }
});

test('an amount over the free-balance floor warns, and the Confirm button is still there', async () => {
  const h = harness();
  h.balance.reading = { known: true, floorCNS: 42_100_000n };
  const confirmation = await typeAmount(h, '1000');

  assert.match(confirmation, /This may be more than your free balance/);
  assert.match(confirmation, /I can see at least 42\.1 AUSD available/);
  assert.match(confirmation, /floor rather than your balance/);
  // Warned, not refused: our floor can understate, and blocking a legitimate
  // rescue is worse than letting the venue reject a genuinely short request.
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, CONFIRM_BUTTON_LABEL);
  // And the warning sits above the last line, which stays the last line.
  assert.match(confirmation, /Nothing has been sent yet\.$/);
});

test('an unknown balance says so instead of implying it was checked', async () => {
  const h = harness();
  h.balance.reading = { known: false, reason: 'I am not signed in to the trading account.' };
  const confirmation = await typeAmount(h, '1000');
  assert.match(confirmation, /could not check your free balance: I am not signed in/);
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, CONFIRM_BUTTON_LABEL);
});

test('an implausibly large amount asks whether it was meant, rather than refusing it', async () => {
  const h = harness();
  h.balance.reading = { known: true, floorCNS: 10n ** 15n };
  const confirmation = await typeAmount(h, '500000');

  assert.match(confirmation, /more than 10x this position's whole size at the mark \(42,003\.65 AUSD\)/);
  assert.match(confirmation, /Confirm only if you meant it/);
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, CONFIRM_BUTTON_LABEL);
});

test('a pending amount expires on the same fifteen minutes as an action token', async () => {
  // An amount typed against a mark from twenty minutes ago is a wrong number.
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.nowMs += 16 * 60_000;
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(messageUpdate('1000'));

  // Not answered at all: with the prompt gone there is no question for it to be
  // an answer to, and a stray "1000" must not become a margin transfer.
  assert.equal(texts(h.telegram).length, 0);
  assert.equal(h.executor.calls.length, 0);
});

test('/cancel drops a pending amount, and says so when there was none', async () => {
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(messageUpdate('/cancel'));
  assert.match(texts(h.telegram).at(-1)!, /^Dropped\. Nothing was sent\./);
  assert.equal(h.amounts.get(OWNER_ID), undefined);

  await h.bot.handleUpdate(messageUpdate('/cancel'));
  assert.match(texts(h.telegram).at(-1)!, /Nothing was pending/);

  // And a number typed after cancelling is not an amount any more.
  await h.bot.handleUpdate(messageUpdate('1000'));
  assert.equal(h.executor.calls.length, 0);
  assert.match(texts(h.telegram).at(-1)!, /Nothing was pending/);
});

test('ordinary chatter with no prompt open is left alone', async () => {
  // A bot that answered every stray message is one people mute, and the muted bot
  // is the one whose DANGER alert goes unread.
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('morning'));
  assert.equal(texts(h.telegram).length, 0);
});

test('the Custom amount marker can never be executed, however its token is used', async () => {
  // It parks an action with amountCNS 0 — a handle on a position, not a top-up —
  // and a confirm payload can be crafted against any token that exists.
  const h = harness();
  const data = await customTap(h);
  const decoded = decodeCallback(data);
  assert.ok(decoded.ok);
  assert.equal(decoded.payload.kind, 'custom');
  assert.equal(decoded.payload.amountCNS, 0n);

  const forged = encodeCallback({ ...decoded.payload, kind: 'confirm' });
  h.telegram.calls.length = 0;
  await h.bot.handleUpdate(callbackUpdate(forged));

  assert.equal(h.executor.calls.length, 0, 'zero margin must never reach the executor');
  assert.match(texts(h.telegram).at(-1)!, /has no amount on it, so there is nothing to send/);
});

test('a disabled Custom amount button reports the reason and opens no prompt', async () => {
  const h = harness();
  h.executor.available = {
    actionable: false,
    network: 'testnet',
    code: 'market-closed',
    reason: 'the venue has BTC closed',
  };
  const data = await customTap(h);
  assert.equal(decodeCallback(data).ok && decodeCallback(data).ok, true);
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  assert.match(answers(h.telegram).at(-1)!, /Not actionable on testnet: the venue has BTC closed/);
  assert.equal(h.amounts.get(OWNER_ID), undefined, 'no prompt for a market we cannot act on');
  assert.equal(texts(h.telegram).length, 0);
});

test('a market that closes between the prompt and the reply ends the flow, with no confirmation', async () => {
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.executor.available = {
    actionable: false,
    network: 'testnet',
    code: 'market-closed',
    reason: 'the venue has BTC closed',
  };
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(messageUpdate('1000'));

  assert.match(texts(h.telegram).at(-1)!, /Not actionable on testnet/);
  assert.doesNotMatch(texts(h.telegram).at(-1)!, /Confirm/);
  assert.equal(h.amounts.get(OWNER_ID), undefined);
  assert.equal(h.executor.calls.length, 0);
});

test('going blind between the prompt and the reply refuses to price the amount', async () => {
  // NO TOP-UPS WHILE BLIND, and that includes an amount the user chose: the mark
  // behind the projection is frozen, so the buffer it would claim is not a claim
  // we can stand behind.
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.view.projectionRefusal = 'I cannot currently see BTC: the price feed is disconnected';
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(messageUpdate('1000'));

  assert.match(texts(h.telegram).at(-1)!, /I cannot currently see BTC: the price feed is disconnected/);
  assert.match(texts(h.telegram).at(-1)!, /Run \/positions when I can see it again/);
  assert.equal(h.executor.calls.length, 0);
});

test('tapping Custom amount while blind asks nothing rather than asking for a number it cannot price', async () => {
  const h = harness();
  const data = await customTap(h);
  h.view.projectionRefusal = 'I cannot currently see BTC: the position set is stale';
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  assert.match(texts(h.telegram).at(-1)!, /I cannot currently see BTC: the position set is stale/);
  assert.equal(h.amounts.get(OWNER_ID), undefined);
});

test('a stranger cannot answer the owner’s prompt', async () => {
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(messageUpdate('1000', { from: STRANGER_ID, chat: 7_777 }));

  assert.deepEqual(texts(h.telegram), [REFUSAL_TEXT]);
  assert.ok(h.amounts.get(OWNER_ID) !== undefined, 'the owner’s prompt is untouched');
  assert.equal(h.executor.calls.length, 0);
});
