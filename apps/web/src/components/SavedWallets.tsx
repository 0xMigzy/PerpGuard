'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '@/lib/api.ts';
import { formatCount, formatPct, formatSignedMoney, shortAddress } from '@/lib/format.ts';
import { SAVED_EVENT, SAVED_KEY, readSaved, withSaved, withoutSaved, writeSaved, type SavedWallet } from '@/lib/savedWallets.ts';
import { bufferTier } from '@/lib/traders.ts';
import { compareHref, MAX_COMPARE } from '@/lib/compare.ts';

// ── the list, shared by every component on the page ─────────────────────────

let cache: { raw: string | null; list: readonly SavedWallet[] } = { raw: null, list: [] };
const EMPTY: readonly SavedWallet[] = [];

function snapshot(): readonly SavedWallet[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SAVED_KEY);
  } catch {
    return EMPTY;
  }
  // A stable reference per stored value, so React does not re-render on every read.
  if (raw !== cache.raw) cache = { raw, list: readSaved() };
  return cache.list;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SAVED_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SAVED_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SAVED_EVENT, onChange);
  };
}

/** The saved list, live across components and tabs; empty on the server and whenever storage is unavailable. */
export function useSavedWallets() {
  const list = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const [refused, setRefused] = useState(false);
  const commit = useCallback((next: readonly SavedWallet[]) => {
    const ok = writeSaved(next);
    setRefused(!ok);
    if (ok) window.dispatchEvent(new Event(SAVED_EVENT));
    return ok;
  }, []);
  return {
    list,
    /** True once a write has been refused by the browser. */
    refused,
    isSaved: (accountId: number) => list.some((w) => w.accountId === accountId),
    save: (accountId: number, address: string) => commit(withSaved(readSaved(), { accountId, address: address.toLowerCase(), savedAtMs: Date.now() })),
    remove: (accountId: number) => commit(withoutSaved(readSaved(), accountId)),
  };
}

function Star({ filled, size = 14 }: { readonly filled: boolean; readonly size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />
    </svg>
  );
}

// ── the star on a profile ───────────────────────────────────────────────────

export function SaveWalletButton({ accountId, address }: { readonly accountId: number; readonly address: string }) {
  const saved = useSavedWallets();
  const on = saved.isSaved(accountId);
  return (
    <button
      type="button"
      onClick={() => (on ? saved.remove(accountId) : saved.save(accountId, address))}
      aria-pressed={on}
      title={saved.refused ? 'This browser is not letting the page save anything (private window or blocked site data).' : on ? 'Saved in this browser. Click to remove.' : 'Save this wallet in this browser'}
      className={`inline-flex items-center gap-[6px] rounded-[9px] border px-[10px] py-[6px] text-[12.5px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        on ? 'border-accent/60 text-accent-hi' : 'border-border2 text-muted hover:text-text'
      }`}
    >
      <Star filled={on} />
      {on ? 'Saved' : 'Save'}
      {saved.refused && <span className="text-[11px] font-medium text-watch">· not stored</span>}
    </button>
  );
}

// ── the list in the top bar ─────────────────────────────────────────────────

