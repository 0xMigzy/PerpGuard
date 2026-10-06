/**
 * The Trading Account's EXECUTION state, in one line, from facts the backend
 * holds about the linked account's live session. Pure.
 *
 * Execution is its own state and is never folded into "connected": a chat can
 * be linked to an account whose key cannot be used, whose socket is down, or
 * which refuses forwarded orders. Each of those says so by name, with what
 * to do, because a trader who believes they can act and cannot is the worst
 * case this product has.
 *
 * Ownership (who proved the wallet) is NOT shown here yet: today's link
 * record does not keep how it was proved, and a guessed "verified" is worse
 * than none. It arrives with the persisted proof (Phase 10–11).
 */
import type { NetworkName } from '@perpguard/shared';

/** What the bot is told about a linked account's session. A subset of the backend's link status. */
export interface ExecutionFacts {
  /** Set when the stored key can no longer be opened (a rotated environment key). */
  readonly needsRelink?: string;
  /** Undefined: no session is running for the account. */
  readonly session?: {
    readonly trading: { readonly state: string; readonly forwardingAllowed?: boolean };
    /** Set when the key signed in as a different account. */
    readonly mismatch?: string;
  };
}

export interface ExecutionState {
  readonly dot: '🟢' | '🟡' | '🟠' | '🔴' | '⚪';
  /** Short, for the menu. */
  readonly label: string;
  /** What to do about it; undefined when nothing needs doing. */
  readonly next?: string;
}

export function executionState(facts: ExecutionFacts | undefined): ExecutionState {
  if (facts?.needsRelink !== undefined) return { dot: '🔴', label: 'Key can no longer be used', next: 'Connect again with /link to paste it again.' };
  const session = facts?.session;
  if (session === undefined) return { dot: '🟠', label: 'Not running', next: 'PerpGuard cannot reach this account right now. Alerts resume when it can.' };
  if (session.mismatch !== undefined) return { dot: '🔴', label: 'Key is for another account', next: 'Connect again with /link using a key for this account.' };
  if (session.trading.state !== 'signed-in') return { dot: '🟠', label: 'Connecting', next: 'PerpGuard is signing in to the exchange. Buttons send once it has.' };
  if (session.trading.forwardingAllowed === false) {
    return { dot: '🟡', label: 'Order forwarding is off', next: 'Turn on order forwarding in Perpl with the wallet that owns the account; until then nothing can be sent.' };
  }
  return { dot: '🟢', label: 'Authorized' };
}

/** Shown when the session exists but says nothing about its state. Never green. */
export const EXECUTION_UNKNOWN: ExecutionState = { dot: '⚪', label: 'Unknown' };

/** "Monad testnet" / "Monad mainnet": every screen that shows the Trading Account names its network. */
export function networkLabel(network: NetworkName | undefined): string {
  return network === undefined ? 'Monad' : `Monad ${network}`;
}
