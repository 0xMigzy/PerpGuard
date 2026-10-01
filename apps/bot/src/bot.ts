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
 *
 * TWO TIERS. The linked owner may do everything. Anyone else may use the PUBLIC
 * commands — /start, /help, /watch, /unwatch, /watching — and nothing more: in
 * particular NO BUTTON TAP from an unlinked chat ever reaches a handler, however
 * its payload was made. The gate decides that before any handler runs, so a
 * watcher's alert carrying no keyboard is a rendering courtesy on top of a
 * refusal, not the refusal itself.
 */
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { ActionAvailability, IndexerHealth } from '@perpguard/shared';
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
import { InMemoryIdentityStore, type IdentityStore } from './identity.ts';
import type { LinkRecord } from './links.ts';
import type { AccountView, SessionRouter } from './sessions.ts';
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
import { HELP_TEXT, REFUSAL_TEXT } from './help.ts';
import type { LinkStore } from './links.ts';
import { positionEntries, positionsHeader } from './positions.ts';
import { renderStatus } from './status.ts';
import type { RiskView } from './view.ts';
import {
  DEFAULT_RATE_LIMIT,
  RateLimiter,
  TIERS_TEXT,
  labelFor,
  parseWatchTarget,
  renderWatched,
  renderWatching,
  type WatchResolver,
  type WatchStore,
} from './watch.ts';

export interface BotDeps {
  readonly config: BotConfig;
  readonly links: LinkStore;
  readonly store: PendingActionStore;
  /**
   * The live sessions, BY ACCOUNT. Every handler that reads positions or acts
   * resolves the requesting chat's link and then this, at request time; the
   * bot holds no view, executor or balance of its own any more.
   */
  readonly sessions: SessionRouter;
  /**
   * The account the configured owner's /start links to: the environment
   * key's account. Undefined means /start cannot link anyone, and says so.
   */
  readonly ownerAccountId?: number;
  /** Market scaling, so `/positions` renders every price at its own precision. */
  readonly configs: MarketConfigs;
  /**
   * Open custom-amount prompts. Defaults to a fresh store on the same 15-minute
   * expiry as the action tokens.
   */
  readonly amounts?: PendingAmountStore;
  readonly alerts?: AlertConfig;
  /**
   * Who the bot has met. Every /start registers the sender here, whether or
   * not they will ever link an account. Defaults to an in-memory store.
   */
  readonly identities?: IdentityStore;
  /**
   * The public watch tier. Absent means `/watch` says it is not available on
   * this deployment, which is the honest answer for a backend with no index.
   */
  readonly watch?: {
    readonly store: WatchStore;
    readonly resolver: WatchResolver;
    /** Per-chat command limit. Defaults to DEFAULT_RATE_LIMIT. */
    readonly limiter?: RateLimiter;
    /** The indexer verdict the watch loop last ran against, quoted in replies. */
    readonly indexerHealth?: () => IndexerHealth | undefined;
  };
  readonly now?: () => number;
  /**
   * Supplied to skip grammY's `getMe` call.
   *
   * Tests pass it so nothing in this package ever opens a socket; production
   * leaves it out and lets grammY ask.
   */
  readonly botInfo?: UserFromGetMe;
}

/**
 * The commands anyone may send, linked or not. Everything else, and EVERY
 * button tap, needs the link. Matched on the first word with any @mention
 * stripped, so `/watch@PerpGuardBot 0x…` in a group is `/watch`.
 */
const PUBLIC_COMMANDS: ReadonlySet<string> = new Set(['/start', '/help', '/watch', '/unwatch', '/watching']);

