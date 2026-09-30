'use client';

import { useEffect, useRef } from 'react';
import { DynamicWidget, useDynamicContext, useIsLoggedIn } from '@dynamic-labs/sdk-react-core';
import { exchangeDynamicSession } from '@/lib/session.ts';

/**
 * The wallet login, and the bridge from Dynamic's session to PerpGuard's.
 *
 * Rendered only when Dynamic is configured, because its hooks need the
 * provider. If Dynamic already holds a login when this mounts — a refresh, or
 * a backend session that expired before Dynamic's did — the token is exchanged
 * again without the user doing anything, which is what makes a session survive
 * a refresh. A fresh login is exchanged by the provider's `onAuthSuccess`; the
 * session module joins the two into one request.
 */
export function DynamicSignIn({ onProblem }: { readonly onProblem: (reason: string | undefined) => void }) {
  const loggedIn = useIsLoggedIn();
  const { sdkHasLoaded, primaryWallet } = useDynamicContext();
  const tried = useRef(false);
  useEffect(() => {
    if (!sdkHasLoaded || !loggedIn || tried.current) return;
    tried.current = true;
    void exchangeDynamicSession().then((r) => {
      if (!r.ok) onProblem(r.reason);
    });
  }, [sdkHasLoaded, loggedIn, onProblem]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <DynamicWidget />
      {loggedIn && primaryWallet !== null && (
        <span className="num text-[12.5px] text-muted">Signed in to Dynamic as {primaryWallet.address.slice(0, 6)}…{primaryWallet.address.slice(-4)} · reading the account…</span>
      )}
    </div>
  );
}
