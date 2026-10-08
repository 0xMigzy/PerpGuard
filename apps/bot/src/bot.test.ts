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
import { StaticSessionRouter } from './sessions.ts';
import { InMemoryPreferenceStore } from '@perpguard/backend/events/preferences';
import type { TraderRow } from '@perpguard/shared';
import {
  CONFIGS,
  FakeBalance,
  FakeExecutor,
  FakeTelegram,
  FakeView,
  OWNER_ACCOUNT,
  OWNER_CHAT,
  OWNER_ID,
  OWNER_LINK,
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
  readonly prefs: InMemoryPreferenceStore;
  readonly resolver: FakeResolver;
  nowMs: number;
  /** What the owner's session reports about its trading socket. */
  sessionStatus: { trading: { state: string; forwardingAllowed?: boolean }; mismatch?: string } | undefined;
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

/** Two traders the index "knows": #987 (big, lifetime ROI) and #1876 (under the ROI floor). */
const traderRow = (over: Partial<TraderRow>): TraderRow => ({
  accountId: 987, address: '0xabc', netPnlAusd: 21_147.9, volumeAusd: 1, tradeCount: 1_240, roundTrips: 24_944, wins: 17_960, losses: 6_984, winRate: 0.72,
  liquidationCount: 0, rescuableLiquidationCount: 0, marginLostAusd: 0, maxSpareHeldAusd: undefined, depositedAusd: 2_045, withdrawnAusd: 0, netFlowAusd: 0,
  freeBalanceAusd: 0, openPositionCount: 2, lastActiveAtMs: 0, roiPct: 1_034.1, ...over,
});
const fakeTraders = {
  top: async (kind: 'pnl' | 'roi') => ({ rows: kind === 'pnl' ? [traderRow({ roiPct: undefined })] : [traderRow({})], label: kind === 'pnl' ? 'the 31 UTC days from 2026-09-06' : 'since Feb 11, 2026' }),
  stats: async (accountId: number) =>
    accountId === 1876
      ? { accountId, month: traderRow({ accountId, roundTrips: 4, wins: 3, winRate: undefined, roiPct: undefined }), lifetime: traderRow({ accountId, depositedAusd: 99, roiPct: undefined }) }
      : { accountId, month: traderRow({ accountId, roiPct: undefined }), lifetime: traderRow({ accountId }) },
};

function harness(options: { readonly links?: InMemoryLinkStore; readonly watch?: boolean; readonly maxPerChat?: number; readonly rateLimit?: number; readonly owner?: number; readonly link?: NonNullable<Parameters<typeof createBot>[0]['link']>; readonly settings?: InMemoryAccountSettingsStore; readonly rescue?: RescueControl; readonly killSwitch?: KillSwitchControl; readonly emergency?: EmergencyControl } = {}): Harness {
  const { bot, telegram } = fakeBot();
  const executor = new FakeExecutor();
  const view = new FakeView();
  const balance = new FakeBalance();
  const links = options.links ?? newLinks();
  const state: { nowMs: number; sessionStatus: Harness['sessionStatus'] } = { nowMs: 1_000_000, sessionStatus: { trading: { state: 'signed-in', forwardingAllowed: true } } };
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
  const prefs = new InMemoryPreferenceStore();

  const built = createBot({
    config: { token: TEST_TOKEN, userId: USER_ID, ownerTelegramUserId: options.owner },
    links,
    store,
    amounts,
    sessions: new StaticSessionRouter([{ accountId: OWNER_ACCOUNT, view, executor, balance, status: () => state.sessionStatus }]),
    tradingNetwork: 'testnet',
    webUrl: 'https://perpguard.example',
    ownerAccountId: OWNER_ACCOUNT,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.rescue === undefined ? {} : { rescue: options.rescue }),
    ...(options.killSwitch === undefined ? {} : { killSwitch: options.killSwitch }),
    ...(options.emergency === undefined ? {} : { emergency: options.emergency }),
    configs: CONFIGS,
    now: () => state.nowMs,
    botInfo: bot.botInfo,
    ...(options.watch === false ? {} : { watch: { store: watchStore, resolver, limiter, indexerHealth: () => indexer, preferences: prefs, traders: fakeTraders } }),
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
    prefs,
    get nowMs() {
      return state.nowMs;
    },
    set nowMs(value: number) {
      state.nowMs = value;
    },
    get sessionStatus() {
      return state.sessionStatus;
    },
    set sessionStatus(value: Harness['sessionStatus']) {
      state.sessionStatus = value;
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
  assert.match(sent.at(-1)!, new RegExp(`🔗 ${h.view.network} #710\nExecution: `), 'the home screen shows the account and its OWN session\'s network');
  assert.equal(h.links.byTelegramUserId(OWNER_ID)?.chatId, OWNER_CHAT);
  assert.equal(h.links.byTelegramUserId(OWNER_ID)?.accountId, OWNER_ACCOUNT);

  // And now the same screens work.
  await tapNav(h, { to: 'positions' });
  assert.match(shown(h.telegram).at(-1)!, /^📊 <b>MY POSITIONS<\/b> · testnet #710\nFree balance <b>10,000 AUSD<\/b> · unrealised −\d+ AUSD\nAlerting you at 5% from liquidation$/);

  // A stranger's /start is an identity and the first-run home screen, not a link and not a refusal.
  await h.bot.handleUpdate(messageUpdate('/start', { from: STRANGER_ID, chat: 7_777 }));
  const hello = texts(h.telegram).at(-1)!;
  assert.match(hello, /^🛡 <b>PERPGUARD<\/b>\n\nI message you before a Perpl position gets liquidated\./);
  assert.deepEqual(keyboardOf(h.telegram.last('sendMessage')).map((b) => b.text), ['👁 Watch & Alerts', '🔐 Trading account']);
  assert.equal(h.links.byTelegramUserId(STRANGER_ID), undefined);
  assert.equal(h.links.byUserId(USER_ID)?.telegramUserId, OWNER_ID);
});

test('with no owner configured, /start links NOBODY: a public bot has no first-come acting slot', async () => {
  const h = harness({ links: new InMemoryLinkStore({ capacity: 1 }) });
  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.match(texts(h.telegram).at(-1)!, /Send me any address or account number to start watching it/, 'the intro, not an account');
  assert.doesNotMatch(texts(h.telegram).at(-1)!, /🔗 \w+ #/);
  assert.equal(h.links.list().length, 0, 'the first person to arrive does not become the owner');
});

test('/start from the already-linked user is idempotent', async () => {
  const h = harness();
  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.match(texts(h.telegram).at(-1)!, /🔗 \w+ #710/);
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

test('My positions lists each position closest first as a button; its screen offers the amounts, a custom amount, Close position and Back — never reduce', async () => {
  const h = harness();
  const scenario = dangerScenario();
  h.view.assessments = [scenario.assessment];
  h.view.loop = scenario.loop;

  await tapNav(h, { to: 'positions' });
  const list = lastScreen(h.telegram);
  assert.match(String(list.payload['text']), /^📊 <b>MY POSITIONS<\/b> · testnet #710\nFree balance <b>10,000 AUSD<\/b> · unrealised −\d+ AUSD\nAlerting you at 5% from liquidation$/);
  assert.deepEqual(keyboardOf(list).map((b) => b.text), ['🔴 BTC long · 2.7% · −12 AUSD', '← Back']);

  const screen = await openPosition(h);
  const html = String(screen.payload['text']);
  assert.equal(html, 'testnet\n🔴 <b>BTC long · 2.7% from liquidation</b>\nMargin <b>2,810 AUSD</b> · liquidation at 81,770.1\nFree balance <b>10,000 AUSD</b> · unrealised −12 AUSD');
  assert.ok(!html.includes('Changed from'), 'a view, not an alert');
  assert.deepEqual(
    actionButtons(screen).map((b) => {
      const decoded = decodeCallback(b.callback_data);
      return decoded.ok ? [decoded.payload.kind, decoded.payload.amountCNS] : undefined;
    }),
    // The three amounts and the custom marker, which carries no money.
    [['act', 100_000_000n], ['act', 250_000_000n], ['act', 500_000_000n], ['custom', 0n]],
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
  assert.match(text, /I haven't been told what's open yet, so this may not be empty/);
  assert.match(text, /I cannot see your positions right now/);
  assert.doesNotMatch(text, /No open positions/);
});

test('a position on a market with no config is listed, and its screen says why it cannot be priced', async () => {
  const h = harness();
  h.view.assessments = [{ ...dangerAssessment(), marketId: 4_242, symbol: 'TAO' }];
  await tapNav(h, { to: 'positions' });
  assert.ok(keyboardOf(lastScreen(h.telegram)).some((b) => b.text.startsWith('🔴 TAO long')));
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
  // The loop behind the sample position, so View position prices its amounts through the real engine.
  const scenario = dangerScenario();
  h.view.assessments = [scenario.assessment];
  h.view.loop = scenario.loop;
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
  // The before AND after, for margin, liquidation price, distance and free balance.
  assert.equal(
    confirmation,
    [
      'testnet',
      '⚠️ <b>Add 100 AUSD to BTC long?</b>',
      '',
      'Margin: <b>2,810 AUSD</b> → <b>2,910 AUSD</b>',
      'Liquidation price: 81,770.1 → 81,570.1',
      'Distance: 2.7% → <b>2.9%</b>',
      'Free balance: <b>10,000 AUSD</b> → <b>9,900 AUSD</b>',
      '',
      "<i>I send exactly this amount, then check the position itself — not just the exchange's reply — and tell you what happened.</i>",
      '',
      'Nothing has been sent yet.',
    ].join('\n'),
  );
  assert.deepEqual(keyboardOf(h.telegram.last('sendMessage')).map((b) => b.text), ['✅ Confirm', 'Cancel']);
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
  assert.equal(decoded.payload.amountCNS, 100_000_000n);
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
  assert.equal(request.action.amountCNS, 100_000_000n);
  assert.equal(request.action.label, 'Add 100 → buffer 2.9%, liquidation 81,570.1');
  assert.equal(request.action.positionId, 4_242);
  assert.match(request.idempotencyKey, new RegExp(`^${USER_ID}:1:custom:`));

  // Nothing claims success. The confirmation became the progress line, then the outcome.
  assert.match(shown(h.telegram).at(-2)!, /^testnet\nAdding the margin… I'll check the position itself afterwards/);
  const reply = shown(h.telegram).at(-1)!;
  assert.match(reply, /^testnet\n<b>Not sent\.<\/b>/);
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
  const custom = keyboardOf(await openPosition(h)).find((b) => b.text === CUSTOM_BUTTON_LABEL);
  assert.ok(custom !== undefined, 'expected a 🎛 Custom amount button');
  return custom.callback_data;
}

/** Tap Custom amount, then reply with `amount`. Returns the last message sent. */
async function typeAmount(h: Harness, amount: string): Promise<string> {
  const data = await customTap(h);
  await h.bot.handleUpdate(callbackUpdate(data));
  await h.bot.handleUpdate(messageUpdate(amount));
  return texts(h.telegram).at(-1)!;
}

test('the position screen offers 🎛 Custom amount below the amounts, never instead of them', async () => {
  const h = harness();
  await customTap(h);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text).slice(0, 4), ['+100 → 2.9%', '+250 → 3.2%', '+500 → 3.8%', '🎛 Custom amount']);
});

test('tapping Custom amount asks for a figure and states where the position stands', async () => {
  const h = harness();
  const data = await customTap(h);
  h.telegram.calls.length = 0;

  await h.bot.handleUpdate(callbackUpdate(data));

  const prompt = texts(h.telegram).at(-1)!;
  assert.equal(
    prompt,
    "How much to add to BTC long? It's 2.7% from liquidation, with 10,000 AUSD free.\nReply with an amount, like 250.",
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
      'testnet',
      '⚠️ <b>Add 1,000 AUSD to BTC long?</b>',
      '',
      'Margin: <b>2,810 AUSD</b> → <b>3,810 AUSD</b>',
      'Liquidation price: 81,770.1 → 79,770.1',
      'Distance: 2.7% → <b>5.0%</b>',
      'Free balance: <b>10,000 AUSD</b> → <b>9,000 AUSD</b>',
      '',
      "<i>I send exactly this amount, then check the position itself — not just the exchange's reply — and tell you what happened.</i>",
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
    assert.equal(lines[0], 'testnet', 'an action screen names its network first');
    assert.match(lines[1]!, /^⚠️ <b>Add [\d,.]+ AUSD to BTC long\?<\/b>$/);
    assert.match(lines[3]!, /^Margin: <b>[\d,]+ AUSD<\/b> → <b>[\d,]+ AUSD<\/b>$/);
    assert.match(lines[4]!, /^Liquidation price: [\d,.]+ → [\d,.]+$/);
    assert.match(lines[5]!, /^Distance: \d+\.\d% → <b>\d+\.\d%<\/b>$/);
    assert.match(lines[6]!, /^Free balance: <b>[\d,]+ AUSD<\/b> → <b>[\d,]+ AUSD<\/b>$/);
    assert.equal(lines.at(-1), 'Nothing has been sent yet.');
  }
  // Only the figures differ.
  assert.notEqual(customLines[1], computedLines[1]);
});

test('confirming a custom amount sends exactly the figure that was shown', async () => {
  const h = harness();
  await typeAmount(h, '1000.5');
  const confirm = keyboardOf(h.telegram.last('sendMessage'))[0]!;
  assert.equal(confirm.text, '✅ Confirm');
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
  assert.match(shown(h.telegram).at(-1)!, /^testnet\n<b>Not sent\.<\/b>/);
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
  assert.match(texts(h.telegram).at(-1)!, /^⚠️ <b>Add 1,000 AUSD to BTC long\?<\/b>$/m);
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
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, '✅ Confirm');
  // And the warning sits above the last line, which stays the last line.
  assert.match(confirmation, /Nothing has been sent yet\.$/);
});

test('an unknown balance says so instead of implying it was checked', async () => {
  const h = harness();
  h.balance.reading = { known: false, reason: 'I am not signed in to the trading account.' };
  const confirmation = await typeAmount(h, '1000');
  assert.match(confirmation, /could not check your free balance: I am not signed in/);
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, '✅ Confirm');
});

test('an implausibly large amount asks whether it was meant, rather than refusing it', async () => {
  const h = harness();
  h.balance.reading = { known: true, floorCNS: 10n ** 15n };
  const confirmation = await typeAmount(h, '500000');

  assert.match(confirmation, /more than 10x this position's whole size at the mark \(42,003\.65 AUSD\)/);
  assert.match(confirmation, /Confirm only if you meant it/);
  assert.equal(keyboardOf(h.telegram.last('sendMessage'))[0]?.text, '✅ Confirm');
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
  assert.match(texts(h.telegram).at(-1)!, /^I didn't catch that\./);
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
  assert.match(shown(h.telegram).at(-1)!, /^testnet\n✓ <b>Added 100 AUSD to BTC long<\/b>/);
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
  assert.match(reply, /^✅ <b>WALLET ADDED<\/b> · #5293 \(found through the Exchange contract\)/);
  assert.match(reply, /From the mainnet index, re-read every 30 seconds/);
  assert.match(reply, /Watching only — nothing here to press\./);
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
  assert.match(texts(h.telegram).at(-1)!, /^✅ <b>WALLET ADDED<\/b> · #710/);
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
  assert.match(texts(h.telegram).at(-1)!, /^✅ <b>WALLET ADDED<\/b> · #5293/);
});

test('a pasted address is watched without pressing anything first; a bare number is only offered, and the tap watches it', async () => {
  const h = harness();
  h.resolver.answers.set(OWNER_ADDRESS.toLowerCase(), { accountId: 5293, address: OWNER_ADDRESS.toLowerCase(), resolvedBy: 'index' });
  h.resolver.answers.set('710', { accountId: 710, address: undefined, resolvedBy: 'index' });
  await h.bot.handleUpdate(stranger(OWNER_ADDRESS));
  assert.match(texts(h.telegram).at(-1)!, /^✅ <b>WALLET ADDED<\/b> · #5293/);
  await h.bot.handleUpdate(stranger('710'));
  assert.equal(texts(h.telegram).at(-1), 'Watch account <b>#710</b>?');
  assert.equal(h.watchStore.watchersOf(710).length, 0);
  const offer = keyboardOf(h.telegram.last('sendMessage'))[0]!;
  await h.bot.handleUpdate(callbackUpdate(offer.callback_data, { from: STRANGER_ID, chat: STRANGER_CHAT }));
  assert.match(texts(h.telegram).at(-1)!, /^✅ <b>WALLET ADDED<\/b> · #710/);
  await h.bot.handleUpdate(stranger('#711'));
  assert.match(texts(h.telegram).at(-1)!, /^I cannot watch that/, 'a #id paste is unambiguous and goes straight to the lookup');
});

test('a stranger navigates the read-only half by buttons: home, Watch & Alerts, Watch Wallet, the list, a wallet, Stop watching', async () => {
  const h = harness();
  h.resolver.answers.set('5293', { accountId: 5293, address: undefined, resolvedBy: 'index' });
  const tap = (route: Route) => h.bot.handleUpdate(callbackUpdate(encodeNav(route), { from: STRANGER_ID, chat: STRANGER_CHAT }));

  await h.bot.handleUpdate(stranger('/start'));
  assert.deepEqual(keyboardOf(h.telegram.last('sendMessage')).map((b) => b.text), ['👁 Watch & Alerts', '🔐 Trading account']);

  await tap({ to: 'watch-menu' });
  const menu = h.telegram.last('editMessageText');
  assert.match(String(menu.payload['text']), /^👁 <b>WATCH & ALERTS<\/b>\nRead-only\. No wallet, no key\./);
  assert.match(String(menu.payload['text']), /Read off the mainnet index, 7 blocks behind the chain\. Watched wallets are re-read every 30 seconds\./, 'the menu states its own latency');
  assert.deepEqual(keyboardOf(menu).map((b) => b.text), ['👛 Watch wallet', '⭐ Watchlist', '💥 Liquidations', '🐋 Large trades', '⚠️ Warning levels', '⚙️ Alert settings', '← Back']);

  await tap({ to: 'watch-ask' });
  const edit = h.telegram.last('editMessageText');
  assert.match(String(edit.payload['text']), /^Send me an address or an account id\./);
  assert.equal((h.telegram.last('sendMessage').payload['reply_markup'] as { force_reply: boolean }).force_reply, true);
  await h.bot.handleUpdate(stranger('5293'));
  assert.match(texts(h.telegram).at(-1)!, /^✅ <b>WALLET ADDED<\/b> · #5293/);

  await tap({ to: 'wallets' });
  const list = String(h.telegram.last('editMessageText').payload['text']);
  assert.match(list, /^👛 <b>WATCHED WALLETS<\/b> · 1 of 5/);
  assert.match(list, /The percentage is how far the price can move against them before the exchange closes it\./);

  await tap({ to: 'wallet', accountId: 5293 });
  const wallet = h.telegram.last('editMessageText');
  assert.match(String(wallet.payload['text']), /👁 <b>mainnet #5293<\/b>[\s\S]*Watching only — nothing here to press\./);
  assert.deepEqual(keyboardOf(wallet).map((b) => b.text), ['🗑 Stop watching', '← Back']);

  await tap({ to: 'unwatch', accountId: 5293 });
  assert.match(String(h.telegram.last('editMessageText').payload['text']), /^Stopped watching <b>#5293<\/b>\.[\s\S]*👛 <b>WATCHED WALLETS<\/b>\nNone yet\./);
  assert.equal(h.watchStore.watchersOf(5293).length, 0);
  assert.equal(h.executor.calls.length, 0);
});

test('SERVER-SIDE: a stranger tapping an ACCOUNT route, or a crafted nav payload, is refused at the gate', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  for (const route of [{ to: 'positions' }, { to: 'position', marketId: 1 }, { to: 'settings' }, { to: 'warn-ask' }] as const) {
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
  assert.match(texts(h.telegram).at(-1)!, /Send me any address or account number/);
  assert.doesNotMatch(texts(h.telegram).at(-1)!, /#710/);
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
  assert.match(texts(h.telegram).at(-1)!, /You're watching 2 wallets, the most I can watch for one chat\./);
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
  assert.match(texts(h.telegram).at(-1)!, /I message you before a Perpl position gets liquidated/);
});

test('/start never points at the old Protect page, and /help names the menu and /watch', async () => {
  const h = harness();
  await h.bot.handleUpdate(stranger('/start'));
  assert.doesNotMatch(texts(h.telegram).at(-1)!, /\/web|Protect/);
  assert.doesNotMatch(HELP_TEXT, /\/web|Protect page|\/unwatch|\/watching/);
  assert.match(HELP_TEXT, /use \/watch/);
  assert.match(HELP_TEXT, /Send \/start for the menu/);
  assert.doesNotMatch(HELP_TEXT, /Margin goes|reducing or closing|Analyse/, 'nothing from the old menu');
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

test('/link from a stranger registers an identity and replies with a one-time URL, and never asks for a key here', async () => {
  const fake = fakeLinkService();
  const h = harness({ links: new InMemoryLinkStore({ capacity: 2 }), link: fake.service });
  await h.bot.handleUpdate(messageUpdate('/link', { from: STRANGER_ID, chat: 7_777 }));
  const reply = texts(h.telegram).at(-1)!;
  assert.match(reply, /https:\/\/perpguard\.example\/link\?code=ABCD-EFGH/);
  assert.match(reply, /works once, for 5 minutes/);
  assert.match(reply, /Never paste a key here\./);
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

test('Trading Account → Disconnect asks first, then calls the link service for that user and shows home', async () => {
  const fake = fakeLinkService();
  const h = harness({ link: fake.service });
  await tapNav(h, { to: 'settings' });
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['🔔 Alert me at: 5% from liquidation', '← Back'], 'Settings no longer holds Disconnect');
  await tapNav(h, { to: 'account' });
  const account = lastScreen(h.telegram);
  assert.match(String(account.payload['text']), new RegExp(`🔗 ${h.view.network} #710\nExecution: 🟢 Authorized\nConnected `));
  assert.deepEqual(keyboardOf(account).map((b) => b.text), ['🔌 Disconnect #710', '← Back']);
  await tapNav(h, { to: 'disconnect-ask' });
  assert.match(shown(h.telegram).at(-1)!, /^testnet\n🔌 <b>Disconnect #710\?<\/b>\nYou'll stop getting its alerts here\.\nI'll delete the API key you gave me\./);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['🔌 Disconnect #710', 'Cancel']);
  assert.deepEqual(fake.unlinked, [], 'asking is not doing');
  await tapNav(h, { to: 'disconnect' });
  assert.deepEqual(fake.unlinked, [USER_ID]);
  assert.match(shown(h.telegram).at(-1)!, /^Unlinked from account 710\./, 'home for a chat with no account carries no network badge');
  // A stranger with nothing connected removes nothing: their own records are the only ones read.
  await tapNav(h, { to: 'disconnect' }, { from: STRANGER_ID, chat: 7_777 });
  assert.equal(answers(h.telegram).at(-1), 'Nothing is connected here.');
  assert.deepEqual(fake.unlinked, [USER_ID]);
});

test('ALERT DISTANCE: one number, presets with the current one marked, custom typed, a tap saves it and the label follows', async () => {
  const saved: Array<[number, number]> = [];
  const settings = new InMemoryAccountSettingsStore({ onChange: (id, v) => saved.push([id, v.alertPct]) });
  const h = harness({ settings });
  await tapNav(h, { to: 'warn-ask' });
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['2%', '3%', '✅ 5%', '8%', '10%', '🎛 Custom distance', '← Back']);
  await tapNav(h, { to: 'warn-set', level: 1 });
  assert.deepEqual(saved, [[710, 3]]);
  assert.equal(keyboardOf(lastScreen(h.telegram))[0]!.text, '🔔 Alert me at: 3% from liquidation');
  await tapNav(h, { to: 'warn-set', level: 9 });
  assert.match(answers(h.telegram).at(-1)!, /do not know that setting/);
  await tapNav(h, { to: 'alert-custom' });
  await h.bot.handleUpdate(messageUpdate('42'));
  assert.match(texts(h.telegram).at(-1)!, /between 0\.5 and 20/, 'out of range asks again');
  await h.bot.handleUpdate(messageUpdate('4.5%'));
  assert.deepEqual(saved.at(-1), [710, 4.5]);
  assert.equal(keyboardOf(lastScreen(h.telegram))[0]!.text, '🔔 Alert me at: 4.5% from liquidation');
});

test('RETIRED BUTTONS: every code taken off the menu fires NOTHING, from anyone', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  for (const old of ['n1:kq', 'n1:kx:123456', 'n1:kx+:123456', 'n1:tt', 'n1:tc:987', 'n1:cs:987', 'n1:cps', 'n1:cpx', 'n1:mg', 'n1:ma:1', 'n1:mp:1', 'n1:xa', 'n1:rr', 'n1:rl:1']) {
    await h.bot.handleUpdate(callbackUpdate(old));
    assert.match(answers(h.telegram).at(-1)!, /older version of the menu\. Nothing was sent/, old);
  }
  assert.equal(h.executor.calls.length, 0);
  // From a stranger the same payload is refused at the gate, before any handler.
  await h.bot.handleUpdate(callbackUpdate('n1:kx:123456', { from: STRANGER_ID, chat: 7_777 }));
  assert.equal(answers(h.telegram).at(-1), REFUSAL_TEXT);
});

test('VIEW POSITION: amounts with the distance each buys, two to a row, 🎛 Custom amount, 🚪 Close position, Back; NO reduce; Cancel deletes the token', async () => {
  const h = harness();
  const scenario = dangerScenario();
  h.view.assessments = [scenario.assessment];
  h.view.loop = scenario.loop;
  const screen = await openPosition(h);
  const html = String(screen.payload['text']);
  assert.match(html, /^testnet\n🔴 <b>BTC long · 2\.7% from liquidation<\/b>\nMargin <b>2,810 AUSD<\/b> · liquidation at 81,770\.1\nFree balance <b>10,000 AUSD<\/b>/);
  const labels = keyboardOf(screen).map((b) => b.text);
  assert.equal(labels.length, 6);
  assert.match(labels[0]!, /^\+100 → [\d.]+%$/);
  assert.match(labels[1]!, /^\+250 → [\d.]+%$/);
  assert.match(labels[2]!, /^\+500 → [\d.]+%$/);
  assert.deepEqual(labels.slice(3), ['🎛 Custom amount', '🚪 Close position', '← Back']);
  const rows = (screen.payload['reply_markup'] as { inline_keyboard: unknown[][] }).inline_keyboard.map((r) => r.length);
  assert.deepEqual(rows, [2, 2, 1, 1], '[+100][+250] / [+500][Custom] / [Close] / [Back]');
  assert.doesNotMatch(labels.join(' | '), /reduce/i);

  await h.bot.handleUpdate(callbackUpdate(keyboardOf(screen)[0]!.callback_data));
  const [send, cancel] = keyboardOf(h.telegram.last('sendMessage'));
  const token = decodeCallback(cancel!.callback_data);
  assert.ok(token.ok && token.payload.kind === 'cancel');
  await h.bot.handleUpdate(callbackUpdate(cancel!.callback_data));
  assert.equal(h.store.get(token.payload.token), undefined, 'cancel deletes the token');
  await h.bot.handleUpdate(callbackUpdate(send!.callback_data));
  assert.equal(h.executor.calls.length, 0, 'a cancelled Send can never fire');
});

test('THE DISTANCE ON A BUTTON IS ROUNDED DOWN: it never promises more room than the top-up buys', async () => {
  const { boughtDistance } = await import('./account.ts');
  assert.equal(boughtDistance(0.0849), '8.4%');
  assert.equal(boughtDistance(0.0899999), '8.9%');
  assert.equal(boughtDistance(0.1799), '17%');
  assert.equal(boughtDistance(0.0099), '0.9%');
  assert.equal(boughtDistance(-0.001), 'still past');
  // Never a figure below where the position already is: 2.7% plus a top-up is not "2%".
  assert.equal(boughtDistance(0.029), '2.9%');
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
  assert.match(shown(h.telegram).at(-1)!, /^📊 <b>MY POSITIONS<\/b> · testnet #710\nFree balance <b>10,000 AUSD<\/b> · unrealised −\d+ AUSD\nAlerting you at 5% from liquidation$/);
});

test('a URL button Telegram refuses does not lose the screen: it goes out again without that button', async () => {
  const h = harness({ link: fakeLinkService().service });
  // The tap is answered, then Telegram refuses the screen over an inline URL it will not open.
  h.telegram.reply({ ok: true, result: true } as never, FakeTelegram.error(400, 'Bad Request: BUTTON_URL_INVALID'));
  await tapNav(h, { to: 'connect-go' }, { from: STRANGER_ID, chat: STRANGER_CHAT });
  const edits = h.telegram.of('editMessageText');
  assert.equal(edits.length, 2, 'refused once, then shown');
  assert.match(String(edits[1]!.payload['text']), /Connect wallet/);
  assert.ok(keyboardOf(edits[1]!).every((b) => (b as { url?: string }).url === undefined), 'without the URL button');
  assert.match(String(edits[1]!.payload['text']), /https:\/\/perpguard\.example\/link\?code=/, 'the link is still in the text');
});

test('navigating on from an outcome opens a new message: the outcome stays in the chat as the record', async () => {
  const h = harness();
  h.executor.outcome = { kind: 'applied', detail: 'Done — the margin is in.' };
  const confirm = await confirmedTopUp(h);
  await h.bot.handleUpdate(callbackUpdate(confirm));
  const outcome = lastScreen(h.telegram);
  assert.match(String(outcome.payload['text']), /^testnet\n✓ <b>Added 100 AUSD to BTC long<\/b>/);
  const myPositions = keyboardOf(outcome).find((b) => b.text === '📊 My positions')!;
  const edits = h.telegram.of('editMessageText').length;
  await h.bot.handleUpdate(callbackUpdate(myPositions.callback_data));
  assert.equal(h.telegram.of('editMessageText').length, edits, 'nothing edited');
  assert.match(String(h.telegram.last('sendMessage').payload['text']), /^📊 <b>MY POSITIONS<\/b> · testnet #710/, 'the network said once, in the heading');
});

// ── Phase 7: the menu as a whole ────────────────────────────────────────────

/**
 * Every screen reachable by tapping, from /start, for one person. Taps only
 * navigation buttons, and never the ones that change something (unlink, stop
 * watching, a setting, minting a link code, a watch offer): those are reached,
 * recorded, and covered by their own tests.
 */
async function walkMenu(h: Harness, who: { readonly from?: number; readonly chat?: number }): Promise<Map<string, { html: string; labels: string[]; routes: Route[]; urls: string[] }>> {
  const CHANGES = new Set(['disconnect', 'unwatch', 'warn-set', 'connect-go', 'connect-key', 'watch-id', 'star', 'unstar', 'liq-set', 'big-set', 'warn-preset', 'wallet-alerts']);
  const seen = new Map<string, { html: string; labels: string[]; routes: Route[]; urls: string[] }>();
  const read = (call: FakeTelegram['calls'][number]) => {
    const markup = call.payload['reply_markup'] as InlineKeyboard | undefined;
    const buttons = (markup?.inline_keyboard?.flat() ?? []) as Array<{ text: string; callback_data?: string; url?: string }>;
    const routes: Route[] = [];
    for (const b of buttons) {
      if (b.callback_data === undefined) continue;
      const decoded = decodeNavTapForTest(b.callback_data);
      if (decoded !== undefined) routes.push(decoded);
    }
    return { html: String(call.payload['text']), labels: buttons.map((b) => b.text), routes, urls: buttons.flatMap((b) => (b.url === undefined ? [] : [b.url])) };
  };
  await h.bot.handleUpdate(messageUpdate('/start', who));
  const queue: Route[] = [{ to: 'home' }];
  seen.set('home', read(lastScreen(h.telegram)));
  for (const r of seen.get('home')!.routes) queue.push(r);
  while (queue.length > 0) {
    const route = queue.shift()!;
    const key = JSON.stringify(route);
    if (route.to === 'home' || seen.has(key) || CHANGES.has(route.to)) {
      if (CHANGES.has(route.to)) seen.set(key, { html: '(changes something: not tapped)', labels: [], routes: [], urls: [] });
      continue;
    }
    await tapNav(h, route, who);
    // The screen is the last message with buttons: a question that follows it (force_reply) has none, by design.
    const call = [...h.telegram.calls].reverse().find((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && (c.payload['reply_markup'] as InlineKeyboard | undefined)?.inline_keyboard !== undefined) ?? lastScreen(h.telegram);
    const screen = read(call);
    seen.set(key, screen);
    queue.push(...screen.routes);
  }
  return seen;
}

import { decodeNav as decodeNavTapForTest } from './nav.ts';
import type { ArmTap, RescueControl, RescueDraft, RescueRuleView } from './rescue.ts';
import type { KillSwitchControl, StopReportView } from './killSwitch.ts';
import type { EmergencyControl, EmergencyPosition, EmergencyReport } from './emergency.ts';
import { createManualAlertSender, type AutoNow } from './manualAlert.ts';

/** Taken off the bot, or never built: these must not appear as buttons anywhere. */
const UNBUILT = /copy|top traders|close all|funding|remove margin|reduce/i;

test('PHASE 7: every screen the OWNER can reach has a way back, offers nothing unbuilt, and links only to the site', async () => {
  const h = harness();
  h.view.assessments = [dangerAssessment()];
  const seen = await walkMenu(h, {});
  const reached = [...seen.keys()].map((k) => (k === 'home' ? 'home' : (JSON.parse(k) as Route).to)).sort();
  assert.deepEqual([...new Set(reached)], ['account', 'alert-custom', 'alert-settings', 'big', 'big-set', 'close-pos', 'disconnect-ask', 'disconnect', 'home', 'liq', 'liq-set', 'position', 'positions', 'settings', 'wallet-alerts', 'wallets', 'warn-ask', 'warn-custom', 'warn-levels', 'warn-preset', 'warn-set', 'watch-ask', 'watch-menu', 'watchlist'].sort());
  for (const [key, screen] of seen) {
    if (screen.html.startsWith('(changes')) continue;
    assert.doesNotMatch(screen.labels.join(' | '), UNBUILT, `${key} offers something not built`);
    if (key !== 'home') assert.ok(screen.routes.length > 0, `${key} has no way on or back`);
    // Only routes the site has: its home, and a trader's page by account id.
    for (const url of screen.urls) assert.match(url, /^https:\/\/perpguard\.example(\/traders\/\d+)?$/, `${key} links somewhere invented: ${url}`);
  }
  // Home, connected: the account in four lines, the network said once.
  const home = seen.get('home')!;
  assert.match(home.html, /^🛡 <b>PERPGUARD<\/b>\n🔗 testnet #710\nExecution: 🟢 Authorized\nAutomation: ⚪ Off\nAlerts: 🟢 5% from liquidation$/);
  assert.deepEqual(home.labels, ['👁 Watch & Alerts', '📊 My positions', '🔐 Trading account', '⚙️ Settings']);
  assert.equal(h.executor.calls.length, 0, 'walking the menu sends nothing');
});

test('PHASE 7: a STRANGER reaches only the public screens, and the Trading account offers the two ways in', async () => {
  const h = harness();
  const who = { from: STRANGER_ID, chat: STRANGER_CHAT };
  const seen = await walkMenu(h, who);
  const reached = new Set([...seen.keys()].map((k) => (k === 'home' ? 'home' : (JSON.parse(k) as Route).to)));
  assert.deepEqual([...reached].sort(), ['account', 'alert-settings', 'big', 'big-set', 'connect-go', 'connect-key', 'home', 'liq', 'liq-set', 'wallet-alerts', 'wallets', 'warn-custom', 'warn-levels', 'warn-preset', 'watch-ask', 'watch-menu', 'watchlist'].sort());
  for (const [key, screen] of seen) assert.doesNotMatch(screen.labels.join(' | '), UNBUILT, key);
  const home = seen.get('home')!;
  assert.match(home.html, /^🛡 <b>PERPGUARD<\/b>\n\nI message you before a Perpl position gets liquidated\.\n\nSend me any address or account number to start watching it — no key, nothing to set up\./);
  assert.deepEqual(home.labels, ['👁 Watch & Alerts', '🔐 Trading account']);
  const account = seen.get(JSON.stringify({ to: 'account' }))!;
  assert.match(account.html, /No account connected\.\n\nConnect your Perpl account and I can warn you before a position is liquidated, and add margin the moment you tap\.\n\nA Perpl key can trade but can never withdraw or move your funds\./);
  assert.deepEqual(account.labels, ['🔗 Connect wallet', '🔑 Enter API key', '← Back']);
  assert.equal(answers(h.telegram).filter((t) => t === REFUSAL_TEXT).length, 0, 'no public screen leads to a refusal');
});

test('PHASE 7: the menu says why execution is not green, never "Authorized" when it is not', async () => {
  const cases: Array<[Harness['sessionStatus'], RegExp]> = [
    [{ trading: { state: 'signed-in', forwardingAllowed: false } }, /Execution: 🟡 Order forwarding is off/],
    [{ trading: { state: 'connecting' } }, /Execution: 🟠 Connecting/],
    [{ trading: { state: 'signed-in' }, mismatch: 'signed in as #711' }, /Execution: 🔴 Key is for another account/],
    [undefined, /Execution: ⚪ Unknown/],
  ];
  for (const [status, line] of cases) {
    const h = harness();
    h.sessionStatus = status;
    await h.bot.handleUpdate(messageUpdate('/start'));
    assert.match(texts(h.telegram).at(-1)!, line);
    await tapNav(h, { to: 'account' });
    assert.match(String(lastScreen(h.telegram).payload['text']), line);
  }
  const relink = harness({ link: { ...fakeLinkService().service, needsRelink: () => 'the key was sealed under a rotated key' } });
  await relink.bot.handleUpdate(messageUpdate('/start'));
  assert.match(texts(relink.telegram).at(-1)!, /Execution: 🔴 Key can no longer be used/);
});

test('MY POSITIONS: one button per position, closest first, the distance on it; nothing sent; a stranger is refused', async () => {
  const h = harness();
  const near = dangerAssessment();
  const far = { ...dangerAssessment(), marketId: 2, symbol: 'ETH', state: 'WATCH' as const, liqBufferPct: 0.061 };
  h.view.assessments = [far, near];
  await tapNav(h, { to: 'positions' });
  const list = lastScreen(h.telegram);
  assert.match(String(list.payload['text']), /^📊 <b>MY POSITIONS<\/b> · testnet #710\nFree balance <b>10,000 AUSD<\/b> · unrealised −\d+ AUSD\nAlerting you at 5% from liquidation$/);
  assert.deepEqual(keyboardOf(list).map((b) => b.text), ['🔴 BTC long · 2.7% · −12 AUSD', '🟡 ETH long · 6.1% · −12 AUSD', '← Back']);
  assert.equal(actionButtons(list).length, 0, 'no action button on the list itself');
  assert.equal(h.executor.calls.length, 0);
  await tapNav(h, { to: 'positions' }, { from: STRANGER_ID, chat: STRANGER_CHAT });
  assert.equal(answers(h.telegram).at(-1), REFUSAL_TEXT);
});

// ── Phase 8: Watch & Alerts ─────────────────────────────────────────────────

test('PHASE 8: thresholds, warning presets and the wallet-alerts switch are saved PER CHAT, by anyone, for their own chat only', async () => {
  const h = harness();
  const stranger = { from: STRANGER_ID, chat: STRANGER_CHAT };
  await tapNav(h, { to: 'liq' }, stranger);
  const liq = lastScreen(h.telegram);
  assert.match(String(liq.payload['text']), /Now: <b>\$10K\+<\/b>/, 'the default');
  assert.deepEqual(keyboardOf(liq).map((b) => b.text), ['$1K+ · about 4.7 a day', '$5K+ · about 1.7 a day', '✅ $10K+ · about 1 a day', '$25K+ · about 0.4 a day', '⚪ Off', '← Back']);
  await tapNav(h, { to: 'liq-set', level: 3 }, stranger);
  await tapNav(h, { to: 'big-set', level: 9 }, stranger);
  await tapNav(h, { to: 'warn-preset', level: 0 }, stranger);
  await tapNav(h, { to: 'wallet-alerts' }, stranger);
  assert.deepEqual(h.prefs.get(STRANGER_CHAT), { walletAlerts: false, liquidationMinAusd: 25_000, largeTradeMinAusd: undefined, warningLevels: [20, 10, 5] });
  assert.equal(h.prefs.get(OWNER_CHAT).liquidationMinAusd, 10_000, 'another chat is untouched');
  await tapNav(h, { to: 'alert-settings' }, stranger);
  assert.match(String(lastScreen(h.telegram).payload['text']), /Wallet alerts: ⚪ OFF\nLiquidations: <b>\$25K\+<\/b>\nLarge trades: <b>Off<\/b>\nWarnings: <b>20% \/ 10% \/ 5%<\/b>/);
  await tapNav(h, { to: 'liq-set', level: 7 }, stranger);
  assert.match(answers(h.telegram).at(-1)!, /do not know that setting/);
});

test('PHASE 8: custom warning levels are asked with force_reply; a bad answer re-asks; a good one is sorted and saved', async () => {
  const h = harness();
  const stranger = { from: STRANGER_ID, chat: STRANGER_CHAT };
  await tapNav(h, { to: 'warn-custom' }, stranger);
  assert.equal((h.telegram.last('sendMessage').payload['reply_markup'] as { force_reply: boolean }).force_reply, true);
  await h.bot.handleUpdate(messageUpdate('3 15 0', stranger));
  assert.match(texts(h.telegram).at(-1)!, /^Each level must be above 0 and at most 100\./);
  await h.bot.handleUpdate(messageUpdate('3 15% 8', stranger));
  assert.deepEqual(h.prefs.get(STRANGER_CHAT).warningLevels, [15, 8, 3]);
  assert.match(texts(h.telegram).at(-1)!, /Now: <b>15% \/ 8% \/ 3%<\/b>/);
  await h.bot.handleUpdate(messageUpdate('5293', stranger));
  assert.match(texts(h.telegram).at(-1)!, /Watch account <b>#5293<\/b>\?/, 'the question is closed: the next number is not a level');
});

test('PHASE 8: a watched wallet goes on and off the Watchlist; the Watchlist shows 30D PnL and all-time ROI WITH its denominator', async () => {
  const h = harness();
  h.watchStore.add({ chatId: STRANGER_CHAT, accountId: 987, label: '#987', addedAtMs: 0 });
  const stranger = { from: STRANGER_ID, chat: STRANGER_CHAT };
  await tapNav(h, { to: 'watchlist' }, stranger);
  assert.match(String(lastScreen(h.telegram).payload['text']), /^⭐ <b>WATCHLIST<\/b>\nEmpty\./);
  await tapNav(h, { to: 'star', accountId: 987 }, stranger);
  const list = String(lastScreen(h.telegram).payload['text']);
  assert.match(list, /1\. <b>#987<\/b>\n   30D PnL <b>\+21,147 AUSD<\/b>\n   ROI \(all time\) <b>\+1,034%<\/b> on 2,045 AUSD deposited/);
  assert.match(list, /Past results do not predict future returns\./);
  await tapNav(h, { to: 'star', accountId: 5 }, stranger);
  assert.match(answers(h.telegram).at(-1)!, /You are not watching #5 here/);
  await tapNav(h, { to: 'unstar', accountId: 987 }, stranger);
  assert.equal(h.watchStore.byChat(STRANGER_CHAT)[0]!.starred, false);
});

test('PHASE 8: watching shows WALLET ADDED with what will be reported, and offers the Watchlist', async () => {
  const h = harness();
  h.resolver.answers.set('4088', { accountId: 4088, address: undefined, resolvedBy: 'index' });
  await h.bot.handleUpdate(messageUpdate('/watch 4088', { from: STRANGER_ID, chat: STRANGER_CHAT }));
  const added = h.telegram.last('sendMessage');
  assert.match(String(added.payload['text']), /^✅ <b>WALLET ADDED<\/b> · #4088\n\nI'll tell you about:\n• position opens, increases, reductions and closes\n• getting close to liquidation, at your warning levels\n• liquidation/);
  assert.deepEqual(keyboardOf(added).map((b) => b.text), ['👁 View wallet', '⭐ Add to Watchlist', '🗑 Stop watching', '← Back']);
});

test('PHASE 8: the Large Trades screen states what it cannot see', async () => {
  const h = harness();
  await tapNav(h, { to: 'big' }, { from: STRANGER_ID, chat: STRANGER_CHAT });
  const html = String(lastScreen(h.telegram).payload['text']);
  assert.match(html, /About 6% of fills carry no recorded taker and are not counted\./);
  assert.match(html, /direction is read from the transaction, and is sometimes not known/);
});

test('TRADING ACCOUNT: the account and its network once, the execution state, and when it was connected', async () => {
  const h = harness();
  await tapNav(h, { to: 'account' });
  const screen = lastScreen(h.telegram);
  assert.match(String(screen.payload['text']), /^🔐 <b>TRADING ACCOUNT<\/b>\n🔗 testnet #710\nExecution: 🟢 Authorized\nConnected \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  assert.deepEqual(keyboardOf(screen).map((b) => b.text), ['🔌 Disconnect #710', '← Back']);
  // Not authorized is never dressed as authorized.
  const off = harness();
  off.sessionStatus = { trading: { state: 'signed-in', forwardingAllowed: false } };
  await tapNav(off, { to: 'account' });
  assert.match(String(lastScreen(off.telegram).payload['text']), /Execution: 🟡 Order forwarding is off\n/);
});

// ── Phase 13: the Trading Account names what is wrong ────────────────────────

test('PHASE 13: a link made on another network is refused BY NAME, and the Trading account says which network', async () => {
  const links = newLinks([{ ...OWNER_LINK, network: 'mainnet' }]);
  const h = harness({ links });
  await tapNav(h, { to: 'positions' });
  assert.match(answers(h.telegram).at(-1)!, /^Your account #710 was connected on mainnet, but PerpGuard trades on testnet here/);
  await tapNav(h, { to: 'account' });
  const screen = lastScreen(h.telegram);
  assert.match(String(screen.payload['text']), /Execution: 🔴 Linked on mainnet, not testnet/);
  assert.deepEqual(keyboardOf(screen).map((b) => b.text), ['🔑 Enter a new API key', '🔌 Disconnect #710', '← Back']);
});

test('PHASE 13: a wallet that proved an account but sent no key is told what is missing, with the way to add the key', async () => {
  const fake = fakeLinkService();
  const h = harness({ link: { ...fake.service, walletProof: () => ({ address: '0x169e49ece0d4f19b92de549482d1562ddd235251', accountId: 900 }) } });
  await tapNav(h, { to: 'account' }, { from: STRANGER_ID, chat: STRANGER_CHAT });
  const screen = lastScreen(h.telegram);
  assert.match(String(screen.payload['text']), /Your wallet <code>0x169e…5251<\/code> owns testnet #900\.\nTo add margin for you I also need an API key for it\. Enter it on the page, never here\./);
  assert.deepEqual(keyboardOf(screen).map((b) => b.text), ['🔑 Enter API key', '🔌 Disconnect #900', '← Back']);
});

test('DISCONNECT, WALLET ONLY: a proof with no link can be undone from the bot, and the ask says no key is held', async () => {
  const fake = fakeLinkService();
  const h = harness({ link: { ...fake.service, walletProof: () => ({ address: '0x169e49ece0d4f19b92de549482d1562ddd235251', accountId: 900 }), hasKey: () => false } });
  const who = { from: STRANGER_ID, chat: STRANGER_CHAT };
  await tapNav(h, { to: 'disconnect-ask' }, who);
  const ask = shown(h.telegram).at(-1)!;
  assert.match(ask, /🔌 <b>Disconnect #900\?<\/b>\nI'll forget that your wallet <code>0x169e…5251<\/code> proved it\.\nNo API key is stored for it, so there is none to delete\./);
  assert.doesNotMatch(ask, /stop getting its alerts|delete the API key you gave me/, 'only what is really held is named');
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['🔌 Disconnect #900', 'Cancel']);
  assert.deepEqual(fake.unlinked, [], 'asking is not doing');
  await tapNav(h, { to: 'disconnect' }, who);
  assert.equal(fake.unlinked.length, 1, 'the link service is asked for the tapper\u2019s own identity');
  assert.match(fake.unlinked[0]!, /^tg:/);
});

test('DISCONNECT, KEY HELD: the ask says the key is deleted only when one is stored', async () => {
  const fake = fakeLinkService();
  const withKey = harness({ link: { ...fake.service, hasKey: () => true } });
  await tapNav(withKey, { to: 'disconnect-ask' });
  assert.match(shown(withKey.telegram).at(-1)!, /I'll delete the API key you gave me\./);
  const noKey = harness({ link: { ...fake.service, hasKey: () => false } });
  await tapNav(noKey, { to: 'disconnect-ask' });
  const text = shown(noKey.telegram).at(-1)!;
  assert.match(text, /You'll stop getting its alerts here\.\nNo API key is stored for it, so there is none to delete\./);
});

test('PHASE 13: a rotated key and order forwarding off are told apart; only the first offers a new key', async () => {
  const rotated = harness({ link: { ...fakeLinkService().service, needsRelink: () => 'rotated' } });
  await tapNav(rotated, { to: 'account' });
  const r = lastScreen(rotated.telegram);
  assert.match(String(r.payload['text']), /Execution: 🔴 Key can no longer be used \(rotated\)/);
  assert.equal(keyboardOf(r)[0]!.text, '🔑 Enter a new API key');
  const forwarding = harness();
  forwarding.sessionStatus = { trading: { state: 'signed-in', forwardingAllowed: false } };
  await tapNav(forwarding, { to: 'account' });
  const f = lastScreen(forwarding.telegram);
  assert.match(String(f.payload['text']), /Execution: 🟡 Order forwarding is off[\s\S]*allowOrderForwarding\(true\)[\s\S]*an API key cannot do it/);
  assert.notEqual(keyboardOf(f)[0]!.text, '🔑 Enter a new API key', 'a new key would not fix this: the owner wallet must');
});

test('CONNECT: 🔗 and 🔑 both mint a one-time code for the HTTPS page; 🔑 opens it on the key form; no key in Telegram', async () => {
  const fake = fakeLinkService();
  const h = harness({ link: fake.service });
  const who = { from: STRANGER_ID, chat: STRANGER_CHAT };
  await tapNav(h, { to: 'connect-go' }, who);
  const wallet = lastScreen(h.telegram);
  assert.match(String(wallet.payload['text']), /^🔗 <b>Connect wallet<\/b>\nOpen this page — it works once, for \d+ minutes\.\nSign with the wallet that owns your Perpl account\./);
  await tapNav(h, { to: 'connect-key' }, who);
  const key = lastScreen(h.telegram);
  assert.match(String(key.payload['text']), /^🔑 <b>Enter API key<\/b>[\s\S]*Paste your key there\. Never paste it here\./);
  const url = (keyboardOf(key)[0] as { url?: string }).url ?? '';
  assert.match(url, /[?&]via=key$/);
});

// ── adding margin ───────────────────────────────────────────────────────────

test('ADD MARGIN: View position → +100 → confirm with before and after for margin, liquidation price, distance and free balance → exactly 100 AUSD sent, once', async () => {
  const h = harness();
  const scenario = dangerScenario();
  h.view.assessments = [scenario.assessment];
  h.view.loop = scenario.loop;
  h.executor.outcome = { kind: 'applied', detail: 'Done — the margin is in.' };

  const pos = await openPosition(h, dangerAssessment().marketId);
  assert.equal(h.executor.calls.length, 0, 'offering amounts sends nothing');
  const plus100 = keyboardOf(pos).find((b) => b.text.startsWith('+100 → '))!;
  await h.bot.handleUpdate(callbackUpdate(plus100.callback_data));
  const confirm = texts(h.telegram).at(-1)!;
  assert.match(confirm, /^testnet\n⚠️ <b>Add 100 AUSD to BTC long\?<\/b>\n\nMargin: <b>2,810 AUSD<\/b> → <b>2,910 AUSD<\/b>\nLiquidation price: 81,770\.1 → [\d,.]+\nDistance: 2\.7% → <b>[\d.]+%<\/b>\nFree balance: <b>10,000 AUSD<\/b> → <b>9,900 AUSD<\/b>/);
  // The button's distance and the confirmation's agree: the button rounds DOWN.
  const onButton = Number(/→ ([\d.]+)%/.exec(plus100.text)![1]);
  const onConfirm = Number(/Distance: 2\.7% → <b>([\d.]+)%/.exec(confirm)![1]);
  assert.ok(onButton <= onConfirm && onButton > 2.7, `${onButton} vs ${onConfirm}`);
  assert.equal(h.executor.calls.length, 0, 'NEVER on the first button press');

  const [send] = keyboardOf(h.telegram.last('sendMessage'));
  await h.bot.handleUpdate(callbackUpdate(send!.callback_data));
  await h.bot.handleUpdate(callbackUpdate(send!.callback_data));
  assert.equal(h.executor.calls.length, 1, 'a double tap is one send');
  assert.equal(h.executor.calls[0]!.action.amountCNS, 100_000_000n, 'exactly the figure shown');
  const said = shown(h.telegram).join('\n');
  assert.doesNotMatch(said, /failed|rejected|sr 32/i, 'a top-up that landed is never shown as failed');
});

test('ADD MARGIN: an amount over the free floor is offered WITH a warning; a blind position offers no amount at all', async () => {
  const h = harness();
  const scenario = dangerScenario();
  h.view.assessments = [scenario.assessment];
  h.view.loop = scenario.loop;
  h.balance.reading = { known: true, floorCNS: 300_000_000n };
  const pos = await openPosition(h, dangerAssessment().marketId);
  const labels = keyboardOf(pos).map((b) => b.text);
  assert.doesNotMatch(labels[0]!, /⚠️/);
  assert.doesNotMatch(labels[1]!, /⚠️/);
  assert.match(labels[2]!, /^\+500 → [\d.]+% ⚠️$/);
  assert.match(String(pos.payload['text']), /⚠️ may be more than your free balance/);

  const blind = harness();
  blind.view.assessments = [{ ...dangerAssessment(), state: 'FEED_DOWN' }];
  const b = await openPosition(blind, dangerAssessment().marketId);
  assert.equal(actionButtons(b).length, 0, 'no amount on a position it cannot see');
  assert.deepEqual(keyboardOf(b).map((x) => x.text), ['↻ Look again', '← Back']);
});


// ── 🛟 Rescue (Phase 17) ────────────────────────────────────────────────────

class FakeRescue implements RescueControl {
  enabled: Array<{ accountId: number; draft: RescueDraft; arm: ArmTap }> = [];
  ruleViews: RescueRuleView[] = [];
  stoppedFlag = false;
  rules(): readonly RescueRuleView[] {
    return this.ruleViews;
  }
  stopped(): boolean {
    return this.stoppedFlag;
  }
  otherAutomation(): string | undefined {
    return undefined;
  }
  async enable(accountId: number, draft: RescueDraft, arm: ArmTap) {
    this.enabled.push({ accountId, draft, arm });
    this.ruleViews = [{ marketId: draft.marketId, symbol: 'BTC', positionId: draft.positionId, triggerPct: draft.triggerPct!, amountCNS: draft.amountCNS!, maxRescues: draft.maxRescues, maxTotalCNS: draft.maxTotalCNS!, minRemainingCNS: draft.minRemainingCNS, cooldownMs: draft.cooldownMs, rescueCount: 0, totalRescuedCNS: 0n, enabled: true, pausedReason: undefined }];
    return { ok: true as const, text: 'Rescue is on for BTC.' };
  }
  async disable() {
    this.ruleViews = this.ruleViews.map((r) => ({ ...r, enabled: false }));
    return { ok: true as const, text: 'Rescue is off for BTC.' };
  }
  async resume() {
    return { ok: true as const, text: 'Resumed.' };
  }
}

test('RESCUE: the rule as one sentence at the alert distance; Change amount (25 typed) and Change limits on one screen; TURN ON hands the server one draft WITH THE TAP', async () => {
  const rescue = new FakeRescue();
  const h = harness({ rescue });
  const a = dangerAssessment();
  h.view.assessments = [a];

  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.ok(keyboardOf(lastScreen(h.telegram)).some((b) => b.text === '🛟 Rescue'), 'home has the Rescue button once it is built');

  await tapNav(h, { to: 'rescue' });
  assert.match(String(lastScreen(h.telegram).payload['text']), /🛟 <b>RESCUE<\/b>\n\nAutomatic top-ups, per position\. Off until you turn one on\./);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['🔴 BTC long · 2.7% · off', '← Back']);
  await tapNav(h, { to: 'rescue-pos', marketId: a.marketId });
  const pos = lastScreen(h.telegram);
  assert.match(String(pos.payload['text']), /🛟 <b>RESCUE · BTC long<\/b>\n\nIf BTC reaches 5% from liquidation, add 100 AUSD\.\nUp to 2 times\. Never spending your last 500 AUSD\.\nAt least 15 minutes apart\./);
  // Already inside 5%: turning on is a choice (owner's finding, 7 Oct 2026).
  assert.deepEqual(keyboardOf(pos).map((b) => b.text), ['Change amount', 'Change limits', '🟢 Turn on · add now', '🟢 Turn on · next time', '← Back']);

  await tapNav(h, { to: 'rescue-cfg', marketId: a.marketId });
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['+100', '+250', '+500', '+1,000', '🎛 Custom amount', '← Back']);
  await tapNav(h, { to: 'rescue-amt-custom' });
  await h.bot.handleUpdate(messageUpdate('25'));
  assert.match(texts(h.telegram).at(-1)!, /If BTC reaches 5% from liquidation, add 25 AUSD\.\nUp to 2 times\./);

  // ALL FOUR LIMITS ON ONE SCREEN; MAX TOTAL is its own setting, said once it bites.
  await tapNav(h, { to: 'rescue-limits' });
  const limits = keyboardOf(lastScreen(h.telegram)).map((b) => b.text);
  assert.ok(limits.includes('✅ 2 times') && limits.includes('✅ Keep 500') && limits.includes('✅ 15 min apart'), limits.join(' | '));
  assert.ok(limits.some((l) => /in all$/.test(l)));
  await tapNav(h, { to: 'rescue-lim', level: 100 });
  await tapNav(h, { to: 'rescue-pos', marketId: a.marketId });
  assert.match(String(lastScreen(h.telegram).payload['text']), /No more than 100 AUSD in all\.|At least 15 minutes apart\.$/m);

  assert.equal(rescue.enabled.length, 0, 'nothing turned on before Turn on');
  await tapNav(h, { to: 'rescue-on' });
  assert.equal(rescue.enabled.length, 1);
  const sent = rescue.enabled[0]!;
  assert.equal(sent.accountId, 710);
  assert.deepEqual(sent.arm, { telegramUserId: OWNER_ID, chatId: OWNER_CHAT }, 'armed by THIS tap, from THIS chat');
  assert.equal(sent.draft.triggerPct, 0.05, 'the alert distance');
  assert.equal(sent.draft.amountCNS, 25_000_000n);
  assert.equal(sent.draft.maxTotalCNS, 100_000_000n);
  assert.equal(sent.draft.positionId, a.positionId);
  assert.equal(h.executor.calls.length, 0, 'the bot sends nothing itself');

  // While on: who turned it on and when, top-ups used, ⛔ Turn off.
  rescue.ruleViews = rescue.ruleViews.map((r) => ({ ...r, armedBy: OWNER_ID, armedAtMs: Date.parse('2026-10-08T06:48:00Z') }));
  await tapNav(h, { to: 'rescue-pos', marketId: a.marketId });
  const on = lastScreen(h.telegram);
  assert.match(String(on.payload['text']), /🛟 <b>RESCUE · BTC long<\/b> · 🟢 On[\s\S]*Turned on by you, 8 Oct, 06:48\.\nTop-ups used: 0 of 2 · 0 AUSD added\./);
  assert.deepEqual(keyboardOf(on).map((b) => b.text), ['⛔ Turn off', '← Back']);
  await tapNav(h, { to: 'rescue-stop', marketId: a.marketId });
  assert.equal(rescue.ruleViews[0]?.enabled, false);
});

test('RESCUE: a position outside the line has one Turn on; while automation is stopped there is none, only the way to resume', async () => {
  const rescue = new FakeRescue();
  const h = harness({ rescue });
  const a = { ...dangerAssessment(), state: 'SAFE' as const, liqBufferPct: 0.2 };
  h.view.assessments = [a];
  await tapNav(h, { to: 'rescue-pos', marketId: a.marketId });
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['Change amount', 'Change limits', '🟢 Turn on', '← Back']);
  rescue.stoppedFlag = true;
  await tapNav(h, { to: 'rescue-pos', marketId: a.marketId });
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['Change amount', 'Change limits', '🆘 Kill switch', '← Back']);
});

test('RESCUE: a stranger cannot reach any rescue screen', async () => {
  const rescue = new FakeRescue();
  const h = harness({ rescue });
  for (const route of [{ to: 'rescue' }, { to: 'rescue-on' }, { to: 'rescue-stop', marketId: 1 }] as Route[]) {
    await tapNav(h, route, { from: STRANGER_ID, chat: STRANGER_CHAT });
  }
  assert.equal(rescue.enabled.length, 0);
  assert.ok(answers(h.telegram).every((t) => t === REFUSAL_TEXT));
});


// ── 🆘 Kill switch ───────────────────────────────────────────────

class FakeKillSwitch implements KillSwitchControl {
  on = false;
  stops: Array<{ accountId: number; by: string }> = [];
  stopped(): boolean {
    return this.on;
  }
  changedAtMs(): number | undefined {
    return undefined;
  }
  async stop(accountId: number, by: string): Promise<StopReportView> {
    this.stops.push({ accountId, by });
    const alreadyStopped = this.on;
    this.on = true;
    return { alreadyStopped, rescueStopped: alreadyStopped ? [] : ['BTC'], modeBefore: alreadyStopped ? 'NONE' : 'LIQUIDATION_RESCUE', inFlight: 'none', inFlightDetail: undefined };
  }
  async resume(): Promise<{ readonly wasStopped: boolean }> {
    const wasStopped = this.on;
    this.on = false;
    return { wasStopped };
  }
}

test('KILL SWITCH: ONE main action (Stop everything) and, under it, Stop automation only; nothing on the first tap', async () => {
  const killSwitch = new FakeKillSwitch();
  const emergency = new FakeEmergency();
  const h = harness({ killSwitch, emergency });
  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.ok(keyboardOf(lastScreen(h.telegram)).some((b) => b.text === '🆘 Kill switch'));
  await tapNav(h, { to: 'kill' });
  const screen = lastScreen(h.telegram);
  assert.equal(String(screen.payload['text']), "testnet\n🆘 <b>KILL SWITCH</b>\n\nStops every automation and closes all your positions at whatever price they get.\n\nThis realises your losses and can't be undone.");
  assert.deepEqual(keyboardOf(screen).map((b) => b.text), ['🆘 Stop everything', 'Stop automation only — leaves your positions open', '← Back']);
  assert.equal(killSwitch.stops.length + emergency.runs.length, 0);
});

test('STOP AUTOMATION ONLY: two taps; the result is a NEW message saying positions are still open; nothing sent to the venue', async () => {
  const killSwitch = new FakeKillSwitch();
  const h = harness({ killSwitch });
  await tapNav(h, { to: 'kill-confirm' });
  assert.match(String(lastScreen(h.telegram).payload['text']), /Stop automation only\?[\s\S]*Your positions stay open\. This works even if the exchange is unreachable\./);
  assert.equal(killSwitch.stops.length, 0, 'the first tap only explains');
  const yes = keyboardOf(lastScreen(h.telegram)).find((b) => b.text === 'Yes, stop automation')!;
  const sendsBefore = h.telegram.of('sendMessage').length;
  await h.bot.handleUpdate(callbackUpdate(yes.callback_data));
  assert.deepEqual(killSwitch.stops, [{ accountId: 710, by: `tg:${OWNER_ID}` }]);
  assert.equal(h.telegram.of('sendMessage').length, sendsBefore + 1, 'the result is a new message: the record is never edited away');
  assert.match(String(lastScreen(h.telegram).payload['text']), /🛑 <b>Automation stopped\.<\/b>\nRescue is off on BTC\. Nothing automatic will run until you resume\.\nYour positions are still open\./);
  assert.equal(h.executor.calls.length, 0, 'nothing sent to the venue');

  // Home now says so, and the switch offers Resume.
  await h.bot.handleUpdate(messageUpdate('/start'));
  assert.match(String(lastScreen(h.telegram).payload['text']), /Automation: 🛑 Stopped/);
  await tapNav(h, { to: 'kill' });
  assert.ok(keyboardOf(lastScreen(h.telegram)).some((b) => b.text === '▶️ Resume automation'));
  await tapNav(h, { to: 'kill-resume' });
  assert.equal(killSwitch.on, false);
});

test('STOP AUTOMATION ONLY: reachable with NO trading session (key needs re-linking, socket down): stopping needs nothing from the exchange', async () => {
  const killSwitch = new FakeKillSwitch();
  // Linked to an account the router has no session for.
  const links = newLinks([{ ...OWNER_LINK, accountId: 999 }]);
  const h = harness({ killSwitch, links });
  await tapNav(h, { to: 'kill-stop' });
  assert.deepEqual(killSwitch.stops, [{ accountId: 999, by: `tg:${OWNER_ID}` }]);
  assert.match(String(lastScreen(h.telegram).payload['text']), /Automation stopped/);
});

test('KILL SWITCH: a stranger cannot reach any of it', async () => {
  const killSwitch = new FakeKillSwitch();
  const emergency = new FakeEmergency();
  const h = harness({ killSwitch, emergency });
  for (const route of [{ to: 'kill' }, { to: 'kill-stop' }, { to: 'kill-resume' }, { to: 'stop-all' }, { to: 'stop-all-go' }, { to: 'close-retry-go', marketId: 16 }] as Route[]) {
    await tapNav(h, route, { from: STRANGER_ID, chat: STRANGER_CHAT });
  }
  assert.equal(killSwitch.stops.length + emergency.runs.length, 0);
});


// ── 🆘 Stop everything ───────────────────────────────────────

const ePos = (symbol: string, marketId: number, sizeLNS: bigint, pnl: bigint | undefined): EmergencyPosition => ({ marketId, symbol, positionId: marketId * 10, side: 'long', sizeLNS, lotDecimals: symbol === 'BTC' ? 5 : 3, unrealisedPnlCNS: pnl });

class FakeEmergency implements EmergencyControl {
  positions: EmergencyPosition[] | undefined = [ePos('BTC', 16, 2_000n, -84_400_000n), ePos('ETH', 32, 310n, -12_100_000n), ePos('SOL', 48, 14_200n, 31_700_000n)];
  runs: Array<{ requestId: string; marketId?: number }> = [];
  next: EmergencyReport | undefined;
  preview(): readonly EmergencyPosition[] | undefined {
    return this.positions;
  }
  async closeAll(_a: number, requestId: string): Promise<EmergencyReport> {
    this.runs.push({ requestId });
    return this.next ?? { kind: 'ran', complete: true, replayed: false, results: (this.positions ?? []).map((position) => ({ kind: 'closed' as const, position, exitPrice: 85_102 })) };
  }
  async closeOne(_a: number, marketId: number, requestId: string): Promise<EmergencyReport> {
    this.runs.push({ requestId, marketId });
    const position = this.positions!.find((p) => p.marketId === marketId)!;
    return { kind: 'ran', complete: true, replayed: false, results: [{ kind: 'closed', position, exitPrice: 2614 }] };
  }
  positionRuns: Array<{ requestId: string; marketId: number }> = [];
  async closePosition(_a: number, marketId: number, requestId: string): Promise<EmergencyReport> {
    this.positionRuns.push({ requestId, marketId });
    const position = this.positions!.find((p) => p.marketId === marketId)!;
    return this.next ?? { kind: 'ran', complete: true, replayed: false, automationOff: false, results: [{ kind: 'closed', position, exitPrice: 81_900 }] };
  }
}


test('🚪 CLOSE POSITION: on View position under the amounts; its tap shows size, price and what it realises, says Auto goes off first, and SENDS NOTHING', async () => {
  const emergency = new FakeEmergency();
  // The scenario's BTC is market 1 in the fixtures: the same market on the screen, the close and the rule.
  emergency.positions = emergency.positions!.map((p) => (p.symbol === 'BTC' ? { ...p, marketId: 1 } : p));
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency, rescue: { rules: () => [{ marketId: 1, enabled: true, symbol: 'BTC' }] } as never });
  const scenario = dangerScenario();
  h.view.assessments = [scenario.assessment];
  h.view.loop = scenario.loop;
  const screen = await openPosition(h);
  const labels = keyboardOf(screen).map((b) => b.text);
  assert.deepEqual(labels.slice(-2), ['🚪 Close position', '← Back'], 'under the amounts, above Back');
  const close = keyboardOf(screen).find((b) => b.text === '🚪 Close position')!;
  await h.bot.handleUpdate(callbackUpdate(close.callback_data));
  const confirm = String(lastScreen(h.telegram).payload['text']);
  assert.match(confirm, /🚪 <b>Close BTC long\?<\/b>\n\nSize <b>0\.02<\/b> · price now [\d,.]+\nYou realise <b>−85 AUSD<\/b> \(a loss\)/);
  assert.match(confirm, /🤖 Auto top-up is on for this position\. I’ll turn it off first, so nothing is added while it closes\./);
  assert.match(confirm, /read the result from your positions afterwards, not from the exchange's receipt/);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['🚪 Yes, close BTC long', 'Cancel']);
  assert.equal(emergency.positionRuns.length, 0, 'nothing is sent on the tap that shows the cost');
  assert.equal(h.executor.calls.length, 0);
});

test('🚪 CLOSE POSITION: Yes sends it ONCE; a second tap sends nothing; "closed" only from the verified result', async () => {
  const emergency = new FakeEmergency();
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'close-pos', marketId: 16 });
  assert.doesNotMatch(String(lastScreen(h.telegram).payload['text']), /Auto top-up/, 'no Auto line when Auto is off');
  await tapNav(h, { to: 'close-pos-go', marketId: 16 });
  await tapNav(h, { to: 'close-pos-go', marketId: 16 });
  assert.equal(emergency.positionRuns.length, 1, 'never re-sent');
  assert.equal(emergency.runs.length, 0, 'not the kill switch\u2019s close-everything');
  assert.match(texts(h.telegram).join('\n'), /✅ <b>BTC long CLOSED<\/b>\n\n0\.02 closed at 81,900\. It's gone from your positions\./);
  assert.equal(answers(h.telegram).at(-1), 'That close was already sent, or has expired. Nothing new was sent.');
});

test('🚪 CLOSE POSITION: a partial close says what remains, with a retry that needs a NEW confirmation; it never says closed', async () => {
  const emergency = new FakeEmergency();
  const btc = emergency.positions![0]!;
  emergency.next = { kind: 'ran', complete: false, replayed: false, automationOff: true, results: [{ kind: 'partial', position: btc, closedLNS: 1_500n, remainingLNS: 500n, why: 'the close was sent, but the exchange did not fill it (not enough on the other side, or it expired)' }] };
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'close-pos', marketId: 16 });
  await tapNav(h, { to: 'close-pos-go', marketId: 16 });
  const result = lastScreen(h.telegram);
  const html = String(result.payload['text']);
  assert.match(html, /⚠️ <b>BTC long PARTLY CLOSED<\/b>\n\n<b>0\.005 of 0\.02 is still open<\/b>: the close was sent, but the exchange did not fill it/);
  assert.match(html, /🤖 Auto top-up is off for this position\./);
  assert.doesNotMatch(html, /CLOSED<\/b>\n\n0\.02 closed/);
  const retry = keyboardOf(result).find((b) => b.text === '🚪 Close what’s left')!;
  assert.ok(retry !== undefined);
  await h.bot.handleUpdate(callbackUpdate(retry.callback_data));
  assert.equal(emergency.positionRuns.length, 1, 'the retry opens a new confirmation; nothing is sent on it');
  assert.match(String(lastScreen(h.telegram).payload['text']), /🚪 <b>Close BTC long\?<\/b>/);
});

test('🚪 CLOSE POSITION: a confirmation older than two minutes sends nothing and shows the cost again', async () => {
  const emergency = new FakeEmergency();
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'close-pos', marketId: 16 });
  h.nowMs += 2 * 60_000 + 1;
  await tapNav(h, { to: 'close-pos-go', marketId: 16 });
  assert.equal(emergency.positionRuns.length, 0);
  assert.match(String(lastScreen(h.telegram).payload['text']), /more than two minutes ago and the price has moved, so nothing was sent/);
});

test('🚪 CLOSE POSITION: a position it cannot see is not closed, and a stranger reaches none of it', async () => {
  const emergency = new FakeEmergency();
  emergency.positions = undefined;
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'close-pos', marketId: 16 });
  assert.match(String(lastScreen(h.telegram).payload['text']), /I can't see this position right now, so I won't close it\. Nothing was sent\./);
  await tapNav(h, { to: 'close-pos-go', marketId: 16 });
  assert.equal(emergency.positionRuns.length, 0);
  const open = new FakeEmergency();
  const s = harness({ killSwitch: new FakeKillSwitch(), emergency: open });
  for (const route of [{ to: 'close-pos', marketId: 16 }, { to: 'close-pos-go', marketId: 16 }] as Route[]) await tapNav(s, route, { from: STRANGER_ID, chat: STRANGER_CHAT });
  assert.equal(open.positionRuns.length, 0);
});

test('STOP EVERYTHING: the cost, position by position, losses rounded away from zero; confirmed by a TAP; the tap that opens it sends nothing', async () => {
  const emergency = new FakeEmergency();
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'stop-all' });
  const confirm = String(lastScreen(h.telegram).payload['text']);
  assert.match(confirm, /🆘 <b>STOP EVERYTHING\?<\/b>\n\nClosing 3 positions:/);
  // A LOSS ROUNDS AWAY FROM ZERO, a gain toward it: −84.4 reads −85, +31.7 reads +31.
  assert.match(confirm, /BTC long +0\.02 +−85 AUSD/);
  assert.match(confirm, /SOL long +14\.2 +\+31 AUSD/);
  // −84.4 − 12.1 + 31.7 = −64.8: shown as −65, never a smaller loss than the real one.
  assert.match(confirm, /You realise +−65 AUSD/);
  assert.match(confirm, /Prices move while this runs, so the real figure will differ\.\nAutomation stops first\./);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['🆘 Yes, stop everything', 'Cancel']);
  assert.equal(emergency.runs.length, 0, 'nothing runs on the tap that shows the cost');
});

test('STOP EVERYTHING: Yes runs it once; a second tap sends nothing; the result is read from the positions', async () => {
  const emergency = new FakeEmergency();
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'stop-all' });
  await tapNav(h, { to: 'stop-all-go' });
  assert.equal(emergency.runs.length, 1);
  const done = texts(h.telegram).at(-1)!;
  assert.match(done, /ALL CLOSED/);
  assert.match(done, /BTC +closed +0\.02 +at 85,102/);
  await tapNav(h, { to: 'stop-all-go' });
  assert.equal(emergency.runs.length, 1, 'the second Yes found nothing to confirm');
  assert.match(answers(h.telegram).at(-1)!, /already sent, or has expired/);
});

test('STOP EVERYTHING: a confirmation older than two minutes sends nothing and shows the cost again', async () => {
  const emergency = new FakeEmergency();
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'stop-all' });
  h.nowMs += 2 * 60_000 + 1;
  await tapNav(h, { to: 'stop-all-go' });
  assert.equal(emergency.runs.length, 0);
  assert.match(String(lastScreen(h.telegram).payload['text']), /more than two minutes old and prices have moved, so nothing was sent/);
});

test('STOP EVERYTHING: a partial close says what remains and offers Retry for it; Retry runs once; never DONE', async () => {
  const emergency = new FakeEmergency();
  const [btc, eth] = emergency.positions!;
  emergency.next = { kind: 'ran', complete: false, replayed: false, results: [
    { kind: 'closed', position: btc!, exitPrice: 85_102 },
    { kind: 'partial', position: eth!, closedLNS: 230n, remainingLNS: 80n, why: 'the close was sent, but the exchange did not fill it (not enough on the other side, or it expired)' },
  ] };
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'stop-all' });
  await tapNav(h, { to: 'stop-all-go' });
  const done = texts(h.telegram).at(-1)!;
  assert.match(done, /NOT ALL CLOSED/);
  assert.match(done, /ETH +PARTLY closed +0\.08 of 0\.31 left/);
  assert.match(done, /ETH didn't fully close/);
  assert.doesNotMatch(done, /🆘 <b>ALL CLOSED/);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['Retry ETH', '📊 My positions', '🏠 Menu']);

  await tapNav(h, { to: 'close-retry', marketId: 32 });
  await tapNav(h, { to: 'close-retry-go', marketId: 32 });
  await tapNav(h, { to: 'close-retry-go', marketId: 32 });
  assert.equal(emergency.runs.filter((r) => r.marketId === 32).length, 1, 'two taps, one close');
});

test('STOP EVERYTHING: a position that cannot be seen is NOT SEEN, never closed', async () => {
  const emergency = new FakeEmergency();
  const [btc] = emergency.positions!;
  emergency.next = { kind: 'ran', complete: false, replayed: false, results: [{ kind: 'not-seen', position: btc!, why: 'I cannot see your positions right now, so I cannot say whether it closed. Check it on Perpl.' }] };
  const h = harness({ killSwitch: new FakeKillSwitch(), emergency });
  await tapNav(h, { to: 'stop-all' });
  await tapNav(h, { to: 'stop-all-go' });
  const done = texts(h.telegram).at(-1)!;
  assert.match(done, /BTC +NOT SEEN/);
  assert.doesNotMatch(done, /BTC +closed|🆘 <b>ALL CLOSED/);
});

test('STOP EVERYTHING: flat, it offers only to stop automation; blind, it offers Stop automation only and closes nothing', async () => {
  const emergency = new FakeEmergency();
  emergency.positions = [];
  const killSwitch = new FakeKillSwitch();
  const h = harness({ killSwitch, emergency });
  await tapNav(h, { to: 'stop-all' });
  assert.match(String(lastScreen(h.telegram).payload['text']), /no open positions, so there's nothing to close\. This stops automation\./);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['🆘 Yes, stop automation', 'Cancel']);
  await tapNav(h, { to: 'stop-all-go' });
  assert.equal(emergency.runs.length, 0, 'no close-all request for a flat account');

  emergency.positions = undefined;
  await tapNav(h, { to: 'stop-all' });
  assert.match(String(lastScreen(h.telegram).payload['text']), /I can't see your positions right now, so I can't close them\.\nI can still stop automation — that works without the exchange\./);
  assert.deepEqual(keyboardOf(lastScreen(h.telegram)).map((b) => b.text), ['Stop automation only', 'Cancel']);
  assert.equal(emergency.runs.length, 0);
});


// ── 🔔 the alert that carries the action ─────────────────────────────────────────────

async function sendAlert(h: Harness, auto: AutoNow): Promise<FakeTelegram['calls'][number]> {
  const scenario = dangerScenario();
  h.view.loop = scenario.loop;
  h.view.assessments = [scenario.assessment];
  const send = createManualAlertSender({
    api: h.bot.api,
    store: h.store,
    links: h.links,
    sessions: new StaticSessionRouter([{ accountId: 710, view: h.view, executor: h.executor, balance: h.balance, status: () => h.sessionStatus }]),
    configs: CONFIGS,
    alerts: { bufferDecimals: 1 },
  });
  await send({ accountId: 710, assessment: scenario.assessment, alertPct: 5, auto });
  return h.telegram.last('sendMessage');
}

test('THE ALERT CARRIES THE ACTION: distance, margin and free balance; +100/+250 with the distance each buys, 🎛 Custom amount, Dismiss; nothing sent', async () => {
  const h = harness();
  const msg = await sendAlert(h, { kind: 'off' });
  const text = String(msg.payload['text']);
  assert.match(text, /^🔴 <b>BTC long is 2\.7% from liquidation<\/b>\nMargin <b>2,810 AUSD<\/b> · <b>10,000 AUSD<\/b> free$/);
  const labels = keyboardOf(msg).map((b) => b.text);
  assert.match(labels[0]!, /^\+100 → [\d.]+%$/);
  assert.match(labels[1]!, /^\+250 → [\d.]+%$/);
  assert.deepEqual(labels.slice(2), ['🎛 Custom amount', 'Dismiss']);
  assert.equal(h.executor.calls.length, 0);
});

test('THE ALERT: TWO TAPS — tapping +100 only shows the confirmation; the confirm sends, once', async () => {
  const h = harness();
  const msg = await sendAlert(h, { kind: 'off' });
  const plus100 = keyboardOf(msg).find((b) => b.text.startsWith('+100'))!;
  await h.bot.handleUpdate(callbackUpdate(plus100.callback_data));
  assert.equal(h.executor.calls.length, 0, 'a mis-tap on a notification sends nothing');
  assert.match(shown(h.telegram).at(-1)!, /Add 100 AUSD to BTC long\?/);
  const send = keyboardOf(h.telegram.last('sendMessage'))[0]!;
  await h.bot.handleUpdate(callbackUpdate(send.callback_data));
  assert.equal(h.executor.calls.length, 1);
  assert.equal(h.executor.calls[0]?.action.amountCNS, 100_000_000n);
});

test('THE ALERT: a button on it is issued to the linked person only', async () => {
  const h = harness();
  const msg = await sendAlert(h, { kind: 'off' });
  const plus100 = keyboardOf(msg).find((b) => b.text.startsWith('+100'))!;
  await h.bot.handleUpdate(callbackUpdate(plus100.callback_data, { from: STRANGER_ID, chat: STRANGER_CHAT }));
  assert.equal(h.executor.calls.length, 0);
});

test('THE ALERT, RESCUE ON: the same crossing says it is ADDING, not asking, with a one-tap Turn off', async () => {
  const h = harness();
  const msg = await sendAlert(h, { kind: 'adding', amountCNS: 100_000_000n, used: 0, max: 2 });
  const text = String(msg.payload['text']);
  assert.match(text, /^🔴 <b>BTC long is 2\.7% from liquidation<\/b>\n🛟 Rescue is adding <b>100 AUSD<\/b> now — top-up 1 of 2\. I'll tell you when it lands\.$/);
  assert.deepEqual(keyboardOf(msg).map((b) => b.text), ['📊 View position', '⛔ Turn off']);
});

test('THE ALERT, RESCUE ON BUT HELD: says why, and offers the amounts', async () => {
  const h = harness();
  const msg = await sendAlert(h, { kind: 'waiting', why: 'the cooldown since the last rescue has 9 min left' });
  assert.match(String(msg.payload['text']), /🛟 Rescue is on but not adding: the cooldown since the last rescue has 9 min left\./);
  assert.ok(keyboardOf(msg).some((b) => b.text.startsWith('+100')));
});

test('THE ALERT: Dismiss takes the buttons off and sends nothing', async () => {
  const h = harness();
  const msg = await sendAlert(h, { kind: 'off' });
  const dismiss = keyboardOf(msg).find((b) => b.text === 'Dismiss')!;
  await h.bot.handleUpdate(callbackUpdate(dismiss.callback_data));
  assert.equal(answers(h.telegram).at(-1), 'Dismissed. Nothing was sent.');
  assert.ok(h.telegram.of('editMessageReplyMarkup').length >= 1);
  assert.equal(h.executor.calls.length, 0);
});
