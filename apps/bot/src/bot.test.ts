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
import type { IndexerHealth } from '@perpguard/shared';
import { InMemoryWatchStore, RateLimiter, type ResolvedWatchTarget, type WatchResolver, type WatchTarget } from './watch.ts';
import { encodeNav, type Route } from './nav.ts';
import { InMemoryAccountSettingsStore } from './settings.ts';
import type { KillSwitchReport } from './sessions.ts';
import { StaticSessionRouter } from './sessions.ts';
import {
  CONFIGS,
  FakeBalance,
  FakeExecutor,
  FakeTelegram,
  FakeView,
  OWNER_ACCOUNT,
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
  readonly watchStore: InMemoryWatchStore;
  readonly resolver: FakeResolver;
  nowMs: number;
  /** What the owner's session does when its kill switch fires. Undefined: not available. */
  killSwitch: ((userId: string) => Promise<KillSwitchReport>) | undefined;
}

/** A resolver the test scripts: an address or id -> an account, or a refusal. */
class FakeResolver implements WatchResolver {
  readonly asked: WatchTarget[] = [];
  answers = new Map<string, ResolvedWatchTarget | { readonly error: string }>();
  async resolve(target: WatchTarget): Promise<ResolvedWatchTarget | { readonly error: string }> {
    this.asked.push(target);
    const key = target.kind === 'address' ? target.address : String(target.accountId);
    return this.answers.get(key) ?? { error: `nothing is known about ${key}` };
  }
}

