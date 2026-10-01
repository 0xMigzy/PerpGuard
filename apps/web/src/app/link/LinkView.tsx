'use client';

/**
 * The linking page: prove you own a Perpl account, once, so the bot can act
 * on it from your chat. It exists solely to prove ownership; it never shows a
 * position and never executes an action.
 *
 * Arrives with `?code=` from the bot's /link. The code opens a session for
 * the Telegram identity that asked — transport, not proof. The proof is one
 * of two things collected here: a wallet signature through Dynamic, or an
 * API key pasted into a form that posts to this origin's backend and nowhere
 * else. The key is never shown again, by this page or any route.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError, describeError, link, type KeyProof, type LinkMe, type WalletProof } from '@/lib/api.ts';
import { PageHeader } from '@/components/PageHeader.tsx';
import { DYNAMIC_ENVIRONMENT_ID } from './dynamicEnv.ts';
import { WalletProofCard } from './WalletProofCard.tsx';

type Phase = { kind: 'opening' } | { kind: 'no-session'; reason: string } | { kind: 'ready'; me: LinkMe };

export function LinkView() {
  const params = useSearchParams();
  const code = params.get('code') ?? '';
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setPhase({ kind: 'ready', me: await link.me() });
    } catch (error) {
      setPhase({ kind: 'no-session', reason: describeError(error) });
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // A code opens the session; without one, an existing cookie may still be live.
        const me = code === '' ? await link.me() : await link.session(code);
        if (alive) setPhase({ kind: 'ready', me });
      } catch (error) {
        if (!alive) return;
        const reason = error instanceof ApiError && error.status === 401 ? error.message : describeError(error);
        setPhase({ kind: 'no-session', reason });
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  if (phase.kind === 'opening') {
    return (
      <>
        <PageHeader title="Link your account" subtitle="Prove you own a Perpl account so the bot can act on it from your chat." />
        <div className="card max-w-[640px] px-[22px] py-5 text-[13px] text-muted">Opening your linking session…</div>
      </>
    );
  }

  if (phase.kind === 'no-session') {
    return (
      <>
        <PageHeader title="Link your account" subtitle="Prove you own a Perpl account so the bot can act on it from your chat." />
        <div className="card max-w-[640px] px-[22px] py-5">
          <div className="eyebrow">No session</div>
          <p className="mt-2 text-[13px] text-muted">{phase.reason}</p>
          <p className="mt-2 text-[13px] text-muted">
            Send <b className="num font-semibold text-text">/link</b> to the PerpGuard bot in Telegram and open the link it replies with.
          </p>
        </div>
      </>
    );
  }

  const { me } = phase;
  const linked = me.link;
  const sessionLine = (s: NonNullable<LinkMe['link']>['session']): string => {
    if (s === undefined) return 'no session is running for it';
    if (s.mismatch !== undefined) return s.mismatch;
    return `session ${s.trading.state}${s.trading.forwardingAllowed === false ? ', order forwarding OFF on the account' : ''}; positions ${s.positions.state}`;
  };

  return (
    <>
      <PageHeader
        title="Link your account"
        subtitle="Prove you own a Perpl account so the bot can act on it from your chat. This page proves ownership and nothing else: it never shows a position and never sends an action."
      />

      <div className="mb-4 text-[12.5px] text-muted">
        Linking session for Telegram user <span className="num">{me.identity.userId}</span> on <span className="num">{me.network}</span>.{' '}
        {me.envAccountId !== null && (
          <>
            This PerpGuard runs account <span className="num">{me.envAccountId}</span> itself; a wallet that owns it links at once.
          </>
        )}
      </div>

      {notice !== undefined && (
        <div role="status" className={`mb-4 rounded-[10px] border px-4 py-3 text-[13px] ${notice.tone === 'ok' ? 'border-safe/40 bg-safe/10' : notice.tone === 'warn' ? 'border-watch/40 bg-watch/10' : 'border-danger/40 bg-danger/10'}`}>
          {notice.text}
        </div>
      )}

      {linked !== null && (
        <div className="card mb-4 max-w-[640px] px-[22px] py-5">
          <div className="eyebrow">Linked</div>
          <h2 className="m-0 mt-1 text-[18px] font-bold tracking-[-0.02em]">
            Account {linked.accountId}, proved by {linked.proof === 'wallet' ? 'wallet signature' : 'API key'}
          </h2>
          <p className="mt-2 text-[13px] text-muted">
            {linked.needsRelink !== undefined ? `Needs re-linking: ${linked.needsRelink}` : sessionLine(linked.session)}. Alerts in your chat carry the buttons to act; every tap is re-checked against this link at the moment you tap.
          </p>
          <button
            type="button"
            className="btn danger mt-3"
            onClick={() => {
              void (async () => {
                try {
                  const r = await link.unlink();
                  setNotice({ tone: 'warn', text: r.text });
                  setPhase({ kind: 'ready', me: r.me });
                } catch (error) {
                  setNotice({ tone: 'bad', text: describeError(error) });
                }
              })();
            }}
          >
            Unlink now
          </button>
          <p className="mt-2 text-[12px] text-muted">Immediate: the link is removed, any stored key is deleted, and the session is closed.</p>
        </div>
      )}

      {me.provenAccountId !== null && linked === null && (
        <div role="status" className="mb-4 rounded-[10px] border border-watch/40 bg-watch/10 px-4 py-3 text-[13px]">
          <b className="text-watch">Your wallet owns account {me.provenAccountId}.</b>{' '}
          <span className="text-muted">That proves ownership. To act on it PerpGuard needs an API key for that account: paste one below and the link completes.</span>
        </div>
      )}

      <div className="grid max-w-[1000px] grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card px-[22px] py-5">
          <div className="eyebrow">Option 1</div>
          <h2 className="m-0 mt-1 text-[16px] font-bold tracking-[-0.02em]">Sign with the wallet that owns the account</h2>
          <p className="mt-2 mb-3 text-[13px] text-muted">
            A signature proves which wallet you hold, and the Exchange contract says which account that wallet owns. No funds move, no approval is granted, nothing is spent.
          </p>
          {DYNAMIC_ENVIRONMENT_ID !== undefined && me.dynamicConfigured ? (
            <WalletProofCard
              onProof={(proof: WalletProof, next: LinkMe) => {
                setPhase({ kind: 'ready', me: next });
                setNotice(
                  proof.kind === 'linked'
                    ? { tone: 'ok', text: `Linked to account ${proof.accountId}. Your chat now gets alerts with the buttons to act.` }
                    : proof.kind === 'proven-needs-key'
                      ? { tone: 'warn', text: proof.reason }
                      : { tone: 'bad', text: proof.reason },
                );
              }}
              onProblem={(text) => setNotice({ tone: 'bad', text })}
            />
          ) : (
            <div className="rounded-[9px] border border-dashed border-border2 px-3 py-2 text-[12.5px] text-muted">Wallet sign-in is not configured on this deployment.</div>
          )}
        </div>

        <KeyProofCard me={me} onProof={(proof, next) => {
          setPhase({ kind: 'ready', me: next });
          setNotice(proof.kind === 'linked' ? { tone: 'ok', text: `Linked to account ${proof.accountId} with an API key.${proof.forwardingAllowed === false ? ' Note: order forwarding is OFF on this account, so actions will be refused until its owner wallet enables it.' : ''}` } : { tone: 'bad', text: proof.reason });
        }} onProblem={(text) => setNotice({ tone: 'bad', text })} />
      </div>

      <p className="mt-4 text-[12px] text-muted">
        <button type="button" className="text-accent-hi" onClick={() => void link.signOut().then(() => refresh())}>
          Close this linking session
        </button>{' '}
        — it closes on its own after thirty minutes. Closing it does not unlink anything.
      </p>
    </>
  );
}

/** The key form. Posts to this origin's backend over HTTPS; refuses plain HTTP off localhost. */
function KeyProofCard({ me, onProof, onProblem }: { readonly me: LinkMe; readonly onProof: (proof: KeyProof, me: LinkMe) => void; readonly onProblem: (text: string) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const insecure = typeof window !== 'undefined' && window.location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(window.location.hostname);
  const disabled = busy || !me.keyStorageConfigured || insecure;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await link.key(apiKey, secret);
      // Cleared whatever the outcome: the key is not kept in this page's memory.
      setApiKey('');
      setSecret('');
      onProof(r.proof, r.me);
    } catch (error) {
      setSecret('');
      onProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card px-[22px] py-5">
      <div className="eyebrow">Option 2</div>
      <h2 className="m-0 mt-1 text-[16px] font-bold tracking-[-0.02em]">Paste an API key for the account</h2>
      <p className="mt-2 text-[13px] text-muted">
        <b className="font-semibold text-text">A Perpl API key cannot withdraw or transfer funds.</b> It can place and cancel orders and add margin, which is what the buttons do. It is entered here and nowhere else — never in Telegram — and PerpGuard signs in with it once to learn which account it is for, stores it encrypted, and never shows it again.
      </p>
      {!me.keyStorageConfigured && <p className="mt-2 text-[12.5px] text-danger">This deployment has no key-encryption key configured, so it cannot store an API key. Link by wallet instead.</p>}
      {insecure && <p className="mt-2 text-[12.5px] text-danger">This page is not on HTTPS, so the key form is off: a key must only travel over an encrypted connection.</p>}
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input className="input" placeholder="API key" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={disabled} />
        <input className="input" type="password" placeholder="API key secret (hex)" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} disabled={disabled} />
        <button type="submit" className="btn primary" disabled={disabled || apiKey.trim() === '' || secret.trim() === ''}>
          {busy ? 'Signing in once…' : 'Link with this key'}
        </button>
      </form>
      <p className="mt-2 text-[12px] text-muted">
        Stored encrypted at rest under a key held only on the server. If that server key is ever rotated, every stored API key becomes unreadable and you will be asked to link again; nothing is ever re-encrypted or kept in the clear.
      </p>
    </div>
  );
}
