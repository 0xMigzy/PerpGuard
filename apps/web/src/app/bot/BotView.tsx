import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader.tsx';
import { ALERT_EXAMPLE, BOT_HANDLE, BOT_URL, TESTNET_GUIDE_URL } from '@/lib/botPreview.ts';

/**
 * THE BOT PAGE: what @PerpGuardBot does, in three words — WATCH, MANAGE,
 * PROTECT — and the way to it. Read-only like every page here: it links to
 * Telegram and nothing on it acts. Every capability named is one the bot has
 * (checked against apps/bot and apps/backend, 8 Oct 2026); amounts are AUSD.
 *
 * The example alert is the bot's own format (`lib/botPreview.ts`, pinned by
 * `apps/bot/src/botPagePreview.test.ts`), labelled as an example, its buttons
 * inert.
 */

type Group = 'watch' | 'manage' | 'protect';

const GROUP: Record<Group, { readonly label: string; readonly className: string }> = {
  watch: { label: 'Watch', className: 'bg-safe/12 text-safe' },
  manage: { label: 'Manage', className: 'bg-accent/14 text-accent-hi' },
  protect: { label: 'Protect', className: 'bg-watch/12 text-watch' },
};

interface Feature {
  readonly title: string;
  readonly group: Group;
  readonly icon: ReactNode;
  readonly lead: string;
  readonly points: readonly string[];
  /** Who it is for: anyone, or a connected account. */
  readonly needs: string;
}

const icon = (d: string): ReactNode => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const FEATURES: readonly Feature[] = [
  {
    title: 'Wallet tracking',
    group: 'watch',
    icon: icon('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'),
    lead: 'Watch up to 10 Perpl wallets on mainnet. No account, no API key, no signature.',
    points: ['A position opened, increased, reduced or closed', 'Every liquidation of a watched wallet, at any size', 'Re-read every 30 seconds'],
    needs: 'Anyone',
  },
  {
    title: 'Risk alerts',
    group: 'watch',
    icon: icon('M12 3 2 20h20L12 3Z M12 10v4 M12 17h.01'),
    lead: 'A warning as a position gets close to liquidation.',
    points: ['Watched wallets: Early, Standard or Late levels, or up to five of your own', 'Your account: one alert distance, from 0.5% to 20%', 'One message per level crossed, not a stream'],
    needs: 'Anyone',
  },
  {
    title: 'Market alerts',
    group: 'watch',
    icon: icon('M3 3v18h18 M7 15l4-4 3 3 5-6'),
    lead: 'What moves the market, as it happens on Perpl.',
    points: ['Liquidations above your threshold: 1,000 to 25,000 AUSD', 'Large trades above your threshold: 10,000 to 50,000 AUSD', 'Each one yours to set, or turn off'],
    needs: 'Anyone',
  },
  {
    title: 'My positions',
    group: 'manage',
    icon: icon('M4 6h16 M4 12h16 M4 18h10'),
    lead: 'Your connected Perpl account, position by position.',
    points: ['Distance to liquidation and unrealised P&L on every position', 'Free balance and the unrealised total for the account', 'Add margin, each amount showing the distance it buys; close a position'],
    needs: 'Connected account',
  },
  {
    title: 'Liquidation Rescue',
    group: 'protect',
    icon: icon('M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z'),
    lead: 'Automatic margin top-ups at your alert distance. Off until you turn it on, one position at a time.',
    points: ['How many top-ups, and the most in total', 'A balance it never spends below', 'Minutes between top-ups; every top-up checked against the position'],
    needs: 'Connected account',
  },
  {
    title: 'Kill switch',
    group: 'protect',
    icon: icon('M12 2v10 M18.4 6.6a9 9 0 1 1-12.8 0'),
    lead: 'Stop automation, or stop and close everything.',
    points: ['Stop automation only: Rescue stops, your positions stay open', 'Stop everything: closes every position after you confirm the cost', 'Resume lifts the stop; Rescue stays off until you turn it back on'],
    needs: 'Connected account',
  },
];

