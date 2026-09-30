'use client';

import { useState } from 'react';
import type { ProtectSession } from '@perpguard/backend/protect';
import { ApiError, describeError, protect } from '@/lib/api.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from './ErrorNote.tsx';
import { PageHeader } from './PageHeader.tsx';
import { Skeleton } from './Skeleton.tsx';

/**
 * The private pages' front door. Renders the sign-in card to an anonymous
 * visitor and NOTHING of the account; renders `children` only once the
 * backend has confirmed a session. Shared by Protect and Alerts so the two
 * cannot drift on who may see what.
 */
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
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  const signOut = () => {
    void protect.signOut().catch(() => undefined).then(() => me.refresh());
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
        {signedOut ? <SignIn onSignedIn={me.refresh} /> : <ErrorNote error={me.error} what="Your session" />}
      </>
    );
  }
  return <>{children(me.data, signOut)}</>;
}

function SignIn({ onSignedIn }: { readonly onSignedIn: () => void }) {
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
    <form onSubmit={submit} className="card max-w-[560px] px-[22px] py-5">
      <div className="eyebrow">Private</div>
      <h2 className="m-0 mt-1 text-[18px] font-bold tracking-[-0.02em]">This page shows one account, to its owner.</h2>
      <p className="mt-2 mb-3 text-[13px] text-muted">
        Send <b className="num font-semibold text-text">/web</b> to the PerpGuard bot in your linked Telegram chat. It replies with a one-time code that works for five
        minutes. Nothing about the account is shown until it is entered.
      </p>
      <label htmlFor="link-code" className="eyebrow">
        Sign-in code
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
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
      {problem !== undefined && <div className="mt-2 text-[12.5px] text-danger">{problem}</div>}
    </form>
  );
}
