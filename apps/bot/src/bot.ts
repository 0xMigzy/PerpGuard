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
import { makeResilient } from './resilience.ts';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { ActingMarket, ActionAvailability, IndexerHealth, MarketRiskConfig, NetworkName } from '@perpguard/shared';
import {
  DEFAULT_ALERT_CONFIG,
  type AlertAction,
  type AlertConfig,
} from '@perpguard/backend/alerts';
import { isBlind, type MarketConfigs, type RiskAssessment } from '@perpguard/backend/risk';
import {
  type ActionExecutor,
  type PendingAction,
  type PendingActionStore,
} from './actions.ts';
import { authorise } from './auth.ts';
import {
  confirmScreen,
  disconnectAskScreen,
  blindLine,
  ADD_MARGIN_PRESETS_AUSD,
  outcomeScreen,
  positionScreen,
  positionsScreen,
  sendingScreen,
  settingsScreen,
  warnAskScreen,
} from './account.ts';
import { InMemoryAccountSettingsStore, type AccountSettingsStore } from './settings.ts';
import { buildMessage } from '@perpguard/backend/alerts/render';
import { esc, pct, withBadge } from '@perpguard/backend/alerts/plain';
import { kindFor } from '@perpguard/backend/alerts/rules';
import { ALERT_DISTANCE_PRESETS, MAX_ALERT_DISTANCE_PCT, MIN_ALERT_DISTANCE_PCT, distanceLabel, parseAlertDistance } from '@perpguard/backend/manual/distance';
import { OFF_LEVEL, decodeNav, decodeNavTap, encodeNav, isNavShaped, isPublicRoute, type Route } from './nav.ts';
import { EXECUTION_UNKNOWN, executionState, type ExecutionState } from './trading.ts';
import {
  WARNING_LEVELS_PROMPT,
  alertSettingsScreen,
  largeTradesScreen,
  liquidationsScreen,
  presetAt,
  walletAddedScreen,
  walletsScreen,
  warningCustomAskScreen,
  warningLevelsScreen,
  watchMenuScreen,
  watchlistScreen,
  type TraderStats,
} from './watchScreens.ts';
import { DEFAULT_PREFERENCES, InMemoryPreferenceStore, LARGE_TRADE_PRESETS_AUSD, LIQUIDATION_PRESETS_AUSD, type AlertPreferences } from '@perpguard/backend/events/preferences';
import { parseCustomLevels } from '@perpguard/backend/events/warnings';
import { PendingQuestionStore } from './questions.ts';
import { killConfirmScreen, killResultScreen, killResumeAskScreen, killResumedScreen, type KillSwitchControl } from './killSwitch.ts';
import {
  STOP_ALL_CONFIRM_MS,
  closeAllResultScreen,
  closeRetryScreen,
  killScreen,
  stopAllConfirmScreen,
  stopAllExpiredScreen,
  type EmergencyControl,
} from './emergency.ts';

/** A request id for one close-everything (or one retry): random, used once. */
const newRequestId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
import {
  applyLimit,
  unitOf,
  capOf,
  freshDraft,
  parseRescueAmount,
  RESCUE_AMOUNTS_AUSD,
  RESCUE_DEFAULTS,
  RescueDraftStore,
  rescueAmountScreen,
  rescueLimitsScreen,
  rescueMenuScreen,
  rescuePositionScreen,
  type RescueControl,
  type RescueDraft,
} from './rescue.ts';
import {
  WATCH_PLACEHOLDER,
  WATCH_PROMPT,
  accountScreen,
  connectGoScreen,
  connectUnavailableScreen,
  homeScreen,
  walletScreen,
  watchAskScreen,
  type AccountFacts,
  type Screen,
} from './screens.ts';
import { InMemoryIdentityStore, type IdentityStore } from './identity.ts';
import type { LinkRecord } from './links.ts';
import type { AccountView, SessionRouter } from './sessions.ts';
import { decodeCallback, encodeCallback } from './callback.ts';
import type { BotConfig } from './config.ts';
import {
  PendingAmountStore,
  customAction,
  renderAmountPrompt,
  validateCustomAmount,
} from './custom.ts';
import { HELP_TEXT, OLD_MENU_TEXT, REFUSAL_TEXT } from './help.ts';
import type { LinkStore } from './links.ts';
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
  /**
   * One line per button tap: who, from which chat, linked or not, and what the
   * button names (a screen, or an action's kind, market and amount). NEVER the
   * token. Owner's finding, 7 Oct 2026: a recorded session's taps left no trace.
   */
  readonly log?: (line: string) => void;
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
    /** `telegramName` lets the page say which Telegram account it is linking. */
    mint(userId: string, telegramName?: string): { readonly url: string; readonly expiresAtMs: number };
    unlink(userId: string): Promise<{ readonly ok: boolean; readonly text: string }>;
    /** Why a linked account cannot be served right now (a rotated key, say). */
    needsRelink?(userId: string): string | undefined;
    /** Ownership a wallet proved for this identity, kept even when nothing is linked yet (it waits for a key). */
    walletProof?(userId: string): { readonly address: string; readonly accountId: number } | undefined;
    /** Whether an API key is stored for this identity: Disconnect says it deletes one only when there is one. */
    hasKey?(userId: string): boolean;
    /** How the link is backed, from records: for the Trading Account's Wallet and Ownership rows. */
    status?(userId: string): { readonly proof: 'wallet' | 'key' | 'owner'; readonly wallet: { readonly address: string } | undefined } | undefined;
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
    /** Each chat's own alert settings: feed thresholds, wallet alerts, warning levels. Defaults to in memory. */
    readonly preferences?: { get(chatId: number): AlertPreferences; set(chatId: number, preferences: AlertPreferences): Promise<void> };
    /** One account's figures from the index, for the Watchlist. Absent: the Watchlist says so. */
    readonly traders?: {
      stats(accountId: number): Promise<TraderStats>;
    };
  };
  /** The public web app, for the home screen's "Open PerpGuard" button. */
  readonly webUrl?: string;
  /**
   * The network a Trading Account is on in this deployment, named on every
   * screen that shows one. A linked account's own session's network wins.
   */
  readonly tradingNetwork?: NetworkName;
  /** Open questions; defaults to a fresh store. */
  readonly questions?: PendingQuestionStore;
  /** Each linked account's own settings ("Warn me at"). Defaults to in memory. */
  readonly settings?: AccountSettingsStore;
  /** 🛟 Liquidation Rescue: rules read and written through the backend, which re-validates them. Absent: no Rescue button. */
  readonly rescue?: RescueControl;
  /** 🔴 Kill Switch: stop automation, leave positions open. Absent: no Kill Switch button. */
  readonly killSwitch?: KillSwitchControl;
  /** 🚪 Close everything, on the 🆘 Emergency screen. Absent: the screen offers the stop only. */
  readonly emergency?: EmergencyControl;
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
const PUBLIC_COMMANDS: ReadonlySet<string> = new Set(['/start', '/help', '/watch', '/link']);

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
    screen.buttons.map((row) =>
      row.map((b) => ('url' in b ? InlineKeyboard.url(b.text, b.url) : 'data' in b ? InlineKeyboard.text(b.text, b.data) : InlineKeyboard.text(b.text, encodeNav(b.route, { fresh: b.fresh === true })))),
    ),
  );
}