function commandOf(text: string | undefined): string | undefined {
  const first = text?.trim().split(/\s+/)[0];
  if (first === undefined || !first.startsWith('/')) return undefined;
  return first.replace(/@\w+$/, '').toLowerCase();
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
  const bot = new Bot(deps.config.token, {
    ...(deps.botInfo === undefined ? {} : { botInfo: deps.botInfo }),
  });

  const limiter = deps.watch?.limiter ?? new RateLimiter({ ...DEFAULT_RATE_LIMIT, now });
  const identities = deps.identities ?? new InMemoryIdentityStore();

  /**
   * THE REQUEST-TIME RULE. The requesting chat's link, and the live session for
   * the account that link names, looked up NOW — never remembered from the
   * message that carried the button, never from link time. A chat unlinked a
   * second ago is refused; an account whose session stopped is told so.
   */
  const resolveAccount = (telegramUserId: number | undefined): Resolved | { readonly refusal: string } => {
    if (telegramUserId === undefined) return { refusal: REFUSAL_TEXT };
    const link = deps.links.byTelegramUserId(telegramUserId);
    if (link === undefined) return { refusal: REFUSAL_TEXT };
    const account = deps.sessions.forAccount(link.accountId);
    if (account === undefined) {
      return { refusal: `Your linked account #${link.accountId} has no running session right now, so I cannot see or act on it. Try /status in a moment.` };
    }
    return { link, account };
  };

  // ── the gate ──────────────────────────────────────────────────────────────
  // Before every handler. The PUBLIC commands are let through to handlers that
  // apply their own policy — the link store's for /start, the watch store's caps
  // and the rate limit for the rest. EVERYTHING ELSE needs the link, and a
  // button tap from an unlinked chat is refused right here, whatever its
  // payload says: this is the server-side rule that a watcher cannot act, and
  // the renderer leaving the keyboard off a watch alert is only its echo.
  bot.use(async (ctx, next) => {
    const verdict = authorise(deps.links, ctx.from?.id, ctx.chat?.id);
    if (verdict.ok) {
      await next();
      return;
    }

    const command = commandOf(ctx.message?.text);
    if (ctx.callbackQuery === undefined && command !== undefined && PUBLIC_COMMANDS.has(command)) {
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

  /** The per-chat limit on public commands. False means the reply was already sent. */
  async function withinLimit(ctx: Context): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return false;
    const verdict = limiter.allow(String(chatId));
    if (verdict.ok) return true;
    await ctx.reply(`Slow down: too many commands from this chat. Try again in ${Math.ceil(verdict.retryInMs / 1000)}s.`);
    return false;
  }

  // ── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (telegramUserId === undefined || chatId === undefined) return;

    if (!(await withinLimit(ctx))) return;

    // EVERYONE IS SOMEBODY. The sender gets their own identity on first sight,
    // whatever else happens below; the watch tier is theirs from here.
    const registered = identities.register(telegramUserId, chatId, now());

    const existing = deps.links.byTelegramUserId(telegramUserId);
    if (existing !== undefined) {
      await ctx.reply(
        existing.chatId === chatId
          ? `Already linked. ${HELP_TEXT}`
          : 'You are linked, but in a different chat. PerpGuard only answers there.',
      );
      return;
    }

    // THE ACTING SLOT IS NEVER FIRST-COME ON A PUBLIC BOT. Only the configured
    // owner claims it from /start; everyone else is told how the two tiers work
    // and that linking their own account is a separate, proof-based step.
    const owner = deps.config.ownerTelegramUserId;
    if (owner !== undefined && owner === telegramUserId && deps.ownerAccountId !== undefined) {
      const result = deps.links.link({ userId: deps.config.userId, accountId: deps.ownerAccountId, telegramUserId, chatId, linkedAtMs: now() });
      if (result.ok) {
        await ctx.reply(`Linked to account ${deps.ownerAccountId}. I will send its alerts here, with the buttons to act.\n\n${TIERS_TEXT}\n\n${HELP_TEXT}`);
        return;
      }
    }

    await ctx.reply(
      `${registered.created ? 'Hello. ' : 'Welcome back. '}You are ${registered.identity.userId} here, and you can watch any account right now.\n\n` +
        `${TIERS_TEXT}\n\n` +
        `Linking your own account, to get the buttons, is a separate step that proves you own it; it is not done from this chat.\n\n${HELP_TEXT}`,
    );
  });

  // ── the public watch tier ─────────────────────────────────────────────────
  // Anyone, any chat. Rate-limited per chat, capped per chat and bot-wide by
  // the store, resolved through the same index-then-chain lookups the web uses.
  const watchUnavailable = 'Watching is not available on this deployment: no mainnet index is wired to this bot.';

  bot.command('watch', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!(await withinLimit(ctx))) return;
    const watch = deps.watch;
    if (watch === undefined) {
      await ctx.reply(watchUnavailable);
      return;
    }
    const target = parseWatchTarget(ctx.message?.text ?? '');
    if ('error' in target) {
      await ctx.reply(target.error);
      return;
    }
    const resolved = await watch.resolver.resolve(target);
    if ('error' in resolved) {
      await ctx.reply(`I cannot watch that: ${resolved.error}`);
      return;
    }
    const added = watch.store.add({ chatId, accountId: resolved.accountId, label: labelFor(target, resolved), addedAtMs: now() });
    if (!added.ok) {
      await ctx.reply(added.text);
      return;
    }
    await ctx.reply(renderWatched(added.subscription, resolved, added.already, watch.indexerHealth?.()));
  });

  bot.command('unwatch', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!(await withinLimit(ctx))) return;
    const watch = deps.watch;
    if (watch === undefined) {
      await ctx.reply(watchUnavailable);
      return;
    }
    const target = parseWatchTarget(ctx.message?.text ?? '');
    if ('error' in target) {
      await ctx.reply(target.error.replace('/watch', '/unwatch').replace('what to watch', 'what to stop watching'));
      return;
    }
    // An account id needs no lookup; an address goes through the resolver so
    // the same checksummed paste that started a watch can end it.
    let accountId: number;
    if (target.kind === 'account') {
      accountId = target.accountId;
    } else {
      const resolved = await watch.resolver.resolve(target);
      if ('error' in resolved) {
        await ctx.reply(`I cannot place that address: ${resolved.error}`);
        return;
      }
      accountId = resolved.accountId;
    }
    const removed = watch.store.remove(chatId, accountId);
    await ctx.reply(removed ? `Stopped watching account ${accountId}.` : `This chat was not watching account ${accountId}. /watching lists what it does.`);
  });

  bot.command('watching', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!(await withinLimit(ctx))) return;
    const watch = deps.watch;
    if (watch === undefined) {
      await ctx.reply(watchUnavailable);
      return;
    }
    await ctx.reply(renderWatching(watch.store.byChat(chatId), watch.indexerHealth?.(), watch.store.maxPerChat));
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  // ── /status ───────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const resolved = resolveAccount(ctx.from?.id);
    if ('refusal' in resolved) {
      await ctx.reply(resolved.refusal);
      return;
    }
    const { view } = resolved.account;
    await ctx.reply(
      `Account ${resolved.account.accountId}.\n` +
        renderStatus({
          network: view.network,
          feed: view.feedStatus(),
          positions: view.positionsStatus(),
          assessments: view.snapshot(),
          nowMs: now(),
        }),
    );
  });

  // ── /positions ────────────────────────────────────────────────────────────
  bot.command('positions', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) return;
    const resolved = resolveAccount(telegramUserId);
    if ('refusal' in resolved) {
      await ctx.reply(resolved.refusal);
      return;
    }
    const { account, link } = resolved;

    const assessments = account.view.snapshot();
    const positions = account.view.positionsStatus();
    await ctx.reply(positionsHeader(assessments, positions));

    for (const entry of positionEntries(assessments, deps.configs, alerts)) {
      if (!entry.ok) {
        await ctx.reply(entry.reason);
        continue;
      }
      const availability = await availabilityFor(account, entry.message.symbol, entry.message.actions);
      const { text, keyboard } = buildTelegramMessage({
        message: entry.message,
        availability,
        store: deps.store,
        userId: link.userId,
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
    const resolved = resolveAccount(telegramUserId);
    if ('refusal' in resolved) {
      amounts.delete(telegramUserId);
      await ctx.reply(resolved.refusal);
      return;
    }
    await handleTypedAmount(ctx, deps, { amounts, alerts, account: resolved.account }, pending, ctx.message.text);
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

    // The tapping chat's link and session, now. A tap on a button for an
    // account this chat is not linked to is refused here, before anything
    // that could act is even looked up.
    const resolved = resolveAccount(ctx.from.id);
    if ('refusal' in resolved) {
      await answer(ctx, resolved.refusal);
      return;
    }
    if (action.accountId !== undefined && action.accountId !== resolved.link.accountId) {
      deps.store.delete(payload.token);
      await answer(ctx, `That button is for account ${action.accountId}; this chat is linked to account ${resolved.link.accountId}. Discarded.`);
      return;
    }
    const { account } = resolved;

    const availability = await availabilityFor(account, action.symbol, [action]);
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
      await openAmountPrompt(ctx, deps, { amounts, alerts, account }, pending, action);
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
    await runConfirmed(ctx, deps, pending, action, resolved);
  });

  return bot;
}

