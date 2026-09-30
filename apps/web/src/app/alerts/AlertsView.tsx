import { PageHeader } from '@/components/PageHeader.tsx';
import { COLORS } from '@/lib/theme.ts';

/**
 * Alerts are delivered to Telegram, and ONLY there. This section explains the
 * two tiers and shows what each one receives. Nothing on it acts: there is no
 * form, no button that sends, and no session. The web app is read-only by
 * construction; the confirmation and the send happen in the chat.
 *
 * THE LINKED EXAMPLE IS THE RENDERER'S OWN OUTPUT for the ground-truth
 * fixture (fixtures/position1.json, 0.5 BTC long, entry 84,029.5, margin
 * 2,810.33 at mark 84,007.3), pinned word for word by the alert render tests.
 * The watched example is the same alert with the address named and no
 * keyboard, which is what a watcher is: someone who can see a position in
 * danger and cannot touch it.
 */
export function AlertsView() {
  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Alerts are delivered to Telegram. This page explains the two tiers and shows what each one receives."
        right={<span className="chip">Telegram only</span>}
      />

      {/* ── the two tiers ───────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card border-cyan/30 px-[17px] py-4">
          <h2 className="m-0 flex items-center gap-[9px] text-[13.5px] font-bold">
            Watch <span className="rounded-[4px] bg-safe/12 px-[6px] py-[2.5px] text-[10px] font-semibold tracking-[0.05em] text-safe">Open to everyone</span>
          </h2>
          <div className="mt-[3px] text-[11.5px] text-muted2">No wallet. No account. No link.</div>
          <p className="mt-3 mb-3 max-w-[52ch] text-[12.5px] text-muted">
            Watch any address and get its alerts. A watch alert carries no buttons — you can see a position in danger, you cannot touch it. The server
            refuses an action from an unlinked chat even if the payload is reconstructed by hand.
          </p>
          <Steps
            steps={[
              'Open the PerpGuard bot in Telegram.',
              'Send it the address or account id to watch.',
              'Alerts for that account arrive in that chat, without a keyboard.',
            ]}
          />
        </div>

        <div className="card border-accent/35 px-[17px] py-4">
          <h2 className="m-0 flex items-center gap-[9px] text-[13.5px] font-bold">
            Linked <span className="rounded-[4px] bg-accent/14 px-[6px] py-[2.5px] text-[10px] font-semibold tracking-[0.05em] text-accent-hi">Required to act</span>
          </h2>
          <div className="mt-[3px] text-[11.5px] text-muted2">Proves you own the account. Unlocks acting on the position from the chat: add margin, reduce, close, kill switch.</div>
          <p className="mt-3 mb-3 max-w-[52ch] text-[12.5px] text-muted">
            A linked chat gets the same alert with a keyboard under it. Tapping shows a confirmation with the same numbers and a second tap; then accepted, then
            reconciled against the position — and if the venue reports a failure while the margin actually applied, both are shown.
          </p>
          <Steps steps={['Send /start to the bot from the chat you want alerts in.', 'Prove the account is yours; the bot reads it off the Exchange.', 'Every action is offered, confirmed and sent in that chat, and nowhere else.']} />
          <div className="mt-3 flex gap-[10px] rounded-[10px] border border-watch/30 bg-watch/8 px-[12px] py-[10px] text-[12.5px] text-[#E8D7B0]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={COLORS.watch} strokeWidth="2.2" aria-hidden="true" className="mt-[2px] flex-none">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16.5v.01" />
            </svg>
            <div>
              A Perpl API key can never withdraw or transfer funds. Nothing on this website asks for one, or for a wallet: the browser never executes anything.
            </div>
          </div>
        </div>
      </section>

      {/* ── what the bot sends ──────────────────────────────────────────── */}
      <section className="mb-4">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">What the bot sends</h2>
          <span className="text-[12.5px] text-muted">Actions live only in Telegram. PerpGuard never executes from the browser.</span>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="card px-[17px] py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="m-0 text-[13px] font-bold">Linked account</h3>
              <span className="chip border-accent/45 text-accent-hi">Can act</span>
            </div>
            <TelegramMessage
              lines={[
                'DANGER · BTC long',
                'Buffer 2.7% — liquidation 81,770.1, mark 84,007.3',
                'Isolated margin: your free AUSD is not used to rescue this position automatically.',
                'Top up (AUSD):',
                'Add 562 → buffer 4.0%, liquidation 80,647.1',
                'Add 2,662 → buffer 9.0%, liquidation 76,446.7',
                'First time PerpGuard has seen this position.',
              ]}
              keys={[['Add 562 → buffer 4.0%, liquidation 80,647.1'], ['Add 2,662 → buffer 9.0%, liquidation 76,446.7'], ['Custom amount']]}
            />
            <p className="mt-3 mb-0 max-w-[56ch] text-[11.5px] text-muted2">
              The renderer&rsquo;s own output for the ground-truth fixture: 0.5 BTC long, entry 84,029.5, margin 2,810.33, mark 84,007.3. Amounts are ceiled to
              the shown precision and the button sends exactly the figure it shows.
            </p>
          </div>

          <div className="card px-[17px] py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="m-0 text-[13px] font-bold">Watched account</h3>
              <span className="chip border-cyan/40 text-cyan">Cannot act</span>
            </div>
            <TelegramMessage
              lines={[
                'DANGER · BTC long · 0x37db…ec7b',
                'Buffer 2.7% — liquidation 81,770.1, mark 84,007.3',
                'Isolated margin: this account’s free AUSD is not used to rescue the position automatically.',
                'First time PerpGuard has seen this position.',
              ]}
              none="No buttons. You are watching this account, not holding it."
            />
            <p className="mt-3 mb-0 max-w-[56ch] text-[11.5px] text-muted2">
              Watch alerts carry no keyboard at all — not disabled buttons, none. The same position, the same numbers, the address named, and nothing to tap.
            </p>
          </div>
        </div>
      </section>

      <div className="text-[11.5px] text-muted2">
        Escalation is immediate; calming down is gated. WATCH fires when the buffer falls below 8% and clears above 9%; DANGER fires below 3% and clears above 4%;
        past liquidation is never softened on an old price. A blind monitor — feed down, positions untrusted — says so and offers no action.
      </div>
    </>
  );
}

