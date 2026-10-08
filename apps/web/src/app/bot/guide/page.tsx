import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * THE SETUP GUIDE (/bot/guide). Static: no data, no fetch, no client code, so it
 * costs the server nothing. The owner's wording, as written; the one change is
 * the link step, which names the bot's real buttons and URL
 * (https://perpguard.app/link?code=…, from apps/backend/src/server/link/service.ts).
 * Prints to a clean light page (globals.css, `[data-guide]` under @media print).
 */

export const metadata: Metadata = {
  title: 'Setup guide',
  description: 'Create a Perpl testnet account, give PerpGuard permission to add margin for you, and connect it to Telegram.',
  openGraph: {
    title: 'Getting started with PerpGuard',
    description: 'Create a Perpl testnet account, give PerpGuard permission to add margin for you, and connect it to Telegram.',
  },
};

const ext = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-hi underline decoration-border2 underline-offset-2 hover:text-text">
    {text}
  </a>
);

function Callout({ tone = 'note', children }: { readonly tone?: 'note' | 'warn'; readonly children: ReactNode }) {
  const style = tone === 'warn' ? 'border-l-watch bg-watch/8' : 'border-l-accent bg-accent/8';
  return <div className={`guide-callout my-4 rounded-r-[8px] border-l-[3px] px-[14px] py-[11px] text-[14px] leading-[1.6] text-text2 ${style}`}>{children}</div>;
}

function Step({ n, title, minutes, children }: { readonly n: number; readonly title: string; readonly minutes: number; readonly children: ReactNode }) {
  return (
    <section className="guide-step mt-10" aria-labelledby={`step-${n}`}>
      <div className="mb-3 flex items-center gap-3">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-accent/16 text-[14px] font-bold text-accent-hi">{n}</span>
        <h2 id={`step-${n}`} className="m-0 flex-1" style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em' }}>
          {title}
        </h2>
        <span className="chip flex-none text-[11.5px]">{minutes} min</span>
      </div>
      {children}
    </section>
  );
}

const Ol = ({ children }: { readonly children: ReactNode }) => <ol className="m-0 flex flex-col gap-2 pl-[22px] text-[15px] leading-[1.6] text-text2">{children}</ol>;
const P = ({ children }: { readonly children: ReactNode }) => <p className="mt-0 mb-3 text-[15px] leading-[1.65] text-text2">{children}</p>;
const H3 = ({ children }: { readonly children: ReactNode }) => (
  <h3 className="mt-6 mb-2" style={{ fontSize: 16, fontWeight: 700 }}>
    {children}
  </h3>
);

