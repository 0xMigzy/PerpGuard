/**
 * The bot: commands, button taps, and the authorisation gate in front of both.
 *
 * Everything this file does is wiring. The words come from `render.ts` in the
 * alerts layer and from the pure renderers next door; the verdicts come from
 * `auth.ts`; the numbers come from the risk loop and are never recomputed here.
 *
 * NO ACTION IS EXECUTED FROM THIS FILE. A tap opens a confirmation screen, and a
 * confirmation goes to the injected {@link ActionExecutor}, which is stubbed. See
 * `actions.ts` for why a naive send would be worse than no send at all.
 */
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { ActionAvailability } from '@perpguard/shared';
import {
  DEFAULT_ALERT_CONFIG,
  type AlertAction,
  type AlertConfig,
} from '@perpguard/backend/alerts';
import type { MarketConfigs } from '@perpguard/backend/risk';
import {
  type ActionExecutor,
  type PendingAction,
  type PendingActionStore,
} from './actions.ts';
import { authorise } from './auth.ts';
import { decodeCallback, encodeCallback } from './callback.ts';
import type { BotConfig } from './config.ts';
import { CONFIRM_BUTTON_LABEL, renderConfirmation } from './confirm.ts';
import { buildTelegramMessage } from './format.ts';
import { HELP_TEXT } from './help.ts';
import type { LinkStore } from './links.ts';
import { positionEntries, positionsHeader } from './positions.ts';
import { renderStatus } from './status.ts';
import type { RiskView } from './view.ts';

export interface BotDeps {
  readonly config: BotConfig;
  readonly links: LinkStore;
  readonly store: PendingActionStore;
  readonly executor: ActionExecutor;
  readonly view: RiskView;
  /** Market scaling, so `/positions` renders every price at its own precision. */
  readonly configs: MarketConfigs;
  readonly alerts?: AlertConfig;
  readonly now?: () => number;
  /**
   * Supplied to skip grammY's `getMe` call.
   *
   * Tests pass it so nothing in this package ever opens a socket; production
   * leaves it out and lets grammY ask.
   */
  readonly botInfo?: UserFromGetMe;
}

/** Answering a tap is mandatory — Telegram spins the button forever otherwise. */
async function answer(ctx: Context, text: string, alert = true): Promise<void> {
  await ctx.answerCallbackQuery({
    // Telegram truncates a callback answer at 200 characters. Kept short here;
    // anything longer is sent as a message instead.
    text: text.length > 200 ? `${text.slice(0, 197)}...` : text,
    show_alert: alert,
  });
}

