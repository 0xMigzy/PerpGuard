import type { ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader.tsx';
import { TRADING } from '@/lib/tradingNetwork.ts';

/**
 * THE PRIVACY POLICY (owner, 12 Oct 2026). Plain prose about what the product
 * ACTUALLY keeps, written from the code: every claim here names a table, a
 * log line or a call that exists (`privacy.test.ts` keeps the tables honest).
 * Static: no fetch. If what is stored changes, this page changes with it.
 *
 * An individual's project: no company, no registered address, no DPO, and it
 * says so. Data requests go to GitHub issues, which are public, and it says
 * that too.
 */
export const metadata = { title: 'Privacy', description: 'What PerpGuard stores, what it never stores, who else sees it and how to delete it.' };

const PRIVACY_UPDATED = '12 October 2026';
const ISSUES_URL = 'https://github.com/0xMigzy/PerpGuard/issues';

const ext = (href: string, text: string): ReactNode => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-hi underline decoration-border2 underline-offset-2">
    {text}
  </a>
);

function Section({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="mt-9" aria-labelledby={id}>
      <h2 id={id} className="mt-0 mb-3" style={{ fontSize: 19, fontWeight: 700 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}
const P = ({ children }: { readonly children: ReactNode }) => <p className="mt-0 mb-3 text-[15px] leading-[1.65] text-text2">{children}</p>;
const List = ({ children }: { readonly children: ReactNode }) => <ul className="mt-0 mb-3 flex flex-col gap-[7px] pl-[22px] text-[15px] leading-[1.6] text-text2">{children}</ul>;
const Note = ({ children }: { readonly children: ReactNode }) => <p className="mt-0 mb-3 text-[13.5px] leading-[1.6] text-muted">{children}</p>;

export default function PrivacyPage() {
  return (
    <div data-ui="terminal" className="mx-auto max-w-[720px]">
      <PageHeader title="Privacy" subtitle="What PerpGuard stores, what it never stores, who else sees it, and how to delete it." />
      <Note>
        Last updated {PRIVACY_UPDATED}. PerpGuard is one person&rsquo;s project, not a company: no legal entity, no registered address, no data protection officer. This describes what the code does. This
        site&rsquo;s bot, {TRADING.botHandle}, acts on {TRADING.chainName}; the other network has its own bot and a separate database.
      </Note>

      <Section id="stored" title="What is stored">
        <P>
          <b className="text-text">Watching needs no account.</b> For anyone who starts the bot, PerpGuard keeps:
        </P>
        <List>
          <li>your Telegram user id and chat id;</li>
          <li>the accounts your chat watches;</li>
          <li>your alert settings: thresholds, warning levels, and which alerts were already sent (that record lasts 14 days).</li>
        </List>
        <P>
          <b className="text-text">Only if you connect a trading account</b>, it also keeps:
        </P>
        <List>
          <li>the wallet address that proved the account is yours, and the account number;</li>
          <li>your Perpl API key, sealed;</li>
          <li>your alert distance and Rescue rules;</li>
          <li>a log of every action sent for you and how it ended, and of the alerts sent about your positions.</li>
        </List>
        <P>
          Server logs last 14 days. They record each button tap and command by Telegram id (never what you typed after a command), the steps of connecting (browser type and wallet address; never a code,
          signature or key) and the website&rsquo;s data requests. They record no IP address.
        </P>
        <P>
          The website has no accounts and no tracking scripts. Its one cookie is a 30-minute session on the connect page. Saved wallets stay in your browser. While you connect, your Telegram name is held in
          memory for up to 30 minutes to show on that page, and is never written down.
        </P>
      </Section>

      <Section id="not-stored" title="What is not stored">
        <List>
          <li>No wallet private key or recovery phrase, ever.</li>
          <li>No API key in the clear: it is sealed with AES-256-GCM, never logged, and never sent to a browser or to Telegram. A Perpl API key can trade; it cannot withdraw.</li>
          <li>No name, email or payment detail. PerpGuard never asks for them.</li>
        </List>
        <Note>Perpl accounts and positions are public on Monad. Watching one reads that public record and gives no access to it.</Note>
      </Section>

      <Section id="others" title="Who else sees it">
        <List>
          <li>
            <b className="text-text">Telegram</b> carries every message.
          </li>
          <li>
            <b className="text-text">Perpl</b> receives the calls made for a connected account: sign-in, each action, and your wallet address when a key is created.
          </li>
          <li>
            <b className="text-text">Dynamic</b> (the wallet button) sees the wallet you connect; a <b className="text-text">Monad RPC provider</b> sees the address being looked up.
          </li>
          <li>
            <b className="text-text">Hostinger</b> (the server) and <b className="text-text">Vercel</b> (this website) see the traffic that reaches them, IP addresses included.
          </li>
        </List>
        <P>Nothing is sold, shared with advertisers, or used for anything but running PerpGuard.</P>
      </Section>

      <Section id="how-long" title="How long, and how to delete it">
        <List>
          <li>
            <b className="text-text">Stop watching</b> removes that account from your chat at once.
          </li>
          <li>
            <b className="text-text">Disconnect</b> removes the link to your account, PerpGuard&rsquo;s copy of your API key and your wallet proof.
          </li>
          <li>
            It does <b className="text-text">not</b> remove the key from your Perpl profile. Only you can, at {ext(`https://${TRADING.perplSite}/apikeys`, `${TRADING.perplSite}/apikeys`)}.
          </li>
          <li>It also leaves your Rescue rules, settings and the action and alert logs. The rules can no longer act; the rest stays until you ask.</li>
        </List>
        <P>
          <b className="text-text">To delete everything:</b> stop watching, disconnect, remove the key on Perpl, then open an issue asking for the rest. Every row tied to your Telegram id and account on this
          network will be deleted.
        </P>
      </Section>

      <Section id="contact" title="Contact">
        <P>
          There is no support email. Open an issue at {ext(ISSUES_URL, 'github.com/0xMigzy/PerpGuard/issues')}. Issues are public, so post nothing private: your Telegram user id and which bot you used is
          enough.
        </P>
      </Section>
    </div>
  );
}
