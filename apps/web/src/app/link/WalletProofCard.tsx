'use client';

/**
 * The wallet proof: connect with RainbowKit, then sign one message.
 *
 * The backend issues a Sign-In with Ethereum challenge for the connected
 * address (this site, the trading network's chain, a one-time nonce, five
 * minutes), the wallet signs it, and the backend verifies the signature and
 * asks the Exchange contract which Perpl account the wallet owns. The
 * signature proves ownership and nothing else: it moves no funds, places no
 * trade, and authorises no future action. The API key does that, separately.
 */
import { useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useDisconnect, useSignMessage } from 'wagmi';
import { describeError, link, type LinkMe, type WalletProof } from '@/lib/api.ts';

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function WalletProofCard({ onProof, onProblem }: { readonly onProof: (proof: WalletProof, me: LinkMe) => void; readonly onProblem: (text: string) => void }) {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState<'idle' | 'signing' | 'checking'>('idle');

  const prove = async () => {
    if (address === undefined) return;
    setBusy('signing');
    try {
      const { message } = await link.challenge(address);
      const signature = await signMessageAsync({ message });
      setBusy('checking');
      const r = await link.wallet(message, signature);
      onProof(r.proof, r.me);
    } catch (error) {
      // A wallet that declined to sign is not a problem with the page.
      const text = error instanceof Error && /reject|denied|cancel/i.test(error.message) ? 'The signature was declined in the wallet. Nothing was linked.' : describeError(error);
      onProblem(text);
    } finally {
      setBusy('idle');
    }
  };

  return (
    <ConnectButton.Custom>
      {({ openConnectModal, openAccountModal, mounted }) => {
        if (!mounted) return <div className="h-[34px]" aria-hidden="true" />;
        if (!isConnected || address === undefined) {
          return (
            <button type="button" className="btn" onClick={openConnectModal}>
              Connect Wallet
            </button>
          );
        }
        return (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={openAccountModal} className="num inline-flex items-center gap-2 rounded-[8px] border border-border2 bg-card px-3 py-[7px] text-[12.5px] text-text" title="Switch or disconnect">
              <span aria-hidden="true">🟢</span> Connected <span className="text-muted">{short(address)}</span>
            </button>
            <button type="button" className="btn" disabled={busy !== 'idle'} onClick={() => void prove()}>
              {busy === 'signing' ? 'Sign in your wallet…' : busy === 'checking' ? 'Looking up your account…' : 'Sign to prove ownership'}
            </button>
            <button type="button" className="text-[12px] text-muted underline decoration-border2 underline-offset-2 hover:text-text" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
