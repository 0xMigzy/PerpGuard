/**
 * The public watch tier: anyone may follow any mainnet account, read-only.
 *
 * TWO TIERS, ONE BOT. The linked owner gets alerts WITH actions for the account
 * the trading socket signs for. Anyone else — no wallet, no account, no link —
 * can `/watch` an address or account id and get the same alerts about it with
 * NO KEYBOARD AT ALL: a watcher sees a position in danger and can do nothing
 * about it from here. That is enforced in the bot's gate, which refuses every
 * action payload from an unlinked chat, not by the renderer leaving buttons
 * out (though it does that too).
 *
 * PUBLIC MEANS BOUNDED. A chat may watch a few accounts, the bot a few hundred
 * in total, and a chat may send so many commands a minute. The limits are
 * numbers in one place, enforced by the store and the limiter rather than by
 * a handler remembering to check.
 *
 * Everything here is pure or in-memory. Persistence is a port, so a Postgres
 * implementation slots in without touching a handler — and one does, in the
 * backend, because a public subscription must survive a restart.
 */
import type { IndexerHealth } from '@perpguard/shared';
import type { AlertRecipient } from '@perpguard/backend/alerts';
import type { RiskChange } from '@perpguard/backend/risk';

export interface WatchSubscription {
  readonly chatId: number;
  readonly accountId: number;
  /** How the watcher named it: the address they typed (lowercased) or `#<id>`. */
  readonly label: string;
  readonly addedAtMs: number;
}

export type WatchAddResult =
  | { readonly ok: true; readonly subscription: WatchSubscription; readonly already: boolean }
  | { readonly ok: false; readonly refusal: 'chat-at-capacity' | 'bot-at-capacity'; readonly text: string };

export interface WatchStore {
  add(subscription: WatchSubscription): WatchAddResult;
  remove(chatId: number, accountId: number): boolean;
  /** What one chat follows, oldest first. */
  byChat(chatId: number): readonly WatchSubscription[];
  /** Every account anybody follows: what the watch loop assesses. */
  accountIds(): readonly number[];
  /** Everyone following one account: who an alert about it fans out to. */
  watchersOf(accountId: number): readonly WatchSubscription[];
  readonly maxPerChat: number;
  readonly maxAccounts: number;
}

export interface InMemoryWatchStoreOptions {
  /** How many accounts one chat may follow. */
  readonly maxPerChat?: number;
  /** How many DISTINCT accounts the whole bot will assess. Bounds the loop's cost. */
  readonly maxAccounts?: number;
  readonly seed?: readonly WatchSubscription[];
}

export const DEFAULT_MAX_PER_CHAT = 20;
export const DEFAULT_MAX_ACCOUNTS = 300;

export class InMemoryWatchStore implements WatchStore {
  readonly #byChat = new Map<number, Map<number, WatchSubscription>>();
  readonly maxPerChat: number;
  readonly maxAccounts: number;

  constructor(options: InMemoryWatchStoreOptions = {}) {
    this.maxPerChat = options.maxPerChat ?? DEFAULT_MAX_PER_CHAT;
    this.maxAccounts = options.maxAccounts ?? DEFAULT_MAX_ACCOUNTS;
    for (const sub of options.seed ?? []) this.#set(sub);
  }

  add(subscription: WatchSubscription): WatchAddResult {
    const chat = this.#byChat.get(subscription.chatId);
    const existing = chat?.get(subscription.accountId);
    if (existing !== undefined) return { ok: true, subscription: existing, already: true };
    if ((chat?.size ?? 0) >= this.maxPerChat) {
      return {
        ok: false,
        refusal: 'chat-at-capacity',
        text: `This chat already watches ${this.maxPerChat} accounts, which is the limit. Stop watching one from My watchlist first.`,
      };
    }
    // A new DISTINCT account counts against the bot-wide cap; following one
    // somebody else already watches costs nothing more to assess.
    if (!this.#anyoneWatches(subscription.accountId) && this.accountIds().length >= this.maxAccounts) {
      return {
        ok: false,
        refusal: 'bot-at-capacity',
        text: `PerpGuard is watching ${this.maxAccounts} accounts in total, which is as many as it assesses. Try again later.`,
      };
    }
    this.#set(subscription);
    return { ok: true, subscription, already: false };
  }