export function createBot(deps: BotDeps): Bot {
  const alerts = deps.alerts ?? DEFAULT_ALERT_CONFIG;
  const now = deps.now ?? Date.now;
  const bot = new Bot(deps.config.token, {
    ...(deps.botInfo === undefined ? {} : { botInfo: deps.botInfo }),
  });

  // ── the gate ──────────────────────────────────────────────────────────────
  // Before every handler. `/start` is the one thing an unlinked chat may send,
  // and it is let through to a handler that applies the link store's own policy
  // rather than deciding anything here.
  bot.use(async (ctx, next) => {
    const verdict = authorise(deps.links, ctx.from?.id, ctx.chat?.id);
    if (verdict.ok) {
      await next();
      return;
    }

    const isStart =
      verdict.code === 'not-linked' && (ctx.message?.text ?? '').trim().startsWith('/start');
    if (isStart) {
      await next();
      return;
    }

    // A refusal is still an answer. A tap that goes unanswered leaves the button
    // spinning, which reads as "working on it" — the last impression a refused
    // request should leave.
    if (ctx.callbackQuery !== undefined) {
      await answer(ctx, verdict.text);
      return;
    }
    if (ctx.message !== undefined) await ctx.reply(verdict.text);
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (telegramUserId === undefined || chatId === undefined) return;

    const existing = deps.links.byTelegramUserId(telegramUserId);
    if (existing !== undefined) {
      await ctx.reply(
        existing.chatId === chatId
          ? `Already linked. ${HELP_TEXT}`
          : 'You are linked, but in a different chat. PerpGuard only answers there.',
      );
      return;
    }

    const result = deps.links.link({
      userId: deps.config.userId,
      telegramUserId,
      chatId,
      linkedAtMs: now(),
    });

    if (!result.ok) {
      // Deliberately the same flat refusal whatever the cause: telling a
      // stranger whether the slot is taken or whether they are the wrong person
      // is the one useful fact to someone probing a leaked token.
      await ctx.reply(
        'PerpGuard is not accepting this chat. It answers one account and nobody else.',
      );
      return;
    }

    await ctx.reply(`Linked. I will send your alerts here.\n\n${HELP_TEXT}`);
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  // ── /status ───────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    await ctx.reply(
      renderStatus({
        network: deps.view.network,
        feed: deps.view.feedStatus(),
        positions: deps.view.positionsStatus(),
        assessments: deps.view.snapshot(),
        nowMs: now(),
      }),
    );
  });

  // ── /positions ────────────────────────────────────────────────────────────
  bot.command('positions', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) return;

    const assessments = deps.view.snapshot();
    const positions = deps.view.positionsStatus();
    await ctx.reply(positionsHeader(assessments, positions));

    for (const entry of positionEntries(assessments, deps.configs, alerts)) {
      if (!entry.ok) {
        await ctx.reply(entry.reason);
        continue;
      }
      const availability = await availabilityFor(deps, entry.message.symbol, entry.message.actions);
      const { text, keyboard } = buildTelegramMessage({
        message: entry.message,
        availability,
        store: deps.store,
        userId: deps.config.userId,
        telegramUserId,
      });
      await ctx.reply(text, {
        ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
        link_preview_options: { is_disabled: true },
      });
    }
  });

  // ── button taps ───────────────────────────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const decoded = decodeCallback(data);
    if (!decoded.ok) {
      await answer(ctx, `I can't read that button: ${decoded.reason}. Run /positions for a current one.`);
      return;
    }
    const payload = decoded.payload;

    const pending = deps.store.get(payload.token);
    if (pending === undefined) {
      // Expiry is a safety property, not an inconvenience: the amount on that
      // button reached a buffer at the mark it was rendered against, and the
      // mark has moved since.
      await answer(
        ctx,
        'That button has expired. The amount on it was for the mark at the time it was ' +
          'sent. Run /positions for a current one.',
      );
      return;
    }

    // Defence in depth. The gate above already established who this is; this
    // establishes that the token was issued TO them.
    if (pending.telegramUserId !== ctx.from.id) {
      await answer(ctx, 'That button was not issued to you.');
      return;
    }

    // THE CROSS-CHECK. The button says a market and an amount; the stored action
    // says a market and an amount. If they disagree, something has gone wrong
    // that could add margin to the wrong position, and the only safe move is to
    // do nothing and say so.
    const action = pending.action;
    if (action.marketId !== payload.marketId || action.amountCNS !== payload.amountCNS) {
      deps.store.delete(payload.token);
      await answer(
        ctx,
        'That button does not match the action I have on file for it, so I have discarded ' +
          'it. Run /positions and try again.',
      );
      return;
    }

    const availability = await availabilityFor(deps, action.symbol, [action]);
    if (availability === undefined || !availability.actionable) {
      await answer(ctx, unavailableText(availability));
      return;
    }

    if (payload.kind === 'blocked') {
      // The button was disabled when it was sent and the market has since opened.
      await answer(
        ctx,
        `${action.symbol} is actionable again on ${availability.network}. Run /positions ` +
          `for a live button with a current amount.`,
      );
      return;
    }

    if (payload.kind === 'act') {
      await answer(ctx, 'Check the amount, then confirm.', false);
      const keyboard = new InlineKeyboard().text(
        CONFIRM_BUTTON_LABEL,
        encodeCallback({
          kind: 'confirm',
          token: payload.token,
          marketId: action.marketId,
          amountCNS: action.amountCNS,
        }),
      );
      await ctx.reply(renderConfirmation(action, deps.configs.get(action.marketId)), {
        reply_markup: keyboard,
      });
      return;
    }

    // payload.kind === 'confirm'
    await runConfirmed(ctx, deps, pending, action);
  });

  return bot;
}

/** Ask the ACTING venue, and treat a thrown answer as "we do not know". */
async function availabilityFor(
  deps: BotDeps,
  symbol: string,
  actions: readonly AlertAction[],
): Promise<ActionAvailability | undefined> {
  if (actions.length === 0) return undefined;
  try {
    return await deps.executor.availability(symbol);
  } catch {
    return undefined;
  }
}

function unavailableText(availability: ActionAvailability | undefined): string {
  if (availability === undefined) {
    return 'I could not check whether this market can be acted on, so I will not act on it.';
  }
  if (availability.actionable) return '';
  return `Not actionable on ${availability.network}: ${availability.reason}`;
}

/**
 * The confirmed tap.
 *
 * The token is spent FIRST, before the executor is called. One in-flight action
 * per position: a double tap must not become two submissions, and a token that
 * survives its own execution is exactly how it would.
 */
async function runConfirmed(
  ctx: Context,
  deps: BotDeps,
  pending: PendingAction,
  action: AlertAction,
): Promise<void> {
  deps.store.delete(pending.token);
  await ctx.answerCallbackQuery();

  const idempotencyKey = `${pending.userId}:${action.marketId}:${action.intent}:${pending.token}`;
  const outcome = await deps.executor.execute({
    idempotencyKey,
    userId: pending.userId,
    action,
  });

  switch (outcome.kind) {
    case 'not-implemented':
      await ctx.reply(`Not sent. ${outcome.detail}`);
      return;
    case 'refused':
      await ctx.reply(`Refused before sending. ${outcome.detail}`);
      return;
    case 'submitted':
      // NOT success. Perpl answers a submission with `mt: 3` / `code: 0`, which
      // means forwarded and nothing more — the real outcome arrives later.
      await ctx.reply(`Sent. The outcome is not known yet. ${outcome.detail}`);
      return;
  }
}