function harness(options: { readonly links?: InMemoryLinkStore; readonly watch?: boolean; readonly maxPerChat?: number; readonly rateLimit?: number; readonly owner?: number; readonly link?: NonNullable<Parameters<typeof createBot>[0]['link']>; readonly settings?: InMemoryAccountSettingsStore } = {}): Harness {
  const { bot, telegram } = fakeBot();
  const executor = new FakeExecutor();
  const view = new FakeView();
  const balance = new FakeBalance();
  const links = options.links ?? newLinks();
  const state: { nowMs: number; killSwitch: ((userId: string) => Promise<KillSwitchReport>) | undefined } = { nowMs: 1_000_000, killSwitch: undefined };
  const store = new PendingActionStore({
    now: () => state.nowMs,
    nextToken: countingTokens(),
  });
  // The same clock as the action store, so the two expiries can be tested against
  // one advance of one number — which is also how they are meant to behave.
  const amounts = new PendingAmountStore({ now: () => state.nowMs });
  const watchStore = new InMemoryWatchStore({ maxPerChat: options.maxPerChat ?? 5 });
  const resolver = new FakeResolver();
  const limiter = new RateLimiter({ limit: options.rateLimit ?? 100, windowMs: 60_000, now: () => state.nowMs });
  const indexer = { state: 'synced', blocksBehind: 7, latestProcessedBlock: 109_000_000, serveAsCurrent: true } as unknown as IndexerHealth;

  const built = createBot({
    config: { token: TEST_TOKEN, userId: USER_ID, ownerTelegramUserId: options.owner },
    links,
    store,
    amounts,
    sessions: new StaticSessionRouter([{ accountId: OWNER_ACCOUNT, view, executor, balance, killSwitch: (userId: string) => (state.killSwitch === undefined ? Promise.resolve({ refused: 'not available', closed: [], stillOpen: [], unresolved: [], notPriceable: [] }) : state.killSwitch(userId)) }]),
    ownerAccountId: OWNER_ACCOUNT,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    configs: CONFIGS,
    now: () => state.nowMs,
    botInfo: bot.botInfo,
    ...(options.watch === false ? {} : { watch: { store: watchStore, resolver, limiter, indexerHealth: () => indexer } }),
    ...(options.link === undefined ? {} : { link: options.link }),
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
    watchStore,
    resolver,
    get nowMs() {
      return state.nowMs;
    },
    set nowMs(value: number) {
      state.nowMs = value;
    },
    get killSwitch() {
      return state.killSwitch;
    },
    set killSwitch(fn: ((userId: string) => Promise<KillSwitchReport>) | undefined) {
      state.killSwitch = fn;
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
  return markup?.inline_keyboard === undefined
    ? []
    : (markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>);
}

/** Every screen the chat saw, sends and edits alike, in order. */
const shown = (telegram: FakeTelegram): string[] =>
  telegram.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => String(c.payload['text']));

/** The last message sent or edited. */
function lastScreen(telegram: FakeTelegram): FakeTelegram['calls'][number] {
  const call = [...telegram.calls].reverse().find((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  if (call === undefined) throw new Error('no screen was shown');
  return call;
}

/** The buttons on a message that carry an ACTION token, not a navigation route. */
const actionButtons = (call: FakeTelegram['calls'][number]) =>
  keyboardOf(call).filter((b) => b.callback_data !== undefined && decodeCallback(b.callback_data).ok);

const tapNav = (h: Harness, route: Route, options: { readonly from?: number; readonly chat?: number } = {}) =>
  h.bot.handleUpdate(callbackUpdate(encodeNav(route), options));

/** Open one position's screen, as the owner, and return the message it landed in. */
async function openPosition(h: Harness, marketId = 1): Promise<FakeTelegram['calls'][number]> {
  await tapNav(h, { to: 'position', marketId });
  return lastScreen(h.telegram);
}

// ── authorisation ───────────────────────────────────────────────────────────

test('a stranger’s command is flatly refused and no handler runs', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];

  for (const command of ['/positions', '/status', '/cancel', '/help']) {
    await h.bot.handleUpdate(messageUpdate(command, { from: STRANGER_ID, chat: 7_777 }));
  }

  // The account commands are refused flat; /help is public and says so.
  assert.deepEqual(texts(h.telegram), [REFUSAL_TEXT, REFUSAL_TEXT, REFUSAL_TEXT, HELP_TEXT]);
  // No position data and no status leaked.
  for (const text of texts(h.telegram).slice(0, 3)) {
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

test('the configured owner links with /start; an unlinked chat gets an identity and the home screen, never the acting slot', async () => {
  const h = harness({ links: new InMemoryLinkStore({ capacity: 1, ownerTelegramUserId: OWNER_ID }), owner: OWNER_ID });
  h.view.assessments = [dangerAssessment()];

  await tapNav(h, { to: 'positions' });
  await tapNav(h, { to: 'settings' });
  assert.deepEqual(answers(h.telegram), [REFUSAL_TEXT, REFUSAL_TEXT]);

  await h.bot.handleUpdate(messageUpdate('/start'));
  const sent = texts(h.telegram);
  assert.match(sent.at(-2)!, /^Connected to account #710\./);
  assert.match(sent.at(-1)!, /🛡 My account <b>#710<\/b>/, 'the home screen shows the account');
  assert.equal(h.links.byTelegramUserId(OWNER_ID)?.chatId, OWNER_CHAT);
  assert.equal(h.links.byTelegramUserId(OWNER_ID)?.accountId, OWNER_ACCOUNT);

  // And now the same screens work.
  await tapNav(h, { to: 'positions' });
  assert.match(shown(h.telegram).at(-1)!, /^<b>Account #710<\/b> · 1 open/);

  // A stranger's /start is an identity and the first-run home screen, not a link and not a refusal.
  await h.bot.handleUpdate(messageUpdate('/start', { from: STRANGER_ID, chat: 7_777 }));
  const hello = texts(h.telegram).at(-1)!;
  assert.match(hello, /Watch any Perpl trader and get told before they are liquidated\./);
  assert.match(hello, /🛡 No account connected/);
  assert.equal(h.links.byTelegramUserId(STRANGER_ID), undefined);
  assert.equal(h.links.byUserId(USER_ID)?.telegramUserId, OWNER_ID);
});

test('with no owner configured, /start links NOBODY: a public bot has no first-come acting slot', async () => {
  const h = harness({ links: new InMemoryLinkStore({ capacity: 1 }) });
  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.match(texts(h.telegram).at(-1)!, /🛡 No account connected/);
  assert.equal(h.links.list().length, 0, 'the first person to arrive does not become the owner');
});

test('/start from the already-linked user is idempotent', async () => {
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.match(texts(h.telegram).at(-1)!, /🛡 My account <b>#710<\/b>/);
  assert.equal(h.links.list().length, 1);
});

// ── commands ────────────────────────────────────────────────────────────────

test('/help lists what the bot can do, one sentence each', async () => {
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('/help'));
  const text = texts(h.telegram).at(-1)!;
  assert.equal(text, HELP_TEXT);
  for (const command of ['/start', '/watch', '/link', '/help']) {
    assert.ok(text.includes(command), `${command} should be documented`);
  }
  assert.match(text, /isolated margin/i);
});

test('My positions lists each position closest first; its screen offers both top-ups, a custom amount, reduce and close', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];

  await tapNav(h, { to: 'positions' });
  const list = lastScreen(h.telegram);
  assert.match(String(list.payload['text']), /^<b>Account #710<\/b> · 1 open\n\n🔴 BTC long [\d.]+ BTC · <b>2\.7%<\/b>/);
  assert.match(String(list.payload['text']), /Free balance at least <b>10,000 AUSD<\/b>/);
  assert.deepEqual(keyboardOf(list).map((b) => b.text), ['BTC long · 2.7%', '⚙️ Settings', '⛔ Kill switch', '← Back']);

  const screen = await openPosition(h);
  const html = String(screen.payload['text']);
  assert.match(html, /^🔴 <b>BTC long · 2\.7% from being closed<\/b>\nBTC is 84,007\.3\. At 81,770\.1 the exchange closes this and you lose the <b>[\d,]+ AUSD<\/b> behind it\./);
  assert.ok(!html.includes('Changed from'), 'a view, not an alert');
  assert.deepEqual(keyboardOf(screen).map((b) => b.text), [
    'Add 562 AUSD → closes at 80,647.1',
    'Add 2,662 AUSD → closes at 76,446.7',
    'Add custom amount',
    'Reduce 25%',
    'Close position',
    '⛔ Kill switch',
    '← Back',
  ]);
  assert.deepEqual(
    actionButtons(screen).map((b) => {
      const decoded = decodeCallback(b.callback_data);
      return decoded.ok ? [decoded.payload.kind, decoded.payload.amountCNS] : undefined;
    }),
    // The two computed amounts, the custom marker, the reduce and the close — none of which carries money.
    [['act', 562_000_000n], ['act', 2_662_000_000n], ['custom', 0n], ['act', 0n], ['act', 0n]],
  );
  assert.equal(h.executor.calls.length, 0, 'showing a screen executes nothing');
});

test('My positions with nothing open, on a healthy monitor, says so', async () => {
  const h = harness();
  await tapNav(h, { to: 'positions' });
  assert.match(shown(h.telegram).at(-1)!, /No open positions\./);
});

test('My positions with nothing open and an untrusted list refuses to call it empty', async () => {
  const h = harness();
  h.view.positions = {
    state: 'awaiting-snapshot',
    reason: 'signed in, no snapshot yet.',
    lastUpdateMs: undefined,
    ageMs: undefined,
  };
  await tapNav(h, { to: 'positions' });
  const text = shown(h.telegram).at(-1)!;
  assert.match(text, /that does not mean you have no positions/);
  assert.match(text, /I cannot see your positions right now/);
  assert.doesNotMatch(text, /No open positions/);
});

test('a position on a market with no config is listed, and its screen says why it cannot be priced', async () => {
  const h = harness();
  h.view.assessments = [{ ...dangerAssessment(), marketId: 4_242, symbol: 'TAO' }];
  await tapNav(h, { to: 'positions' });
  assert.match(shown(h.telegram).at(-1)!, /TAO long/);
  await openPosition(h, 4_242);
  assert.match(answers(h.telegram).at(-1)!, /no market details for that position/);
});

test('a blind position offers no action at all: no top-up, reduce or close against a frozen price', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  h.view.feed = { state: 'reconnecting', reconnectAttempt: 2 } as never;
  const screen = await openPosition(h);
  assert.equal(actionButtons(screen).length, 0);
  assert.match(String(screen.payload['text']), /The price feed is down/);
});

// ── the action flow ─────────────────────────────────────────────────────────

/** Send /positions and return the callback data of the first top-up button. */
async function firstButton(h: Harness): Promise<string> {
  h.view.assessments = [dangerAssessment()];
  const data = actionButtons(await openPosition(h))[0]?.callback_data;
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
      '<b>Add 562 AUSD to BTC long?</b>',
      'Closes at, after: 80,647.1',
      'Room to fall, after: 4.0%',
      'Free balance left: at least <b>9,438 AUSD</b>',
      '<i>The amount sent is exactly the figure above.</i>',
      '',
      'Nothing has been sent yet.',
    ].join('\n'),
  );
  assert.deepEqual(keyboardOf(h.telegram.last('sendMessage')).map((b) => b.text), ['✓ Send it', 'Cancel']);
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

  // Nothing claims success. The confirmation became the progress line, then the outcome.
  assert.match(shown(h.telegram).at(-2)!, /^Adding the margin… I will check the position itself afterwards/);
  const reply = shown(h.telegram).at(-1)!;
  assert.match(reply, /^<b>Not sent\.<\/b>/);
  assert.match(reply, /lands in the next piece of work/);
  assert.equal(h.telegram.last('editMessageText').payload['text'], reply, 'edited in place, not a new message');
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
  assert.match(answers(h.telegram).at(-1)!, /Open My positions/);
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
  const custom = keyboardOf(await openPosition(h)).find((b) => b.text === 'Add custom amount');
  assert.ok(custom !== undefined, 'expected an Add custom amount button');
  return custom.callback_data;
}

/** Tap Custom amount, then reply with `amount`. Returns the last message sent. */
async function typeAmount(h: Harness, amount: string): Promise<string> {
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  await h.bot.handleUpdate(messageUpdate(amount));
  return texts(h.telegram).at(-1)!;
}

test('the position screen offers Add custom amount below both computed options, never instead of one', async () => {
  const h = harness();
  await customTap(h);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text).slice(0, 3), [
    'Add 562 AUSD → closes at 80,647.1',
    'Add 2,662 AUSD → closes at 76,446.7',
    'Add custom amount',
  ]);
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
      'Smallest increment 0.000001 AUSD. Tap Back on the position to drop this.',
      'Nothing has been sent, and nothing will be until you confirm.',
    ].join('\n'),
  );
  // Asked with force_reply, so the answer is heard.
  assert.deepEqual(h.telegram.last('sendMessage').payload['reply_markup'], { force_reply: true, input_field_placeholder: 'Amount in AUSD' });
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
      '<b>Add 1,000 AUSD to BTC long?</b>',
      'Closes at, after: 79,770.1',
      'Room to fall, after: 5.0%',
      'Free balance left: at least <b>9,000 AUSD</b>',
      '<i>The amount sent is exactly the figure above.</i>',
      '',
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
  for (const lines of [computedLines, customLines]) {
    assert.match(lines[0]!, /^<b>Add [\d,.]+ AUSD to BTC long\?<\/b>$/);
    assert.match(lines[1]!, /^Closes at, after: [\d,.]+$/);
    assert.match(lines[2]!, /^Room to fall, after: \d+\.\d%$/);
    assert.match(lines[3]!, /^Free balance left: at least <b>[\d,]+ AUSD<\/b>$/);
    assert.equal(lines.at(-1), 'Nothing has been sent yet.');
  }
  // Only the figures differ.
  assert.notEqual(customLines[0], computedLines[0]);
});

