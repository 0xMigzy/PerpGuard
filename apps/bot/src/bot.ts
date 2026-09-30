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
import { UnknownFreeBalance, type FreeBalanceView } from './balance.ts';
import { decodeCallback, encodeCallback } from './callback.ts';
import type { BotConfig } from './config.ts';
import { CONFIRM_BUTTON_LABEL, RETRY_BUTTON_LABEL, renderConfirmation } from './confirm.ts';
import {
  CANCELLED_TEXT,
  NOTHING_TO_CANCEL_TEXT,
  PendingAmountStore,
  customAction,
  renderAmountPrompt,
  validateCustomAmount,
} from './custom.ts';
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
  /**
   * Open custom-amount prompts. Defaults to a fresh store on the same 15-minute
   * expiry as the action tokens.
   */
  readonly amounts?: PendingAmountStore;
  /**
   * Where the free-balance floor comes from.
   *
   * Defaults to "unknown", which is a real answer and the honest one for a bot
   * with no trading session behind it. It never blocks the custom-amount flow —
   * the amount is warned about, not refused. See `balance.ts`.
   */
  readonly balance?: FreeBalanceView;
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
  const amounts = deps.amounts ?? new PendingAmountStore({ now });
  const balance = deps.balance ?? new UnknownFreeBalance();
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

  // ── /cancel ───────────────────────────────────────────────────────────────
  // The way out of a prompt, from anywhere. It only ever clears the pending
  // question — there is nothing in flight for it to stop, because nothing is sent
  // before a confirmation.
  bot.command('cancel', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) return;
    const pending = amounts.get(telegramUserId);
    amounts.delete(telegramUserId);
    await ctx.reply(pending === undefined ? NOTHING_TO_CANCEL_TEXT : CANCELLED_TEXT);
  });

  // ── a typed amount ────────────────────────────────────────────────────────
  // Registered last, so it sees only text no command claimed. It does nothing at
  // all unless a prompt is open: a bot that answered every stray message would be
  // one people mute, and the muted bot is the one whose DANGER alert goes unread.
  bot.on('message:text', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) return;
    const pending = amounts.get(telegramUserId);
    if (pending === undefined) return;
    await handleTypedAmount(ctx, deps, { amounts, balance, alerts }, pending, ctx.message.text);
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

    if (payload.kind === 'custom') {
      // Nothing is stored yet but the question. The amount arrives as a message.
      await answer(ctx, 'Reply with an amount in AUSD.', false);
      await openAmountPrompt(ctx, deps, { amounts, balance, alerts }, pending, action);
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

/** What the custom-amount flow needs beyond {@link BotDeps}, resolved once. */
interface CustomDeps {
  readonly amounts: PendingAmountStore;
  readonly balance: FreeBalanceView;
  readonly alerts: AlertConfig;
}

/**
 * Ask for an amount.
 *
 * The projection at ZERO is doing two jobs: it restates where the position stands
 * for the prompt, and it establishes that a projection is possible AT ALL before
 * a question is asked. Asking someone for a number and only then discovering we
 * cannot price it would waste their time at the moment they have least of it.
 */
async function openAmountPrompt(
  ctx: Context,
  deps: BotDeps,
  custom: CustomDeps,
  pending: PendingAction,
  action: AlertAction,
): Promise<void> {
  const market = deps.configs.get(action.marketId);
  if (market === undefined) {
    await ctx.reply(
      `I have no market configuration for ${action.symbol}, so I cannot price an amount at the ` +
        `right precision. I am still watching the position.`,
    );
    return;
  }

  const projected = deps.view.projectAddMargin(action.marketId, 0n);
  if (!projected.ok) {
    await ctx.reply(`${projected.reason}. Run /positions when I can see it again.`);
    return;
  }
  const now = projected.projection;

  custom.amounts.put({
    userId: pending.userId,
    telegramUserId: pending.telegramUserId,
    marketId: action.marketId,
    symbol: action.symbol,
    positionId: action.positionId,
  });

  await ctx.reply(
    renderAmountPrompt({
      symbol: now.symbol,
      side: now.side,
      market,
      freeBalance: custom.balance.freeBalance(),
      bufferPct: now.resultingBufferPct,
      liquidationPricePNS: now.resultingLiquidationPricePNS,
      markPricePNS: now.markPricePNS,
      notionalCNS: now.notionalCNS,
      bufferDecimals: custom.alerts.bufferDecimals,
    }),
  );
}

/**
 * A reply to that question.
 *
 * THE PROMPT SURVIVES A BAD NUMBER. A refused amount says what is expected and
 * leaves the question open, so a typo costs one more message rather than sending
 * the user back through `/positions`. Everything that ENDS the flow — an
 * unavailable market, a position we can no longer see, a confirmation screen —
 * closes it.
 */
async function handleTypedAmount(
  ctx: Context,
  deps: BotDeps,
  custom: CustomDeps,
  pending: ReturnType<PendingAmountStore['put']>,
  text: string,
): Promise<void> {
  const close = (): void => custom.amounts.delete(pending.telegramUserId);

  const market = deps.configs.get(pending.marketId);
  if (market === undefined) {
    close();
    await ctx.reply(
      `I have no market configuration for ${pending.symbol}, so I cannot price an amount at the ` +
        `right precision.`,
    );
    return;
  }

  // Re-projected at reply time, not trusted from the prompt: the feed may have
  // dropped, or the position closed, in the seconds since the question was asked.
  const current = deps.view.projectAddMargin(pending.marketId, 0n);
  if (!current.ok) {
    close();
    await ctx.reply(`${current.reason}. Run /positions when I can see it again.`);
    return;
  }

  const verdict = validateCustomAmount(text, {
    market,
    freeBalance: custom.balance.freeBalance(),
    notionalCNS: current.projection.notionalCNS,
  });
  if (!verdict.ok) {
    // Prompt stays open on purpose.
    await ctx.reply(verdict.message);
    return;
  }

  const projected = deps.view.projectAddMargin(pending.marketId, verdict.amountCNS);
  if (!projected.ok) {
    close();
    await ctx.reply(`${projected.reason}. Run /positions when I can see it again.`);
    return;
  }

  const action = customAction(
    projected.projection,
    market,
    pending.positionId,
    custom.alerts.bufferDecimals,
  );

  // Asked of the ACTING venue, and asked HERE rather than only on the confirm
  // tap: a confirmation screen for a market that cannot be acted on is an offer
  // PerpGuard cannot honour.
  const availability = await availabilityFor(deps, action.symbol, [action]);
  if (availability === undefined || !availability.actionable) {
    close();
    await ctx.reply(unavailableText(availability));
    return;
  }

  const parked = deps.store.put({
    userId: pending.userId,
    telegramUserId: pending.telegramUserId,
    action,
  });
  close();

  const keyboard = new InlineKeyboard().text(
    CONFIRM_BUTTON_LABEL,
    encodeCallback({
      kind: 'confirm',
      token: parked.token,
      marketId: action.marketId,
      amountCNS: action.amountCNS,
    }),
  );
  await ctx.reply(renderConfirmation(action, market, verdict.warnings), {
    reply_markup: keyboard,
  });
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

  // THE MARKER CAN NEVER EXECUTE. The "Custom amount" button parks an action with
  // `amountCNS` 0 — it is a handle on a position, not a top-up — and a confirm
  // payload can be crafted against any token that exists. Refused here rather
  // than relying on the callback kinds never crossing, because "add no margin" is
  // a request the venue would happily accept and report on.
  if (action.amountCNS <= 0n) {
    await ctx.reply(
      'That button has no amount on it, so there is nothing to send. Tap Custom amount and ' +
        'reply with a figure, or run /positions.',
    );
    return;
  }

  const idempotencyKey = `${pending.userId}:${action.marketId}:${action.intent}:${pending.token}`;
  const outcome = await deps.executor.execute({
    idempotencyKey,
    userId: pending.userId,
    action,
  });

  switch (outcome.kind) {
    case 'applied':
      // EARNED, not assumed. The actions layer read this position's margin before
      // and after and saw the exact delta; the venue's own `st: 7 Failed` does not
      // appear here, because it is not what happened and saying it would only
      // teach the reader to distrust the answer.
      await ctx.reply(outcome.detail);
      return;
    case 'not-applied': {
      // THE ONE OUTCOME THAT EARNS A RETRY BUTTON. The position was read after the
      // send and had not moved, so nothing landed and nothing can land twice —
      // see the reasoning on RETRY_BUTTON_LABEL. The dropped-forwarder case is
      // real and common on testnet, and a trader whose rescue silently vanished
      // with no way to send it again is worse off than one we never alerted.
      //
      // A FRESH TOKEN, not the spent one: the retry is a new action with its own
      // `action_log` row, and it expires on the same fifteen minutes as every
      // other button, so an old "Send again" cannot send a stale amount.
      const retry = deps.store.put({
        userId: pending.userId,
        telegramUserId: pending.telegramUserId,
        action,
      });
      const keyboard = new InlineKeyboard().text(
        RETRY_BUTTON_LABEL,
        encodeCallback({
          kind: 'confirm',
          token: retry.token,
          marketId: action.marketId,
          amountCNS: action.amountCNS,
        }),
      );
      await ctx.reply(outcome.detail, { reply_markup: keyboard });
      return;
    }
    case 'unknown':
      // NO RETRY BUTTON HERE, deliberately. Something may have landed, and this is
      // the one state where sending again could double it. The reply must read as
      // neither success nor failure and must not leave a gap a user fills with a
      // retry of their own, which is what `nextStep` is for.
      await ctx.reply(`${outcome.detail}\n\n${outcome.nextStep}`);
      return;
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
