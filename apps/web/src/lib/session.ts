'use client';

import { protect } from './api.ts';

const EVENT = 'perpguard:session';

/** Tells every gate on the page to re-ask the backend who is signed in. */
export function notifySessionChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

export function onSessionChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

type Exchange = { readonly ok: true } | { readonly ok: false; readonly reason: string };
let inFlight: Promise<Exchange> | undefined;

/**
 * Dynamic's JWT -> the backend's session cookie.
 *
 * Loaded lazily so a build without Dynamic never imports the SDK here. Returns
 * the backend's answer, or the refusal reason: a wallet that owns no account
 * this backend watches is told so rather than shown someone else's positions.
 *
 * ONE EXCHANGE AT A TIME. A fresh login fires both the provider's
 * `onAuthSuccess` and the sign-in card's mount effect; the second caller joins
 * the first's promise instead of opening a second session.
 */
export function exchangeDynamicSession(): Promise<Exchange> {
  inFlight ??= (async (): Promise<Exchange> => {
    try {
      const { getAuthToken } = await import('@dynamic-labs/sdk-react-core');
      const token = getAuthToken();
      if (token === undefined) return { ok: false, reason: 'Dynamic has no session token yet.' };
      try {
        await protect.signInWithDynamic(token);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        notifySessionChanged();
      }
    } finally {
      inFlight = undefined;
    }
  })();
  return inFlight;
}

// ── ending Dynamic's session from outside its React tree ────────────────────
//
// The SDK's logout is `handleLogOut` off its context hook, which only a
// component under the provider can call. The provider registers it here once
// mounted, so the gate's Sign out button, which renders whether or not Dynamic
// is configured, can end both sessions without importing the SDK.
let dynamicLogoutFn: (() => Promise<void>) | undefined;

export function registerDynamicLogout(fn: (() => Promise<void>) | undefined): void {
  dynamicLogoutFn = fn;
}

/**
 * Ends Dynamic's session too, so a signed-out page does not sign itself back
 * in: the card's mount effect would otherwise see the SDK still logged in and
 * exchange the token again.
 */
export async function dynamicLogout(): Promise<void> {
  if (dynamicLogoutFn === undefined) return;
  try {
    await dynamicLogoutFn();
  } catch {
    // The backend session is already closed; a failed SDK logout only means
    // the widget still shows the wallet until the next reload.
  }
}