const STEPS: readonly { readonly title: string; readonly text: string }[] = [
  { title: 'Open Telegram', text: `Launch ${BOT_HANDLE} and tap Start.` },
  { title: 'Start watching', text: 'Add up to 10 wallets and set your alerts. No account or API key needed to monitor.' },
  { title: 'Connect and protect', text: 'Optionally connect your Perpl account to manage positions, add margin and set up Liquidation Rescue. Trading actions are testnet only.' },
];

const SECURITY: readonly { readonly title: string; readonly points: readonly string[] }[] = [
  { title: 'Read-only monitoring', points: ['Public wallets can be watched without any access to the account.', 'Watching can never execute a trade.'] },
  {
    title: 'Trading account',
    points: [
      'Linking uses a one-time code and an HTTPS verification page.',
      'Proving you own a wallet is separate from authorising trades with an API key.',
      'An API key can authorise trading but can never withdraw or transfer funds.',
      'Disconnecting removes the account link and PerpGuard’s copy of the API key. The key itself stays on your Perpl profile until you remove it there.',
    ],
  },
  {
    title: 'Trading safety',
    points: [
      'Every action you take that moves money asks you to confirm first; Rescue acts on its own only after you turn it on.',
      'Liquidation Rescue is off by default and works within the limits you set.',
      'Outcomes are checked against your actual positions, not the exchange’s receipt.',
      'Stop automation blocks anything automatic without closing your positions.',
    ],
  },
];

