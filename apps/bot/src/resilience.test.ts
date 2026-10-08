/**
 * 8 Oct 2026: one stale tap's 400 on `answerCallbackQuery` stopped long
 * polling. The bot kept pushing alerts and heard no command until a restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, BotError, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { makeResilient } from './resilience.ts';

const BOT_INFO = {
  id: 1, is_bot: true, first_name: 'PerpGuard', username: 'PerpGuardBot',
  can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
} as const;

const STALE = 'Bad Request: query is too old and response timeout expired or query ID is invalid';

function build(): { bot: Bot; calls: string[]; lines: string[] } {
  const bot = new Bot('1:test', { botInfo: BOT_INFO as never });
  const calls: string[] = [];
  const lines: string[] = [];
  // Installed FIRST, so it is the innermost call: Telegram itself.
  bot.api.config.use(async (_prev, method) => {
    calls.push(method);
    if (method === 'answerCallbackQuery') return { ok: false, error_code: 400, description: STALE } as never;
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, text: '' } } as never;
  });
  makeResilient(bot, (line) => lines.push(line));
  return { bot, calls, lines };
}

const tap: Update = {
  update_id: 21_328_559,
  callback_query: {
    id: 'q1', chat_instance: 'c', data: 'n1:h',
    from: { id: 5, is_bot: false, first_name: 'T' },
    message: { message_id: 9, date: 0, chat: { id: 5, type: 'private', first_name: 'T' } },
  },
};

test('A STALE TAP STILL GETS ITS SCREEN: the 400 on the answer is logged, not thrown', async () => {
  const { bot, calls, lines } = build();
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('home');
  });
  await bot.handleUpdate(tap);
  assert.deepEqual(calls, ['answerCallbackQuery', 'sendMessage']);
  assert.match(lines.join('\n'), /callback answer refused/);
});

test('ONLY the stale answer is forgiven: a 400 on a send still throws', async () => {
  const bot = new Bot('1:test', { botInfo: BOT_INFO as never });
  bot.api.config.use(async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) as never);
  makeResilient(bot);
  await assert.rejects(bot.api.sendMessage(5, 'x'), /chat not found/);
});

test('A HANDLER THAT THROWS NEVER STOPS POLLING: the error handler logs and returns', async () => {
  const { bot, lines } = build();
  const error = new BotError(new Error('boom'), { update: tap } as unknown as Context);
  // grammY's default handler rethrows, which is what ends `bot.start()`.
  await bot.errorHandler(error);
  assert.match(lines.join('\n'), /update 21328559 failed and was dropped; still polling: boom/);
});
