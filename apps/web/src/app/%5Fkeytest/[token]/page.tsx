'use client';

/**
 * TEMPORARY (Stage 1): does Perpl enrol an API key for this wallet when
 * PerpGuard's backend asks with no Origin? Connect, press the button, sign
 * once; every raw answer is shown. The backend refuses any request without the
 * token in this page's address. The key's secret never comes here.
 */
import { use, useState } from 'react';
import { useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { isEthereumWallet } from '@dynamic-labs/ethereum';

type Step = { readonly label: string; readonly data: unknown };

async function post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // shown as text
  }
  return { status: res.status, data };
}

export default function KeyTestPage({ params }: { readonly params: Promise<{ readonly token: string }> }) {
  const { token } = use(params);
  const { primaryWallet, sdkHasLoaded, setShowAuthFlow } = useDynamicContext();
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const add = (label: string, data: unknown) => setSteps((s) => [...s, { label, data }]);

  const run = async () => {
    if (primaryWallet === null) return;
    setBusy(true);
    setSteps([]);
    try {
      const address = primaryWallet.address;
      const payload = await post('/api/keytest/payload', { token, address });
      add(`1. PerpGuard → Perpl /v1/api-key/payload (our server's answer: HTTP ${payload.status})`, payload.data);
      const nonce = (payload.data as { nonce?: string }).nonce;
      const typed = ((payload.data as { perpl?: { body?: { typed_data?: Record<string, unknown> } } }).perpl?.body?.typed_data) as
        | { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType?: string; message: Record<string, unknown> }
        | undefined;
      if (nonce === undefined || typed === undefined) return;
      if (!isEthereumWallet(primaryWallet)) {
        add('2. Wallet signature', 'This wallet is not an Ethereum wallet, so it cannot sign the typed data.');
        return;
      }
      const { EIP712Domain: _d, ...types } = typed.types;
      const primaryType = typed.primaryType ?? Object.keys(types)[0]!;
      const client = await primaryWallet.getWalletClient();
      let signature: string;
      try {
        // The typed data is Perpl's, shaped at run time; viem's generics cannot check it, so it is passed as given.
        const sign = client.signTypedData as unknown as (args: Record<string, unknown>) => Promise<string>;
        signature = await sign({
          account: client.account,
          domain: { ...typed.domain, chainId: BigInt(typed.domain['chainId'] as string) },
          types,
          primaryType,
          message: typed.message,
        });
      } catch (error) {
        add('2. Wallet signature', `Not signed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      add('2. Wallet signature', `${signature.slice(0, 18)}… (${(signature.length - 2) / 2} bytes)`);
      const enroll = await post('/api/keytest/enroll', { token, nonce, signature });
      add(`3. PerpGuard → Perpl /v1/api-key/enroll, then a sign-in with the new key (our server's answer: HTTP ${enroll.status})`, enroll.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-ui="terminal" className="mx-auto max-w-[760px]">
      <h1 className="mt-0 mb-1 text-[24px] font-bold">Perpl key test</h1>
      <p className="mt-0 mb-4 text-[13.5px] text-muted">Temporary. PerpGuard&rsquo;s server asks Perpl for the key with no Origin and no Referer; your wallet signs once. Nothing is stored.</p>
      {!sdkHasLoaded ? (
        <p className="text-muted">Loading the wallet connector…</p>
      ) : primaryWallet === null ? (
        <button type="button" className="btn primary" onClick={() => setShowAuthFlow(true)}>
          Connect wallet
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="chip">{primaryWallet.address}</span>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>
            {busy ? 'Working…' : 'Request a Perpl key'}
          </button>
        </div>
      )}
      <div className="mt-5 flex flex-col gap-3">
        {steps.map((s) => (
          <div key={s.label} className="card px-[14px] py-3">
            <div className="mb-2 text-[13px] font-semibold text-text">{s.label}</div>
            <pre className="m-0 overflow-x-auto text-[12px] leading-[1.5] whitespace-pre-wrap break-all text-text2">{typeof s.data === 'string' ? s.data : JSON.stringify(s.data, null, 2)}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
