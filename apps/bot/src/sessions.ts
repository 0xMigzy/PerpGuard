/**
 * How the bot finds the session behind a linked chat, at the moment it needs it.
 *
 * The bot used to hold one view, one executor and one balance, because there
 * was one account. Now each linked account has its own session in the
 * backend's registry, and the bot asks for it BY ACCOUNT ID, which it takes
 * from the requesting chat's link record at request time. Nothing is held
 * across requests: a chat that is unlinked between two taps gets a refusal on
 * the second, and a session torn down between them gets "not running".
 */
import type { ActionExecutor } from './actions.ts';
import type { FreeBalanceView } from './balance.ts';
import type { RiskView } from './view.ts';

export interface AccountView {
  readonly accountId: number;
  readonly view: RiskView;
  readonly executor: ActionExecutor;
  readonly balance: FreeBalanceView;
  /**
   * Close every open position on this account, worst first, and say what
   * happened. Absent where no session can fire one (tests, demos).
   */
  readonly killSwitch?: (userId: string) => Promise<string>;
}

export interface SessionRouter {
  /** The live session for an account, or undefined when none is running. */
  forAccount(accountId: number): AccountView | undefined;
}

/** A router over a fixed map. For tests, and for a process with one account. */
export class StaticSessionRouter implements SessionRouter {
  readonly #views = new Map<number, AccountView>();

  constructor(views: readonly AccountView[] = []) {
    for (const view of views) this.#views.set(view.accountId, view);
  }

  set(view: AccountView): void {
    this.#views.set(view.accountId, view);
  }

  delete(accountId: number): void {
    this.#views.delete(accountId);
  }

  forAccount(accountId: number): AccountView | undefined {
    return this.#views.get(accountId);
  }
}