/** The requesting chat's link and the live session it names. */
interface Resolved {
  readonly link: LinkRecord;
  readonly account: AccountView;
}

/** What the custom-amount flow needs beyond {@link BotDeps}, resolved once per request. */
interface CustomDeps {
  readonly amounts: PendingAmountStore;
  readonly alerts: AlertConfig;
  /** The requesting chat's session: its view and its free-balance floor. */
  readonly account: AccountView;
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

  const projected = custom.account.view.projectAddMargin(action.marketId, 0n);
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
      freeBalance: custom.account.balance.freeBalance(),
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
  const current = custom.account.view.projectAddMargin(pending.marketId, 0n);
  if (!current.ok) {
    close();
    await ctx.reply(`${current.reason}. Run /positions when I can see it again.`);
    return;
  }

  const verdict = validateCustomAmount(text, {
    market,
    freeBalance: custom.account.balance.freeBalance(),
    notionalCNS: current.projection.notionalCNS,
  });
  if (!verdict.ok) {
    // Prompt stays open on purpose.
    await ctx.reply(verdict.message);
    return;
  }

  const projected = custom.account.view.projectAddMargin(pending.marketId, verdict.amountCNS);
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
  const availability = await availabilityFor(custom.account, action.symbol, [action]);
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
  account: AccountView,
  symbol: string,
  actions: readonly AlertAction[],
): Promise<ActionAvailability | undefined> {
  if (actions.length === 0) return undefined;
  try {
    return await account.executor.availability(symbol);
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
  resolved: Resolved,
): Promise<void> {
  deps.store.delete(pending.token);
  await ctx.answerCallbackQuery();

  // RE-CHECKED AT THE MOMENT OF THE REQUEST, not carried from the tap that
  // opened the confirmation: the link may have gone, or point elsewhere, since.
  const fresh = deps.links.byTelegramUserId(ctx.from?.id ?? -1);
  if (fresh === undefined || fresh.accountId !== resolved.link.accountId) {
    await ctx.reply('This chat is no longer linked to the account that action is for. Nothing was sent.');
    return;
  }
  if (action.accountId !== undefined && action.accountId !== fresh.accountId) {
    await ctx.reply(`That action is for account ${action.accountId}; this chat is linked to account ${fresh.accountId}. Nothing was sent.`);
    return;
  }
  const account = deps.sessions.forAccount(fresh.accountId);
  if (account === undefined) {
    await ctx.reply(`Your linked account #${fresh.accountId} has no running session right now. Nothing was sent.`);
    return;
  }

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
  const outcome = await account.executor.execute({
    idempotencyKey,
    userId: pending.userId,
    accountId: fresh.accountId,
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
