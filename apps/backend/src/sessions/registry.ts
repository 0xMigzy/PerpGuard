/**
 * The registry of live account sessions, keyed by account id.
 *
 * Replaces the backend's one-of-everything with N-of-everything, where N is
 * bounded. A session is opened when a user links (or, for the environment
 * key, at boot), and closed when they unlink or the key proves to be for a
 * different account. Closing tears the session down completely — loop,
 * engine, socket — so an unlinked account is not assessed, not alerted, and
 * cannot be acted on, immediately.
 *
 * THE CAP IS A REFUSAL, NOT A DEGRADATION. Each session is a live websocket
 * with a 30s ping, a position set, a risk loop ticking every second and an
 * alert queue. On an 8GB box shared with two indexers and Postgres, the
 * limit is not memory — a session is a few megabytes — but attention: one
 * core's worth of loops evaluating, and one venue's tolerance for sockets
 * signed in from one host. The default of 20 keeps every session's evaluate
 * well under a millisecond per tick and leaves the venue's limits far away,
 * and when it is hit a new link is refused with a sentence rather than every
 * existing session slowing down together.
 */
import type { AccountView, SessionRouter } from '@perpguard/bot';
import { AccountSession, type SessionCredentials, type SessionDeps, type SessionStatus } from './session.ts';

export const DEFAULT_MAX_SESSIONS = 20;

export type OpenResult =
  | { readonly ok: true; readonly session: AccountSession; readonly already: boolean }
  /** `full`: the instance is at its cap, and the reason is fit to show the person as is. */
  | { readonly ok: false; readonly reason: string; readonly code?: 'full' | 'trading-off' };

/**
 * What someone is told when this instance has no room (owner, 7 Oct 2026):
 * that it is full, and that PerpGuard is self-hostable. Shown on the link page
 * as written.
 */
export const instanceFullText = (max: number): string =>
  `This PerpGuard instance is full: it is already watching ${max} linked accounts, its limit. ` +
  `Nothing was changed. PerpGuard is open source and self-hostable (https://github.com/0xMigzy/PerpGuard), ` +
  `so you can run your own; or try again later, when a place frees up.`;

export interface AccountRegistryOptions {
  readonly deps: SessionDeps;
  readonly maxSessions?: number;
  /**
   * Set when trading on this deployment's network is switched off (mainnet,
   * without PERPGUARD_MAINNET_TRADING=1): every open is refused with this
   * sentence. Monitoring is unaffected; nothing can execute.
   */
  readonly tradingOff?: string;
}

export class AccountRegistry implements SessionRouter {
  readonly #deps: SessionDeps;
  readonly #sessions = new Map<number, AccountSession>();
  readonly #maxSessions: number;
  readonly #tradingOff: string | undefined;
  /** Closes in progress, so a close followed by an open waits for the teardown. */
  readonly #closing = new Map<number, Promise<void>>();

  constructor(options: AccountRegistryOptions) {
    this.#deps = options.deps;
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#tradingOff = options.tradingOff;
  }

  get maxSessions(): number {
    return this.#maxSessions;
  }

  get size(): number {
    return this.#sessions.size;
  }

  /**
   * Open and start a session for an account. Idempotent for an account that
   * already has one; refused at the cap.
   */
  open(accountId: number, credentials: SessionCredentials): OpenResult {
    if (this.#tradingOff !== undefined) return { ok: false, reason: this.#tradingOff, code: 'trading-off' };
    const existing = this.#sessions.get(accountId);
    if (existing !== undefined) return { ok: true, session: existing, already: true };
    if (this.#sessions.size >= this.#maxSessions) {
      return { ok: false, reason: instanceFullText(this.#maxSessions), code: 'full' };
    }
    const session = new AccountSession(accountId, credentials, this.#deps);
    session.onMismatch(() => {
      void this.close(accountId);
    });
    this.#sessions.set(accountId, session);
    session.start();
    this.#deps.logger.info(`[account ${accountId}] session opened (${this.#sessions.size}/${this.#maxSessions})`);
    return { ok: true, session, already: false };
  }

  /** Tear a session down completely. Resolves once its socket is closed. False when there was none. */
  async close(accountId: number): Promise<boolean> {
    const session = this.#sessions.get(accountId);
    if (session === undefined) return false;
    // Unreferenced FIRST, so no request routed from this moment on finds it.
    this.#sessions.delete(accountId);
    const closing = session.stop().finally(() => {
      this.#closing.delete(accountId);
    });
    this.#closing.set(accountId, closing);
    await closing;
    this.#deps.logger.info(`[account ${accountId}] session closed (${this.#sessions.size}/${this.#maxSessions})`);
    return true;
  }

  get(accountId: number): AccountSession | undefined {
    return this.#sessions.get(accountId);
  }

  list(): readonly AccountSession[] {
    return [...this.#sessions.values()];
  }

  statuses(): readonly SessionStatus[] {
    return this.list().map((session) => session.status());
  }

  /** The bot's view of one account, resolved NOW. Undefined once closed. */
  forAccount(accountId: number): AccountView | undefined {
    return this.#sessions.get(accountId)?.accountView;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }
}