/** How the person appears in Telegram: @username, else their first name. */
function telegramNameOf(ctx: Context): string | undefined {
  const from = ctx.from;
  if (from === undefined) return undefined;
  return from.username !== undefined ? `@${from.username}` : from.first_name || undefined;
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
  makeResilient(bot, deps.log);

  const limiter = deps.watch?.limiter ?? new RateLimiter({ ...DEFAULT_RATE_LIMIT, now });
  const identities = deps.identities ?? new InMemoryIdentityStore();
  const questions = deps.questions ?? new PendingQuestionStore({ now });
  const drafts = new RescueDraftStore(now);

  /**
   * ONE NUMBER: saves the account's alert distance, and moves every armed AUTO
   * top-up on the account to it (they act where the alert fires). False, and
   * nothing changed, when it could not be saved.
   */
  async function saveAlertDistance(accountId: number, alertPct: number): Promise<boolean> {
    try {
      await settings.set(accountId, { ...settings.get(accountId), alertPct });
    } catch {
      return false;
    }
    await deps.rescue?.followAlertDistance?.(accountId, alertPct / 100);
    return true;
  }
  /** One pending retry per chat, person and market: minted when its confirm screen is shown, consumed by the tap. */
  const retryRequests = new Map<string, string>();
  /** 🆘 Stop everything: the request each chat's cost screen confirms, minted when it was shown, run at most once. */
  const stopAllRequests = new Map<string, { readonly requestId: string; readonly shownAtMs: number }>();
  const settings = deps.settings ?? new InMemoryAccountSettingsStore();
  const watchUnavailable = 'Watching is not available on this deployment: no mainnet index is wired to this bot.';
  /** Taps whose screen opens as a new message, leaving the tapped one as it is. */
  const freshTaps = new WeakSet<Context>();
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
    // ONE NETWORK PER TRADING ACCOUNT: a link made on another network names another account here, or none.
    if (link.network !== undefined && deps.tradingNetwork !== undefined && link.network !== deps.tradingNetwork) {
      return { refusal: `Your account #${link.accountId} was connected on ${link.network}, but PerpGuard trades on ${deps.tradingNetwork} here, so nothing can act on it. Send /link to connect a ${deps.tradingNetwork} account.` };
    }
    const relink = deps.link?.needsRelink?.(link.userId);
    if (relink !== undefined) {
      return { refusal: `Your link to account ${link.accountId} needs renewing: ${relink}. Send /link to do that.` };
    }
    const account = deps.sessions.forAccount(link.accountId);
    if (account === undefined) {
      return { refusal: `Your linked account #${link.accountId} has no running session right now, so I cannot see or act on it. Try again in a moment.` };
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
  // ── every tap, logged before anything decides about it ────────────────────
  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (data !== undefined && deps.log !== undefined) {
      const linked = authorise(deps.links, ctx.from?.id, ctx.chat?.id).ok;
      deps.log(`tap tg:${ctx.from?.id ?? '?'} chat ${ctx.chat?.id ?? '?'} (${linked ? 'linked' : 'not linked'}): ${describeTap(data)}`);
    }
    // EVERY COMMAND, LOGGED TOO (8 Oct 2026): "did /start reach the bot?" must be answerable from the box.
    // The command name only, never its argument (an address someone is watching is theirs).
    const command = commandOf(ctx.message?.text);
    if (command !== undefined && deps.log !== undefined) {
      const linked = authorise(deps.links, ctx.from?.id, ctx.chat?.id).ok;
      deps.log(`command tg:${ctx.from?.id ?? '?'} chat ${ctx.chat?.id ?? '?'} (${linked ? 'linked' : 'not linked'}): /${command}`);
    }
    await next();
  });

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

  /** The linked account's Execution line, from its live session at the moment of asking. */
  const executionFor = (link: LinkRecord): ExecutionState => {
    if (link.network !== undefined && deps.tradingNetwork !== undefined && link.network !== deps.tradingNetwork) return executionState({ otherNetwork: { linkedOn: link.network, tradingOn: deps.tradingNetwork } });
    const needsRelink = deps.link?.needsRelink?.(link.userId);
    if (needsRelink !== undefined) return executionState({ needsRelink });
    const account = deps.sessions.forAccount(link.accountId);
    if (account === undefined) return executionState({});
    const session = account.status?.();
    return session === undefined ? EXECUTION_UNKNOWN : executionState({ session });
  };

  /** The home screen's Automation line, from the rules as they are now. */
  const automationLine = (accountId: number): string | undefined => {
    if (deps.killSwitch?.stopped(accountId) === true) return '🛑 Stopped';
    if (deps.rescue === undefined) return undefined;
    if (deps.rescue.stopped(accountId)) return '🛑 Stopped';
    const on = deps.rescue.rules(accountId).filter((r) => r.enabled && r.pausedReason === undefined);
    if (on.length > 0) return `🟢 Rescue on ${on.map((r) => esc(r.symbol)).join(', ')}`;
    const other = deps.rescue.otherAutomation(accountId);
    return other === undefined ? undefined : esc(other);
  };

  const home = (chatId: number, telegramUserId: number | undefined): Screen => {
    const link = linkHere(telegramUserId, chatId);
    const subs = deps.watch?.store.byChat(chatId) ?? [];
    const session = link === undefined ? undefined : deps.sessions.forAccount(link.accountId);
    const own = session?.view.snapshot() ?? [];
    return homeScreen({
      health: deps.watch?.indexerHealth?.(),
      watching: subs.length,
      account:
        link === undefined
          ? undefined
          : {
              accountId: link.accountId,
              network: session?.view.network ?? deps.tradingNetwork,
              execution: executionFor(link),
              warnAt: distanceLabel(settings.get(link.accountId).alertPct),
              automation: automationLine(link.accountId),
            },
      rescue: deps.rescue !== undefined && link !== undefined,
      killSwitch: deps.killSwitch !== undefined && link !== undefined,
      tradingNetwork: deps.tradingNetwork,
      assessments: [...own, ...subs.flatMap((sub) => watchedAssessments(sub.accountId))],
    });
  };

  const tradingAccount = (chatId: number, telegramUserId: number): Screen => {
    const link = linkHere(telegramUserId, chatId);
    if (link === undefined) {
      // OWNERSHIP PROVEN, EXECUTION NOT YET: a wallet signed for an account but no key followed. Say exactly that.
      const proven = deps.link?.walletProof?.(identities.register(telegramUserId, chatId, now()).identity.userId);
      return accountScreen({
        accountId: undefined,
        network: deps.tradingNetwork,
        execution: undefined,
        ...(proven === undefined ? {} : { proven: { accountId: proven.accountId, walletAddress: proven.address } }),
      });
    }
    const session = deps.sessions.forAccount(link.accountId);
    return accountScreen({
      accountId: link.accountId,
      network: session?.view.network ?? deps.tradingNetwork,
      execution: executionFor(link),
      linkedAtMs: link.linkedAtMs,
    });
  };

  const preferences = deps.watch?.preferences ?? new InMemoryPreferenceStore();
  const prefsOf = (chatId: number): AlertPreferences => preferences.get(chatId) ?? DEFAULT_PREFERENCES;

  /** 👛 Every wallet this chat watches. */
  const wallets = (chatId: number): Screen => {
    const watch = deps.watch;
    if (watch === undefined) return { html: watchUnavailable, buttons: [[{ text: '← Back', route: { to: 'home' } }]] };
    const rows = watch.store.byChat(chatId).map((sub) => ({ sub, assessments: watchedAssessments(sub.accountId), facts: watch.facts?.(sub.accountId) }));
    return walletsScreen(rows, watch.store.maxPerChat);
  };

  /** ⭐ The starred ones, with their figures from the index (at most five, so five reads). */
  const watchlist = async (chatId: number): Promise<Screen> => {
    const watch = deps.watch;
    if (watch === undefined) return { html: watchUnavailable, buttons: [[{ text: '← Back', route: { to: 'home' } }]] };
    const starred = watch.store.byChat(chatId).filter((sub) => sub.starred === true);
    const stats = await Promise.all(
      starred.map((sub) => watch.traders?.stats(sub.accountId).catch(() => undefined) ?? Promise.resolve(undefined)),
    );
    return watchlistScreen(starred.map((sub, i) => stats[i] ?? { accountId: sub.accountId, month: undefined, lifetime: undefined }));
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

  const sendScreenRaw = (c: Context, screen: Screen): Promise<void> => sendScreen(c, screen);
  const showScreenRaw = (c: Context, screen: Screen): Promise<void> => showScreen(c, screen);
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
    if (ctx.callbackQuery?.message === undefined || freshTaps.has(ctx)) {
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
  async function askWarningLevels(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat?.id;
    const telegramUserId = ctx.from?.id;
    if (chatId === undefined || telegramUserId === undefined) return;
    amounts.delete(telegramUserId);
    questions.ask(chatId, telegramUserId, { kind: 'warning-levels' });
    await ctx.reply(text, { reply_markup: { force_reply: true, input_field_placeholder: '15 8 3' } });
  }

  /** Saves this chat's settings, toasting the result. False (and nothing changed) when it could not be saved. */
  async function savePrefs(ctx: Context, chatId: number, next: AlertPreferences): Promise<boolean> {
    try {
      await preferences.set(chatId, next);
    } catch {
      await answer(ctx, 'I could not save that, so nothing changed. Try again in a moment.');
      return false;
    }
    if (ctx.callbackQuery !== undefined) await ctx.answerCallbackQuery({ text: 'Saved.' });
    return true;
  }

  /** The per-chat limit, for taps that read the index. */
  async function tapWithinLimit(ctx: Context, chatId: number): Promise<boolean> {
    const verdict = limiter.allow(String(chatId));
    if (verdict.ok) return true;
    await answer(ctx, `Slow down: try again in ${Math.ceil(verdict.retryInMs / 1000)}s.`);
    return false;
  }

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
      await sendScreen(ctx, { html: added.text, buttons: [[{ text: '👛 Watched wallets', route: { to: 'wallets' } }]] });
      return true;
    }
    if (!added.already && watch.refresh !== undefined) {
      // Bounded: a slow index shows "not read yet" rather than a hung chat.
      await Promise.race([watch.refresh().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS).unref?.())]);
    }
    const how = resolved.resolvedBy === 'chain' ? ' (found through the Exchange contract)' : '';
    await sendScreen(
      ctx,
      walletAddedScreen({ accountId: resolved.accountId, label: added.subscription.label, already: added.already, starred: added.subscription.starred === true, via: how }),
    );
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
      const result = deps.links.link({ userId: deps.config.userId, accountId: deps.ownerAccountId, telegramUserId, chatId, linkedAtMs: now(), ...(deps.tradingNetwork === undefined ? {} : { network: deps.tradingNetwork }) });
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
    const minted = deps.link.mint(identity.userId, telegramNameOf(ctx));
    const minutes = Math.max(1, Math.round((minted.expiresAtMs - now()) / 60_000));
    await ctx.reply(`Open this to connect your Perpl account (works once, for ${minutes} minutes):\n${minted.url}\n\nNever paste a key here.`, { link_preview_options: { is_disabled: true } });
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
    if (question?.kind === 'alert-distance') {
      const verdict = authorise(deps.links, telegramUserId, chatId);
      if (!verdict.ok) {
        questions.close(chatId, telegramUserId);
        await ctx.reply(verdict.text);
        return;
      }
      const parsed = parseAlertDistance(text);
      if ('error' in parsed) {
        await ctx.reply(parsed.error, { reply_markup: { force_reply: true, input_field_placeholder: '4' } });
        return;
      }
      questions.close(chatId, telegramUserId);
      if (!(await saveAlertDistance(verdict.link.accountId, parsed.pct))) {
        await ctx.reply('I could not save that, so nothing changed. Try again in a moment.');
        return;
      }
      await sendScreen(ctx, settingsScreen(verdict.link.accountId, settings.get(verdict.link.accountId), deps.tradingNetwork));
      return;
    }
    if (question?.kind === 'rescue-amount') {
      await handleRescueAnswer(ctx, text);
      return;
    }
    if (question?.kind === 'warning-levels') {
      const parsed = parseCustomLevels(text);
      if ('error' in parsed) {
        await askWarningLevels(ctx, `${parsed.error}\n\n${WARNING_LEVELS_PROMPT.replace(/<\/?b>/g, '')}`);
        return;
      }
      const next = { ...prefsOf(chatId), warningLevels: parsed.levels };
      try {
        await preferences.set(chatId, next);
      } catch {
        await ctx.reply('I could not save that, so nothing changed. Try again in a moment.');
        return;
      }
      questions.close(chatId, telegramUserId);
      await sendScreen(ctx, warningLevelsScreen(next.warningLevels));
      return;
    }
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
      html: "I didn't catch that. Send an address or account number to watch it, or open the menu.",
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
      case 'watch-menu': {
        await ctx.answerCallbackQuery();
        questions.close(chatId, telegramUserId);
        const subs = deps.watch?.store.byChat(chatId) ?? [];
        await showScreen(ctx, watchMenuScreen({ watching: subs.length, starred: subs.filter((s) => s.starred === true).length, maxPerChat: deps.watch?.store.maxPerChat ?? 0, health: deps.watch?.indexerHealth?.() }));
        return;
      }
      case 'wallets':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, wallets(chatId));
        return;
      case 'star':
      case 'unstar': {
        const on = route.to === 'star';
        const changed = deps.watch?.store.star(chatId, route.accountId, on) ?? false;
        await ctx.answerCallbackQuery({ text: changed ? (on ? `#${route.accountId} is on your Watchlist.` : `#${route.accountId} is off your Watchlist.`) : `You are not watching #${route.accountId} here.` });
        await showScreen(ctx, await watchlist(chatId));
        return;
      }
      case 'liq':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, liquidationsScreen(prefsOf(chatId).liquidationMinAusd));
        return;
      case 'big':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, largeTradesScreen(prefsOf(chatId).largeTradeMinAusd));
        return;
      case 'liq-set':
      case 'big-set': {
        const presets = route.to === 'liq-set' ? LIQUIDATION_PRESETS_AUSD : LARGE_TRADE_PRESETS_AUSD;
        const value = route.level === OFF_LEVEL ? undefined : presets[route.level];
        if (route.level !== OFF_LEVEL && value === undefined) {
          await answer(ctx, 'I do not know that setting.');
          return;
        }
        const before = prefsOf(chatId);
        const next = route.to === 'liq-set' ? { ...before, liquidationMinAusd: value } : { ...before, largeTradeMinAusd: value };
        if (!(await savePrefs(ctx, chatId, next))) return;
        await showScreen(ctx, route.to === 'liq-set' ? liquidationsScreen(next.liquidationMinAusd) : largeTradesScreen(next.largeTradeMinAusd));
        return;
      }
      case 'warn-levels':
        await ctx.answerCallbackQuery();
        questions.close(chatId, telegramUserId);
        await showScreen(ctx, warningLevelsScreen(prefsOf(chatId).warningLevels));
        return;
      case 'warn-preset': {
        const levels = presetAt(route.level);
        if (levels === undefined) {
          await answer(ctx, 'I do not know that setting.');
          return;
        }
        const next = { ...prefsOf(chatId), warningLevels: levels };
        if (!(await savePrefs(ctx, chatId, next))) return;
        await showScreen(ctx, warningLevelsScreen(next.warningLevels));
        return;
      }
      case 'warn-custom':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, warningCustomAskScreen());
        await askWarningLevels(ctx, '↩️ Reply with your levels here.');
        return;
      case 'alert-settings':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, alertSettingsScreen(prefsOf(chatId)));
        return;
      case 'wallet-alerts': {
        const before = prefsOf(chatId);
        const next = { ...before, walletAlerts: !before.walletAlerts };
        if (!(await savePrefs(ctx, chatId, next))) return;
        await showScreen(ctx, alertSettingsScreen(next));
        return;
      }
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
        await ctx.editMessageText(`Watching <b>#${route.accountId}</b>.`, { parse_mode: 'HTML' }).catch(() => undefined);
        await watchTarget(ctx, { kind: 'account', accountId: route.accountId });
        return;
      }
      case 'watchlist':
        if (!(await tapWithinLimit(ctx, chatId))) return;
        await ctx.answerCallbackQuery();
        await showScreen(ctx, await watchlist(chatId));
        return;
      case 'wallet':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, wallet(chatId, route.accountId));
        return;
      case 'unwatch': {
        const removed = deps.watch?.store.remove(chatId, route.accountId) ?? false;
        await ctx.answerCallbackQuery({ text: removed ? `Stopped watching #${route.accountId}.` : `You were not watching #${route.accountId}.` });
        const list = wallets(chatId);
        await showScreen(ctx, { ...list, html: `${removed ? `Stopped watching <b>#${route.accountId}</b>.` : `You were not watching <b>#${route.accountId}</b>.`}\n\n${list.html}` });
        return;
      }
      case 'account':
      case 'connect':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, tradingAccount(chatId, telegramUserId));
        return;
      case 'connect-go':
      case 'connect-key': {
        // A linked chat may open the connect page too, to fix its authorization (a rotated key, a key for
        // another account, an account on another network); one whose execution is fine has no reason to.
        const linked = linkHere(telegramUserId, chatId);
        if (linked !== undefined && executionFor(linked).dot === '🟢') {
          await ctx.answerCallbackQuery();
          await showScreen(ctx, tradingAccount(chatId, telegramUserId));
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
        const minted = deps.link.mint(identity.userId, telegramNameOf(ctx));
        const via = route.to === 'connect-key' ? 'key' : 'wallet';
        // The page opens on the key form for 🔑, on the wallet for 🔗. The code is the proof of the chat; neither is proof of the account.
        const url = via === 'key' ? `${minted.url}${minted.url.includes('?') ? '&' : '?'}via=key` : minted.url;
        await showScreen(ctx, connectGoScreen(url, Math.max(1, Math.round((minted.expiresAtMs - now()) / 60_000)), via));
        return;
      }
      case 'disconnect-ask':
      case 'disconnect': {
        // PUBLIC, BECAUSE ANYTHING HELD CAN BE UNDONE: a wallet proof with no link yet, or a link whose
        // session is down (a rotated key). Only the tapper's OWN records are read, at tap time.
        const { identity } = identities.register(telegramUserId, chatId, now());
        const linked = linkHere(telegramUserId, chatId);
        const proof = deps.link?.walletProof?.(identity.userId);
        const accountId = linked?.accountId ?? proof?.accountId;
        if (accountId === undefined) {
          await ctx.answerCallbackQuery({ text: 'Nothing is connected here.' });
          await showScreen(ctx, tradingAccount(chatId, telegramUserId));
          return;
        }
        await ctx.answerCallbackQuery();
        if (route.to === 'disconnect-ask') {
          const wallet = proof !== undefined && proof.accountId === accountId ? proof.address : undefined;
          await showScreen(ctx, badged(deps, disconnectAskScreen({ accountId, linked: linked !== undefined, hasKey: deps.link?.hasKey?.(identity.userId) ?? linked !== undefined, ...(wallet === undefined ? {} : { walletAddress: wallet }) })));
          return;
        }
        const result =
          deps.link !== undefined
            ? await deps.link.unlink(linked?.userId ?? identity.userId)
            : { ok: deps.links.unlink(telegramUserId), text: `Disconnected from account #${accountId}.` };
        const after = home(chatId, telegramUserId);
        // Home for a chat that is no longer connected: no account, so no network badge.
        await showScreen(ctx, { ...after, html: `${esc(result.text)}\n\n${after.html}` });
        return;
      }
      case 'dismiss':
        // The alert's words stay as the record; its buttons go, so nothing on it can be tapped later.
        await ctx.answerCallbackQuery({ text: 'Dismissed. Nothing was sent.' });
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        } catch {
          // An old or deleted message: nothing to take the buttons off.
        }
        return;
      case 'kill':
      case 'kill-confirm':
      case 'kill-stop':
      case 'kill-resume-ask':
      case 'kill-resume':
      case 'stop-all':
      case 'stop-all-go':
      case 'close-retry':
      case 'close-retry-go':
        await killNav(ctx, route);
        return;
      default:
        await accountNav(ctx, route);
        return;
    }
  }

  // ── the account half: every route resolves the link at tap time ──────────
  async function accountNav(ctx: Context, route: Route): Promise<void> {
    // THE NETWORK ON EVERY ACTION SCREEN: every screen this handler shows carries the acting network's badge.
    const showScreen = (c: Context, screen: Screen): Promise<void> => showScreenRaw(c, badged(deps, screen));
    const sendScreen = (c: Context, screen: Screen): Promise<void> => sendScreenRaw(c, badged(deps, screen));
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) return;
    const resolved = resolveAccount(telegramUserId);
    if ('refusal' in resolved) {
      await answer(ctx, resolved.refusal);
      return;
    }
    const { account, link } = resolved;
    const { view } = account;
    // Navigating away drops a half-typed custom amount: Back is the way out.
    amounts.delete(telegramUserId);

    const mint = (action: AlertAction, kind: 'act' | 'custom' | 'blocked'): string =>
      encodeCallback({ kind, token: deps.store.put({ userId: link.userId, telegramUserId, action }).token, marketId: action.marketId, amountCNS: action.amountCNS });

    switch (route.to) {
      case 'positions':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, positionsScreen({ accountId: account.accountId, network: view.network ?? deps.tradingNetwork, assessments: view.snapshot(), feed: view.feedStatus(), positions: view.positionsStatus(), free: account.balance.freeBalance(), configs: deps.configs }));
        return;
      case 'position': {
        const assessment = view.snapshot().find((a) => a.marketId === route.marketId);
        const market = deps.configs.get(route.marketId);
        if (assessment === undefined || market === undefined) {
          await answer(ctx, assessment === undefined ? "That position isn't open any more." : "I have no market details for that position, so I can't price it.");
          await showScreen(ctx, positionsScreen({ accountId: account.accountId, network: view.network ?? deps.tradingNetwork, assessments: view.snapshot(), feed: view.feedStatus(), positions: view.positionsStatus(), free: account.balance.freeBalance(), configs: deps.configs }));
          return;
        }
        await ctx.answerCallbackQuery();
        // Asked of the ACTING venue before any amount is offered: an amount it will not take is not an offer.
        const probe: AlertAction = { type: 'add-margin', intent: 'custom', marketId: assessment.marketId, symbol: assessment.symbol, positionId: assessment.positionId, amountCNS: 0n, label: 'probe' };
        const availability = await availabilityFor(account, assessment, [probe]);
        const kind: 'act' | 'blocked' = availability?.actionable === true ? 'act' : 'blocked';
        const unit = 10n ** BigInt(market.collateralDecimals);
        const canPrice = !isBlind(assessment.state) && blindLine(view.feedStatus(), view.positionsStatus()) === undefined;
        // Each amount priced by the engine NOW, so its button shows the distance it buys and the confirmation's after-figures are this position's.
        const presets = !canPrice
          ? []
          : ADD_MARGIN_PRESETS_AUSD.map((ausd) => {
              const projected = view.projectAddMargin(assessment.marketId, BigInt(ausd) * unit);
              if (!projected.ok) return { ausd, reason: projected.reason };
              const action = customAction(projected.projection, market, assessment.positionId, alerts.bufferDecimals, assessment.liqBufferPct);
              return { ausd, data: mint(action, kind), resultingBufferPct: action.resultingBufferPct };
            });
        const custom: AlertAction = { type: 'add-margin', intent: 'custom', marketId: assessment.marketId, symbol: assessment.symbol, positionId: assessment.positionId, ...(assessment.accountId === undefined ? {} : { accountId: assessment.accountId }), amountCNS: 0n, label: 'Custom amount' };
        await showScreen(ctx, positionScreen({ assessment, market, free: account.balance.freeBalance(), feed: view.feedStatus(), positions: view.positionsStatus(), availability, presets, customData: mint(custom, kind === 'act' ? 'custom' : 'blocked') }));
        return;
      }
      case 'rescue':
      case 'rescue-pos':
      case 'rescue-cfg':
      case 'rescue-amt':
      case 'rescue-amt-custom':
      case 'rescue-limits':
      case 'rescue-lim':
      case 'rescue-on':
      case 'rescue-on-next':
      case 'rescue-stop':
      case 'rescue-resume':
        await rescueNav(ctx, route, account, link);
        return;
      case 'settings':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, settingsScreen(account.accountId, settings.get(account.accountId), view.network ?? deps.tradingNetwork));
        return;
      case 'warn-ask':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, warnAskScreen(settings.get(account.accountId).alertPct));
        return;
      case 'warn-set': {
        const pctChosen = ALERT_DISTANCE_PRESETS[route.level];
        if (pctChosen === undefined) {
          await answer(ctx, 'I do not know that setting.');
          return;
        }
        if (!(await saveAlertDistance(account.accountId, pctChosen))) {
          await answer(ctx, 'I could not save that, so nothing changed. Try again in a moment.');
          return;
        }
        await ctx.answerCallbackQuery({ text: `Saved: alerts at ${distanceLabel(pctChosen)}.` });
        await showScreen(ctx, settingsScreen(account.accountId, settings.get(account.accountId), view.network ?? deps.tradingNetwork));
        return;
      }
      case 'alert-custom': {
        const chatId = ctx.chat?.id;
        if (chatId === undefined) return;
        await ctx.answerCallbackQuery();
        amounts.delete(telegramUserId);
        questions.ask(chatId, telegramUserId, { kind: 'alert-distance' });
        await ctx.reply(`Alert me at what distance from liquidation? Send a percentage between ${MIN_ALERT_DISTANCE_PCT} and ${MAX_ALERT_DISTANCE_PCT}, like 4 or 3.5.`, { reply_markup: { force_reply: true, input_field_placeholder: '4' } });
        return;
      }
      default:
        await answer(ctx, 'That screen is not available.');
    }
  }

  // ── 🔴 Kill Switch (spec 54-57) ─────────────────────────────────────────
  // Resolved from the chat's LINK, never its session: stopping must work when
  // the trading account is down or its key needs re-linking (spec 54). The
  // gate has already refused every unlinked chat (these routes are not public).
  async function killNav(ctx: Context, route: Route): Promise<void> {
    // THE NETWORK, SAID ONCE, on every action screen.
    const showScreen = (c: Context, screen: Screen): Promise<void> => showScreenRaw(c, badged(deps, screen));
    const sendScreen = (c: Context, screen: Screen): Promise<void> => sendScreenRaw(c, badged(deps, screen));
    const telegramUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const link = linkHere(telegramUserId, chatId);
    const control = deps.killSwitch;
    if (link === undefined || control === undefined || telegramUserId === undefined || chatId === undefined) {
      await answer(ctx, control === undefined ? "The kill switch isn't available here." : REFUSAL_TEXT);
      return;
    }
    const accountId = link.accountId;
    const rescueOn = (deps.rescue?.rules(accountId) ?? []).filter((r) => r.enabled && r.pausedReason === undefined).map((r) => r.symbol);
    const by = `tg:${telegramUserId}`;
    const who = `${chatId}:${telegramUserId}`;
    switch (route.to) {
      case 'kill':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, killScreen({ stopped: control.stopped(accountId), changedAtMs: control.changedAtMs(accountId), canClose: deps.emergency !== undefined }));
        return;
      case 'stop-all': {
        const emergency = deps.emergency;
        if (emergency === undefined) return answer(ctx, "Stop everything isn't available here.");
        const positions = emergency.preview(accountId);
        // The request this cost screen confirms: minted NOW, run at most once.
        if (positions !== undefined && positions.length > 0) stopAllRequests.set(who, { requestId: newRequestId(), shownAtMs: now() });
        await ctx.answerCallbackQuery();
        await showScreen(ctx, stopAllConfirmScreen(positions));
        return;
      }
      case 'stop-all-go': {
        const emergency = deps.emergency;
        const pending = stopAllRequests.get(who);
        if (emergency === undefined || pending === undefined) return answer(ctx, 'That was already sent, or has expired. Nothing new was sent.');
        // Taken first: a second tap finds nothing and sends nothing.
        stopAllRequests.delete(who);
        if (now() - pending.shownAtMs > STOP_ALL_CONFIRM_MS) {
          await ctx.answerCallbackQuery();
          await showScreen(ctx, stopAllExpiredScreen());
          return;
        }
        await ctx.answerCallbackQuery({ text: 'Stopping…' });
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
        await ctx.reply(withBadge('🛑 Stopping automation, then closing your positions one at a time. This takes a few seconds per position…', deps.tradingNetwork));
        const report = await emergency.closeAll(accountId, pending.requestId, by);
        await sendScreen(ctx, closeAllResultScreen(report, control.stopped(accountId)));
        return;
      }
      case 'close-retry': {
        const emergency = deps.emergency;
        if (emergency === undefined) return answer(ctx, "Closing isn't available here.");
        const p = emergency.preview(accountId)?.find((x) => x.marketId === route.marketId);
        if (p === undefined) return answer(ctx, "That position isn't open any more, or I can't see it right now. Nothing was sent.");
        retryRequests.set(`${who}:${route.marketId}`, newRequestId());
        await ctx.answerCallbackQuery();
        await showScreen(ctx, closeRetryScreen(p));
        return;
      }
      case 'close-retry-go': {
        const emergency = deps.emergency;
        const key = `${who}:${route.marketId}`;
        const requestId = retryRequests.get(key);
        if (emergency === undefined || requestId === undefined) return answer(ctx, 'That close was already sent, or has expired. Nothing new was sent.');
        retryRequests.delete(key);
        await ctx.answerCallbackQuery({ text: 'Closing…' });
        const report = await emergency.closeOne(accountId, route.marketId, requestId, by);
        await showScreen(ctx, closeAllResultScreen(report, control.stopped(accountId)));
        return;
      }
      case 'kill-confirm':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, killConfirmScreen({ rescueOn }));
        return;
      case 'kill-stop': {
        await ctx.answerCallbackQuery({ text: 'Stopping…' });
        const report = await control.stop(accountId, by);
        await showScreen(ctx, killResultScreen(report));
        return;
      }
      case 'kill-resume-ask':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, killResumeAskScreen());
        return;
      case 'kill-resume': {
        const result = await control.resume(accountId, by);
        await ctx.answerCallbackQuery({ text: result.wasStopped ? 'Automation resumed.' : "It wasn't stopped." });
        await showScreen(ctx, killResumedScreen(result.wasStopped));
        return;
      }
      default:
        await answer(ctx, "That screen isn't available.");
    }
  }

  // ── 🛟 Rescue ───────────────────────────────────────────────────────────
  // A draft per chat and person holds the rule being put together; the
  // position screen shows it as one sentence. Turning on hands it to the
  // backend, which re-validates everything against the live position and
  // signs it with the tap. Turning off is one tap: it is the safe direction.
  function rescueMenu(account: AccountView): Screen {
    const control = deps.rescue!;
    return rescueMenuScreen({
      accountId: account.accountId,
      network: account.view.network ?? deps.tradingNetwork,
      assessments: account.view.snapshot(),
      rules: control.rules(account.accountId),
      stopped: control.stopped(account.accountId),
      otherAutomation: control.otherAutomation(account.accountId),
    });
  }

  /** The draft for this position: the one being edited, else a fresh one from the rule or the defaults, acting at the alert distance. */
  function draftFor(account: AccountView, a: RiskAssessment, chatId: number, telegramUserId: number): RescueDraft | undefined {
    const market = deps.configs.get(a.marketId);
    if (market === undefined || a.positionId === undefined) return undefined;
    const triggerPct = settings.get(account.accountId).alertPct / 100;
    const held = drafts.get(chatId, telegramUserId);
    if (held !== undefined && held.marketId === a.marketId && held.positionId === a.positionId) return { ...held, triggerPct };
    const rule = deps.rescue!.rules(account.accountId).find((r) => r.marketId === a.marketId && r.positionId === a.positionId);
    const fresh = { ...freshDraft(a, rule, market.collateralDecimals), triggerPct, amountCNS: rule?.amountCNS ?? RESCUE_DEFAULTS.amountAusd * unitOf(market.collateralDecimals) };
    drafts.set(chatId, telegramUserId, fresh);
    return fresh;
  }

  function rescuePosition(account: AccountView, marketId: number, chatId: number, viewer: number): Screen | undefined {
    const a = account.view.snapshot().find((x) => x.marketId === marketId);
    if (a === undefined) return undefined;
    const draft = draftFor(account, a, chatId, viewer);
    if (draft === undefined) return undefined;
    const rule = deps.rescue!.rules(account.accountId).find((r) => r.marketId === marketId && r.positionId === a.positionId);
    const free = account.balance.freeBalance();
    return rescuePositionScreen({ assessment: a, market: deps.configs.get(marketId), rule, draft, viewerTelegramUserId: viewer, stopped: deps.rescue!.stopped(account.accountId), free: free.known ? free.floorCNS : undefined });
  }

  async function rescueNav(ctx: Context, route: Route, account: AccountView, link: LinkRecord): Promise<void> {
    // THE NETWORK, SAID ONCE, on every action screen.
    const showScreen = (c: Context, screen: Screen): Promise<void> => showScreenRaw(c, badged(deps, screen));
    const chatId = ctx.chat?.id;
    const telegramUserId = ctx.from?.id;
    if (chatId === undefined || telegramUserId === undefined) return;
    const control = deps.rescue;
    if (control === undefined) {
      await answer(ctx, "Rescue isn't available here.");
      return;
    }
    const draft = drafts.get(chatId, telegramUserId);
    const gone = async (): Promise<void> => {
      drafts.delete(chatId, telegramUserId);
      await answer(ctx, "That position isn't open any more.");
      await showScreen(ctx, rescueMenu(account));
    };
    const needDraft = async (): Promise<RescueDraft | undefined> => {
      if (draft !== undefined) return draft;
      await answer(ctx, 'That took too long. Open the position again.');
      await showScreen(ctx, rescueMenu(account));
      return undefined;
    };
    const backToPosition = async (d: RescueDraft, toast?: string): Promise<void> => {
      const screen = rescuePosition(account, d.marketId, chatId, telegramUserId);
      if (screen === undefined) return gone();
      await ctx.answerCallbackQuery(toast === undefined ? undefined : { text: toast });
      await showScreen(ctx, screen);
    };
    const positionOf = (d: RescueDraft): RiskAssessment | undefined => account.view.snapshot().find((x) => x.marketId === d.marketId && x.positionId === d.positionId);
    switch (route.to) {
      case 'rescue':
        await ctx.answerCallbackQuery();
        await showScreen(ctx, rescueMenu(account));
        return;
      case 'rescue-pos': {
        const screen = rescuePosition(account, route.marketId, chatId, telegramUserId);
        if (screen === undefined) return gone();
        await ctx.answerCallbackQuery();
        await showScreen(ctx, screen);
        return;
      }
      case 'rescue-cfg': {
        // Change amount.
        const a = account.view.snapshot().find((x) => x.marketId === route.marketId);
        if (a === undefined || draftFor(account, a, chatId, telegramUserId) === undefined) return gone();
        await ctx.answerCallbackQuery();
        await showScreen(ctx, rescueAmountScreen(a));
        return;
      }
      case 'rescue-amt-custom': {
        if ((await needDraft()) === undefined) return;
        await ctx.answerCallbackQuery();
        amounts.delete(telegramUserId);
        questions.ask(chatId, telegramUserId, { kind: 'rescue-amount' });
        await ctx.reply('How much each time? Send an amount in AUSD, like 25 or 150.', {
          reply_markup: { force_reply: true, input_field_placeholder: '150' },
        });
        return;
      }
      case 'rescue-amt': {
        const d = await needDraft();
        if (d === undefined) return;
        const n = RESCUE_AMOUNTS_AUSD[route.level];
        if (n === undefined) return answer(ctx, "I don't know that amount.");
        const next = { ...d, amountCNS: BigInt(n) * unitOf(d.collateralDecimals) };
        drafts.set(chatId, telegramUserId, next);
        await backToPosition(next);
        return;
      }
      case 'rescue-limits': {
        const d = await needDraft();
        if (d === undefined) return;
        const a = positionOf(d);
        if (a === undefined) return gone();
        await ctx.answerCallbackQuery();
        await showScreen(ctx, rescueLimitsScreen(a, d));
        return;
      }
      case 'rescue-lim': {
        const d = await needDraft();
        if (d === undefined) return;
        const next = applyLimit(d, route.level);
        if (next === undefined) return answer(ctx, "I don't know that setting.");
        drafts.set(chatId, telegramUserId, next);
        const a = positionOf(next);
        if (a === undefined) return gone();
        await ctx.answerCallbackQuery({ text: 'Set.' });
        await showScreen(ctx, rescueLimitsScreen(a, next));
        return;
      }
      case 'rescue-on':
      case 'rescue-on-next': {
        const d = await needDraft();
        if (d === undefined) return;
        if (executionFor(link).dot !== '🟢') {
          await answer(ctx, "Execution isn't authorized on this account, so Rescue couldn't act. Fix it under 🔐 Trading account first.");
          return;
        }
        const result = await control.enable(account.accountId, { ...d, maxTotalCNS: capOf(d) }, { telegramUserId, chatId }, { fromNextCrossing: route.to === 'rescue-on-next' });
        if (!result.ok) {
          await answer(ctx, result.text);
          return;
        }
        drafts.delete(chatId, telegramUserId);
        await ctx.answerCallbackQuery({ text: 'Rescue is on.' });
        const screen = rescuePosition(account, d.marketId, chatId, telegramUserId) ?? rescueMenu(account);
        await showScreen(ctx, { ...screen, html: `${esc(result.text)}\n\n${screen.html}` });
        return;
      }
      case 'rescue-stop':
      case 'rescue-resume': {
        const result = route.to === 'rescue-stop' ? await control.disable(account.accountId, route.marketId) : await control.resume(account.accountId, route.marketId, { telegramUserId, chatId });
        await ctx.answerCallbackQuery({ text: result.text.slice(0, 190) });
        const screen = rescuePosition(account, route.marketId, chatId, telegramUserId) ?? rescueMenu(account);
        await showScreen(ctx, { ...screen, html: `${esc(result.text)}\n\n${screen.html}` });
        return;
      }
      default:
        await answer(ctx, "That screen isn't available.");
    }
  }

  /** A typed trigger or amount for a rescue draft. Linked chat only; the link is resolved again. */
  async function handleRescueAnswer(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat?.id;
    const telegramUserId = ctx.from?.id;
    if (chatId === undefined || telegramUserId === undefined) return;
    const verdict = authorise(deps.links, telegramUserId, chatId);
    if (!verdict.ok) {
      questions.close(chatId, telegramUserId);
      await ctx.reply(verdict.text);
      return;
    }
    const resolved = resolveAccount(telegramUserId);
    if ('refusal' in resolved) {
      questions.close(chatId, telegramUserId);
      await ctx.reply(resolved.refusal);
      return;
    }
    const draft = drafts.get(chatId, telegramUserId);
    if (draft === undefined || deps.rescue === undefined) {
      questions.close(chatId, telegramUserId);
      await sendScreen(ctx, { html: 'That rule was not finished in time. Start again from the position.', buttons: [[{ text: '🛟 Rescue', route: { to: 'rescue' } }]] });
      return;
    }
    const a = resolved.account.view.snapshot().find((x) => x.marketId === draft.marketId && x.positionId === draft.positionId);
    if (a === undefined) {
      questions.close(chatId, telegramUserId);
      drafts.delete(chatId, telegramUserId);
      await sendScreen(ctx, { html: 'That position is not open any more.', buttons: [[{ text: '🛟 Rescue', route: { to: 'rescue' } }]] });
      return;
    }
    const parsed = parseRescueAmount(text, draft.collateralDecimals);
    if ('error' in parsed) {
      await ctx.reply(parsed.error, { reply_markup: { force_reply: true, input_field_placeholder: '150' } });
      return;
    }
    const next = { ...draft, amountCNS: parsed.amountCNS };
    drafts.set(chatId, telegramUserId, next);
    questions.close(chatId, telegramUserId);
    const screen = rescuePosition(resolved.account, next.marketId, chatId, telegramUserId);
    if (screen !== undefined) await sendScreen(ctx, badged(deps, screen));
  }

  // ── button taps ───────────────────────────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const tap = decodeNavTap(data);
    if (tap !== undefined) {
      if (tap.fresh) freshTaps.add(ctx);
      await handleNav(ctx, tap.route);
      return;
    }
    if (isNavShaped(data)) {
      // A button from an older menu, such as the retired close-all kill
      // switch. It names nothing that exists now, so nothing runs.
      await answer(ctx, OLD_MENU_TEXT);
      return;
    }
    const decoded = decodeCallback(data);
    if (!decoded.ok) {
      await answer(ctx, `I can't read that button: ${decoded.reason}. Open My positions for a current one.`);
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
          'sent. Open My positions for a current one.',
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
          'it. Open My positions and try again.',
      );
      return;
    }

    if (payload.kind === 'cancel') {
      // Deleted, not just hidden: its Send button can never fire now.
      deps.store.delete(payload.token);
      await ctx.answerCallbackQuery({ text: 'Cancelled. Nothing was sent.' });
      await showScreen(ctx, { html: 'Cancelled. Nothing was sent.', buttons: [[{ text: '📊 My positions', route: { to: 'positions' } }, { text: '🏠 Menu', route: { to: 'home' } }]] });
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

    const availability = await availabilityFor(account, action, [action]);
    if (availability === undefined || !availability.actionable) {
      await answer(ctx, unavailableText(availability));
      return;
    }

    if (payload.kind === 'blocked') {
      // The button was disabled when it was sent and the market has since opened.
      await answer(
        ctx,
        `${action.symbol} is actionable again on ${availability.network}. Open My positions ` +
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
      await answer(ctx, 'Check it, then send it.', false);
      await sendScreen(ctx, confirmFor(deps, account, pending, action));
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

/**
 * The confirmation screen for a parked action: the second tap. Its Send and
 * Cancel buttons both carry the action's own token, so Cancel deletes the very
 * thing Send would have fired.
 */
/** THE NETWORK ON EVERY ACTION SCREEN: the acting network's badge on the first line. */
function badged(deps: Pick<BotDeps, 'tradingNetwork'>, screen: Screen): Screen {
  return { ...screen, html: withBadge(screen.html, deps.tradingNetwork) };
}

function confirmFor(deps: BotDeps, account: AccountView, pending: PendingAction, action: AlertAction, notes: readonly string[] = []): Screen {
  const data = (kind: 'confirm' | 'cancel'): string => encodeCallback({ kind, token: pending.token, marketId: action.marketId, amountCNS: action.amountCNS });
  return badged(deps, confirmScreen({
    action,
    market: deps.configs.get(action.marketId),
    assessment: account.view.snapshot().find((a) => a.marketId === action.marketId),
    free: account.balance.freeBalance(),
    confirmData: data('confirm'),
    cancelData: data('cancel'),
    notes,
  }));
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
    await ctx.reply(`${projected.reason}. Open My positions when I can see it again.`);
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
    // ASKED WITH force_reply, so the keyboard opens on the answer.
    { reply_markup: { force_reply: true, input_field_placeholder: 'Amount in AUSD' } },
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
    await ctx.reply(`${current.reason}. Open My positions when I can see it again.`);
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
    await ctx.reply(`${projected.reason}. Open My positions when I can see it again.`);
    return;
  }

  const action = customAction(
    projected.projection,
    market,
    pending.positionId,
    custom.alerts.bufferDecimals,
    current.projection.resultingBufferPct,
  );

  // Asked of the ACTING venue, and asked HERE rather than only on the confirm
  // tap: a confirmation screen for a market that cannot be acted on is an offer
  // PerpGuard cannot honour.
  const availability = await availabilityFor(custom.account, action, [action]);
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

  const screen = confirmFor(deps, custom.account, parked, action, verdict.warnings);
  await ctx.reply(screen.html, { parse_mode: 'HTML', reply_markup: keyboardFor(screen) });
}

/** Ask the ACTING venue, and treat a thrown answer as "we do not know". */
async function availabilityFor(
  account: AccountView,
  market: ActingMarket,
  actions: readonly AlertAction[],
): Promise<ActionAvailability | undefined> {
  if (actions.length === 0) return undefined;
  try {
    return await account.executor.availability({ marketId: market.marketId, symbol: market.symbol });
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
  if (action.type === 'add-margin' && action.amountCNS <= 0n) {
    await ctx.reply(
      'That button has no amount on it, so there is nothing to send. Tap 🎛 Custom amount and ' +
        'reply with a figure, or open My positions.',
    );
    return;
  }
  // A reduce with no size is the same mistake in another unit.
  if (action.type === 'reduce-position' && (action.sizeLNS === undefined || action.sizeLNS <= 0n)) {
    await ctx.reply('That reduce has no size on it, so there is nothing to send. Open My positions.');
    return;
  }

  // The confirmation becomes the progress line, so its Send button is gone
  // while the action is in flight and cannot be tapped twice.
  await editOrSend(ctx, badged(deps, sendingScreen(action)));
  const market = deps.configs.get(action.marketId);
  const assessment = account.view.snapshot().find((a) => a.marketId === action.marketId);

  const idempotencyKey = `${pending.userId}:${action.marketId}:${action.intent}:${pending.token}`;
  const outcome = await account.executor.execute({
    idempotencyKey,
    userId: pending.userId,
    accountId: fresh.accountId,
    action,
  });

  // THE ONE OUTCOME THAT EARNS A RETRY BUTTON is a reconciled not-applied: the
  // position was read after the send and had not moved, so nothing landed and
  // nothing can land twice. A FRESH TOKEN, not the spent one: the retry is a
  // new action with its own `action_log` row and its own fifteen minutes.
  // `unknown` never gets one — something may have landed.
  let retryData: string | undefined;
  if (outcome.kind === 'not-applied') {
    const retry = deps.store.put({ userId: pending.userId, telegramUserId: pending.telegramUserId, action });
    retryData = encodeCallback({ kind: 'confirm', token: retry.token, marketId: action.marketId, amountCNS: action.amountCNS });
  }
  await editOrSend(ctx, badged(deps, outcomeScreen({ action, outcome, market, assessment, ...(retryData === undefined ? {} : { retryData }) })));
}

/** Edit the tapped message into a screen; send it fresh when that is not possible. */
async function editOrSend(ctx: Context, screen: Screen): Promise<void> {
  const options = { parse_mode: 'HTML' as const, reply_markup: keyboardFor(screen), link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message !== undefined) {
    try {
      await ctx.editMessageText(screen.html, options);
      return;
    } catch (error) {
      if (error instanceof Error && /message is not modified/i.test(error.message)) return;
    }
  }
  await ctx.reply(screen.html, options);
}

/** What a button names, for the tap log: a screen and its argument, or an action's kind, market and amount. Never a token. */
export function describeTap(data: string): string {
  const tap = decodeNavTap(data);
  if (tap !== undefined) {
    const { to, ...args } = tap.route as { to: string } & Record<string, unknown>;
    const arg = Object.entries(args).map(([k, v]) => `${k} ${String(v)}`).join(' ');
    return `screen ${to}${arg === '' ? '' : ` (${arg})`}${tap.fresh ? ', new message' : ''}`;
  }
  if (isNavShaped(data)) return 'a button from an older menu';
  const decoded = decodeCallback(data);
  if (!decoded.ok) return 'an unreadable button';
  return `action ${decoded.payload.kind} on market ${decoded.payload.marketId}, amount ${decoded.payload.amountCNS} (micros)`;
}
