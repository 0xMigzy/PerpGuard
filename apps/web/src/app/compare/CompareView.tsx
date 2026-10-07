'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AssessedPosition, Timeframe, TraderDayPoint, WalletMatch, WalletProfile } from '@perpguard/shared';
import { ApiError, api } from '@/lib/api.ts';
import { alignedCumulative, compareColumn, MAX_COMPARE, parseCompareIds, walletLabel, withAdded, withRemoved, type CompareColumn } from '@/lib/compare.ts';
import { formatCount, formatDay, formatDayLong, formatDuration, formatMoney, formatPct, formatSignedMoney, shortAddress } from '@/lib/format.ts';
import { DAY_BUCKET_24H, dayPeriodLabel } from '@/lib/history.ts';
import { marketName } from '@/lib/markets.ts';
import { SERIES, VAR } from '@/lib/theme.ts';
import { parseTraderQuery } from '@/lib/traders.ts';
import { useHistoryStart } from '@/lib/useHistory.ts';
import { ErrorNote } from '@/components/ErrorNote.tsx';
import { PageHeader } from '@/components/PageHeader.tsx';
import { Skeleton } from '@/components/Skeleton.tsx';
import { TimeframePills, useTimeframe } from '@/components/TimeframePills.tsx';
import { useSavedWallets } from '@/components/SavedWallets.tsx';
import { ChartTooltip } from '@/components/charts/ChartTooltip.tsx';

const POLL_MS = 60_000;

interface WalletData {
  readonly profile?: WalletProfile | undefined;
  readonly days?: readonly TraderDayPoint[] | undefined;
  readonly positions?: readonly AssessedPosition[] | undefined;
  readonly error?: string | undefined;
}

/** The three reads the profile page makes, per account, every minute. A failure stays in its own column. */
function useCompareData(ids: readonly number[], t: Timeframe): Readonly<Record<number, WalletData>> {
  const [data, setData] = useState<Record<number, WalletData>>({});
  const key = `${ids.join(',')}:${t}`;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      await Promise.all(
        ids.map(async (id) => {
          const [profile, days, positions] = await Promise.allSettled([api.account(id), api.accountDays(id, t), api.accountPositions(id)]);
          if (!alive) return;
          setData((prev) => {
            const old = prev[id] ?? {};
            const error =
              profile.status === 'rejected'
                ? profile.reason instanceof ApiError && profile.reason.status === 404
                  ? `No account ${id} in the index.`
                  : 'Could not be read just now.'
                : undefined;
            return {
              ...prev,
              [id]: {
                profile: profile.status === 'fulfilled' ? profile.value.data : old.profile,
                days: days.status === 'fulfilled' ? days.value.data : old.days,
                positions: positions.status === 'fulfilled' ? positions.value.data.positions : old.positions,
                ...(error === undefined ? {} : { error }),
              },
            };
          });
        }),
      );
      if (alive) timer = setTimeout(run, POLL_MS);
    };
    // A new window drops the old window's days, so no column shows one window under another's label.
    setData((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, days: undefined }])));
    void run();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return data;
}

