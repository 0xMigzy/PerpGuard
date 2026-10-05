/**
 * Saved wallets: a per-viewer convenience kept in THIS browser's storage.
 * No account, no backend. Storage can be missing or throw (private windows,
 * cleared or blocked site data), so every read and write is wrapped and the
 * worst case is an empty list, never a broken page.
 */
export interface SavedWallet {
  readonly accountId: number;
  /** Lowercased, or empty for an account with no recorded owner. */
  readonly address: string;
  readonly savedAtMs: number;
}

export const SAVED_KEY = 'perpguard.savedWallets.v1';
/** A list, not a database: past this the oldest are dropped. */
export const SAVED_MAX = 25;
/** Fired on the window when this tab changes the list; other tabs hear `storage`. */
export const SAVED_EVENT = 'perpguard:saved-wallets';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function valid(x: unknown): x is SavedWallet {
  if (typeof x !== 'object' || x === null) return false;
  const w = x as Record<string, unknown>;
  return Number.isInteger(w['accountId']) && (w['accountId'] as number) >= 0 && typeof w['address'] === 'string' && typeof w['savedAtMs'] === 'number';
}

/** The saved list, newest first. Anything unreadable is an empty list. */
export function readSaved(store: StorageLike | undefined = storage()): readonly SavedWallet[] {
  try {
    const raw = store?.getItem(SAVED_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, SAVED_MAX) : [];
  } catch {
    return [];
  }
}

/** Writes the list; false when the browser refused. */
export function writeSaved(list: readonly SavedWallet[], store: StorageLike | undefined = storage()): boolean {
  try {
    if (store === undefined) return false;
    store.setItem(SAVED_KEY, JSON.stringify(list.slice(0, SAVED_MAX)));
    return true;
  } catch {
    return false;
  }
}

/** The list with this account first (moved there if already saved), capped. */
export function withSaved(list: readonly SavedWallet[], wallet: SavedWallet): readonly SavedWallet[] {
  return [wallet, ...list.filter((w) => w.accountId !== wallet.accountId)].slice(0, SAVED_MAX);
}

export function withoutSaved(list: readonly SavedWallet[], accountId: number): readonly SavedWallet[] {
  return list.filter((w) => w.accountId !== accountId);
}