test('confirming a custom amount sends exactly the figure that was shown', async () => {
  const h = harness();
  await typeAmount(h, '1000.5');
  const confirm = keyboardOf(h.telegram.last('sendMessage'))[0]!;
  assert.equal(confirm.text, '✓ Send it');
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
  assert.match(shown(h.telegram).at(-1)!, /^<b>Not sent\.<\/b>/);
});

test('typing something that is not a number leaves the prompt open rather than stuck', async () => {
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(messageUpdate('a hundred quid'));

  const reply = texts(h.telegram).at(-1)!;
  assert.match(reply, /I need a number of AUSD/);
  assert.match(reply, /Tap Back on the position/);
  assert.ok(h.amounts.get(OWNER_ID) !== undefined, 'the prompt must survive a typo');

  // And the retry works, without going back through /positions.
  await h.bot.handleUpdate(messageUpdate('1000'));
  assert.match(texts(h.telegram).at(-1)!, /^<b>Add 1,000 AUSD to BTC long\?<\/b>$/m);
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
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, '✓ Send it');
  // And the warning sits above the last line, which stays the last line.
  assert.match(confirmation, /Nothing has been sent yet\.$/);
});

test('an unknown balance says so instead of implying it was checked', async () => {
  const h = harness();
  h.balance.reading = { known: false, reason: 'I am not signed in to the trading account.' };
  const confirmation = await typeAmount(h, '1000');
  assert.match(confirmation, /could not check your free balance: I am not signed in/);
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, '✓ Send it');
});

test('an implausibly large amount asks whether it was meant, rather than refusing it', async () => {
  const h = harness();
  h.balance.reading = { known: true, floorCNS: 10n ** 15n };
  const confirmation = await typeAmount(h, '500000');

  assert.match(confirmation, /more than 10x this position's whole size at the mark \(42,003\.65 AUSD\)/);
  assert.match(confirmation, /Confirm only if you meant it/);
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, '✓ Send it');
});

