'use client';

/**
 * The wallet proof: Dynamic's widget, and the one token exchange this page
 * makes. When the SDK holds a login, its JWT is posted to this origin's
 * backend, which verifies it against Dynamic's keys and asks the Exchange
 * contract which account the wallet owns. The token is read here and sent
 * there, and nowhere else.
 */
import { useEffect, useRef, useState } from 'react';
import { DynamicWidget, getAuthToken, useDynamicContext, useIsLoggedIn } from '@dynamic-labs/sdk-react-core';
import { describeError, link, type LinkMe, type WalletProof } from '@/lib/api.ts';

export function WalletProofCard({ onProof, onProblem }: { readonly onProof: (proof: WalletProof, me: LinkMe) => void; readonly onProblem: (text: string) => void }) {
  const loggedIn = useIsLoggedIn();
  const { sdkHasLoaded, primaryWallet } = useDynamicContext();
  const [busy, setBusy] = useState(false);
  const sent = useRef<string | undefined>(undefined);

  const prove = async () => {
    const token = getAuthToken();
    if (token === undefined) {
      onProblem('Sign in with your wallet first.');
      return;
    }
    if (sent.current === token) return;
    sent.current = token;
    setBusy(true);
    try {
      const r = await link.wallet(token);
      onProof(r.proof, r.me);
    } catch (error) {
      sent.current = undefined;
      onProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  // A login completed while this card is mounted is proved automatically, once.
  useEffect(() => {
    if (sdkHasLoaded && loggedIn) void prove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkHasLoaded, loggedIn]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <DynamicWidget />
      {loggedIn && primaryWallet !== null && (
        <>
          <span className="num text-[12.5px] text-muted">
            {primaryWallet.address.slice(0, 6)}…{primaryWallet.address.slice(-4)}
          </span>
          <button type="button" className="btn" disabled={busy} onClick={() => void prove()}>
            {busy ? 'Looking up your account…' : 'Use this wallet'}
          </button>
        </>
      )}
    </div>
  );
}
