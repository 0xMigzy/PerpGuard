/**
 * Who is signed in to the web app, and what they have been shown a screen for.
 *
 * THE SAME RULE THE BOT ENFORCES: the right person, and the right context. A
 * link code is minted only for the app user the bot already serves and reaches
 * them only in their linked Telegram chat (or the operator's own terminal in
 * dev), so redeeming one proves the reader is that person. The session it opens
 * is an opaque random token in an HttpOnly cookie: no user id travels in the
 * browser, and nothing on the page can read the cookie.
 *
 * IN MEMORY, like the bot's link store: a restart signs everyone out and they
 * type a fresh code. Persisting sessions without persisting the policy around
 * them would be the worse failure.
 *
 * Everything here is pure or a small store with an injected clock, so the
 * expiry, single-use and cookie rules are unit tested.
 */
import { randomBytes } from 'node:crypto';
import type { AlertAction } from '../../alerts/types.ts';
import { ACTION_TTL_MS } from '@perpguard/bot';

export const SESSION_COOKIE = 'pg_session';
export const LINK_CODE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;

/** No 0/O/1/I: a code is read off a phone and typed. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Case, spaces and the dash do not matter when typing a code back. */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface LinkCode {
  readonly code: string;
  readonly userId: string;
  readonly expiresAtMs: number;
}

export class LinkCodeStore {
  readonly #codes = new Map<string, LinkCode>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #nextCode: () => string;

  constructor(options: { now?: () => number; ttlMs?: number; nextCode?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? LINK_CODE_TTL_MS;
    this.#nextCode = options.nextCode ?? randomCode;
  }

  mint(userId: string): LinkCode {
    this.#sweep();
    let code = this.#nextCode();
    while (this.#codes.has(normaliseCode(code))) code = this.#nextCode();
    const minted: LinkCode = { code, userId, expiresAtMs: this.#now() + this.#ttlMs };
    this.#codes.set(normaliseCode(code), minted);
    return minted;
  }

  /** ONE USE. A redeemed code is gone whether or not the caller keeps the session. */
  redeem(input: string): LinkCode | undefined {
    this.#sweep();
    const key = normaliseCode(input);
    const found = this.#codes.get(key);
    if (found === undefined) return undefined;
    this.#codes.delete(key);
    return found;
  }

  get size(): number {
    this.#sweep();
    return this.#codes.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [key, code] of this.#codes) if (code.expiresAtMs <= now) this.#codes.delete(key);
  }
}

/**
 * `owner` may act; `demo` may only look. A demo session sees the account this
 * backend monitors, read-only, and exists so a judge without a funded wallet
 * still sees the product — it is opened only when the operator has turned demo
 * mode on, because on a real deployment the monitored account is somebody's.
 */
export type SessionRole = 'owner' | 'demo';
/** How the session was opened. Recorded so the page can say so. */
export type SessionMethod = 'dynamic' | 'code' | 'demo';

export interface SessionDetails {
  readonly role: SessionRole;
  readonly method: SessionMethod;
  /** The signed-in wallet, lowercased, when Dynamic supplied one. */
  readonly wallet?: string | undefined;
  /** The account THIS wallet owns on the analytics network, for a profile link. */
  readonly ownAccountId?: number | undefined;
}

export interface Session extends SessionDetails {
  readonly token: string;
  readonly userId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #nextToken: () => string;

  constructor(options: { now?: () => number; ttlMs?: number; nextToken?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.#nextToken = options.nextToken ?? (() => randomBytes(32).toString('hex'));
  }

  create(userId: string, details: SessionDetails = { role: 'owner', method: 'code' }): Session {
    this.#sweep();
    const now = this.#now();
    const session: Session = { ...details, token: this.#nextToken(), userId, createdAtMs: now, expiresAtMs: now + this.#ttlMs };
    this.#sessions.set(session.token, session);
    return session;
  }

  get(token: string | undefined): Session | undefined {
    this.#sweep();
    return token === undefined ? undefined : this.#sessions.get(token);
  }

  revoke(token: string): void {
    this.#sessions.delete(token);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, s] of this.#sessions) if (s.expiresAtMs <= now) this.#sessions.delete(token);
  }
}

// ── cookies ─────────────────────────────────────────────────────────────────

export function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name === '') continue;
    out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** HttpOnly always; Secure when the page is served over https. */
export function sessionCookie(token: string, options: { readonly secure: boolean; readonly maxAgeSec: number }): string {
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}${options.secure ? '; Secure' : ''}`
  );
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ── what a confirmation screen was shown for ────────────────────────────────

/**
 * The thing behind a Send button. Parked when the screen is rendered and spent
 * when it is confirmed, on the bot's fifteen-minute expiry and for the bot's
 * reason: an amount quoted against a mark stops being that amount when the mark
 * moves.
 */
export type PendingIntent =
  | { readonly kind: 'add-margin'; readonly action: AlertAction }
  | { readonly kind: 'close-position'; readonly marketId: number; readonly symbol: string; readonly positionId: number | undefined }
  | { readonly kind: 'kill-switch' };

export interface PendingWebAction {
  readonly token: string;
  /** Who may confirm it. A token shown to one session is not a token for another. */
  readonly userId: string;
  readonly intent: PendingIntent;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export class WebPendingActionStore {
  readonly #entries = new Map<string, PendingWebAction>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #nextToken: () => string;

  constructor(options: { now?: () => number; ttlMs?: number; nextToken?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? ACTION_TTL_MS;
    this.#nextToken = options.nextToken ?? (() => randomBytes(12).toString('hex'));
  }

  put(userId: string, intent: PendingIntent): PendingWebAction {
    this.#sweep();
    const now = this.#now();
    const entry: PendingWebAction = { token: this.#nextToken(), userId, intent, createdAtMs: now, expiresAtMs: now + this.#ttlMs };
    this.#entries.set(entry.token, entry);
    return entry;
  }

  /** Spent on read: a double click must not become two submissions. */
  take(token: string, userId: string): PendingWebAction | undefined {
    this.#sweep();
    const entry = this.#entries.get(token);
    if (entry === undefined || entry.userId !== userId) return undefined;
    this.#entries.delete(token);
    return entry;
  }

  get size(): number {
    this.#sweep();
    return this.#entries.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, e] of this.#entries) if (e.expiresAtMs <= now) this.#entries.delete(token);
  }
}