test('a pending amount expires on the same fifteen minutes as an action token', async () => {
  // An amount typed against a mark from twenty minutes ago is a wrong number.
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.nowMs += 16 * 60_000;
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(messageUpdate('1000'));

  // With the prompt gone there is no question for it to be an answer to, and a
  // stray "1000" must not become a margin transfer. Nor is it taken as an
  // account to watch: a bare number nobody asked for is only OFFERED.
  assert.deepEqual(texts(h.telegram), ['Watch account <b>#1000</b>?']);
  assert.equal(h.executor.calls.length, 0);
  assert.equal(h.watchStore.byChat(OWNER_CHAT).length, 0, 'nothing watched without a tap');
});

test('Back from an amount prompt drops it: nothing is waiting for a number any more', async () => {
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  assert.ok(h.amounts.get(OWNER_ID) !== undefined);
  h.telegram.calls.length = 0;

  await tapNav(h, { to: 'position', marketId: 1 });
  assert.equal(h.amounts.get(OWNER_ID), undefined);

  // And a number typed after cancelling is not an amount any more.
  await h.bot.handleUpdate(messageUpdate('1000'));
  assert.equal(h.executor.calls.length, 0);
  assert.equal(texts(h.telegram).at(-1), 'Watch account <b>#1000</b>?');
});

test('ordinary chatter gets one pointer to the menu an hour, not a reply each', async () => {
  // A bot that answered every stray message is one people mute, and the muted bot
  // is the one whose DANGER alert goes unread.
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('morning'));
  assert.match(texts(h.telegram).at(-1)!, /^I did not catch that\./);
  await h.bot.handleUpdate(messageUpdate('how are you'));
  await h.bot.handleUpdate(messageUpdate('hello?'));
  assert.equal(texts(h.telegram).length, 1, 'once, not three times');
  h.nowMs += 61 * 60_000;
  await h.bot.handleUpdate(messageUpdate('still there'));
  assert.equal(texts(h.telegram).length, 2);
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
  assert.match(texts(h.telegram).at(-1)!, /Open My positions when I can see it again/);
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

  // The stranger's "1000" is THEIR message, read as theirs: an offer to watch
  // an account, never an answer to someone else's prompt.
  assert.deepEqual(texts(h.telegram), ['Watch account <b>#1000</b>?']);
  assert.ok(h.amounts.get(OWNER_ID) !== undefined, 'the owner’s prompt is untouched');
  assert.equal(h.executor.calls.length, 0);
});

test('the owner typing an amount in ANOTHER chat is refused there, and the prompt stays open', async () => {
  const h = harness();
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  h.telegram.calls.length = 0;
  await h.bot.handleUpdate(messageUpdate('1000', { chat: 7_777 }));
  assert.deepEqual(texts(h.telegram), [WRONG_CHAT_TEXT]);
  assert.ok(h.amounts.get(OWNER_ID) !== undefined);
  assert.equal(h.executor.calls.length, 0);
});

// ── retry after reconciliation ──────────────────────────────────────────────

/** Confirm a top-up and return the confirm button's callback data. */
async function confirmedTopUp(h: Harness): Promise<string> {
  const data = await firstButton(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  return keyboardOf(h.telegram.last('sendMessage'))[0]!.callback_data;
}

test('a reconciled not-applied offers Send again, because nothing landed', async () => {
  // The forwarder drops requests: mt: 3 code 0, no mt: 24, no lfr movement. The
  // position was read afterwards and had not moved, so a retry cannot double
  // anything — and a trader whose rescue silently vanished with no way to send it
  // again is worse off than one we never alerted.
  const h = harness();
  h.executor.outcome = {
    kind: 'not-applied',
    detail: 'Nothing was added. I checked the position afterwards and its margin is unchanged.',
  };
  const confirm = await confirmedTopUp(h);
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(confirm));

  const reply = lastScreen(h.telegram);
  assert.match(String(reply.payload['text']), /Nothing was added/);
  const buttons = actionButtons(reply);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0]!.text, 'Send again');
});

test('the Send again button sends the same amount, once, under a NEW key', async () => {
  const h = harness();
  h.executor.outcome = { kind: 'not-applied', detail: 'Nothing was added.' };
  const confirm = await confirmedTopUp(h);
  await h.bot.handleUpdate(callbackUpdate(confirm));
  const retry = actionButtons(lastScreen(h.telegram))[0]!;

  // The retry lands, this time.
  h.executor.outcome = { kind: 'applied', detail: 'Done — the margin is in.' };
  await h.bot.handleUpdate(callbackUpdate(retry.callback_data));

  assert.equal(h.executor.calls.length, 2, 'one original, one retry — not three');
  const [first, second] = h.executor.calls;
  assert.equal(second!.action.amountCNS, first!.action.amountCNS, 'the same amount');
  assert.notEqual(second!.idempotencyKey, first!.idempotencyKey, 'a new action_log row');
  assert.match(shown(h.telegram).at(-1)!, /^✓ <b>Added 562 AUSD to BTC long<\/b>/);
});

test('an unknown outcome gets NO retry button: something may have landed', async () => {
  // The one state where sending again could double it.
  const h = harness();
  h.executor.outcome = {
    kind: 'unknown',
    detail: 'the position left the set, so its margin cannot be compared.',
    nextStep: 'Read the position directly. Do NOT send this action again until you have.',
  };
  const confirm = await confirmedTopUp(h);
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(confirm));

  const reply = lastScreen(h.telegram);
  assert.equal(actionButtons(reply).length, 0, 'no action button at all: navigation only');
  assert.match(String(reply.payload['text']), /Do NOT send this action again/);
});

test('an applied outcome gets no retry button either', async () => {
  const h = harness();
  h.executor.outcome = { kind: 'applied', detail: 'Done — the margin is in.' };
  const confirm = await confirmedTopUp(h);
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(confirm));
  assert.equal(actionButtons(lastScreen(h.telegram)).length, 0);
});