  remove(chatId: number, accountId: number): boolean {
    const chat = this.#byChat.get(chatId);
    const removed = chat?.delete(accountId) ?? false;
    if (chat !== undefined && chat.size === 0) this.#byChat.delete(chatId);
    return removed;
  }

  byChat(chatId: number): readonly WatchSubscription[] {
    return [...(this.#byChat.get(chatId)?.values() ?? [])].sort((a, b) => a.addedAtMs - b.addedAtMs);
  }

  accountIds(): readonly number[] {
    const ids = new Set<number>();
    for (const chat of this.#byChat.values()) for (const id of chat.keys()) ids.add(id);
    return [...ids].sort((a, b) => a - b);
  }

  watchersOf(accountId: number): readonly WatchSubscription[] {
    const out: WatchSubscription[] = [];
    for (const chat of this.#byChat.values()) {
      const sub = chat.get(accountId);
      if (sub !== undefined) out.push(sub);
    }
    return out;
  }

  #anyoneWatches(accountId: number): boolean {
    for (const chat of this.#byChat.values()) if (chat.has(accountId)) return true;
    return false;
  }

  #set(sub: WatchSubscription): void {
    let chat = this.#byChat.get(sub.chatId);
    if (chat === undefined) {
      chat = new Map();
      this.#byChat.set(sub.chatId, chat);
    }
    chat.set(sub.accountId, sub);
  }
}

// ── rate limiting ───────────────────────────────────────────────────────────

export interface RateLimiterOptions {
  /** Allowed events per window, per key. */
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export type RateVerdict = { readonly ok: true } | { readonly ok: false; readonly retryInMs: number };

/**
 * A sliding window per key. Pure apart from the clock.
 *
 * Keyed by CHAT, because that is the thing a stranger controls: one person
 * with many chats is many keys, and that is acceptable for a bot whose worst
 * case is a few extra database reads per minute.
 */
export class RateLimiter {
  readonly #events = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: RateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  allow(key: string): RateVerdict {
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    const kept = (this.#events.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length >= this.#limit) {
      const oldest = kept[0] as number;
      this.#events.set(key, kept);
      return { ok: false, retryInMs: oldest + this.#windowMs - now };
    }
    kept.push(now);
    this.#events.set(key, kept);
    return { ok: true };
  }
}

export const DEFAULT_RATE_LIMIT = { limit: 12, windowMs: 60_000 } as const;

// ── what a watcher typed ────────────────────────────────────────────────────

export type WatchTarget =
  | { readonly kind: 'address'; readonly address: string }
  | { readonly kind: 'account'; readonly accountId: number };

/**
 * `/watch <0x…>` or `/watch <id>` or `/watch #<id>`.
 *
 * Addresses are accepted IN ANY CASE and lowercased here, per CLAUDE.md: a
 * checksummed address pasted from an explorer must resolve.
 */
export function parseWatchTarget(text: string): WatchTarget | { readonly error: string } {
  const arg = text.trim().split(/\s+/).slice(1).join(' ').trim();
  if (arg === '') return { error: 'Tell me what to watch: an address or an account id.' };
  return parseWatchArgument(arg);
}

/**
 * The value alone: what someone types in answer to "what should I watch?", or
 * pastes without being asked. An address in any case, a bare id, or `#id`.
 */
export function parseWatchArgument(value: string): WatchTarget | { readonly error: string } {
  const arg = value.trim();
  if (arg === '') return { error: 'Tell me what to watch: an address or an account id.' };
  if (/^0x[0-9a-fA-F]{40}$/.test(arg)) return { kind: 'address', address: arg.toLowerCase() };
  const id = arg.replace(/^#/, '');
  if (/^\d{1,12}$/.test(id)) return { kind: 'account', accountId: Number(id) };
  if (/^0x/i.test(arg)) return { error: `${arg} is not a full address: I need 0x followed by 40 hex characters.` };
  return { error: `I did not understand ${JSON.stringify(arg)}. Give me a 0x address or an account id.` };
}

/** A resolved target: the account to assess, and how it was found. */
export interface ResolvedWatchTarget {
  readonly accountId: number;
  /** Lowercased owner address, when known. */
  readonly address: string | undefined;
  readonly resolvedBy: 'index' | 'chain';
}

/**
 * Turns a typed target into an account id, through the SAME lookups the web's
 * search uses: the index first, then the Exchange contract itself, so a
 * checksummed address the index has never seen still resolves.
 */
export interface WatchResolver {
  resolve(target: WatchTarget): Promise<ResolvedWatchTarget | { readonly error: string }>;
}

/** The label a subscription is shown under: the address typed, or `#<id>`. */
export function labelFor(target: WatchTarget, resolved: ResolvedWatchTarget): string {
  if (target.kind === 'address') return `${target.address.slice(0, 6)}…${target.address.slice(-4)}`;
  return resolved.address === undefined ? `#${resolved.accountId}` : `#${resolved.accountId} (${resolved.address.slice(0, 6)}…${resolved.address.slice(-4)})`;
}

// ── words ───────────────────────────────────────────────────────────────────

/** How current the watched data is, for `/watching` and the subscribe reply. */
export function describeWatchFreshness(health: IndexerHealth | undefined): string {
  if (health === undefined) return 'Positions come from the mainnet index; I could not read how far behind it is right now.';
  const behind = health.blocksBehind;
  const block = health.latestProcessedBlock;
  const base =
    block !== undefined && block > 0
      ? `Positions come from the mainnet index at block ${block.toLocaleString('en-US')}` +
        (behind === undefined ? '' : `, ${behind.toLocaleString('en-US')} block${behind === 1 ? '' : 's'} behind the chain`)
      : 'Positions come from the mainnet index';
  const state = health.state === 'synced' ? '' : ` (indexer ${health.state})`;
  return `${base}${state}; marks come from the venue. Not live, and read-only from this chat.`;
}

export function renderWatching(subs: readonly WatchSubscription[], health: IndexerHealth | undefined, maxPerChat: number): string {
  if (subs.length === 0) {
    return 'This chat watches nothing yet. /watch <0x address or account id> to follow one — no wallet or link needed.';
  }
  const lines = [`Watching ${subs.length} of ${maxPerChat}:`];
  for (const sub of subs) lines.push(`  ${sub.label} — account ${sub.accountId}`);
  lines.push('', describeWatchFreshness(health), '/unwatch <address or id> to stop.');
  return lines.join('\n');
}

export function renderWatched(sub: WatchSubscription, resolved: ResolvedWatchTarget, already: boolean, health: IndexerHealth | undefined): string {
  const how = resolved.resolvedBy === 'chain' ? 'resolved by the Exchange contract' : 'found in the index';
  return [
    `${already ? 'Already watching' : 'Watching'} ${sub.label} — account ${resolved.accountId}, ${how}.`,
    `I will warn this chat when a position on it enters WATCH, DANGER or passes its liquidation price, and say when it recovers.`,
    describeWatchFreshness(health),
  ].join('\n');
}

/** The one line that states both tiers. Used by /start and /help. */
export const TIERS_TEXT =
  'Two ways to use PerpGuard:\n' +
  '  • Watch anything, right now: /watch <0x address or account id>. No wallet, no sign-up. Alerts only, no actions.\n' +
  '  • Link your own account when you want to act: /link, prove you own it on the page, and this chat gets the same alerts with Add-margin buttons.';

// ── who hears a watched account's alert ─────────────────────────────────────

/**
 * How long a NEW subscription is spared first-sight alerts. Watching an
 * account shows its wallet screen at once — every position, how close each is
 * — so the first-sight alerts the next pass produces for it would repeat that
 * screen as a burst of messages (six of them, the first time this ran against
 * a live nine-position account). Long enough to cover the bounded refresh and
 * the next 30-second pass.
 */
export const FRESH_SUBSCRIPTION_MS = 2 * 60_000;

/**
 * The recipients for one watched change. A first sight (`previousState`
 * undefined) is not sent to a subscription made in the last two minutes: that
 * chat has just seen it on screen. Every REAL change goes to everyone, and a
 * first sight still goes to older subscriptions (after a restart, say).
 */
export function watchRecipients(store: WatchStore, change: RiskChange, nowMs: number): AlertRecipient[] {
  const accountId = change.assessment.watch?.accountId;
  if (accountId === undefined) return [];
  return store
    .watchersOf(accountId)
    .filter((sub) => change.previousState !== undefined || nowMs - sub.addedAtMs >= FRESH_SUBSCRIPTION_MS)
    .map((sub) => ({ userId: `watch:${sub.chatId}`, rights: 'watch' as const, chatId: sub.chatId }));
}
