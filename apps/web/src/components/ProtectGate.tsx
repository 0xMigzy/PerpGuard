'use client';

import { useEffect, useState } from 'react';
import type { ProtectConfig, ProtectSession } from '@perpguard/backend/protect';
import { ApiError, describeError, protect } from '@/lib/api.ts';
import { dynamicLogout, onSessionChanged } from '@/lib/session.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { DYNAMIC_ENVIRONMENT_ID } from './DynamicProviders.tsx';
import nextDynamic from 'next/dynamic';
import { ErrorNote } from './ErrorNote.tsx';
import { PageHeader } from './PageHeader.tsx';
import { Skeleton } from './Skeleton.tsx';

/**
 * The private pages' front door. Renders the sign-in card to an anonymous
 * visitor and NOTHING of the account; renders `children` only once the
 * backend has confirmed a session. Shared by Protect and Alerts so the two
 * cannot drift on who may see what.
 *
 * THE TRUST ARGUMENT IS ON THE CARD, in words: the user signs in with a wallet
 * and PerpGuard reads the account from the chain. No API key, no seed phrase,
 * no signature that moves funds, at any step.
 */
/**
 * Loaded only when the card actually renders it: the Dynamic SDK and its
 * wallet connectors are most of this page's bytes, and a deployment without
 * an environment id must not ship them. Client-only, since the SDK reads the
 * browser's storage on load.
 */
const DynamicSignIn = nextDynamic(() => import('./DynamicSignIn.tsx').then((m) => m.DynamicSignIn), {
  ssr: false,
  loading: () => <Skeleton className="h-[44px] w-[220px]" />,
});

export function ProtectGate({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: (session: ProtectSession, signOut: () => void) => React.ReactNode;
}) {
  const me = usePoll(protect.me, 60_000, 'protect:me');
  const config = usePoll(protect.config, 300_000, 'protect:config');
  const signedOut = me.error instanceof ApiError && me.error.status === 401;

  // Anything that changes the session — a Dynamic login, a logout, a demo
  // button — tells the gate to ask again.
  useEffect(() => onSessionChanged(() => me.refresh()), [me.refresh]);

  const signOut = () => {
    void protect
      .signOut()
      .catch(() => undefined)
      .then(async () => {
        await dynamicLogout();
        me.refresh();
      });
  };

  if (me.loading && me.data === undefined) {
    return (
      <>
        <PageHeader title={title} subtitle={subtitle} />
        <Skeleton className="h-[120px] w-full" />
      </>
    );
  }
  if (me.data === undefined) {
    return (
      <>
        <PageHeader title={title} subtitle={subtitle} />
        {signedOut ? <SignInCard config={config.data} onSignedIn={me.refresh} /> : <ErrorNote error={me.error} what="Your session" />}
      </>
    );
  }
  return <>{children(me.data, signOut)}</>;
}

function SignInCard({ config, onSignedIn }: { readonly config: ProtectConfig | undefined; readonly onSignedIn: () => void }) {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const dynamicOn = DYNAMIC_ENVIRONMENT_ID !== undefined && config?.dynamicConfigured === true;

  const demo = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await protect.signInDemo();
      onSignedIn();
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card max-w-[640px] px-[22px] py-5">
      <div className="eyebrow">Private</div>
      <h2 className="m-0 mt-1 text-[18px] font-bold tracking-[-0.02em]">This page shows one account, to its owner.</h2>
      <p className="mt-2 mb-4 max-w-[60ch] text-[13px] text-muted">
        Sign in with the wallet that owns your Perpl account and PerpGuard reads the account off the Exchange contract from that address.{' '}
        <b className="font-semibold text-text">No API key, no seed phrase, and no signature that moves funds</b> — at any step. The only thing you prove is
        which wallet you hold.
      </p>

      {dynamicOn ? (
        <DynamicSignIn onProblem={setProblem} />
      ) : (
        <div className="rounded-[9px] border border-dashed border-border2 px-3 py-2 text-[12.5px] text-muted">
          Wallet sign-in is not configured on this deployment{config === undefined ? '' : ' (no Dynamic environment id)'}.
        </div>
      )}

      {config?.demoEnabled === true && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[9px] border border-border2 bg-card2 px-3 py-3">
          <div className="min-w-[220px] flex-1 text-[12.5px] text-muted">
            <b className="text-text">No funded wallet?</b> View PerpGuard&rsquo;s own testnet account, read-only. Everything renders; nothing can be sent.
          </div>
          <button type="button" className="btn" disabled={busy} onClick={() => void demo()}>
            {busy ? 'Opening…' : 'View the demo account'}
          </button>
        </div>
      )}

      <details className="mt-4 text-[12.5px] text-muted">
        <summary className="cursor-pointer">Have a code from the Telegram bot?</summary>
        <CodeSignIn onSignedIn={onSignedIn} />
      </details>

      {problem !== undefined && <div className="mt-3 text-[12.5px] text-danger">{problem}</div>}
    </div>
  );
}

function CodeSignIn({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (code.trim() === '' || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await protect.signIn(code);
      onSignedIn();
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-2">
      <p className="mt-0 mb-2">
        Send <b className="num font-semibold text-text">/web</b> to the bot in your linked chat; it replies with a one-time code that works for five minutes.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          id="link-code"
          className="num min-w-0 flex-1 rounded-[9px] border border-border2 bg-page px-3 py-2 text-[15px] tracking-[0.12em] text-text uppercase outline-none placeholder:normal-case placeholder:tracking-normal placeholder:text-muted focus:border-accent"
          placeholder="XXXX-XXXX"
          spellCheck={false}
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={busy || code.trim() === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
      {problem !== undefined && <div className="mt-2 text-danger">{problem}</div>}
    </form>
  );
}