test('a Send again button expires on the same fifteen minutes as every other', async () => {
  // An old retry must not send an amount computed against a mark that has moved.
  const h = harness();
  h.executor.outcome = { kind: 'not-applied', detail: 'Nothing was added.' };
  const confirm = await confirmedTopUp(h);
  await h.bot.handleUpdate(callbackUpdate(confirm));
  const retry = actionButtons(lastScreen(h.telegram))[0]!;

  h.nowMs += 16 * 60_000;
  h.telegram.calls.length = 0;
  await h.bot.handleUpdate(callbackUpdate(retry.callback_data));

  assert.equal(h.executor.calls.length, 1, 'the expired retry must not send');
  assert.match(answers(h.telegram).at(-1)!, /expired/);
});

test('a Send again button is single use, so a double tap cannot send twice', async () => {
  const h = harness();
  h.executor.outcome = { kind: 'not-applied', detail: 'Nothing was added.' };
  const confirm = await confirmedTopUp(h);
  await h.bot.handleUpdate(callbackUpdate(confirm));
  const retry = actionButtons(lastScreen(h.telegram))[0]!;

  // Still not-applied, so the retry itself offers another retry — each one used once.
  await h.bot.handleUpdate(callbackUpdate(retry.callback_data));
  const sendsAfterFirst = h.executor.calls.length;
  await h.bot.handleUpdate(callbackUpdate(retry.callback_data));

  assert.equal(h.executor.calls.length, sendsAfterFirst, 'the second tap on the same button sends nothing');
});

// ── the public watch tier ───────────────────────────────────────────────────

const OWNER_ADDRESS = '0xB7854953A71e45D1033B3d619E76d56391291765';
const STRANGER_CHAT = 7_777;
const stranger = (text: string) => messageUpdate(text, { from: STRANGER_ID, chat: STRANGER_CHAT });

