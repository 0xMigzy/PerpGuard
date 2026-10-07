/**
 * TWO PEOPLE, ONE BOT (7 Oct 2026). The real bot, the real Rescue control, the
 * real kill switch and the real settings store; only Telegram's wire and the
 * two account sessions are faked. A and B are linked from their own chats to
 * their own accounts and use the bot at the same time.
 *
 * What it proves, per thing a person owns: positions, risk readings, actions,
 * Rescue rules, the kill switch and settings are each scoped to the chat's own
 * link, and a request from one person can neither read nor act on the other's
 * account. (Alerts are proven one layer down, in `sessions/registry.test.ts`,
 * with two real sessions.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot, encodeNav, InMemoryAccountSettingsStore, InMemoryLinkStore, StaticSessionRouter, type LinkRecord, type Route } from '@perpguard/bot';
import { CONFIGS, FakeBalance, FakeExecutor, FakeView, OWNER_CHAT, OWNER_ID, TEST_TOKEN, callbackUpdate, dangerAssessment, fakeBot, messageUpdate, newStore, type FakeTelegram } from '@perpguard/bot/test-support';
import { decodeCallback } from '@perpguard/bot';
import { InMemoryAutomationStore } from './rescue/automation.ts';
import { RescueControlService } from './rescue/control.ts';
import { ArmSigner } from './rescue/arming.ts';
import { KillSwitch } from './rescue/killSwitch.ts';
import { InMemoryRescueStore } from './rescue/store.ts';
import type { RiskAssessment } from './risk/types.ts';

const A = { telegramUserId: OWNER_ID, chatId: OWNER_CHAT, accountId: 710 };
const B = { telegramUserId: 7_001, chatId: 7_002, accountId: 711 };

function world() {
  const { bot, telegram } = fakeBot();
  const links = new InMemoryLinkStore({
    capacity: 5,
    seed: [
      { userId: 'tg:A', accountId: A.accountId, telegramUserId: A.telegramUserId, chatId: A.chatId, linkedAtMs: 1 } satisfies LinkRecord,
      { userId: 'tg:B', accountId: B.accountId, telegramUserId: B.telegramUserId, chatId: B.chatId, linkedAtMs: 2 } satisfies LinkRecord,
    ],
  });
  const base = dangerAssessment();
  // A: close to liquidation. B: same market, a different position, far from it.
  const viewA = new FakeView();
  viewA.assessments = [{ ...base, accountId: A.accountId, liqBufferPct: 0.025 } as RiskAssessment];
  const viewB = new FakeView();
  viewB.assessments = [{ ...base, accountId: B.accountId, positionId: 999_999, liqBufferPct: 0.15 } as RiskAssessment];
  const execA = new FakeExecutor();
  const execB = new FakeExecutor();
  const signedIn = () => ({ trading: { state: 'signed-in', forwardingAllowed: true } }) as const;
  const sessions = new StaticSessionRouter([
    { accountId: A.accountId, view: viewA, executor: execA, balance: new FakeBalance(), status: signedIn },
    { accountId: B.accountId, view: viewB, executor: execB, balance: new FakeBalance(), status: signedIn },
  ]);
  const automation = new InMemoryAutomationStore();
  const rescueStore = new InMemoryRescueStore();
  const byAccount = new Map([[A.accountId, viewA], [B.accountId, viewB]]);
  const settings = new InMemoryAccountSettingsStore();
  const rescue = new RescueControlService({
    store: rescueStore,
    automation,
    collateralDecimals: 6,
    signer: new ArmSigner('22'.repeat(32)),
    isLinked: (tg, chat, acct) => links.byTelegramUserId(tg)?.accountId === acct && links.byTelegramUserId(tg)?.chatId === chat,
    alertPctOf: (id) => settings.get(id).alertPct,
    snapshot: (id) => byAccount.get(id)?.snapshot(),
  });
  const killSwitch = new KillSwitch({ automation, rescueStore, rescueEngine: { inFlightOn: () => false, settleAccount: async () => true }, log: () => {} });
  const built = createBot({
    config: { token: TEST_TOKEN, userId: 'tg:A', ownerTelegramUserId: undefined },
    links,
    store: newStore(),
    sessions,
    tradingNetwork: 'testnet',
    configs: CONFIGS,
    settings,
    rescue,
    killSwitch: { stopped: (id) => automation.automationStopped(id), changedAtMs: (id) => killSwitch.changedAtMs(id), stop: (id, by) => killSwitch.stop(id, by), resume: (id, by) => killSwitch.resume(id, by) },
    botInfo: bot.botInfo,
  });
  telegram.install(built.api);
  const tap = (who: typeof A, route: Route) => built.handleUpdate(callbackUpdate(encodeNav(route), { from: who.telegramUserId, chat: who.chatId }));
  const say = (who: typeof A, text: string) => built.handleUpdate(messageUpdate(text, { from: who.telegramUserId, chat: who.chatId }));
  return { bot: built, telegram, viewA, viewB, execA, execB, automation, rescueStore, settings, tap, say, base };
}

/** The last screen shown IN ONE PERSON'S CHAT. */
function lastIn(telegram: FakeTelegram, chatId: number): string {
  const call = [...telegram.calls].reverse().find((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload['chat_id'] === chatId);
  return call === undefined ? '' : String(call.payload['text']);
}
function buttonsIn(telegram: FakeTelegram, chatId: number): Array<{ text: string; callback_data: string }> {
  const call = [...telegram.calls].reverse().find((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload['chat_id'] === chatId);
  const markup = call?.payload['reply_markup'] as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined;
  return markup?.inline_keyboard?.flat() ?? [];
}

test('POSITIONS AND RISK READINGS: each person sees only their own account', async () => {
  const w = world();
  await w.tap(A, { to: 'positions' });
  await w.tap(B, { to: 'positions' });
  const a = lastIn(w.telegram, A.chatId);
  const b = lastIn(w.telegram, B.chatId);
  assert.match(a, /#710/);
  assert.match(a, /2\.5% from liquidation/);
  assert.doesNotMatch(a, /15\.0%|#711/);
  assert.match(b, /#711/);
  assert.match(b, /15\.0% from liquidation/);
  assert.doesNotMatch(b, /2\.5%|#710/);
});

test('ACTIONS: B cannot use a button issued to A; A\'s action runs on A\'s executor only', async () => {
  const w = world();
  await w.tap(A, { to: 'position', marketId: w.base.marketId });
  const aButton = buttonsIn(w.telegram, A.chatId).find((x) => decodeCallback(x.callback_data).ok);
  assert.ok(aButton !== undefined, 'A was offered a top-up');
  // B replays A's exact payload from B's own chat.
  await w.bot.handleUpdate(callbackUpdate(aButton.callback_data, { from: B.telegramUserId, chat: B.chatId }));
  const refusals = w.telegram.of('answerCallbackQuery').map((c) => String(c.payload['text'] ?? ''));
  assert.ok(refusals.some((t) => /not issued to you/.test(t)), refusals.join(' | '));
  assert.equal(w.execA.calls.length + w.execB.calls.length, 0, 'nothing ran on either account');
  // A taps it, then sends.
  await w.bot.handleUpdate(callbackUpdate(aButton.callback_data, { from: A.telegramUserId, chat: A.chatId }));
  const send = buttonsIn(w.telegram, A.chatId)[0]!;
  await w.bot.handleUpdate(callbackUpdate(send.callback_data, { from: A.telegramUserId, chat: A.chatId }));
  assert.equal(w.execA.calls.length, 1);
  assert.equal(w.execB.calls.length, 0, "B's account was never touched");
});

test('B cannot act from A\'s chat either: a link is for one person in one chat', async () => {
  const w = world();
  await w.bot.handleUpdate(callbackUpdate(encodeNav({ to: 'positions' }), { from: B.telegramUserId, chat: A.chatId }));
  assert.ok(w.telegram.of('answerCallbackQuery').some((c) => String(c.payload['text'] ?? '').length > 0));
  assert.doesNotMatch(lastIn(w.telegram, A.chatId), /#711|15\.0%/);
});

test('RESCUE RULES: A\'s rule is A\'s; B\'s menu shows nothing of it and B\'s stop cannot reach it', async () => {
  const w = world();
  await w.tap(A, { to: 'rescue-cfg', marketId: w.base.marketId });
  await w.tap(A, { to: 'rescue-trig', level: 2 });
  await w.tap(A, { to: 'rescue-amt', level: 0 });
  await w.tap(A, { to: 'rescue-on' });
  assert.equal(w.rescueStore.enabledRules().length, 1);
  assert.equal(w.rescueStore.enabledRules()[0]?.accountId, A.accountId);

  await w.tap(B, { to: 'rescue' });
  assert.match(lastIn(w.telegram, B.chatId), /Account: <b>#711<\/b>[\s\S]*Auto top-up: ⚪ off everywhere/);
  // B taps Stop on the SAME market id: it is B's account that is asked, and B has no rule there.
  await w.tap(B, { to: 'rescue-stop', marketId: w.base.marketId });
  assert.equal(w.rescueStore.enabledRules().length, 1, "A's rule is still on");
});

test('KILL SWITCH: A stopping automation stops A only; B can still turn Rescue on', async () => {
  const w = world();
  await w.tap(A, { to: 'kill-stop' });
  assert.equal(w.automation.automationStopped(A.accountId), true);
  assert.equal(w.automation.automationStopped(B.accountId), false);
  await w.tap(B, { to: 'rescue-cfg', marketId: w.base.marketId });
  await w.tap(B, { to: 'rescue-trig', level: 0 });
  await w.tap(B, { to: 'rescue-amt', level: 0 });
  await w.tap(B, { to: 'rescue-on' });
  assert.equal(w.rescueStore.enabledRules().filter((r) => r.accountId === B.accountId).length, 1, 'B is unaffected');
});

test('SETTINGS: A changing the alert distance leaves B\'s untouched', async () => {
  const w = world();
  const before = w.settings.get(B.accountId).alertPct;
  await w.tap(A, { to: 'warn-set', level: 0 });
  assert.equal(w.settings.get(A.accountId).alertPct, 2);
  assert.equal(w.settings.get(B.accountId).alertPct, before);
});

test('TYPED ANSWERS: a custom alert distance A is asked for is heard from A only', async () => {
  const w = world();
  const before = w.settings.get(B.accountId).alertPct;
  await w.tap(A, { to: 'alert-custom' });
  // B types a number in B's own chat: it must not become A's distance, nor B's.
  await w.say(B, '4');
  await w.say(A, '6');
  assert.equal(w.settings.get(A.accountId).alertPct, 6);
  assert.equal(w.settings.get(B.accountId).alertPct, before);
});
