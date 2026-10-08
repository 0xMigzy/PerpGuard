'use client';

/**
 * The wallet proof: connect, then sign one message. ONE FLOW (6 Oct 2026).
 *
 * Connecting is not signing, and the owner failed the signing step three
 * times while testing it on purpose: a green "Connected" read as finished.
 * So the signature is asked for AUTOMATICALLY the moment a wallet connects,
 * the card stays neutral ("one more step") until the backend has verified
 * it, and it turns green only for a wallet whose ownership is on record.
 * Declining is not an error: the card offers to ask again.
 *
 * Dynamic finds and connects the wallet (connect-only: its own sign-in is
 * off). The backend issues a Sign-In with Ethereum challenge for the
 * connected address (this site, the trading network's chain, a one-time
 * nonce, five minutes), the wallet signs it, and the backend verifies the
 * signature with viem and asks the Exchange contract which Perpl account the
 * wallet owns. The signature proves ownership and nothing else: it moves no
 * funds, places no trade, and authorises no future action. The API key does
 * that, separately.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { describeError, link, type LinkMe, type WalletProof } from '@/lib/api.ts';
import { DYNAMIC_ENVIRONMENT_ID } from './dynamicEnv.ts';

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

type Step = 'idle' | 'signing' | 'checking' | 'declined';

interface Props {
  /** The wallet whose ownership is on record (lowercase), if any. Only that wallet is shown green. */
  readonly verifiedAddress: string | undefined;
  readonly onProof: (proof: WalletProof, me: LinkMe) => void;
  readonly onProblem: (text: string) => void;
}

/** Without a Dynamic environment there is no provider, so no wallet: the key path is the way in. */
export function WalletProofCard(props: Props) {
  if (DYNAMIC_ENVIRONMENT_ID === undefined) {
    return <p className="m-0 text-[13px] text-muted">Wallet connection isn&apos;t available on this build. Use an API key below.</p>;
  }
  return <DynamicWalletProof {...props} />;
}

function DynamicWalletProof({ verifiedAddress, onProof, onProblem }: Props) {
  const { primaryWallet, sdkHasLoaded, setShowAuthFlow, handleLogOut } = useDynamicContext();
  const address = primaryWallet?.address;
  const [step, setStep] = useState<Step>('idle');
  /** Dynamic never loaded (its origin list, a blocked request): say so rather than leave an empty box. */
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (sdkHasLoaded) return;
    const timer = setTimeout(() => setStalled(true), 8_000);
    return () => clearTimeout(timer);
  }, [sdkHasLoaded]);
  /** Each connected address is asked automatically once per page; after that, the button asks. */
  const asked = useRef(new Set<string>());
  const verified = address !== undefined && verifiedAddress !== undefined && address.toLowerCase() === verifiedAddress.toLowerCase();

  const prove = useCallback(async () => {
    if (primaryWallet === null || address === undefined) return;
    setStep('signing');
    try {
      const { message } = await link.challenge(address);
      const signature = await primaryWallet.signMessage(message);
      if (signature === undefined) {
        setStep('declined');
        return;
      }
      setStep('checking');
      const r = await link.wallet(message, signature);
      onProof(r.proof, r.me);
      setStep('idle');
    } catch (error) {
      // A wallet that declined to sign is not a problem with the page: say so, and offer again.
      if (error instanceof Error && /reject|denied|cancel|declin/i.test(error.message)) {
        setStep('declined');
        return;
      }
      setStep('idle');
      onProblem(describeError(error));
    }
  }, [primaryWallet, address, onProof, onProblem]);

  // THE SECOND STEP STARTS ITSELF: a newly connected, not-yet-verified wallet is asked to sign at once.
  useEffect(() => {
    if (address === undefined || verified) return;
    const key = address.toLowerCase();
    if (asked.current.has(key)) return;
    asked.current.add(key);
    void prove();
  }, [address, verified, prove]);

  const forget = (
    <button type="button" className="text-[12px] text-muted underline decoration-border2 underline-offset-2 hover:text-text" title="Forgets the wallet on this page only. Links nothing and unlinks nothing." onClick={() => void handleLogOut()}>
      Use a different wallet
    </button>
  );

  if (!sdkHasLoaded) {
    return stalled ? (
      <p role="status" className="m-0 text-[13px] text-muted">Wallet connection didn&apos;t load. Reload the page, or use an API key instead.</p>
    ) : (
      <div className="h-[34px]" aria-hidden="true" />
    );
  }
  if (address === undefined) {
    return (
      <button type="button" className="btn" onClick={() => setShowAuthFlow(true)}>
        Connect wallet
      </button>
    );
  }
  if (verified) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="num inline-flex items-center gap-2 rounded-[8px] border border-safe/40 bg-safe/10 px-3 py-[7px] text-[12.5px] text-text">
          <span aria-hidden="true">✅</span> Ownership verified <span className="text-muted">{short(address)}</span>
        </span>
        {forget}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {/* NEUTRAL until verified: connected is not finished. */}
      <span className="num inline-flex w-fit items-center gap-2 rounded-[8px] border border-border2 bg-card px-3 py-[7px] text-[12.5px] text-text">
        Wallet connected <span className="text-muted">{short(address)}</span>
      </span>
      <p role="status" className="m-0 text-[13px]">
        {step === 'signing' ? (
          <>
            <b>One more step: sign in your wallet.</b> <span className="text-muted">The request is waiting in your wallet app; if it didn&apos;t open, switch to it.</span>
          </>
        ) : step === 'checking' ? (
          <span className="text-muted">Checking the signature and looking up your account…</span>
        ) : step === 'declined' ? (
          <>
            <b>The signature was declined.</b> <span className="text-muted">Nothing was linked. Sign to prove this wallet is yours.</span>
          </>
        ) : (
          <>
            <b>One more step: sign to prove this wallet is yours.</b> <span className="text-muted">It moves no funds and places no trade.</span>
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn primary" disabled={step === 'signing' || step === 'checking'} onClick={() => void prove()}>
          {step === 'signing' ? 'Waiting for your wallet…' : step === 'checking' ? 'Checking…' : 'Sign to prove ownership'}
        </button>
        {forget}
      </div>
    </div>
  );
}