export function CompareView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTimeframe();
  const period = dayPeriodLabel(t, useHistoryStart());
  const { ids, dropped } = useMemo(() => parseCompareIds(params.get('a')), [params]);
  const data = useCompareData(ids, t);
  const saved = useSavedWallets();

  const go = (next: readonly number[]) => {
    const q = new URLSearchParams(params.toString());
    if (next.length === 0) q.delete('a');
    else q.set('a', next.join(','));
    const s = q.toString();
    router.replace(s === '' ? pathname : `${pathname}?${s.replace(/%2C/g, ',')}`, { scroll: false });
  };

  const columns = ids.map((id, i) => {
    const d = data[id];
    return { id, colour: SERIES[i % SERIES.length]!, data: d, column: d?.profile !== undefined && d.days !== undefined ? compareColumn(d.profile, d.days, d.positions) : undefined };
  });

  return (
    <>
      <PageHeader
        title="Compare"
        thin={ids.length === 0 ? undefined : `${formatCount(ids.length)} of ${MAX_COMPARE}`}
        subtitle="Up to four accounts side by side: the same figures as each trader's profile."
        right={<TimeframePills labels={{ '24h': { text: DAY_BUCKET_24H.pill, title: DAY_BUCKET_24H.title } }} />}
      />

      <AddWallet ids={ids} onAdd={(next) => go(next)} savedIds={saved.list.map((w) => w.accountId)} />
      {dropped.length > 0 && (
        <p className="mb-3 text-[12px] text-watch">
          Left out of the link: {dropped.join(', ')}. {ids.length >= MAX_COMPARE ? `At most ${MAX_COMPARE} accounts compare at once; ` : ''}account ids are whole numbers.
        </p>
      )}

      {ids.length === 0 ? (
        <section className="card px-[18px] py-8 text-center">
          <div className="text-[14px] font-semibold text-text">Nothing to compare yet.</div>
          <p className="mx-auto mt-1 mb-0 max-w-[520px] text-[12.5px] text-muted">
            Add up to four accounts by address or account id above, press <b className="text-text">Compare</b> on any trader&rsquo;s profile, or compare the wallets you have saved.
          </p>
        </section>
      ) : (
        <>
          {/* Phones: one block per metric, the wallets as short columns beneath it. */}
          <section className="card mb-4 px-[14px] py-3 sm:hidden" aria-label="Wallets side by side">
            <ul className="m-0 flex list-none flex-col gap-[6px] border-b border-border p-0 pb-3">
              {columns.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <WalletHead id={c.id} colour={c.colour} profile={c.data?.profile} onRemove={() => go(withRemoved(ids, c.id))} />
                  {c.data?.error !== undefined && c.data.profile === undefined && <span className="text-[11px] font-medium text-watch">{c.data.error}</span>}
                </li>
              ))}
            </ul>
            {ROWS(period).map((row) =>
              row.group !== undefined ? (
                <div key={row.group} className="section-label pt-4 pb-1">
                  {row.group}
                </div>
              ) : (
                <div key={row.label} className="border-b border-border py-2 last:border-b-0">
                  <div className="text-[12px] text-muted" title={row.title}>
                    {row.label}
                  </div>
                  <div className="mt-1 grid gap-2" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
                    {columns.map((c) => (
                      <div key={c.id} className="num flex min-w-0 items-start gap-[4px] text-[12px] leading-[1.3]">
                        <i aria-hidden="true" className="mt-[3px] inline-block h-[8px] w-[8px] flex-none rounded-[2px]" style={{ background: c.colour }} />
                        {/* Wraps between words only: a number is never split. */}
                        <span className="min-w-0 break-normal">
                          {c.data?.error !== undefined && c.data.profile === undefined ? (
                            <span className="text-muted2">—</span>
                          ) : c.column === undefined ? (
                            <span aria-hidden="true" className="skeleton inline-block h-[11px] w-[44px] align-middle" />
                          ) : (
                            row.cell!(c.column)
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ),
            )}
            <Footnote period={period} floor={columns.find((c) => c.column !== undefined)?.column?.floor ?? 10} />
          </section>

          <section className="card mb-4 hidden overflow-x-auto sm:block" aria-label="Wallets side by side">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-[1] bg-card text-left">
                    <span className="sr-only">Figure</span>
                  </th>
                  {columns.map((c) => (
                    <th key={c.id} scope="col" className="min-w-[150px] text-right align-bottom normal-case tracking-normal">
                      <WalletHead id={c.id} colour={c.colour} profile={c.data?.profile} onRemove={() => go(withRemoved(ids, c.id))} />
                      {c.data?.error !== undefined && c.data.profile === undefined && <span className="mt-1 block text-[11px] font-medium text-watch">{c.data.error}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS(period).map((row) =>
                  row.group !== undefined ? (
                    <tr key={row.group}>
                      <th scope="colgroup" colSpan={columns.length + 1} className="sticky left-0 bg-card pt-4 text-left">
                        {row.group}
                      </th>
                    </tr>
                  ) : (
                    <tr key={row.label}>
                      <th scope="row" className="sticky left-0 z-[1] bg-card text-left text-[12.5px] font-medium tracking-normal normal-case text-muted" title={row.title}>
                        {row.label}
                      </th>
                      {columns.map((c) => (
                        <td key={c.id} className="num text-right whitespace-nowrap">
                          {c.data?.error !== undefined && c.data.profile === undefined ? (
                            <span className="text-muted2">—</span>
                          ) : c.column === undefined ? (
                            <span aria-hidden="true" className="skeleton inline-block h-[12px] w-[64px] align-middle" />
                          ) : (
                            row.cell!(c.column)
                          )}
                        </td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
            <div className="border-t border-border px-[14px]">
              <Footnote period={period} floor={columns.find((c) => c.column !== undefined)?.column?.floor ?? 10} />
            </div>
          </section>

          <section className="card px-[18px] py-4" aria-label="Cumulative net PnL">
            <h2 className="m-0 text-[15px] font-bold tracking-[-0.01em]">
              Cumulative net PnL <span className="ml-1 text-[12.5px] font-medium text-muted">{period} · from 0 where the window opens</span>
            </h2>
            <CompareChart
              columns={columns.map((c) => ({
                id: c.id,
                colour: c.colour,
                label: labelOf(c.id, c.data?.profile),
                days: c.data?.days,
                failed: c.data?.error !== undefined && c.data.days === undefined,
              }))}
            />
          </section>
        </>
      )}
    </>
  );
}

const labelOf = (id: number, profile: WalletProfile | undefined) => (profile === undefined ? `#${id}` : walletLabel(profile, shortAddress));

function Swatch({ colour }: { readonly colour: string }) {
  return <i aria-hidden="true" className="inline-block h-[10px] w-[10px] flex-none rounded-[2px]" style={{ background: colour }} />;
}

function WalletHead({ id, colour, profile, onRemove }: { readonly id: number; readonly colour: string; readonly profile: WalletProfile | undefined; readonly onRemove: () => void }) {
  const href = `/traders/${profile !== undefined && profile.address !== '' ? profile.address : id}`;
  return (
    <span className="flex items-start justify-end gap-2">
      <span className="flex flex-col items-end gap-[2px]">
        <span className="flex items-center gap-[6px]">
          <Swatch colour={colour} />
          <Link href={href} className="num text-[12.5px] font-semibold text-text">
            {profile === undefined || profile.address === '' ? `#${id}` : shortAddress(profile.address)}
          </Link>
        </span>
        <span className="text-[11px] font-medium text-muted2">account #{id}</span>
      </span>
      <button type="button" onClick={onRemove} aria-label={`Remove account #${id} from the comparison`} className="rounded-[5px] px-[5px] text-[15px] leading-none text-muted2 hover:bg-card2 hover:text-text">
        ×
      </button>
    </span>
  );
}

interface Row {
  readonly group?: string;
  readonly label: string;
  readonly title?: string;
  readonly cell?: (c: CompareColumn) => ReactNode;
}

// The money rule keeps cents under $1, so a small loss never prints as "−0".
const signed = (v: number) => <span className={v > 0 ? 'text-safe' : v < 0 ? 'text-danger' : ''}>{formatSignedMoney(v)}</span>;
const volume = (v: number) => (v === 0 ? '0' : formatMoney(v));
const withheld = (v: number | undefined, floor: number, roundTrips: number) =>
  v === undefined ? <span className="text-muted2" title={`Withheld under ${floor} round trips; this has ${roundTrips}.`}>under {floor} trips</span> : formatPct(v);

function ROWS(period: string): readonly Row[] {
  return [
    { group: 'Now', label: '' },
    { label: 'Equity', title: 'Free balance + posted margin + unrealised PnL, at the venue’s marks now', cell: (c) => (c.equityAusd === undefined ? <span className="text-muted2">not priced yet</span> : formatMoney(c.equityAusd)) },
    { label: 'Open positions', cell: (c) => formatCount(c.openPositions) },
    { group: period, label: '' },
    { label: 'Net PnL', title: 'Realised + funding − fees over the window', cell: (c) => signed(c.window.netPnlAusd) },
    { label: 'Volume', cell: (c) => volume(c.window.volumeAusd) },
    { label: 'Round trips', cell: (c) => formatCount(c.window.roundTrips) },
    { label: 'Win rate, before fees', title: 'Round trips won, before fees: the index records fees per account per day, not per position', cell: (c) => withheld(c.window.winRate, c.floor, c.window.roundTrips) },
    { label: 'Liquidations', cell: (c) => (c.window.liquidations === 0 ? '0' : `${formatCount(c.window.liquidations)} · ${formatCount(c.window.rescuableLiquidations)} rescuable`) },
    { group: 'Lifetime', label: '' },
    { label: 'Net PnL', cell: (c) => signed(c.lifetime.netPnlAusd) },
    { label: 'Volume', cell: (c) => volume(c.lifetime.volumeAusd) },
    { label: 'Round trips', cell: (c) => formatCount(c.lifetime.roundTrips) },
    { label: 'Win rate, before fees', title: 'Round trips won, before fees: the index records fees per account per day, not per position', cell: (c) => withheld(c.lifetime.winRate, c.floor, c.lifetime.roundTrips) },
    {
      label: 'Profit factor, before fees',
      title: 'Gross profit ÷ gross loss over round trips, before fees: the index records fees per account per day, not per position. Withheld under the floor, and when there has been no losing trip.',
      cell: (c) => (c.lifetime.profitFactor === undefined ? <span className="text-muted2">{c.lifetime.roundTrips < c.floor ? `under ${c.floor} trips` : 'no losses'}</span> : `${c.lifetime.profitFactor.toFixed(2)}×`),
    },
    { label: 'Max drawdown, before fees', title: 'Largest peak-to-trough fall in the running total of round-trip results, before fees: the index records fees per account per day, not per position', cell: (c) => (c.lifetime.maxDrawdownAusd === 0 ? '0' : <span className="text-danger">−{formatMoney(c.lifetime.maxDrawdownAusd)}</span>) },
    { label: 'Best / worst streak, before fees', title: 'Longest run of winning, then losing, round trips, before fees: the index records fees per account per day, not per position', cell: (c) => `${formatCount(c.lifetime.longestWinStreak)} won / ${formatCount(c.lifetime.longestLossStreak)} lost` },
    { label: 'Average hold', cell: (c) => (c.lifetime.averageHoldMs === undefined ? '—' : formatDuration(c.lifetime.averageHoldMs)) },
    { label: 'Best market, before fees', title: 'Realised P&L plus funding per market, before fees: the index records fees per account per day, not per position', cell: (c) => (c.lifetime.bestMarket === undefined ? '—' : <>{marketName(c.lifetime.bestMarket.market)} {signed(c.lifetime.bestMarket.netPnlAusd)}</>) },
    { label: 'Worst market, before fees', title: 'Realised P&L plus funding per market, before fees: the index records fees per account per day, not per position', cell: (c) => (c.lifetime.worstMarket === undefined ? '—' : <>{marketName(c.lifetime.worstMarket.market)} {signed(c.lifetime.worstMarket.netPnlAusd)}</>) },
    {
      label: 'Liquidations',
      title: 'Rescuable: the free balance would have covered the top-up that kept the position open. Out of those that can be judged.',
      cell: (c) => (c.lifetime.liquidations === 0 ? '0' : `${formatCount(c.lifetime.liquidations)} · ${formatCount(c.lifetime.rescuableLiquidations)} of ${formatCount(c.lifetime.judgeableLiquidations)} rescuable`),
    },
  ];
}

interface ChartColumn {
  readonly id: number;
  readonly colour: string;
  readonly label: string;
  /** Undefined while loading, or when the read failed. */
  readonly days: readonly TraderDayPoint[] | undefined;
  readonly failed: boolean;
}

function CompareChart({ columns: all }: { readonly columns: readonly ChartColumn[] }) {
  const columns = useMemo(() => all.filter((c): c is ChartColumn & { days: readonly TraderDayPoint[] } => c.days !== undefined), [all]);
  const points = useMemo(() => alignedCumulative(columns.map((c) => ({ accountId: c.id, days: c.days }))), [columns]);
  const rows = points.map((p) => ({ dayMs: p.dayMs, ...Object.fromEntries(columns.map((c) => [`w${c.id}`, p.values[c.id]])) }));
  return (
    <div>
      {/* The legend names EVERY wallet in words, loaded or not: a missing line is never a silent gap. */}
      <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12px] text-text2">
        {all.map((c) => (
          <li key={c.id} className="flex items-center gap-[6px]">
            {c.days === undefined ? (
              <i aria-hidden="true" className="inline-block h-0 w-[14px] border-t-2 border-dashed" style={{ borderColor: c.colour }} />
            ) : (
              <i aria-hidden="true" className="inline-block h-[2px] w-[14px]" style={{ background: c.colour }} />
            )}
            <span className="num">{c.label}</span>
            {c.days === undefined && <span className={c.failed ? 'text-watch' : 'text-muted2'}>{c.failed ? 'could not be read' : 'loading…'}</span>}
          </li>
        ))}
      </ul>
      {columns.length === 0 ? (
        <Skeleton className="mt-2 h-[260px] w-full" />
      ) : points.length === 0 ? (
        <div className="py-8 text-center text-[12.5px] text-muted">None of these accounts traded in this window.</div>
      ) : (
      <div className="mt-2 h-[260px] w-full" role="img" aria-label={`Cumulative net PnL per account: ${columns.map((c) => `${c.label} ends at ${formatSignedMoney(points.at(-1)!.values[c.id] ?? 0)}`).join('; ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={VAR.border} />
            <XAxis dataKey="dayMs" tickFormatter={formatDay} tickLine={false} axisLine={false} minTickGap={28} />
            <YAxis tickFormatter={(v: number) => formatMoney(v)} tickLine={false} axisLine={false} width={64} />
            <ReferenceLine y={0} stroke={VAR.border2} />
            <Tooltip
              content={({ active, label }) => {
                if (!active || label === undefined) return null;
                const p = points.find((x) => x.dayMs === label);
                if (p === undefined) return null;
                return <ChartTooltip title={formatDayLong(Number(label))} rows={columns.map((c) => ({ swatch: c.colour, label: c.label, value: formatSignedMoney(p.values[c.id] ?? 0) }))} />;
              }}
            />
            {columns.map((c) => (
              <Line key={c.id} type="linear" dataKey={`w${c.id}`} stroke={c.colour} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: VAR.card, strokeWidth: 2 }} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      )}
    </div>
  );
}

function Footnote({ period, floor }: { readonly period: string; readonly floor: number }) {
  return (
    <p className="m-0 py-[10px] text-[11.5px] leading-[1.55] text-muted2">
      Window figures sum each account&rsquo;s UTC days over {period}; lifetime figures run since its first trade. Win rate and profit factor are withheld under {formatCount(floor)} round
      trips, as on every page. Rescuable liquidations are those the free balance would have covered, out of those that can be judged.
    </p>
  );
}

/** Add by account id, full address, or the start of one: the same lookups the Search box uses. */
function AddWallet({ ids, onAdd, savedIds }: { readonly ids: readonly number[]; readonly onAdd: (next: readonly number[]) => void; readonly savedIds: readonly number[] }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [matches, setMatches] = useState<readonly WalletMatch[] | undefined>(undefined);
  const full = ids.length >= MAX_COMPARE;

  const add = (id: number) => {
    const r = withAdded(ids, id);
    if (r.kind === 'already') setNote(`Account #${id} is already in the comparison.`);
    else if (r.kind === 'full') setNote(`At most ${MAX_COMPARE} accounts compare at once. Remove one first.`);
    else {
      onAdd(r.ids);
      setText('');
      setNote(undefined);
      setMatches(undefined);
    }
  };

  const submit = async () => {
    const parsed = parseTraderQuery(text.trim());
    setMatches(undefined);
    if (parsed.kind === 'invalid') return setNote(parsed.reason);
    if (parsed.kind === 'account') return add(parsed.accountId);
    setBusy(true);
    try {
      if (parsed.kind === 'address') {
        const r = (await api.wallet(parsed.address)).data;
        if (r.kind === 'found') add(r.profile.accountId);
        else if (r.accountId !== undefined) add(r.accountId);
        else setNote('This address has no account the index or the Exchange can see.');
      } else {
        const found = (await api.walletSearch(parsed.prefix)).data.matches;
        if (found.length === 1) add(found[0]!.accountId);
        else if (found.length === 0) setNote(`No recorded owner starts with ${parsed.prefix}. Paste the full address, or use the account id.`);
        else setMatches(found);
      }
    } catch {
      setNote('The lookup failed just now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const savedToAdd = savedIds.filter((id) => !ids.includes(id)).slice(0, MAX_COMPARE - ids.length);
  return (
    <section className="mb-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="compare-add">
          Add an account by address or account id
        </label>
        <input
          id="compare-add"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={full}
          placeholder={full ? `${MAX_COMPARE} accounts: remove one to add another` : 'Add by address, part of one, or account id'}
          className="num min-w-0 flex-1 rounded-[8px] border border-border2 bg-card px-3 py-[8px] text-[13px] text-text placeholder:text-muted2 sm:max-w-[460px]"
        />
        <button type="submit" className="seg" disabled={full || busy || text.trim() === ''}>
          {busy ? 'Looking up…' : 'Add'}
        </button>
        {savedToAdd.length > 0 && (
          <button type="button" className="seg" onClick={() => onAdd([...ids, ...savedToAdd])}>
            Add saved ({formatCount(savedToAdd.length)})
          </button>
        )}
      </form>
      {note !== undefined && <p className="mt-2 mb-0 text-[12px] text-watch">{note}</p>}
      {matches !== undefined && (
        <ul className="mt-2 mb-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
          {matches.map((m) => (
            <li key={m.accountId}>
              <button type="button" className="num text-left text-accent underline-offset-2 hover:underline" onClick={() => add(m.accountId)}>
                {m.address}
              </button>
              <span className="text-muted"> · account {m.accountId}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