export function SavedWalletsMenu() {
  const saved = useSavedWallets();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const n = saved.list.length;
  return (
    <div ref={box} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Saved wallets, ${n}`}
        className="flex items-center gap-[6px] rounded-[10px] border border-border2 bg-card px-[10px] py-[7px] text-[12px] text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Star filled={n > 0} size={13} />
        <span className="hidden sm:inline">Saved</span>
        <span className="num">{formatCount(n)}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Saved wallets" className="fixed inset-x-4 top-[58px] z-30 rounded-[10px] sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-[380px] border border-border2 bg-card shadow-[0_8px_24px_rgba(0,0,0,0.45)]">
          <div className="flex items-center justify-between gap-2 border-b border-border px-[14px] py-[10px]">
            <span className="text-[13px] font-semibold text-text">Saved wallets</span>
            {n >= 2 && (
              <Link
                href={compareHref(saved.list.slice(0, MAX_COMPARE).map((w) => w.accountId))}
                onClick={() => setOpen(false)}
                className="seg no-underline"
                title={n > MAX_COMPARE ? `Compares the first ${MAX_COMPARE} of your ${n} saved wallets` : 'Compare these wallets side by side'}
              >
                Compare saved{n > MAX_COMPARE ? ` (first ${MAX_COMPARE})` : ''}
              </Link>
            )}
          </div>
          {n === 0 ? (
            <div className="px-[14px] py-5 text-center text-[12.5px] text-muted">
              Nothing saved yet. Open any trader and press <b className="text-text">Save</b> beside its name.
            </div>
          ) : (
            <ul className="m-0 max-h-[360px] list-none overflow-y-auto p-0">
              {saved.list.map((w) => (
                <SavedRow key={w.accountId} wallet={w} onOpen={() => setOpen(false)} onRemove={() => saved.remove(w.accountId)} />
              ))}
            </ul>
          )}
          <p className="m-0 border-t border-border px-[14px] py-[10px] text-[11.5px] leading-[1.45] text-muted2">
            Saved in this browser only. Clearing site data removes the list. For alerts that actually reach you, watch the address in Telegram.
            {saved.refused && <span className="block text-watch">This browser refused to store the list just now.</span>}
          </p>
        </div>
      )}
    </div>
  );
}

type RowState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly netPnl: number; readonly positions: number; readonly status: { readonly text: string; readonly tone: 'safe' | 'watch' | 'danger' | 'muted' } };

/** One saved wallet, read fresh when the list opens: the same profile and positions the profile page uses. */
function SavedRow({ wallet, onOpen, onRemove }: { readonly wallet: SavedWallet; readonly onOpen: () => void; readonly onRemove: () => void }) {
  const [state, setState] = useState<RowState>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    Promise.all([api.account(wallet.accountId), api.accountPositions(wallet.accountId)])
      .then(([profile, assessed]) => {
        if (!live) return;
        const positions = assessed.data.positions;
        const buffers = positions.map((p) => p.liqBufferPct);
        let status: Extract<RowState, { kind: 'ready' }>['status'];
        if (positions.length === 0) status = { text: 'no positions', tone: 'muted' };
        else if (buffers.some((b) => b === undefined)) status = { text: 'not priced', tone: 'muted' };
        else {
          const nearest = Math.min(...(buffers as number[]));
          const tier = bufferTier(nearest);
          status =
            tier === 'past'
              ? { text: 'past liquidation', tone: 'danger' }
              : tier === 'safe'
                ? { text: 'healthy', tone: 'safe' }
                : { text: `${formatPct(nearest)} from liquidation`, tone: tier === 'danger' ? 'danger' : 'watch' };
        }
        setState({ kind: 'ready', netPnl: profile.data.netPnlAusd, positions: positions.length, status });
      })
      .catch(() => live && setState({ kind: 'failed' }));
    return () => {
      live = false;
    };
  }, [wallet.accountId]);

  const tone = state.kind === 'ready' ? { safe: 'text-safe bg-safe/12', watch: 'text-watch bg-watch/12', danger: 'text-danger bg-danger/12', muted: 'text-muted bg-card2' }[state.status.tone] : '';
  return (
    <li className="flex items-center gap-2 border-b border-border px-[14px] py-[9px] last:border-b-0 hover:bg-card2">
      <Link href={`/traders/${wallet.address === '' ? wallet.accountId : wallet.address}`} onClick={onOpen} className="min-w-0 flex-1 no-underline">
        <span className="num block text-[13px] font-semibold text-text">{wallet.address === '' ? `#${wallet.accountId}` : shortAddress(wallet.address)}</span>
        <span className="block text-[11.5px] text-muted2">
          {state.kind === 'loading' ? 'reading…' : state.kind === 'failed' ? 'could not be read just now' : `${formatCount(state.positions)} open position${state.positions === 1 ? '' : 's'} · account #${formatCount(wallet.accountId)}`}
        </span>
      </Link>
      {state.kind === 'ready' && (
        <span className="flex flex-none flex-col items-end gap-[3px]">
          <span className={`rounded-[4px] px-[6px] py-[1px] text-[10.5px] font-semibold whitespace-nowrap ${tone}`}>{state.status.text}</span>
          <span className={`num text-[12px] ${state.netPnl > 0 ? 'text-safe' : state.netPnl < 0 ? 'text-danger' : 'text-muted'}`} title="Net PnL, lifetime">
            {formatSignedMoney(state.netPnl)}
          </span>
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${wallet.address === '' ? `account #${wallet.accountId}` : wallet.address} from saved wallets`}
        className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[5px] text-[15px] leading-none text-muted2 hover:bg-card hover:text-text"
      >
        ×
      </button>
    </li>
  );
}
