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
import { isEthereumWallet } from '@dynamic-labs/ethereum';
import { describeError, link, ApiError, type LinkMe, type WalletKeyResult, type WalletKeyTypedData, type WalletProof } from '@/lib/api.ts';
import { DYNAMIC_ENVIRONMENT_ID } from './dynamicEnv.ts';

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

type Step = 'idle' | 'signing' | 'checking' | 'declined';

interface Props {
  /** The wallet whose ownership is on record (lowercase), if any. Only that wallet is shown green. */
  readonly verifiedAddress: string | undefined;
  readonly onProof: (proof: WalletProof, me: LinkMe) => void;
  readonly onProblem: (text: string) => void;
  /**
   * 'key' (the `wallet-key` switch on): the ONE signature is Perpl's own key authorisation; the server
   * creates, seals and links the key. 'sign-in' (off): the signed challenge, proving ownership only.
   */
  readonly mode?: 'sign-in' | 'key';
  readonly onKeyResult?: (result: WalletKeyResult, me: LinkMe) => void;
}

/** Perpl's typed data in the wallet's shape: the domain entry out of `types`, the chain id as a bigint. */
function forWallet(t: WalletKeyTypedData): Record<string, unknown> {
  const { EIP712Domain: _domainType, ...types } = t.types;
  return { domain: { ...t.domain, chainId: BigInt(t.domain['chainId'] as string) }, types, primaryType: t.primaryType ?? Object.keys(types)[0]!, message: t.message };
}

/** Without a Dynamic environment there is no provider, so no wallet: the key path is the way in. */
export function WalletProofCard(props: Props) {
  if (DYNAMIC_ENVIRONMENT_ID === undefined) {
    return <p className="m-0 text-[13px] text-muted">Wallet connection isn&apos;t available on this build. Use an API key below.</p>;
  }
  return <DynamicWalletProof {...props} />;
}

function DynamicWalletProof({ verifiedAddress, onProof, onProblem, mode = 'sign-in', onKeyResult }: Props) {
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
  // In key mode a proven wallet still needs its key: ownership alone is not the end of the page.
  const verified = mode === 'sign-in' && address !== undefined && verifiedAddress !== undefined && address.toLowerCase() === verifiedAddress.toLowerCase();

  const prove = useCallback(async () => {
    if (primaryWallet === null || address === undefined) return;
    setStep('signing');
    try {
      if (mode === 'key') {
        // 🔗 ONE SIGNATURE: Perpl's typed data, signed by this wallet; the server does the rest.
        const started = await link.walletKeyStart(address);
        // REUSED: PerpGuard already holds a working key for this account. Nothing created, nothing to sign.
        if (started.result !== undefined) {
          onKeyResult?.(started.result, started.me);
          setStep('idle');
          return;
        }
        const typedData = started.typedData;
        if (!isEthereumWallet(primaryWallet)) {
          setStep('idle');
          onProblem('This wallet can’t sign the request. Connect an Ethereum wallet, or paste an API key you already have.');
          return;
        }
        const client = await primaryWallet.getWalletClient();
        // Perpl's typed data is shaped at run time; viem's generics cannot check it, so it is passed as given.
        const sign = client.signTypedData as unknown as (args: Record<string, unknown>) => Promise<string>;
        const signature = await sign({ account: client.account, ...forWallet(typedData) });
        setStep('checking');
        const r = await link.walletKeyFinish(signature);
        onKeyResult?.(r.result, r.me);
        setStep('idle');
        return;
      }
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
      onProblem(error instanceof ApiError && mode === 'key' ? error.message : describeError(error));
    }
  }, [primaryWallet, address, onProof, onProblem, mode, onKeyResult]);

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
          <span className="text-muted">{mode === 'key' ? 'Creating your key with Perpl and connecting your account…' : 'Checking the signature and looking up your account…'}</span>
        ) : step === 'declined' ? (
          <>
            <b>The signature was declined.</b> <span className="text-muted">{mode === 'key' ? 'Nothing was created and nothing was linked.' : 'Nothing was linked. Sign to prove this wallet is yours.'}</span>
          </>
        ) : (
          <>
            {mode === 'key' ? (
              <>
                <b>One more step: approve one signature.</b> <span className="text-muted">It reads perpl.xyz and authorises creating a trade-only key for PerpGuard. It moves no funds; reject anything that mentions withdrawing or transferring.</span>
              </>
            ) : (
              <>
                <b>One more step: sign to prove this wallet is yours.</b> <span className="text-muted">It moves no funds and places no trade.</span>
              </>
            )}
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn primary" disabled={step === 'signing' || step === 'checking'} onClick={() => void prove()}>
          {step === 'signing' ? 'Waiting for your wallet…' : step === 'checking' ? (mode === 'key' ? 'Creating your key…' : 'Checking…') : mode === 'key' ? 'Approve the signature' : 'Sign to prove ownership'}
        </button>
        {forget}
      </div>
    </div>
  );
}