function Table({ head, rows }: { readonly head: readonly [string, string]; readonly rows: readonly (readonly [ReactNode, ReactNode])[] }) {
  return (
    <div className="guide-table card overflow-hidden">
      <table className="w-full border-collapse text-[14px] leading-[1.55]">
        <thead>
          <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-[0.06em] text-muted">
            <th scope="col" className="w-[38%] px-[14px] py-[9px] font-semibold">{head[0]}</th>
            <th scope="col" className="px-[14px] py-[9px] font-semibold">{head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, b], i) => (
            <tr key={i} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="px-[14px] py-[10px] text-left font-semibold text-text">{a}</th>
              <td className="px-[14px] py-[10px] text-text2">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CHECKLIST = [
  'Wallet on Monad testnet, chain 10143',
  'Perpl account created and funded with test AUSD',
  'One-Click Trading turned on — the step that’s easy to miss',
  'API key created with read and trade permission, both parts saved',
  'Key entered on perpguard.app only, never in Telegram',
  'The bot shows the right account and network',
  'One small trade placed by hand, so you know the account works',
  'You’ve opened the kill switch screen and read it',
];

export default function GuidePage() {
  return (
    <div data-ui="terminal" data-guide="" className="mx-auto max-w-[720px]">
      <div className="text-[12px] font-semibold tracking-[0.08em] text-muted uppercase">PerpGuard · Testnet setup</div>
      <h1 className="mt-2 mb-3 text-[30px] font-bold tracking-[-0.03em] sm:text-[34px]">Getting started with PerpGuard</h1>
      <p className="mt-0 mb-4 text-[16.5px] leading-[1.6] text-text2">Create a Perpl testnet account, give PerpGuard permission to add margin for you, and connect it to Telegram.</p>
      <div className="mb-2 flex flex-wrap gap-2">
        <span className="chip">About 15 minutes</span>
        <span className="chip">Monad testnet · chain 10143</span>
        <span className="chip">Test funds only</span>
      </div>

      <Callout>
        You don&rsquo;t need any of this to get alerts. Send {ext('https://t.me/PerpGuardBot', '@PerpGuardBot')} any Perpl address or account number and it will watch that account on mainnet and message
        you before it gets liquidated — no wallet, no key, nothing to set up. This guide is for the next step: letting PerpGuard add margin for you, which runs on testnet.
      </Callout>

      <section className="mt-8" aria-labelledby="need">
        <h2 id="need" className="mt-0 mb-3" style={{ fontSize: 19, fontWeight: 700 }}>
          What you&rsquo;ll need
        </h2>
        <Table
          head={['Thing', 'Where']}
          rows={[
            ['A browser wallet', 'Rabby, MetaMask or Phantom. Use a wallet kept for testing, not your main one.'],
            ['Perpl testnet', ext('https://testnet.perpl.xyz', 'testnet.perpl.xyz')],
            ['Perpl API keys', ext('https://testnet.perpl.xyz/apikeys', 'testnet.perpl.xyz/apikeys')],
            [
              'PerpGuard',
              <>
                {ext('https://t.me/PerpGuardBot', 't.me/PerpGuardBot')} · <Link href="/" className="text-accent-hi underline decoration-border2 underline-offset-2">perpguard.app</Link>
              </>,
            ],
            ['Network', 'Monad testnet, chain id 10143'],
            ['RPC', <code key="rpc">https://testnet-rpc.monad.xyz</code>],
            ['Gas token', 'MON'],
            ['Collateral', 'AUSD'],
          ]}
        />
      </section>

      <Step n={1} title="Connect a wallet to Perpl" minutes={2}>
        <Ol>
          <li>Open {ext('https://testnet.perpl.xyz', 'testnet.perpl.xyz')} and select Connect.</li>
          <li>Approve the connection in your wallet. If it asks you to switch network, accept — Monad testnet, chain id 10143.</li>
          <li>
            To add the network by hand: chain id 10143, RPC <code>https://testnet-rpc.monad.xyz</code>, currency symbol MON.
          </li>
        </Ol>
        <Callout>Use a wallet you keep for testing. Never give your recovery phrase or private key to PerpGuard, to Perpl, or to anyone — nothing here will ever ask for them.</Callout>
      </Step>

      <Step n={2} title="Open a funded account" minutes={3}>
        <P>Connecting a wallet doesn&rsquo;t create a trading account. You need an account on Perpl&rsquo;s exchange contract with collateral in it.</P>
        <Ol>
          <li>Select Deposit and claim your test AUSD. Perpl gives new testnet accounts a starting balance.</li>
          <li>Deposit at least the minimum Perpl asks for, and approve the wallet transactions.</li>
          <li>Wait for the balance to appear in the trading interface.</li>
          <li>Place one small trade by hand to confirm the account works.</li>
        </Ol>
        <Callout tone="warn">You may need a little MON for gas. Deposits and permissions are on-chain transactions. If a transaction fails for lack of gas, get testnet MON from a Monad faucet first.</Callout>
      </Step>

      <Step n={3} title="Allow order forwarding" minutes={1}>
        <P>
          <b className="text-text">This is the step people miss, and nothing works without it.</b>
        </P>
        <P>By default, only your own wallet can place orders on your account. Order forwarding is the permission that lets an API key place them instead. Perpl calls it One-Click Trading.</P>
        <Ol>
          <li>Open Perpl&rsquo;s user settings and turn on One-Click Trading.</li>
          <li>Approve the transaction in your wallet. It&rsquo;s one transaction, once — not per session.</li>
        </Ol>
        <Callout tone="warn">
          If you skip this, every order PerpGuard sends is rejected. The exchange accepts the message and then refuses the order with reason <code>sr 34</code>, OrderForwardingNotAllowed. You can turn the permission off again at any time, from the same place.
        </Callout>
      </Step>

      <Step n={4} title="Create an API key" minutes={2}>
        <P>The key is what PerpGuard uses to place orders. A Perpl key can trade, and can never withdraw or move your funds.</P>
        <Ol>
          <li>With the same wallet connected, open {ext('https://testnet.perpl.xyz/apikeys', 'testnet.perpl.xyz/apikeys')}.</li>
          <li>Create a new key and label it PerpGuard.</li>
          <li>Give it read and trade permission. Nothing more.</li>
          <li>Approve the wallet signature.</li>
          <li>Save both parts of the key when they&rsquo;re shown. The secret cannot be recovered later — if you lose it, make a new key.</li>
        </Ol>
        <Callout tone="warn">The API secret is not your wallet&rsquo;s recovery phrase. It&rsquo;s a separate credential. Never paste either into a Telegram message, including to PerpGuard.</Callout>
      </Step>

      <Step n={5} title="Connect PerpGuard" minutes={3}>
        <Ol>
          <li>Open {ext('https://t.me/PerpGuardBot', '@PerpGuardBot')} in Telegram and send /start.</li>
          <li>Choose 🔐 Trading account.</li>
          <li>
            Tap 🔑 Enter API key. The bot gives you a one-time link. It opens <code>https://perpguard.app/link?code=…</code> over HTTPS and works once, for five minutes.
          </li>
          <li>
            Check the address bar reads <b className="text-text">perpguard.app</b> before you type anything.
          </li>
          <li>Enter your API key on that page only.</li>
          <li>Go back to Telegram. The bot confirms which account it&rsquo;s connected to.</li>
        </Ol>
        <P>
          <span className="mt-3 block">
            Then: you can also connect your wallet on that page. That proves which account is yours, so you don&rsquo;t have to know its number — but the key is still what lets PerpGuard act, so you need both.
          </span>
        </P>
      </Step>

      <Step n={6} title="Decide what it may do" minutes={2}>
        <P>Nothing automatic is on when you connect. PerpGuard watches and asks.</P>
        <H3>Alerts, which are always on</H3>
        <P>
          Set how close to liquidation you want to be told, in ⚙️ Settings. When a position reaches it, you get a message with the position, how close it is, your free balance, and buttons to add margin. Tapping an
          amount opens a confirmation — nothing is sent until you confirm.
        </P>
        <H3>Rescue, which is off until you turn it on</H3>
        <P>
          Automatic margin top-ups, for one position at a time, armed by tapping. You set the amount, how many top-ups, the total, the balance never to spend, and the wait between them. It only ever adds margin — it
          never closes or reduces a position.
        </P>
        <Callout>Rescue is not protection. It adds margin within the limits you set. A fast enough move still liquidates the position, and when its limits are spent it stops and tells you.</Callout>
        <H3>The kill switch</H3>
        <P>
          Stops every automation and closes every position, after a confirmation showing what you&rsquo;d realise. There&rsquo;s also a stop-automation-only option that leaves positions open — that one sends
          nothing to the exchange, so it works even when the exchange is unreachable.
        </P>
      </Step>

      <section className="mt-10" aria-labelledby="check">
        <h2 id="check" className="mt-0 mb-3" style={{ fontSize: 19, fontWeight: 700 }}>
          Before you rely on it
        </h2>
        <ul className="guide-checklist card m-0 flex list-none flex-col gap-0 p-0">
          {CHECKLIST.map((item, i) => (
            <li key={item} className="border-b border-border last:border-b-0">
              <label className="flex cursor-pointer items-start gap-3 px-[14px] py-[11px] text-[15px] leading-[1.5] text-text2">
                <input type="checkbox" id={`check-${i}`} className="mt-[3px] h-[17px] w-[17px] flex-none accent-[#6E54FF]" />
                <span>{item}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="trouble">
        <h2 id="trouble" className="mt-0 mb-3" style={{ fontSize: 19, fontWeight: 700 }}>
          When something doesn&rsquo;t work
        </h2>
        <Table
          head={['What you see', 'What it usually is']}
          rows={[
            ['Orders rejected with sr 34', 'Order forwarding is off. Turn on One-Click Trading in Perpl’s settings. This is the most common one.'],
            ['Account not found', 'The deposit hasn’t completed, or you’re on the wrong wallet. Check the account exists in Perpl’s own interface first.'],
            ['The key is refused', 'A mainnet key on a testnet account, or the other way round. PerpGuard’s actions are testnet only.'],
            ['You can see positions but nothing can be sent', 'Either the key lacks trade permission, or forwarding is off.'],
            ['A wallet transaction fails', 'Wrong network, or no MON for gas.'],
            ['You’ve lost the key, or shown it to someone', 'Revoke it on Perpl’s API keys page and make a new one. Revoking stops future orders; it does not close positions already open.'],
          ]}
        />
      </section>

      <section className="mt-10" aria-labelledby="safe">
        <h2 id="safe" className="mt-0 mb-3" style={{ fontSize: 19, fontWeight: 700 }}>
          Keeping it safe
        </h2>
        <ul className="m-0 flex flex-col gap-2 pl-[22px] text-[15px] leading-[1.6] text-text2">
          <li>Never share a recovery phrase or private key. Nothing in this guide needs one.</li>
          <li>Never paste an API secret into Telegram, including into a message to PerpGuard. It goes on the HTTPS page, nowhere else.</li>
          <li>Use a separate wallet for testing.</li>
          <li>A trading key can lose money without being able to withdraw any. Treat the permission seriously even though funds can&rsquo;t leave.</li>
          <li>Check the bot&rsquo;s username and the domain in the address bar before connecting.</li>
          <li>If anything looks wrong: stop automation in the bot, then revoke the key on Perpl.</li>
        </ul>
      </section>

      <footer className="guide-footer mt-12 border-t border-border pt-5 text-[13px] leading-[1.6] text-muted">
        <p className="mt-0 mb-2">PerpGuard is an independent tool and is not affiliated with or endorsed by Perpl or the Monad Foundation. Test tokens have no monetary value.</p>
        <p className="mt-0 mb-3">Perpl changes its interface, deposit minimums and faucets from time to time. Where this guide and Perpl&rsquo;s own app disagree, the app is right.</p>
        <p className="m-0">
          <Link href="/" className="text-accent-hi underline decoration-border2 underline-offset-2">perpguard.app</Link> — the dashboard ·{' '}
          <Link href="/status" className="text-accent-hi underline decoration-border2 underline-offset-2">perpguard.app/status</Link> — where every figure comes from ·{' '}
          {ext('https://t.me/PerpGuardBot', '@PerpGuardBot')} — the bot
        </p>
      </footer>
    </div>
  );
}
