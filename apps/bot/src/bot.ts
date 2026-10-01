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
import type { ActionAvailability, IndexerHealth, MarketRiskConfig } from '@perpguard/shared';
import {
  DEFAULT_ALERT_CONFIG,
  type AlertAction,
  type AlertConfig,
} from '@perpguard/backend/alerts';
import type { MarketConfigs, RiskAssessment } from '@perpguard/backend/risk';
import {
  type ActionExecutor,
  type PendingAction,
  type PendingActionStore,
} from './actions.ts';
import { authorise } from './auth.ts';
import { decodeNav, encodeNav, isPublicRoute, type Route } from './nav.ts';
import { PendingQuestionStore } from './questions.ts';
import {
  WATCH_PLACEHOLDER,
  WATCH_PROMPT,
  connectGoScreen,
  connectScreen,
  connectUnavailableScreen,
  homeScreen,
  walletScreen,
  watchAskScreen,
  watchlistScreen,
  type AccountFacts,
  type Screen,
} from './screens.ts';
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
  labelFor,
  parseWatchArgument,
  parseWatchTarget,
  type WatchResolver,
  type WatchStore,
  type WatchTarget,
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
   * Proof-based linking: `/link` mints a one-time deep link to the page that
   * collects the proof; `/unlink` tears the link, its key and its session
   * down. Absent means the bot says linking is not available here.
   */
  readonly link?: {
    mint(userId: string): { readonly url: string; readonly expiresAtMs: number };
    unlink(userId: string): Promise<{ readonly ok: boolean; readonly text: string }>;
    /** Why a linked account cannot be served right now (a rotated key, say). */
    needsRelink?(userId: string): string | undefined;
  };
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
    /** One watched account's current assessments, for the watched-wallet screen. */
    readonly assessments?: (accountId: number) => readonly RiskAssessment[];
    /** What the last pass learned about one account; undefined means not read yet. */
    readonly facts?: (accountId: number) => AccountFacts | undefined;
    /** The mainnet market configs the watch loop prices with. */
    readonly configs?: () => ReadonlyMap<number, MarketRiskConfig> | undefined;
    /** Run a watch pass now, so a freshly watched account shows at once. Bounded by the bot. */
    readonly refresh?: () => Promise<unknown>;
  };
  /** The public web app, for the home screen's "Open PerpGuard" button. */
  readonly webUrl?: string;
  /** Open questions; defaults to a fresh store. */
  readonly questions?: PendingQuestionStore;
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
const PUBLIC_COMMANDS: ReadonlySet<string> = new Set(['/start', '/help', '/watch', '/link', '/unlink']);

/** At most one "I did not catch that" per chat per hour. */
const HINT_EVERY_MS = 60 * 60_000;

/** How long a fresh watch waits for the index before showing what it has. */
const REFRESH_WAIT_MS = 8_000;

function isUrlButtonError(error: unknown): boolean {
  return error instanceof Error && /BUTTON_URL_INVALID|wrong HTTP URL|URL host is empty/i.test(error.message);
}

function withoutUrlButtons(screen: Screen): Screen {
  return { ...screen, buttons: screen.buttons.map((row) => row.filter((b) => !('url' in b))).filter((row) => row.length > 0) };
}

