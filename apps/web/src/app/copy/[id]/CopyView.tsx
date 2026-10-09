'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api.ts';
import { COPY_SIZE_MAX, COPY_SIZE_MIN, copyHref, parseCopyDays, parseCopySize, type CopyReplayed } from '@/lib/copy.ts';
import { formatAxisMoney, formatCount, formatDay, formatDayLong, formatMoney, formatWhen } from '@/lib/format.ts';
import { VAR } from '@/lib/theme.ts';
import { usePoll } from '@/lib/usePoll.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { StatTile } from '@/components/StatTile.tsx';
import { ChartTooltip } from '@/components/charts/ChartTooltip.tsx';

const POLL_MS = 120_000;
const PAGE = 200;

export function CopyView({ accountId }: { readonly accountId: number }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const size = parseCopySize(params.get('size'));
  const days = parseCopyDays(params.get('days'));
  const [draft, setDraft] = useState(String(size));
  const valid = Number.isSafeInteger(accountId) && accountId > 0;
  const replay = usePoll(() => api.copyReplay(accountId, size, days), POLL_MS, `copy:${accountId}:${size}:${days}`);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const next = parseCopySize(draft);
    setDraft(String(next));
    router.replace(copyHref(accountId, next, days), { scroll: false });
  };

  const sizeForm = (
    <form onSubmit={apply} className="flex items-center gap-2" aria-label="Account size">
      <label htmlFor="copy-size" className="text-[12.5px] text-muted">Account size</label>
      <input
        id="copy-size"
        inputMode="numeric"
        className="num w-[110px] rounded-[8px] border border-border2 bg-card2 px-2 py-[6px] text-right text-[13px] text-text"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        title={`Whole AUSD, ${formatCount(COPY_SIZE_MIN)} to ${formatCount(COPY_SIZE_MAX)}`}
      />
      <span className="text-[12.5px] text-muted">AUSD</span>
      <button type="submit" className="seg">Replay</button>
    </form>
  );

  const result = replay.data?.result;
  return (
    <>
      <PageHeader
        title={<>What if you&rsquo;d copied #{valid ? accountId : '?'}?</>}
        thin={`last ${days} days`}
        subtitle={
          <>
            A replay of this trader onto an account of <b className="font-semibold text-text">{formatCount(size)} AUSD</b>: every position this trader opened, copied in proportion, or skipped with the reason. <b className="font-semibold text-text">Nothing is sent</b>; nothing here can trade.
          </>
        }
        right={
          <>
            <div className="flex gap-1" role="group" aria-label="Window">
              {([30, 7] as const).map((d) => (
                <button key={d} type="button" className="seg" aria-pressed={days === d} onClick={() => router.replace(copyHref(accountId, size, d), { scroll: false })}>
                  {d}D
                </button>
              ))}
            </div>
            {sizeForm}
            {valid && <Link href={`/traders/${accountId}`} className="seg no-underline">Trader profile</Link>}
          </>
        }
      />
      {!valid && <div className="card px-5 py-4 text-muted">That is not an account id.</div>}
      <ErrorNote error={replay.error} what="The replay" />
      {valid && replay.loading && result === undefined && <Skeleton className="h-[320px] w-full" />}
      {result?.kind === 'unknown-account' && <div className="card px-5 py-4 text-muted">The index has no account #{result.accountId}.</div>}
      {result?.kind === 'no-follower-equity' && <div className="card px-5 py-4 text-muted">An account of that size has nothing to copy with.</div>}
      {result?.kind === 'too-busy' && (
        <div className="card px-5 py-4">
          #{result.accountId} opened <b className="num">{formatCount(result.openedInWindow)}</b> positions in the last {days} days, more than {formatCount(result.cap)}. That is a bot&rsquo;s pace: a copy could not keep up with it, so it is not replayed at all rather than shown in part.
        </div>
      )}
      {result?.kind === 'replayed' && <Replayed r={result} days={days} ageMs={replay.data?.ageMs ?? 0} />}
    </>
  );
}

function Replayed({ r, days, ageMs }: { readonly r: CopyReplayed; readonly days: number; readonly ageMs: number }) {
  const [shown, setShown] = useState(PAGE);
  const t = r.totals;
  const rows = r.trades;
  const span = `${formatDayLong(r.fromMs)} to ${formatDayLong(r.toMs)}`;
  // The line runs to today: the account holds its last figure until the next close.
  const last = r.curve.at(-1);
  const curve = last === undefined || last.atMs >= r.toMs ? r.curve : [...r.curve, { atMs: r.toMs, equityAusd: last.equityAusd }];
  // A small account's line moves by cents: the axis then shows cents, never five identical "$1K" ticks.
  const values = curve.map((c) => c.equityAusd);
  const spread = values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
  const gainColor = (n: number) => (n > 0 ? VAR.safe : n < 0 ? VAR.danger : undefined);

  if (r.trades.length === 0) {
    return (
      <div className="card px-5 py-4 text-muted">
        #{r.accountId} opened no positions in the last {days} days ({span}), so a copy would have done nothing.
        {t.skippedBy['open-at-start'] !== undefined && ` ${t.skippedBy['open-at-start']} it already held when the window began are never copied: a copy starts with the next open.`}
      </div>
    );
  }

  const b = r.books;
  return (
    <>
      {b.reconciled ? (
        <div className="mb-4 text-[12.5px] text-muted" title={`Rebuilt ${b.rebuilt}; the index's own books (free balance plus open margin) ${b.onRecord}.`}>
          ✅ Books reconciled: #{r.accountId}&rsquo;s balance rebuilt from deposits, withdrawals, results and fees matches the index&rsquo;s own to within {b.gap}.
        </div>
      ) : (
        <div role="status" className="mb-4 rounded-[10px] border border-watch/40 bg-watch/10 px-4 py-3 text-[13px]">
          <b>⚠️ Not reconciled.</b> #{r.accountId}&rsquo;s balance rebuilt from deposits, withdrawals, results and fees is <b className="num">{b.gap}</b> off the index&rsquo;s own books ({b.rebuilt} against {b.onRecord}), and nothing the index records explains it. Every copy below is scaled off that balance, so read these figures as approximate.
        </div>
      )}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Result on closed copies · after fees" value={t.closedResult} valueColor={gainColor(t.closedResultAusd)} secondary={<>{t.fees} of fees · the leader made {t.leaderResultOnCopiedBeforeFees} on the same positions, before fees</>} />
        <StatTile label="Account" value={t.followerEnd} secondary={<>from {r.followerStart} · lowest free balance {t.lowestFree}</>} />
        <StatTile label="Copied" value={`${formatCount(t.copied)} of ${formatCount(t.copied + t.skipped)}`} secondary={<>{formatCount(t.wins)} won, {formatCount(t.losses)} lost{t.forcedExits > 0 ? <>, <span className="text-danger">{formatCount(t.forcedExits)} liquidated</span></> : null}</>} />
        <StatTile label="Still open · at today's price" value={t.openEstimateAusd === 0 ? '—' : t.openEstimate} valueColor={gainColor(t.openEstimateAusd)} secondary="Not realised; valued at the current mainnet mark" />
      </div>

      <div className="card mb-4 px-[18px] py-4">
        <div className="mb-1 font-semibold">The copy&rsquo;s account, after each copy closed</div>
        <div className="mb-3 text-[12.5px] text-muted">{span}. Open copies are not in it.</div>
        <div className="h-[220px] w-full">
          <ResponsiveContainer>
            <LineChart data={curve as { atMs: number; equityAusd: number }[]} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={VAR.border} />
              <XAxis dataKey="atMs" type="number" domain={[r.fromMs, r.toMs]} scale="time" tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
              <YAxis tickFormatter={(v: number) => formatAxisMoney(v, { precise: spread < 50 })} tickLine={false} axisLine={false} width={64} domain={['auto', 'auto']} />
              <Tooltip
                content={({ active, payload }) => {
                  const p = active ? (payload?.[0]?.payload as { atMs: number; equityAusd: number } | undefined) : undefined;
                  if (p === undefined) return null;
                  return <ChartTooltip title={formatWhen(p.atMs)} rows={[{ label: 'Account', value: `${formatMoney(p.equityAusd, { floor: true })} AUSD` }]} />;
                }}
              />
              <Line type="stepAfter" dataKey="equityAusd" stroke={VAR.accent} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="font-semibold">Every position #{r.accountId} opened, and what the copy did</div>
      </div>
      <div className="card mb-4 overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col" className="text-left">Opened (UTC)</th>
              <th scope="col" className="text-left">Market</th>
              <th scope="col" className="text-right" title="The leader's peak size, in the market's units, and leverage at entry">Leader size · lev.</th>
              <th scope="col" className="text-right" title="Rounded down to the market's size step">Copy size</th>
              <th scope="col" className="text-right" title="The leader's peak margin, scaled, rounded up">Margin</th>
              <th scope="col" className="text-right" title="Perpl's taker rate on opening and closing the full size">Fee</th>
              <th scope="col" className="text-right" title="After the fee; a loss rounded away from zero">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((x) => {
              const c = x.copy;
              const cell = 'num px-[10px] py-[9px] text-right whitespace-nowrap';
              return (
                <tr key={x.key}>
                  <td className="num px-[10px] py-[9px] whitespace-nowrap">{formatWhen(x.openedAtMs)}</td>
                  <td className="px-[10px] py-[9px] whitespace-nowrap">
                    {x.symbol} {x.side}
                    {x.status === 'forced' && <span className="ml-1 text-danger">· liquidated</span>}
                    {x.status === 'open' && <span className="ml-1 text-muted">· open</span>}
                  </td>
                  <td className={`${cell} text-muted`}>{x.leader.size}{x.leader.leverage !== null && ` · ${x.leader.leverage.toFixed(1)}x`}</td>
                  {c.kind === 'copied' ? (
                    <>
                      <td className={cell} title={c.affordScale === null ? undefined : `The proportional copy needed more margin than the free balance held, so it was cut to ${Math.round(c.affordScale * 100)}% of it.`}>
                        {c.size}
                        {c.affordScale !== null && <span className="block text-[11px] text-watch">cut to {c.affordScale.toFixed(2)}× to fit free balance</span>}
                      </td>
                      <td className={cell}>{c.margin}</td>
                      <td className={`${cell} text-muted`}>{c.fee}</td>
                      <td className={cell} style={{ color: c.resultAusd === null ? undefined : gainColor(c.resultAusd) }}>
                        {c.result ?? 'no price now'}
                        {c.estimate && c.result !== null && <span className="text-muted"> (est.)</span>}
                      </td>
                    </>
                  ) : (
                    <td colSpan={4} className="px-[10px] py-[9px] text-right text-muted">Not copied: {c.text}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > shown && (
          <div className="border-t border-border px-[18px] py-3 text-center">
            <button type="button" className="seg" onClick={() => setShown((n) => n + PAGE)}>
              Show {formatCount(Math.min(PAGE, rows.length - shown))} more of {formatCount(rows.length - shown)}
            </button>
          </div>
        )}
      </div>

      <div className="card mb-4 px-[18px] py-4 text-[13px] text-muted">
        <div className="mb-2 font-semibold text-text">How this is worked out, and what it cannot know</div>
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
          <li><b className="text-text">Past results do not predict future returns.</b> This is what copying would have done, not what it will do.</li>
          <li>A real copy fills after the leader, so at a slightly different price. Here each copy is assumed to fill at the leader&rsquo;s prices.</li>
          <li>Each copy is the leader&rsquo;s position scaled by this account&rsquo;s equity over the leader&rsquo;s at that moment (the leader&rsquo;s was {r.leaderStart} when the window began). Equity is deposits minus withdrawals plus realised results minus fees, on both sides; unrealised P&amp;L is not in it.</li>
          <li>Sizes are each position&rsquo;s peak: the index keeps a position&rsquo;s open and close, not the adds and reduces between. The result is exact for a proportional copy at the leader&rsquo;s prices; the margin is the most it needed.</li>
          <li>Fees are Perpl&rsquo;s taker rate on opening and closing each copy, the least it would cost. The index keeps fees per account per day, not per position, so the leader&rsquo;s own result per position is before fees.</li>
          <li>Only new opens are copied{t.skippedBy['open-at-start'] !== undefined ? `: ${t.skippedBy['open-at-start']} position${t.skippedBy['open-at-start'] === 1 ? '' : 's'} already open when the window began ${t.skippedBy['open-at-start'] === 1 ? 'is' : 'are'} not in the list` : ''}. A copy that needed more margin than the account had free is cut to fit, and its row says by how much.</li>
          {ageMs > 45_000 && <li>Computed {Math.round(ageMs / 1000)} s ago.</li>}
        </ul>
      </div>
    </>
  );
}