export function BotView() {
  return (
    // Opts this page into the terminal design system (globals.css).
    <div data-ui="terminal">
      <PageHeader title="PerpGuard Bot" subtitle="Track wallets, receive liquidation alerts and manage your Perpl positions directly from Telegram." />

      {/* ── the panel ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="bot-panel-title" className="card mb-4 px-[18px] py-5 sm:px-6 sm:py-6">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Telegram · {BOT_HANDLE}</div>
        {/* The terminal system sets every h2 to 14px; this one is the page's display line, sized inline. */}
        <h2 id="bot-panel-title" className="mt-2 mb-1" style={{ fontSize: 'clamp(21px, 2.2vw, 27px)', fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2 }}>
          Monitor risk. Protect your positions.
        </h2>
        <p className="m-0 max-w-[62ch] text-[13.5px] leading-[1.55] text-text2">Real-time monitoring, liquidation warnings and position management for Perpl on Monad.</p>

        <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f.title} className="rounded-[10px] border border-border bg-card2 px-[15px] py-[14px]">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="m-0 flex items-center gap-[9px] text-[14px] font-bold">
                    <span className="text-accent-hi">{f.icon}</span>
                    {f.title}
                  </h3>
                  <span className={`rounded-[4px] px-[6px] py-[2.5px] text-[10px] font-semibold tracking-[0.05em] uppercase ${GROUP[f.group].className}`}>{GROUP[f.group].label}</span>
                </div>
                <p className="mt-2 mb-2 text-[13px] leading-[1.5] text-text2">{f.lead}</p>
                <ul className="m-0 flex list-none flex-col gap-[5px] p-0 text-[12.5px] leading-[1.45] text-muted">
                  {f.points.map((p) => (
                    <li key={p} className="flex gap-2">
                      <span aria-hidden="true" className="text-muted2">·</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-[10px] text-[11px] text-muted2">{f.needs}</div>
              </li>
            ))}
          </ul>

          <AlertPreview />
        </div>
      </section>

      {/* ── the way in ────────────────────────────────────────────────────── */}
      <div className="mb-8 flex flex-col items-center gap-2 text-center">
        <a className="btn primary px-[22px] py-[12px] text-[14px]" href={BOT_URL} target="_blank" rel="noopener noreferrer">
          Open {BOT_HANDLE}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 4h6v6" />
            <path d="M20 4 10 14" />
            <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
          </svg>
        </a>
        <div className="text-[12.5px] text-muted">Mainnet monitoring · Testnet trading actions</div>
      </div>

      {/* ── how it works ──────────────────────────────────────────────────── */}
      <section aria-labelledby="bot-steps-title" className="mb-6">
        <h2 id="bot-steps-title" className="m-0 mb-3 text-[16px] font-bold tracking-[-0.01em]">
          How it works
        </h2>
        <ol className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card px-[16px] py-[14px]">
              <div className="flex items-center gap-[10px]">
                <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-accent/16 text-[12.5px] font-bold text-accent-hi">{i + 1}</span>
                <h3 className="m-0 text-[14px] font-bold">{s.title}</h3>
              </div>
              <p className="mt-2 mb-0 text-[13px] leading-[1.5] text-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── testnet guide: not written yet ────────────────────────────────── */}
      <section aria-labelledby="bot-guide-title" className="card mb-6 flex flex-col gap-3 px-[18px] py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="bot-guide-title" className="m-0 text-[15px] font-bold">
            New to Perpl Testnet?
          </h2>
          <p className="mt-1 mb-0 max-w-[62ch] text-[13px] leading-[1.5] text-muted">Learn how to create a Testnet account, get test funds and connect to PerpGuard Bot.</p>
        </div>
        {TESTNET_GUIDE_URL === undefined ? (
          <span className="chip flex-none self-start sm:self-center">Coming soon</span>
        ) : (
          <Link href={TESTNET_GUIDE_URL} className="flex-none self-start text-[14px] font-semibold text-accent-hi underline decoration-border2 underline-offset-4 hover:text-text sm:self-center">
            Read the guide →
          </Link>
        )}
      </section>

      {/* ── security ──────────────────────────────────────────────────────── */}
      <details className="group card mb-4 px-[18px] py-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-bold [&::-webkit-details-marker]:hidden">
          Security &amp; How It Works
          <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-3">
          {SECURITY.map((g) => (
            <div key={g.title}>
              <h3 className="m-0 mb-2 text-[13.5px] font-bold">{g.title}</h3>
              <ul className="m-0 flex list-none flex-col gap-[6px] p-0 text-[13px] leading-[1.5] text-muted">
                {g.points.map((p) => (
                  <li key={p} className="flex gap-2">
                    <span aria-hidden="true" className="text-safe">✓</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * The manual alert, as the bot sends it, drawn as a Telegram message. AN
 * EXAMPLE: labelled so, its figures not live, its buttons inert spans that
 * call nothing.
 */
function AlertPreview() {
  const a = ALERT_EXAMPLE;
  return (
    <figure className="m-0 flex flex-col gap-2" aria-label="Example of a liquidation alert from PerpGuard Bot">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-text2">The alert</span>
        <span className="chip text-[11px]">Example</span>
      </div>
      <div className="rounded-[14px] border border-border2 bg-[#0E1621] p-3">
        <div className="mb-2 flex items-center gap-2">
          {/* The header's own mark (public/perpguard-mark.svg), on a round dark disc as Telegram draws a bot's photo, 34px. */}
          <span aria-hidden="true" className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full bg-[#080A0F]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/perpguard-mark.svg" alt="" width={808} height={888} style={{ height: 19, width: 'auto' }} />
          </span>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-text">PerpGuard Bot</div>
            <div className="text-[11px] text-muted">bot</div>
          </div>
        </div>
        <div className="rounded-[12px] rounded-tl-[4px] bg-[#182533] px-[13px] py-[10px] text-[14px] leading-[1.5] text-[#E9EDF2]">
          <div className="text-[13px] text-[#9BA8B6]">{a.network}</div>
          <div className="font-bold">
            🔴 {a.position} is <span className="text-danger">{a.distance}</span> from liquidation
          </div>
          <div>
            Margin <b>{a.margin}</b> · <b>{a.free}</b> free
          </div>
        </div>
        <div className="mt-[6px] flex flex-col gap-[6px]" aria-hidden="true">
          {a.keyboard.map((row) => (
            <div key={row.join('|')} className="flex gap-[6px]">
              {row.map((label) => (
                <span key={label} className="flex-1 rounded-[8px] bg-[#1D2733] px-2 py-[10px] text-center text-[14px] font-semibold text-[#8CC6F5]">
                  {label}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="text-[12px] leading-[1.5] text-muted">
        An example, not live data. Each amount shows the distance it would buy; in Telegram, tapping one asks you to confirm before anything is sent. These buttons do nothing.
      </figcaption>
    </figure>
  );
}