test('a stranger can /watch a checksummed address: it resolves, is stored, and the wallet screen says how current the data is', async () => {
  const h = harness();
  h.resolver.answers.set(OWNER_ADDRESS.toLowerCase(), { accountId: 5293, address: OWNER_ADDRESS.toLowerCase(), resolvedBy: 'chain' });
  await h.bot.handleUpdate(stranger(`/watch ${OWNER_ADDRESS}`));

  assert.deepEqual(h.resolver.asked, [{ kind: 'address', address: OWNER_ADDRESS.toLowerCase() }], 'lowercased before lookup');
  const reply = texts(h.telegram).at(-1)!;
  assert.match(reply, /^Now watching <b>#5293<\/b> \(found through the Exchange contract\)\./);
  assert.match(reply, /No buttons\. You are watching this account, not holding it\./);
  assert.deepEqual(h.watchStore.watchersOf(5293).map((s) => s.chatId), [STRANGER_CHAT]);
  assert.equal(h.telegram.last('sendMessage').payload['parse_mode'], 'HTML');
});

test('THE BUG: /watch with nothing after it ASKS with force_reply, and the "710" sent back is heard', async () => {
  const h = harness();
  h.resolver.answers.set('710', { accountId: 710, address: undefined, resolvedBy: 'index' });
  await h.bot.handleUpdate(stranger('/watch'));
  const ask = h.telegram.last('sendMessage');
  assert.match(String(ask.payload['text']), /^Send me an address or an account id\./);
  assert.deepEqual(ask.payload['reply_markup'], { force_reply: true, input_field_placeholder: '0x… or 710' });

  await h.bot.handleUpdate(stranger('710'));
  assert.match(texts(h.telegram).at(-1)!, /^Now watching <b>#710<\/b>\./);
  assert.deepEqual(h.watchStore.watchersOf(710).map((s) => s.chatId), [STRANGER_CHAT]);
  // The question is closed: the next number is a fresh paste, offered rather than acted on.
  await h.bot.handleUpdate(stranger('711'));
  assert.equal(texts(h.telegram).at(-1), 'Watch account <b>#711</b>?');
});

test('a bad answer re-asks with force_reply and keeps the question open; a good one then lands', async () => {
  const h = harness();
  h.resolver.answers.set('5293', { accountId: 5293, address: undefined, resolvedBy: 'index' });
  await h.bot.handleUpdate(stranger('/watch'));
  await h.bot.handleUpdate(stranger('0x123'));
  assert.match(texts(h.telegram).at(-1)!, /is not a full address/);
  assert.equal((h.telegram.last('sendMessage').payload['reply_markup'] as { force_reply: boolean }).force_reply, true);
  await h.bot.handleUpdate(stranger('999999'));
  assert.match(texts(h.telegram).at(-2)!, /^I cannot watch that: nothing is known about 999999/);
  assert.equal((h.telegram.last('sendMessage').payload['reply_markup'] as { force_reply: boolean }).force_reply, true, 'asked again');
  await h.bot.handleUpdate(stranger('5293'));
  assert.match(texts(h.telegram).at(-1)!, /^Now watching <b>#5293<\/b>/);
});

test('a pasted address is watched without pressing anything first; a bare number is only offered, and the tap watches it', async () => {
  const h = harness();
  h.resolver.answers.set(OWNER_ADDRESS.toLowerCase(), { accountId: 5293, address: OWNER_ADDRESS.toLowerCase(), resolvedBy: 'index' });
  h.resolver.answers.set('710', { accountId: 710, address: undefined, resolvedBy: 'index' });
  await h.bot.handleUpdate(stranger(OWNER_ADDRESS));
  assert.match(texts(h.telegram).at(-1)!, /^Now watching <b>#5293<\/b>/);
  await h.bot.handleUpdate(stranger('710'));
  assert.equal(texts(h.telegram).at(-1), 'Watch account <b>#710</b>?');
  assert.equal(h.watchStore.watchersOf(710).length, 0);
  const offer = keyboardOf(h.telegram.last('sendMessage'))[0]!;
  await h.bot.handleUpdate(callbackUpdate(offer.callback_data, { from: STRANGER_ID, chat: STRANGER_CHAT }));
  assert.match(texts(h.telegram).at(-1)!, /^Now watching <b>#710<\/b>/);
  await h.bot.handleUpdate(stranger('#711'));
  assert.match(texts(h.telegram).at(-1)!, /^I cannot watch that/, 'a #id paste is unambiguous and goes straight to the lookup');
});

test('a stranger navigates the read-only half by buttons: home, Watch a wallet, the list, a wallet, Stop watching', async () => {
  const h = harness();
  h.resolver.answers.set('5293', { accountId: 5293, address: undefined, resolvedBy: 'index' });
  const tap = (route: Route) => h.bot.handleUpdate(callbackUpdate(encodeNav(route), { from: STRANGER_ID, chat: STRANGER_CHAT }));

  await h.bot.handleUpdate(stranger('/start'));
  assert.deepEqual(keyboardOf(h.telegram.last('sendMessage')).map((b) => b.text), ['👁 Watch a wallet', '🔗 Connect my account']);

  await tap({ to: 'watch-ask' });
  const edit = h.telegram.last('editMessageText');
  assert.match(String(edit.payload['text']), /^Send me an address or an account id\./);
  assert.equal((h.telegram.last('sendMessage').payload['reply_markup'] as { force_reply: boolean }).force_reply, true);
  await h.bot.handleUpdate(stranger('5293'));
  assert.match(texts(h.telegram).at(-1)!, /^Now watching <b>#5293<\/b>/);

  await tap({ to: 'watchlist' });
  const list = String(h.telegram.last('editMessageText').payload['text']);
  assert.match(list, /^<b>Watching 1 wallet<\/b> · 1 of 5/);
  assert.match(list, /The percentage is how far the price can move against them before the exchange closes it\./);

  await tap({ to: 'wallet', accountId: 5293 });
  assert.match(String(h.telegram.last('editMessageText').payload['text']), /<b>Account #5293<\/b>/);

  await tap({ to: 'unwatch', accountId: 5293 });
  assert.match(String(h.telegram.last('editMessageText').payload['text']), /^Stopped watching <b>#5293<\/b>\.[\s\S]*You are not watching anything yet\./);
  assert.equal(h.watchStore.watchersOf(5293).length, 0);
  assert.equal(h.executor.calls.length, 0);
});

test('SERVER-SIDE: a stranger tapping an ACCOUNT route, or a crafted nav payload, is refused at the gate', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  for (const route of [{ to: 'positions' }, { to: 'position', marketId: 1 }, { to: 'settings' }, { to: 'disconnect' }] as const) {
    await h.bot.handleUpdate(callbackUpdate(encodeNav(route as Route), { from: STRANGER_ID, chat: STRANGER_CHAT }));
  }
  for (const crafted of ['n1:zz', 'n1:w:abc', 'n1:h:1', 'n2:h', 'n1:p:5']) {
    await h.bot.handleUpdate(callbackUpdate(crafted, { from: STRANGER_ID, chat: STRANGER_CHAT }));
  }
  assert.deepEqual(answers(h.telegram), Array(9).fill(REFUSAL_TEXT));
  assert.deepEqual(texts(h.telegram), [], 'no screen of the owner\u2019s account leaked');
  assert.equal(h.executor.calls.length, 0);
});

test('the owner in ANOTHER chat sees only public screens there: home never shows their account in that room', async () => {
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('/start', { chat: 7_777 }));
  assert.match(texts(h.telegram).at(-1)!, /🛡 No account connected/);
  await h.bot.handleUpdate(callbackUpdate(encodeNav({ to: 'positions' }), { chat: 7_777 }));
  assert.deepEqual(answers(h.telegram), [WRONG_CHAT_TEXT]);
});

test('an address nobody can place is refused with the resolver\u2019s reason, and nothing is stored', async () => {
  const h = harness();
  await h.bot.handleUpdate(stranger(`/watch ${OWNER_ADDRESS}`));
  assert.match(texts(h.telegram).at(-1)!, /^I cannot watch that: nothing is known about/);
  assert.deepEqual(h.watchStore.accountIds(), []);
});

test('a chat is capped at its number of watched accounts', async () => {
  const h = harness({ maxPerChat: 2 });
  for (const id of ['1', '2', '3']) h.resolver.answers.set(id, { accountId: Number(id), address: undefined, resolvedBy: 'index' });
  await h.bot.handleUpdate(stranger('/watch 1'));
  await h.bot.handleUpdate(stranger('/watch 2'));
  await h.bot.handleUpdate(stranger('/watch 3'));
  assert.match(texts(h.telegram).at(-1)!, /already watches 2 accounts, which is the limit/);
  assert.deepEqual(h.watchStore.accountIds(), [1, 2]);
});

test('a chat that sends too many public commands is told to slow down, with a wait', async () => {
  const h = harness({ rateLimit: 2 });
  await h.bot.handleUpdate(stranger('/start'));
  await h.bot.handleUpdate(stranger('/start'));
  await h.bot.handleUpdate(stranger('/start'));
  assert.match(texts(h.telegram).at(-1)!, /^Slow down: too many commands from this chat\. Try again in \d+s\./);
  // Another chat is not affected.
  await h.bot.handleUpdate(messageUpdate('/start', { from: 8_888, chat: 8_888 }));
  assert.match(texts(h.telegram).at(-1)!, /Not watching anything yet/);
});

test('/start never points at the old Protect page, and /help names the menu and /watch', async () => {
  const h = harness();
  await h.bot.handleUpdate(stranger('/start'));
  assert.doesNotMatch(texts(h.telegram).at(-1)!, /\/web|Protect/);
  assert.doesNotMatch(HELP_TEXT, /\/web|Protect page|\/unwatch|\/watching/);
  assert.match(HELP_TEXT, /\/watch <0x address or account id>/);
  assert.match(HELP_TEXT, /send \/start for the menu/);
});

test('SERVER-SIDE: an unlinked chat sending a hand-crafted action payload is refused before any handler, and the executor is never called', async () => {
  // The watcher's alert carries no keyboard, but a keyboard is only a hint:
  // callback data is a string anyone can send. Build a VALID payload — a real
  // token the owner's store issued — and send it from a chat that is not linked.
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  const live = actionButtons(await openPosition(h))[0]!;
  const decoded = decodeCallback(live.callback_data);
  assert.ok(decoded.ok);
  const crafted = encodeCallback({ ...decoded.payload, kind: 'confirm' });
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(crafted, { from: STRANGER_ID, chat: STRANGER_CHAT }));

  assert.deepEqual(answers(h.telegram), [REFUSAL_TEXT], 'answered, with the flat refusal');
  assert.equal(h.executor.calls.length, 0, 'the executor was never reached');
  assert.deepEqual(texts(h.telegram), [], 'no confirmation screen, no outcome');
  assert.notEqual(h.store.get(decoded.payload.token), undefined, 'the owner\u2019s token is untouched');
  // And the same from a chat that merely watches the account: watching grants nothing.
  h.resolver.answers.set('5293', { accountId: 5293, address: undefined, resolvedBy: 'index' });
  await h.bot.handleUpdate(stranger('/watch 5293'));
  h.telegram.calls.length = 0;
  await h.bot.handleUpdate(callbackUpdate(crafted, { from: STRANGER_ID, chat: STRANGER_CHAT }));
  assert.deepEqual(answers(h.telegram), [REFUSAL_TEXT]);
  assert.equal(h.executor.calls.length, 0);
});

test('without a watch tier wired, the public commands say so instead of failing', async () => {
  const h = harness({ watch: false });
  await h.bot.handleUpdate(stranger('/watch 710'));
  assert.match(texts(h.telegram).at(-1)!, /not available on this deployment/);
});

// ── linking: /link and /unlink ──────────────────────────────────────────────

/** A fake link service: records who asked, hands out a URL, and can be told a link needs renewing. */
function fakeLinkService() {
  const minted: string[] = [];
  const unlinked: string[] = [];
  let relink: string | undefined;
  return {
    minted,
    unlinked,
    setRelink: (reason: string | undefined) => {
      relink = reason;
    },
    service: {
      mint: (userId: string) => {
        minted.push(userId);
        return { code: 'ABCD-EFGH', url: 'https://perpguard.example/link?code=ABCD-EFGH', expiresAtMs: 1_000_000 + 5 * 60_000 };
      },
      unlink: async (userId: string) => {
        unlinked.push(userId);
        return { ok: true, text: `Unlinked from account 710. The session is closed.` };
      },
      needsRelink: (_userId: string) => relink,
    },
  };
}

test('/link from a stranger registers an identity and replies with a one-time URL that says it proves nothing by itself', async () => {
  const fake = fakeLinkService();
  const h = harness({ links: new InMemoryLinkStore({ capacity: 2 }), link: fake.service });
  await h.bot.handleUpdate(messageUpdate('/link', { from: STRANGER_ID, chat: 7_777 }));
  const reply = texts(h.telegram).at(-1)!;
  assert.match(reply, /https:\/\/perpguard\.example\/link\?code=ABCD-EFGH/);
  assert.match(reply, /works once, for 5 minutes, and it proves nothing by itself/);
  assert.match(reply, /Never paste a key here in Telegram/);
  assert.deepEqual(fake.minted, ['tg:6060'], 'minted for the Telegram identity, not a slot');
  assert.equal(h.links.byTelegramUserId(STRANGER_ID), undefined, 'minting links nothing');
  const call = h.telegram.of('sendMessage').at(-1)!;
  assert.equal((call.payload['link_preview_options'] as { is_disabled: boolean }).is_disabled, true);
});

test('/link without a link service says so instead of pretending', async () => {
  const h = harness({ links: new InMemoryLinkStore({ capacity: 2 }) });
  await h.bot.handleUpdate(messageUpdate('/link', { from: STRANGER_ID, chat: 7_777 }));
  assert.equal(texts(h.telegram).at(-1), 'Linking is not available on this deployment.');
});

test('Settings → Disconnect asks first, then calls the link service for that user and shows home', async () => {
  const fake = fakeLinkService();
  const h = harness({ link: fake.service });
  await tapNav(h, { to: 'settings' });
  const settings = lastScreen(h.telegram);
  assert.deepEqual(keyboardOf(settings).map((b) => b.text), ['⚠️ Warn me at: Normal (8%)', '🔗 Disconnect account #710', '← Back']);
  await tapNav(h, { to: 'disconnect-ask' });
  assert.match(shown(h.telegram).at(-1)!, /^<b>Disconnect account #710\?<\/b>/);
  assert.deepEqual(fake.unlinked, [], 'asking is not doing');
  await tapNav(h, { to: 'disconnect' });
  assert.deepEqual(fake.unlinked, [USER_ID]);
  assert.match(shown(h.telegram).at(-1)!, /^Unlinked from account 710\./);
  // A stranger cannot reach it at all.
  await tapNav(h, { to: 'disconnect' }, { from: STRANGER_ID, chat: 7_777 });
  assert.equal(answers(h.telegram).at(-1), REFUSAL_TEXT);
  assert.deepEqual(fake.unlinked, [USER_ID]);
});

test('Warn me at: three choices, the current one marked, a tap saves it and the label follows', async () => {
  const saved: Array<[number, string]> = [];
  const settings = new InMemoryAccountSettingsStore({ onChange: (id, v) => saved.push([id, v.warnLevel]) });
  const h = harness({ settings });
  await tapNav(h, { to: 'warn-ask' });
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), [
    'Early · 10% — most time to react',
    'Normal · 8% — currently set',
    'Last minute · 3% — fewest messages',
    '← Back',
  ]);
  await tapNav(h, { to: 'warn-set', level: 0 });
  assert.deepEqual(saved, [[710, 'early']]);
  assert.equal(keyboardOf(lastScreen(h.telegram))[0]!.text, '⚠️ Warn me at: Early (10%)');
  await tapNav(h, { to: 'warn-set', level: 9 });
  assert.match(answers(h.telegram).at(-1)!, /do not know that setting/);
  assert.deepEqual(saved, [[710, 'early']]);
});

test('the kill switch needs the nonce it just showed: a crafted or replayed kill-go fires nothing', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  let fired = 0;
  h.killSwitch = async () => {
    fired += 1;
    return { closed: ['BTC long'], stillOpen: [], unresolved: [], notPriceable: [] };
  };
  await tapNav(h, { to: 'kill-go', nonce: 123_456 });
  assert.match(answers(h.telegram).at(-1)!, /has expired\. Nothing was sent/);
  await tapNav(h, { to: 'kill-ask' });
  const ask = lastScreen(h.telegram);
  assert.match(String(ask.payload['text']), /^<b>Close all 1 position on account #710\?<\/b>/);
  const go = keyboardOf(ask)[0]!;
  assert.equal(go.text, '⛔ Close all 1');
  await h.bot.handleUpdate(callbackUpdate(go.callback_data));
  assert.equal(fired, 1);
  assert.match(shown(h.telegram).at(-1)!, /^✓ <b>Closed all 1 position<\/b>: BTC long\./);
  await h.bot.handleUpdate(callbackUpdate(go.callback_data));
  assert.equal(fired, 1, 'single use');
  // A stranger tapping the same payload is refused at the gate.
  await h.bot.handleUpdate(callbackUpdate(go.callback_data, { from: STRANGER_ID, chat: 7_777 }));
  assert.equal(answers(h.telegram).at(-1), REFUSAL_TEXT);
  assert.equal(fired, 1);
});

test('reduce says the closing price does not move; close says it closes the whole position; Cancel deletes the token', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  const buttons = actionButtons(await openPosition(h));
  const reduce = buttons.find((b) => b.text === 'Reduce 25%')!;
  await h.bot.handleUpdate(callbackUpdate(reduce.callback_data));
  const reduceAsk = texts(h.telegram).at(-1)!;
  assert.match(reduceAsk, /^<b>Reduce BTC long by 25% \([\d.]+ BTC\)\?<\/b>/);
  assert.match(reduceAsk, /The closing price stays at 81,770\.1: Perpl releases margin in proportion/);
  const [send, cancel] = keyboardOf(h.telegram.last('sendMessage'));
  const token = decodeCallback(cancel!.callback_data);
  assert.ok(token.ok && token.payload.kind === 'cancel');
  await h.bot.handleUpdate(callbackUpdate(cancel!.callback_data));
  assert.equal(h.store.get(token.payload.token), undefined, 'cancel deletes the token');
  await h.bot.handleUpdate(callbackUpdate(send!.callback_data));
  assert.equal(h.executor.calls.length, 0, 'a cancelled Send can never fire');

  const close = actionButtons(await openPosition(h)).find((b) => b.text === 'Close position')!;
  await h.bot.handleUpdate(callbackUpdate(close.callback_data));
  assert.match(texts(h.telegram).at(-1)!, /^<b>Close BTC long\?<\/b>\nThe whole position closes at the market price\./);
  await h.bot.handleUpdate(callbackUpdate(keyboardOf(h.telegram.last('sendMessage'))[0]!.callback_data));
  assert.equal(h.executor.calls.length, 1);
  assert.equal(h.executor.calls[0]!.action.type, 'close-position');
  assert.equal(h.executor.calls[0]!.action.amountCNS, 0n);
});

test('a linked user whose key needs renewing is told to /link again on every gated command and every tap, until it is renewed', async () => {
  const fake = fakeLinkService();
  const h = harness({ link: fake.service });
  h.view.assessments = [dangerAssessment()];
  fake.setRelink('the environment key was rotated');

  await tapNav(h, { to: 'positions' });
  assert.match(answers(h.telegram).at(-1)!, /^Your link to account 710 needs renewing: the environment key was rotated\. Send \/link to do that\.$/);
  await tapNav(h, { to: 'settings' });
  assert.match(answers(h.telegram).at(-1)!, /needs renewing/);

  // A tap on a real button is refused at tap time, before any executor call.
  fake.setRelink(undefined);
  const data = actionButtons(await openPosition(h))[0]!;
  fake.setRelink('the environment key was rotated');
  await h.bot.handleUpdate(callbackUpdate(data.callback_data));
  assert.match(answers(h.telegram).at(-1)!, /needs renewing/);
  assert.equal(h.executor.calls.length, 0);

  // Renewed: the same screens work again, with no restart.
  fake.setRelink(undefined);
  await tapNav(h, { to: 'positions' });
  assert.match(shown(h.telegram).at(-1)!, /^<b>Account #710<\/b> · 1 open/);
});

test('a URL button Telegram refuses does not lose the screen: it goes out again without that button', async () => {
  const h = harness();
  // Telegram's answer to an inline URL it will not open.
  h.telegram.reply(FakeTelegram.error(400, 'Bad Request: BUTTON_URL_INVALID'));
  await h.bot.handleUpdate(stranger('/start'));
  const sends = h.telegram.of('sendMessage');
  assert.equal(sends.length, 2, 'refused once, then sent');
  assert.match(String(sends[1]!.payload['text']), /Watch any Perpl trader/);
});

test('navigating on from an outcome opens a new message: the outcome stays in the chat as the record', async () => {
  const h = harness();
  h.executor.outcome = { kind: 'applied', detail: 'Done — the margin is in.' };
  const confirm = await confirmedTopUp(h);
  await h.bot.handleUpdate(callbackUpdate(confirm));
  const outcome = lastScreen(h.telegram);
  assert.match(String(outcome.payload['text']), /^✓ <b>Added 562 AUSD to BTC long<\/b>/);
  const myPositions = keyboardOf(outcome).find((b) => b.text === '🛡 My positions')!;
  const edits = h.telegram.of('editMessageText').length;
  await h.bot.handleUpdate(callbackUpdate(myPositions.callback_data));
  assert.equal(h.telegram.of('editMessageText').length, edits, 'nothing edited');
  assert.match(String(h.telegram.last('sendMessage').payload['text']), /^<b>Account #710<\/b>/);
});
