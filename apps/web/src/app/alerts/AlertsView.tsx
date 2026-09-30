'use client';

import type { ProtectAlerts, ProtectAlertRow } from '@perpguard/backend/protect';
import { protect } from '@/lib/api.ts';
import { formatAge, formatCount, formatDayLong, formatPct, formatWhen } from '@/lib/format.ts';
import { tierOf } from '@/lib/protect.ts';
import { COLORS } from '@/lib/theme.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { ProtectGate } from '@/components/ProtectGate.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';

const POLL_MS = 10_000;

export function AlertsView() {
  return (
    <ProtectGate title="Alerts" subtitle="Telegram link, alert history, and the thresholds the risk loop watches.">
      {(session, signOut) => <Alerts network={session.network} accountId={session.accountId} onSignOut={signOut} />}
    </ProtectGate>
  );
}

function Alerts({ network, accountId, onSignOut }: { readonly network: string; readonly accountId: number | undefined; readonly onSignOut: () => void }) {
  const poll = usePoll(() => protect.alerts(100), POLL_MS, 'protect:alerts');
  const a = poll.data;
  return (
    <>
      <PageHeader
        title="Alerts"
        thin={`account ${accountId ?? '?'} on ${network}`}
        subtitle="Where warnings go, what has been sent, and the rules that decide when the next one may fire."
        right={
          <button type="button" className="btn" onClick={onSignOut}>
            Sign out
          </button>
        }
      />
      <ErrorNote error={poll.error} what="Alert history" />

      {/* ── link + delivery ─────────────────────────────────────────────── */}
      <section className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {a === undefined ? (
          <>
            <Skeleton className="h-[150px] w-full" />
            <Skeleton className="h-[150px] w-full" />
          </>
        ) : (
          <>
            <TelegramCard alerts={a} />
            <DeliveryCard alerts={a} />
          </>
        )}
      </section>

      {/* ── rules ───────────────────────────────────────────────────────── */}
      {a !== undefined && <RulesCard alerts={a} />}

      {/* ── history ─────────────────────────────────────────────────────── */}
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-[10px]">
          <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Alert history</h2>
          <span className="text-[12.5px] text-muted">One row per attempt sequence, newest first. Suppressed ticks write nothing.</span>
        </div>
        {a === undefined ? (
          <Skeleton className="h-[200px] w-full" />
        ) : a.history.length === 0 ? (
          <div className="card px-[18px] py-5 text-[13px] text-muted">
            No alert has been sent yet{a.delivery.durableLog ? '' : ', and the log is in memory, so a restart would have emptied it'}. That is a quiet account, not a broken
            monitor: the delivery card above says whether one could be sent.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {a.history.map((row) => (
              <HistoryRow key={row.alertKey + row.createdAtMs} row={row} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function TelegramCard({ alerts: a }: { readonly alerts: ProtectAlerts }) {
  const t = a.telegram;
  const ok = t.linked && t.transportConfigured;
  return (
    <div className="card px-[18px] py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12.5px] font-medium text-muted">Telegram</div>
        <span className="rounded-[6px] px-[8px] py-[3px] text-[10.5px] font-bold tracking-[0.05em]" style={{ background: `${ok ? COLORS.safe : COLORS.danger}26`, color: ok ? COLORS.safe : COLORS.danger }}>
          {ok ? 'LINKED' : t.linked ? 'LINKED · NO TRANSPORT' : 'NOT LINKED'}
        </span>
      </div>
      <div className="mt-2 text-[20px] font-bold tracking-[-0.02em]">{t.botUsername === undefined ? 'the PerpGuard bot' : `@${t.botUsername}`}</div>
      <p className="mt-1 mb-0 text-[12.5px] text-muted">
        {t.linked
          ? `Linked ${t.linkedAtMs === undefined ? '' : `${formatAge(Date.now() - t.linkedAtMs)} ago (${formatDayLong(t.linkedAtMs)})`}. Alerts go to that chat and nowhere else; the bot answers only there.`
          : 'No chat is linked, so a warning has nowhere to go. Send /start to the bot from the chat you want alerts in. It accepts one account and refuses everyone else.'}
        {!t.transportConfigured && t.transportReason !== undefined && ` ${t.transportReason}`}
      </p>
    </div>
  );
}

function DeliveryCard({ alerts: a }: { readonly alerts: ProtectAlerts }) {
  const d = a.delivery;
  return (
    <div className="card px-[18px] py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12.5px] font-medium text-muted">Delivery since this backend started</div>
        <span className="rounded-[6px] px-[8px] py-[3px] text-[10.5px] font-bold tracking-[0.05em]" style={{ background: `${d.durableLog ? COLORS.safe : COLORS.watch}26`, color: d.durableLog ? COLORS.safe : COLORS.watch }}>
          {d.durableLog ? 'LOG ON POSTGRES' : 'LOG IN MEMORY'}
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-4">
        <div>
          <div className="num text-[20px] font-bold tracking-[-0.02em]" style={{ color: COLORS.safe }}>
            {formatCount(d.delivered)}
          </div>
          <div className="text-[11px] text-muted uppercase">delivered</div>
        </div>
        <div>
          <div className="num text-[20px] font-bold tracking-[-0.02em]" style={{ color: d.failed > 0 ? COLORS.danger : undefined }}>
            {formatCount(d.failed)}
          </div>
          <div className="text-[11px] text-muted uppercase">failed</div>
        </div>
      </div>
      <p className="mt-1 mb-0 text-[12.5px] text-muted">
        {d.lastDelivered !== undefined && d.lastDeliveredAtMs !== undefined && `Last delivered: ${d.lastDelivered}, ${formatAge(Date.now() - d.lastDeliveredAtMs)} ago. `}
        {d.lastFailure !== undefined && d.lastFailureAtMs !== undefined && (
          <span className="text-danger">
            Last failure, {formatAge(Date.now() - d.lastFailureAtMs)} ago: {d.lastFailure}.{' '}
          </span>
        )}
        {!d.durableLog && d.durableReason !== undefined && `${d.durableReason}. `}
        {d.lastDelivered === undefined && d.lastFailure === undefined && 'Nothing has needed sending since the backend started.'}
      </p>
    </div>
  );
}

function RulesCard({ alerts: a }: { readonly alerts: ProtectAlerts }) {
  const t = a.rules.thresholds;
  const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
  const now = Date.now();
  return (
    <section className="card mb-4 px-[18px] py-4">
      <div className="mb-[6px] flex flex-wrap items-baseline justify-between gap-[10px]">
        <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">Rules</h2>
        <span className="text-[12.5px] text-muted">Escalation is immediate; calming down is gated. No all-clear from an old price.</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <table className="w-full border-collapse text-[13px]">
          <tbody>
            <Rule name="Watch" when={`buffer falls below ${formatPct(t.watchEnterPct, 0)}`} back={`above ${formatPct(t.watchExitPct, 0)} for ${minutes(t.minDwellMs)}`} cooldown={minutes(a.rules.cooldownMs['WATCH'] ?? 0)} />
            <Rule name="Danger" when={`buffer falls below ${formatPct(t.dangerEnterPct, 0)}`} back={`above ${formatPct(t.dangerExitPct, 0)} for ${minutes(t.minDwellMs)}`} cooldown={minutes(a.rules.cooldownMs['DANGER'] ?? 0)} />
            <Rule name="Past liquidation" when="the mark passes the liquidation price" back="never softened on an old price" cooldown={minutes(a.rules.cooldownMs['PAST_LIQUIDATION'] ?? 0)} />
            <Rule name="Feed down / positions untrusted" when="the feed is not connected, or the position list cannot be believed" back="announced once per outage" cooldown="—" />
          </tbody>
        </table>
        <div>
          <div className="eyebrow mb-2">Cooldowns right now</div>
          {a.rules.cooldowns.length === 0 ? (
            <div className="text-[12.5px] text-muted">No position is being watched.</div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {a.rules.cooldowns.map((c) => (
                  <tr key={c.marketId} className="border-t border-border">
                    <td className="py-[6px] font-semibold">{c.symbol}</td>
                    <td className="py-[6px] text-right text-muted">
                      {c.bySeverity.length === 0 ? (
                        'nothing sent yet; the first alert is never delayed'
                      ) : (
                        c.bySeverity.map((s) => (
                          <div key={s.severity} className="num">
                            {s.severity} sent {formatAge(now - s.lastSentAtMs)} ago ·{' '}
                            {s.nextAllowedAtMs <= now ? 'another may fire now' : `next in ${formatAge(s.nextAllowedAtMs - now)}`}
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-2 text-[11.5px] text-muted2">Cooldown is per position per severity and escalation bypasses it: a WATCH that becomes DANGER is sent at once.</div>
        </div>
      </div>
    </section>
  );
}

function Rule({ name, when, back, cooldown }: { readonly name: string; readonly when: string; readonly back: string; readonly cooldown: string }) {
  return (
    <tr className="border-t border-border align-top">
      <td className="py-[7px] pr-3 font-semibold whitespace-nowrap">{name}</td>
      <td className="py-[7px] text-muted">
        <div>{when}</div>
        <div className="text-[11.5px] text-muted2">back: {back} · cooldown {cooldown}</div>
      </td>
    </tr>
  );
}

function HistoryRow({ row }: { readonly row: ProtectAlertRow }) {
  const tier = tierOf(row.state);
  const color = tier === 'past' || tier === 'danger' ? COLORS.danger : tier === 'watch' ? COLORS.watch : tier === 'safe' ? COLORS.safe : COLORS.muted;
  const [title, ...lines] = row.text.split('\n');
  return (
    <div className="card px-[16px] py-3">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="num text-muted">{formatWhen(row.createdAtMs)}</span>
        <b style={{ color }}>{title}</b>
        {row.previousState !== undefined && <span className="text-muted2">from {row.previousState.replace(/_/g, ' ')}</span>}
        <span className={`ml-auto rounded-[6px] px-[7px] py-[2px] text-[10.5px] font-bold tracking-[0.05em] ${row.outcome === 'delivered' ? 'bg-safe/15 text-safe' : 'bg-danger/15 text-danger'}`} title={row.lastError}>
          {row.outcome === 'delivered' ? `DELIVERED${row.attempts > 1 ? ` · ${row.attempts} tries` : ''}` : `FAILED · ${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}`}
        </span>
      </div>
      <div className="mt-1 whitespace-pre-wrap text-[12.5px] text-muted">{lines.join('\n')}</div>
      {row.outcome === 'failed' && row.lastError !== undefined && <div className="mt-1 text-[12px] text-danger">{row.lastError}</div>}
    </div>
  );
}
