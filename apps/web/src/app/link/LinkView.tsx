'use client';

/**
 * The linking page: prove you own a Perpl account, once, so the bot can act
 * on it from your chat. It exists solely to prove ownership; it never shows a
 * position and never executes an action.
 *
 * Arrives with `?code=` from the bot's /link. The code opens a session for
 * the Telegram identity that asked — transport, not proof. The proof is one
 * of two things collected here: a signed wallet challenge (RainbowKit), or an
 * API key pasted into a form that posts to this origin's backend and nowhere
 * else. The key is never shown again, by this page or any route.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError, describeError, link, type KeyProof, type LinkMe, type WalletProof } from '@/lib/api.ts';
import { PageHeader } from '@/components/PageHeader.tsx';
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
        <PageHeader title="Connect your account" subtitle="Show that a Perpl account is yours, so the bot can act on it from your Telegram chat." />
        <div className="card max-w-[640px] px-[22px] py-5 text-[13px] text-muted">Opening…</div>
      </>
    );
  }

  if (phase.kind === 'no-session') {
    return (
      <>
        <PageHeader title="Connect your account" subtitle="Show that a Perpl account is yours, so the bot can act on it from your Telegram chat." />
        <div className="card max-w-[640px] px-[22px] py-5">
          <div className="eyebrow">This link has ended</div>
          <p className="mt-2 text-[13px] text-muted">{phase.reason}</p>
          <p className="mt-2 text-[13px] text-muted">
            In the PerpGuard bot on Telegram, tap <b className="font-semibold text-text">Connect my account</b> (or send <b className="num font-semibold text-text">/link</b>) and open the new link it gives you.
          </p>
        </div>
      </>
    );
  }

  const { me } = phase;
  const linked = me.link;
  const showOptions = linked === null || linked.needsRelink !== undefined;
  // Plain words for the connection's state; the internals stay out of it.
  const stateLine = (l: NonNullable<LinkMe['link']>): string => {
    if (l.needsRelink !== undefined) return 'Your saved API key can no longer be used, so the buttons are off. Paste it again below to reconnect.';
    const s = l.session;
    if (s === undefined || s.mismatch !== undefined || s.trading.state !== 'signed-in') return "PerpGuard can't reach this account right now. It will keep trying; alerts resume when it can.";
    if (s.trading.forwardingAllowed === false) return "This account doesn't allow trading by API key yet, so the buttons won't send. Turn on order forwarding in Perpl with the wallet that owns it.";
    return 'PerpGuard is watching it now. Alerts in your Telegram chat come with buttons to act.';
  };

  return (
    <>
      <PageHeader
        title="Connect your account"
        subtitle="Show that a Perpl account is yours, so the bot can act on it from your Telegram chat. This page only checks that; it never shows positions or sends trades."
      />

      <div className="mb-4 text-[13px] text-muted">
        Connecting {me.telegram.name === null ? 'your Telegram account' : <><b className="font-semibold text-text">{me.telegram.name}</b> on Telegram</>}, on Perpl <b className="font-semibold text-text">{me.network}</b>.
      </div>

      {notice !== undefined && (
        <div role="status" className={`mb-4 rounded-[10px] border px-4 py-3 text-[13px] ${notice.tone === 'ok' ? 'border-safe/40 bg-safe/10' : notice.tone === 'warn' ? 'border-watch/40 bg-watch/10' : 'border-danger/40 bg-danger/10'}`}>
          {notice.text}
        </div>
      )}

      {linked !== null && (
        <div className="card mb-4 max-w-[640px] px-[22px] py-5">
          <div className="eyebrow">Connected</div>
          <h2 className="m-0 mt-1 text-[18px] font-bold tracking-[-0.02em]">
            Perpl account #{linked.accountId}
          </h2>
          <p className="mt-1 mb-0 text-[12.5px] text-muted">Confirmed with {linked.proof === 'wallet' ? 'your wallet' : 'an API key'}.</p>
          <p className="mt-2 text-[13px] text-muted">{stateLine(linked)}</p>
          <button
            type="button"
            className="btn danger mt-3"
            title="Stops this Telegram chat acting on the account and deletes any API key you gave PerpGuard"
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
            Unlink account #{linked.accountId} from Telegram
          </button>
          <p className="mt-2 text-[12px] text-muted">Takes effect at once, and deletes any API key you gave PerpGuard. Your wallet and your positions are not touched.</p>
        </div>
      )}

      {me.provenAccountId !== null && linked === null && (
        <div role="status" className="mb-4 rounded-[10px] border border-watch/40 bg-watch/10 px-4 py-3 text-[13px]">
          <b className="text-watch">Your wallet owns Perpl account #{me.provenAccountId}.</b>{' '}
          <span className="text-muted">To use the buttons, PerpGuard also needs an API key for it. Paste one below to finish.</span>
        </div>
      )}

      {/* LINKED, THE PROOF IS DONE: the two ways in collapse, so nothing reads as unfinished
          and the only disconnect on the page is the account's own, named. A key that can no
          longer be opened still needs pasting again, so that case keeps them. */}
      {showOptions && (
      <div className="grid max-w-[1000px] grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card px-[22px] py-5">
          <div className="eyebrow">Option 1</div>
          <h2 className="m-0 mt-1 text-[16px] font-bold tracking-[-0.02em]">Sign in with the wallet that owns the account</h2>
          <p className="mt-2 mb-3 text-[13px] text-muted">
            Signing in shows which wallet you hold; PerpGuard then looks up the Perpl account it owns. No funds move and nothing is approved or spent.
          </p>
          {me.walletSignIn ? (
            <WalletProofCard
              onProof={(proof: WalletProof, next: LinkMe) => {
                setPhase({ kind: 'ready', me: next });
                setNotice(
                  proof.kind === 'linked'
                    ? { tone: 'ok', text: `Connected to Perpl account #${proof.accountId}. Alerts in your Telegram chat now come with buttons to act.` }
                    : proof.kind === 'proven-needs-key'
                      ? { tone: 'warn', text: proof.reason }
                      : { tone: 'bad', text: proof.reason },
                );
              }}
              onProblem={(text) => setNotice({ tone: 'bad', text })}
            />
          ) : (
            <div className="rounded-[9px] border border-dashed border-border2 px-3 py-2 text-[12.5px] text-muted">Wallet sign-in isn&rsquo;t available right now. Use an API key instead.</div>
          )}
        </div>

        <KeyProofCard me={me} onProof={(proof, next) => {
          setPhase({ kind: 'ready', me: next });
          setNotice(proof.kind === 'linked' ? { tone: 'ok', text: `Connected to Perpl account #${proof.accountId}.${proof.forwardingAllowed === false ? " One thing first: this account doesn't allow trading by API key yet, so the buttons won't send. Turn on order forwarding in Perpl with the wallet that owns it." : ' Alerts in your Telegram chat now come with buttons to act.'}` } : { tone: 'bad', text: proof.reason });
        }} onProblem={(text) => setNotice({ tone: 'bad', text })} />
      </div>
      )}

      <p className="mt-4 text-[12px] text-muted">
        <button type="button" className="text-accent-hi" onClick={() => void link.signOut().then(() => refresh())}>
          Close this page
        </button>{' '}
        when you&rsquo;re done. It also closes by itself after 30 minutes. Your connection stays either way.
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
        <b className="font-semibold text-text">A Perpl API key cannot withdraw or transfer funds.</b> It can add margin, reduce and close positions, which is what the buttons do. Enter it here and nowhere else, never in Telegram. PerpGuard stores it encrypted and never shows it again.
      </p>
      {!me.keyStorageConfigured && <p className="mt-2 text-[12.5px] text-danger">Connecting with an API key isn&rsquo;t available right now. Sign in with your wallet instead.</p>}
      {insecure && <p className="mt-2 text-[12.5px] text-danger">This page isn&rsquo;t on a secure (HTTPS) connection, so the key form is switched off. A key should only ever travel encrypted.</p>}
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
          {busy ? 'Checking the key…' : 'Connect with this key'}
        </button>
      </form>
      <p className="mt-2 text-[12px] text-muted">
        Disconnect at any time and the key is deleted.
      </p>
    </div>
  );
}