/** A screen's buttons as Telegram's keyboard: routes become nav payloads, URLs stay URLs. */
export function keyboardFor(screen: Screen): InlineKeyboard {
  return InlineKeyboard.from(
    screen.buttons.map((row) => row.map((b) => ('url' in b ? InlineKeyboard.url(b.text, b.url) : InlineKeyboard.text(b.text, encodeNav(b.route))))),
  );
}

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
  const questions = deps.questions ?? new PendingQuestionStore({ now });
  const watchUnavailable = 'Watching is not available on this deployment: no mainnet index is wired to this bot.';
  /** When each chat was last pointed at the menu for chatter it sent. */
  const hinted = new Map<number, number>();

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
    const relink = deps.link?.needsRelink?.(link.userId);
    if (relink !== undefined) {
      return { refusal: `Your link to account ${link.accountId} needs renewing: ${relink}. Send /link to do that.` };
    }
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
    // A NAVIGATION tap to a PUBLIC route: a screen a watcher may see. Decoded
    // strictly, by a different decoder from the action buttons, so no action
    // payload — real or crafted — can pass as one. Everything else a tap can
    // carry is refused below, exactly as before.
    const data = ctx.callbackQuery?.data;
    if (data !== undefined) {
      const route = decodeNav(data);
      if (route !== undefined && isPublicRoute(route)) {
        await next();
        return;
      }
    }
    // Plain text is an ANSWER or a paste of something to watch; the text
    // handler decides, and it re-checks the link before anything that reads
    // an account.
    if (ctx.callbackQuery === undefined && ctx.message?.text !== undefined && command === undefined) {
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

  // ── screens ───────────────────────────────────────────────────────────────

  /** The chat's link, only if THIS chat is the linked one. A screen never shows another room's account. */
  const linkHere = (telegramUserId: number | undefined, chatId: number | undefined): LinkRecord | undefined => {
    const verdict = authorise(deps.links, telegramUserId, chatId);
    return verdict.ok ? verdict.link : undefined;
  };

  const watchedAssessments = (accountId: number): readonly RiskAssessment[] => deps.watch?.assessments?.(accountId) ?? [];

  const home = (chatId: number, telegramUserId: number | undefined): Screen => {
    const link = linkHere(telegramUserId, chatId);
    const subs = deps.watch?.store.byChat(chatId) ?? [];
    const own = link === undefined ? [] : (deps.sessions.forAccount(link.accountId)?.view.snapshot() ?? []);
    return homeScreen({
      health: deps.watch?.indexerHealth?.(),
      watching: subs.length,
      linkedAccountId: link?.accountId,
      assessments: [...own, ...subs.flatMap((sub) => watchedAssessments(sub.accountId))],
      webUrl: deps.webUrl,
    });
  };

  const watchlist = (chatId: number): Screen => {
    const watch = deps.watch;
    if (watch === undefined) return { html: watchUnavailable, buttons: [[{ text: '← Back', route: { to: 'home' } }]] };
    const rows = watch.store.byChat(chatId).map((sub) => ({ sub, assessments: watchedAssessments(sub.accountId), facts: watch.facts?.(sub.accountId) }));
    return watchlistScreen(rows, watch.store.maxPerChat);
  };

  const wallet = (chatId: number, accountId: number, extra: { lead?: string; back?: Route } = {}): Screen =>
    walletScreen({
      accountId,
      sub: deps.watch?.store.byChat(chatId).find((sub) => sub.accountId === accountId),
      assessments: watchedAssessments(accountId),
      facts: deps.watch?.facts?.(accountId),
      configs: deps.watch?.configs?.(),
      ...extra,
    });

  async function sendScreen(ctx: Context, screen: Screen): Promise<void> {
    try {
      await ctx.reply(screen.html, { parse_mode: 'HTML', reply_markup: keyboardFor(screen), link_preview_options: { is_disabled: true } });
    } catch (error) {
      // Telegram refuses the WHOLE message over one URL button it will not
      // open. The screen still goes out, without that button; any link it
      // carried is in the text as well.
      if (!isUrlButtonError(error)) throw error;
      const bare = withoutUrlButtons(screen);
      await ctx.reply(bare.html, { parse_mode: 'HTML', reply_markup: keyboardFor(bare), link_preview_options: { is_disabled: true } });
    }
  }

  /**
   * Show a screen in place of the one whose button was tapped, so navigating
   * does not pile up messages. "Not modified" is success; any other failure
   * (an old or deleted message) falls back to sending it fresh.
   */
  async function showScreen(ctx: Context, screen: Screen): Promise<void> {
    if (ctx.callbackQuery?.message === undefined) {
      await sendScreen(ctx, screen);
      return;
    }
    try {
      await ctx.editMessageText(screen.html, { parse_mode: 'HTML', reply_markup: keyboardFor(screen), link_preview_options: { is_disabled: true } });
    } catch (error) {
      if (error instanceof Error && /message is not modified/i.test(error.message)) return;
      if (isUrlButtonError(error)) {
        const bare = withoutUrlButtons(screen);
        await ctx.editMessageText(bare.html, { parse_mode: 'HTML', reply_markup: keyboardFor(bare), link_preview_options: { is_disabled: true } }).catch(() => sendScreen(ctx, bare));
        return;
      }
      await sendScreen(ctx, screen);
    }
  }

  /** Ask what to watch, with force_reply, and park the question so the answer is heard. */
  async function askWatchTarget(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat?.id;
    const telegramUserId = ctx.from?.id;
    if (chatId === undefined || telegramUserId === undefined) return;
    // One open question per person: a new one replaces a half-typed amount.
    amounts.delete(telegramUserId);
    questions.ask(chatId, telegramUserId, { kind: 'watch-target' });
    await ctx.reply(text, { reply_markup: { force_reply: true, input_field_placeholder: WATCH_PLACEHOLDER } });
  }

  /**
   * Resolve and watch, then show the wallet. Shared by `/watch <x>`, an answer
   * to the question, and a bare paste. Returns false when the target was
   * refused, so a caller holding an open question can ask again.
   */
  async function watchTarget(ctx: Context, target: WatchTarget): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return false;
    const watch = deps.watch;
    if (watch === undefined) {
      await ctx.reply(watchUnavailable);
      return true;
    }
    const resolved = await watch.resolver.resolve(target);
    if ('error' in resolved) {
      await ctx.reply(`I cannot watch that: ${resolved.error}`);
      return false;
    }
    const added = watch.store.add({ chatId, accountId: resolved.accountId, label: labelFor(target, resolved), addedAtMs: now() });
    if (!added.ok) {
      await sendScreen(ctx, { html: added.text, buttons: [[{ text: '📋 My watchlist', route: { to: 'watchlist' } }]] });
      return true;
    }
    if (!added.already && watch.refresh !== undefined) {
      // Bounded: a slow index shows "not read yet" rather than a hung chat.
      await Promise.race([watch.refresh().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS).unref?.())]);
    }
    const how = resolved.resolvedBy === 'chain' ? ' (found through the Exchange contract)' : '';
    const lead = added.already
      ? `Already watching <b>#${resolved.accountId}</b>.`
      : `Now watching <b>#${resolved.accountId}</b>${how}. I will message this chat when a position on it gets close to being closed.`;
    const screen = wallet(chatId, resolved.accountId, { lead, back: { to: 'home' } });
    await sendScreen(ctx, { ...screen, buttons: [[{ text: '📋 My watchlist', route: { to: 'watchlist' } }, { text: '← Home', route: { to: 'home' } }]] });
    return true;
  }

  // ── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (telegramUserId === undefined || chatId === undefined) return;

    if (!(await withinLimit(ctx))) return;

    // EVERYONE IS SOMEBODY. The sender gets their own identity on first sight,
    // whatever else happens below; the watch tier is theirs from here.
    identities.register(telegramUserId, chatId, now());

    const existing = deps.links.byTelegramUserId(telegramUserId);
    if (existing !== undefined && existing.chatId !== chatId) {
      await ctx.reply('You are connected, but in a different chat. Your account is only shown there. You can still watch any account from here.');
    }

    // THE ACTING SLOT IS NEVER FIRST-COME ON A PUBLIC BOT. Only the configured
    // owner claims it from /start; everyone else connects through the
    // proof-based page.
    const owner = deps.config.ownerTelegramUserId;
    if (existing === undefined && owner !== undefined && owner === telegramUserId && deps.ownerAccountId !== undefined) {
      const result = deps.links.link({ userId: deps.config.userId, accountId: deps.ownerAccountId, telegramUserId, chatId, linkedAtMs: now() });
      if (result.ok) await ctx.reply(`Connected to account #${deps.ownerAccountId}. Its alerts come here, with the buttons to act.`);
    }

    await sendScreen(ctx, home(chatId, telegramUserId));
  });

  // ── linking: the proof happens on the page, never in this chat ───────────
  bot.command('link', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (telegramUserId === undefined || chatId === undefined) return;
    if (!(await withinLimit(ctx))) return;
    if (deps.link === undefined) {
      await ctx.reply('Linking is not available on this deployment.');
      return;
    }
    const { identity } = identities.register(telegramUserId, chatId, now());
    const minted = deps.link.mint(identity.userId);
    const minutes = Math.max(1, Math.round((minted.expiresAtMs - now()) / 60_000));
    await ctx.reply(
      `Open this to link your Perpl account to this chat:\n${minted.url}\n\n` +
        `It works once, for ${minutes} minutes, and it proves nothing by itself: the page asks you to prove you own the account, ` +
        `with the wallet that owns it or with an API key for it. Never paste a key here in Telegram — only on that page.`,
      { link_preview_options: { is_disabled: true } },
    );
  });

  bot.command('unlink', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) return;
    if (!(await withinLimit(ctx))) return;
    if (deps.link === undefined) {
      await ctx.reply('Linking is not available on this deployment.');
      return;
    }
    const link = deps.links.byTelegramUserId(telegramUserId);
    if (link === undefined) {
      await ctx.reply('This chat is not linked to any account.');
      return;
    }
    const result = await deps.link.unlink(link.userId);
    await ctx.reply(result.text);
  });

  // ── the public watch tier ─────────────────────────────────────────────────
  // Anyone, any chat. Rate-limited per chat, capped per chat and bot-wide by
  // the store, resolved through the same index-then-chain lookups the web uses.
  // /unwatch and /watching are gone: the watch list and its buttons do both.
  bot.command('watch', async (ctx) => {
    if (!(await withinLimit(ctx))) return;
    if (deps.watch === undefined) {
      await ctx.reply(watchUnavailable);
      return;
    }
    const target = parseWatchTarget(ctx.message?.text ?? '');
    if ('error' in target) {
      // No argument, or one I cannot read: ASK, and hear the answer.
      const nothing = (ctx.message?.text ?? '').trim().split(/\s+/).length < 2;
      await askWatchTarget(ctx, nothing ? WATCH_PROMPT : `${target.error}\n\n${WATCH_PROMPT}`);
      return;
    }
    await watchTarget(ctx, target);
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
    await sendPositions(ctx);
  });

  async function sendPositions(ctx: Context): Promise<void> {
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
  }

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

  // ── plain text: an answer, a typed amount, or a paste ────────────────────
  // Registered last, so it sees only text no command claimed. In order:
  //   1. the answer to a question the bot asked (force_reply, parked);
  //   2. a typed amount for an open custom-amount prompt — LINKED CHAT ONLY,
  //      because it reads an account;
  //   3. an address or account id pasted without asking: watch it;
  //   4. anything else: one line pointing at the menu.
  bot.on('message:text', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (telegramUserId === undefined || chatId === undefined) return;
    const text = ctx.message.text;
    if (commandOf(text) !== undefined) return;

    const question = questions.peek(chatId, telegramUserId);
    if (question?.kind === 'watch-target') {
      if (!(await withinLimit(ctx))) return;
      const target = parseWatchArgument(text);
      if ('error' in target) {
        await askWatchTarget(ctx, `${target.error}\n\n${WATCH_PROMPT}`);
        return;
      }
      if (await watchTarget(ctx, target)) {
        questions.close(chatId, telegramUserId);
      } else {
        await askWatchTarget(ctx, 'Send another address or account id.');
      }
      return;
    }

    const pending = amounts.get(telegramUserId);
    if (pending !== undefined) {
      // The gate let plain text through so answers are heard; an amount reads
      // an account, so the link AND the room are checked again here.
      const verdict = authorise(deps.links, telegramUserId, chatId);
      if (!verdict.ok) {
        await ctx.reply(verdict.text);
        return;
      }
      const resolved = resolveAccount(telegramUserId);
      if ('refusal' in resolved) {
        amounts.delete(telegramUserId);
        await ctx.reply(resolved.refusal);
        return;
      }
      await handleTypedAmount(ctx, deps, { amounts, alerts, account: resolved.account }, pending, text);
      return;
    }

    const pasted = parseWatchArgument(text);
    if (!('error' in pasted)) {
      if (pasted.kind === 'account' && !/^#/.test(text.trim())) {
        // A BARE NUMBER NOBODY ASKED FOR IS AMBIGUOUS: an account id, or an
        // amount typed after its prompt expired. Offer, do not act.
        await sendScreen(ctx, {
          html: `Watch account <b>#${pasted.accountId}</b>?`,
          buttons: [[{ text: `👁 Watch #${pasted.accountId}`, route: { to: 'watch-id', accountId: pasted.accountId } }, { text: '🏠 Menu', route: { to: 'home' } }]],
        });
        return;
      }
      if (!(await withinLimit(ctx))) return;
      await watchTarget(ctx, pasted);
      return;
    }

    // Chatter gets ONE pointer an hour, not a reply each: a bot that answers
    // every stray message is one people mute, and the muted bot is the one
    // whose DANGER alert goes unread.
    const last = hinted.get(chatId);
    if (last !== undefined && now() - last < HINT_EVERY_MS) return;
    hinted.set(chatId, now());
    await sendScreen(ctx, {
      html: 'I did not catch that. Paste an address or an account id to watch it, or open the menu.',
      buttons: [[{ text: '🏠 Menu', route: { to: 'home' } }]],
    });
  });

  // ── navigation taps ───────────────────────────────────────────────────────
  // Public routes reach here from anyone; the gate refused every other route
  // from a chat that is not the linked one. Account routes still resolve the
  // link at tap time, like a command.
  async function handleNav(ctx: Context, route: Route): Promise<void> {
    const chatId = ctx.chat?.id;
    const telegramUserId = ctx.from?.id;
    if (chatId === undefined || telegramUserId === undefined) return;
    switch (route.to) {
      case 'home':
        await ctx.answerCallbackQuery();
        questions.close(chatId, telegramUserId);
        await showScreen(ctx, home(chatId, telegramUserId));
        return;
      case 'watch-ask':
        await ctx.answerCallbackQuery();
        if (deps.watch === undefined) {
          await showScreen(ctx, { html: watchUnavailable, buttons: [[{ text: '← Back', route: { to: 'home' } }]] });
          return;
        }
        await showScreen(ctx, watchAskScreen());
        await askWatchTarget(ctx, '↩️ Reply with it here.');
        return;
      case 'watch-id': {
        const verdict = limiter.allow(String(chatId));
        if (!verdict.ok) {
          await answer(ctx, `Slow down: try again in ${Math.ceil(verdict.retryInMs / 1000)}s.`);
          return;
        }
        await ctx.answerCallbackQuery();
        // The offer is answered: its buttons go, so it cannot be tapped twice
        // or read later as still open.
        await ctx.editMessageText(`Watch account <b>#${route.accountId}</b>? Yes.`, { parse_mode: 'HTML' }).catch(() => undefined);
        await watchTarget(ctx, { kind: 'account', accountId: route.accountId });
        return;
      }
      case 'watchlist':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, watchlist(chatId));
        return;
      case 'wallet':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, wallet(chatId, route.accountId));
        return;
      case 'unwatch': {
        const removed = deps.watch?.store.remove(chatId, route.accountId) ?? false;
        await ctx.answerCallbackQuery({ text: removed ? `Stopped watching #${route.accountId}.` : `You were not watching #${route.accountId}.` });
        const list = watchlist(chatId);
        await showScreen(ctx, { ...list, html: `${removed ? `Stopped watching <b>#${route.accountId}</b>.` : `You were not watching <b>#${route.accountId}</b>.`}\n\n${list.html}` });
        return;
      }
      case 'connect':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, connectScreen(linkHere(telegramUserId, chatId)?.accountId));
        return;
      case 'connect-go': {
        const linked = linkHere(telegramUserId, chatId);
        if (linked !== undefined) {
          await ctx.answerCallbackQuery();
          await showScreen(ctx, connectScreen(linked.accountId));
          return;
        }
        if (deps.link === undefined) {
          await ctx.answerCallbackQuery();
          await showScreen(ctx, connectUnavailableScreen());
          return;
        }
        const verdict = limiter.allow(String(chatId));
        if (!verdict.ok) {
          await answer(ctx, `Slow down: try again in ${Math.ceil(verdict.retryInMs / 1000)}s.`);
          return;
        }
        await ctx.answerCallbackQuery();
        const { identity } = identities.register(telegramUserId, chatId, now());
        const minted = deps.link.mint(identity.userId);
        await showScreen(ctx, connectGoScreen(minted.url, Math.max(1, Math.round((minted.expiresAtMs - now()) / 60_000))));
        return;
      }
      case 'positions':
        await ctx.answerCallbackQuery();
        await sendPositions(ctx);
        return;
      case 'position':
      case 'settings':
      case 'warn-ask':
      case 'warn-set':
      case 'disconnect-ask':
      case 'disconnect':
        await answer(ctx, 'That screen is not built yet.');
        return;
    }
  }

  // ── button taps ───────────────────────────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const route = decodeNav(data);
    if (route !== undefined) {
      await handleNav(ctx, route);
      return;
    }
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