function Steps({ steps }: { readonly steps: readonly string[] }) {
  return (
    <ol className="m-0 grid gap-[6px] pl-0 text-[12.5px]" style={{ listStyle: 'none' }}>
      {steps.map((step, i) => (
        <li key={step} className="flex items-start gap-[10px]">
          <span className="num flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full bg-card2 text-[11px] font-semibold text-muted">{i + 1}</span>
          <span className="text-muted">{step}</span>
        </li>
      ))}
    </ol>
  );
}

/** A Telegram message as the phone shows it: the bot's name, the text, then the keyboard or the absence of one. */
function TelegramMessage({ lines, keys, none }: { readonly lines: readonly string[]; readonly keys?: readonly (readonly string[])[]; readonly none?: string }) {
  const [title, ...body] = lines;
  return (
    <div className="max-w-[420px] rounded-[12px] border border-border2 bg-[#11161D] px-[15px] py-[14px]">
      <div className="mb-[9px] flex items-center gap-2 text-[11.5px] font-semibold text-cyan">
        <svg width="13" height="13" viewBox="0 0 24 24" fill={COLORS.cyan} aria-hidden="true">
          <path d="M21 4 2.5 11.2l5.3 1.8 2 6 2.7-3.6 4.6 3.4Z" />
        </svg>
        PerpGuard
      </div>
      <div className="text-[12.5px] leading-[1.55] text-[#DDE3EA]">
        <span className="mb-[5px] block font-semibold text-white">{title}</span>
        {body.map((line) => (
          <span key={line} className="block whitespace-pre-wrap">
            {line}
          </span>
        ))}
      </div>
      {keys !== undefined && (
        <div className="mt-[11px] flex flex-col gap-[5px]">
          {keys.map((row) => (
            <div key={row.join('|')} className="flex gap-[5px]">
              {row.map((label) => (
                <span key={label} className={`flex-1 rounded-[7px] bg-[#1D2733] px-[11px] py-[9px] text-center text-[12.5px] font-medium ${/Close|Kill/.test(label) ? 'text-watch' : 'text-[#6AB8F0]'}`}>
                  {label}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      {none !== undefined && <div className="mt-[11px] text-[11.5px] italic text-[#6E7A88]">{none}</div>}
    </div>
  );
}
