import type { ReactNode } from 'react';
import type { OiReconciliation } from '@perpguard/shared';
import { gapPct } from '@/lib/oiHistory.ts';
import type { DataSourceRow, FieldState, MetricMethod, StatusField } from '@/lib/status.ts';

/**
 * The /status page's building blocks: a field that says what it is (a value,
 * not available, awaiting implementation), a card of fields, a sources table
 * and a methodology accordion. Plain markup in the site's own classes.
 */

const TONE: Record<'ok' | 'warn' | 'bad', string> = { ok: 'bg-safe', warn: 'bg-watch', bad: 'bg-danger' };

/** One field's value. An empty field says so in words, muted, never as a blank or a zero. */
export function FieldValue({ state }: { readonly state: FieldState }) {
  if (state.kind === 'value') {
    return (
      <span className="inline-flex items-start gap-2 text-text" title={state.title}>
        {state.tone !== undefined && <span className={`mt-[6px] h-2 w-2 flex-none rounded-full ${TONE[state.tone]}`} aria-hidden="true" />}
        <span>{state.text}</span>
      </span>
    );
  }
  const text = state.kind === 'unavailable' ? 'Not available' : 'Awaiting implementation';
  return (
    <span className="text-muted2" title={state.why}>
      {text}
      {state.why !== undefined && <span className="block text-[11.5px] text-muted2">{state.why}</span>}
    </span>
  );
}

/** A section: its title as an anchor, then its body. */
export function StatusSection({ id, title, intro, children }: { readonly id: string; readonly title: string; readonly intro?: ReactNode; readonly children: ReactNode }) {
  return (
    <section id={id} className="mb-6 scroll-mt-24">
      <h2 className="m-0 mb-1 text-[16px] font-bold tracking-[-0.01em]">
        <a href={`#${id}`} className="text-text no-underline hover:underline">
          {title}
        </a>
      </h2>
      {intro !== undefined && <p className="m-0 mb-3 max-w-[80ch] text-[13px] leading-[1.55] text-muted">{intro}</p>}
      {intro === undefined && <div className="mb-3" />}
      {children}
    </section>
  );
}

/** A card of label / value pairs: two columns on a wide screen, stacked on a phone. */
export function FieldCard({ fields }: { readonly fields: readonly StatusField[] }) {
  return (
    <div className="card px-[18px] py-2">
      <dl className="m-0 divide-y divide-border">
        {fields.map((f) => (
          <div key={f.label} className="grid gap-1 py-[10px] text-[13px] sm:grid-cols-[200px_1fr] sm:gap-4">
            <dt className="text-muted">{f.label}</dt>
            <dd className="m-0 leading-[1.5]">
              <FieldValue state={f.value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The sources: a compact table on a wide screen, one card per source on a phone. */
export function SourcesTable({ rows }: { readonly rows: readonly DataSourceRow[] }) {
  const cols: Array<[keyof Omit<DataSourceRow, 'name'>, string]> = [
    ['type', 'Type'],
    ['network', 'Network'],
    ['collected', 'Data collected'],
    ['sync', 'Sync status'],
    ['lastSynced', 'Last synced'],
  ];
  return (
    <>
      <div className="card hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-[0.06em] text-muted">
              <th scope="col" className="px-[14px] py-[9px] font-semibold">Source</th>
              {cols.map(([, label]) => (
                <th key={label} scope="col" className="px-[14px] py-[9px] font-semibold">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-border align-top last:border-b-0">
                <th scope="row" className="px-[14px] py-[10px] text-left font-semibold text-text">{r.name}</th>
                {cols.map(([key]) => (
                  <td key={key} className="px-[14px] py-[10px] leading-[1.5]">
                    <FieldValue state={r[key]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 md:hidden">
        {rows.map((r) => (
          <div key={r.name} className="card px-[16px] py-2">
            <div className="py-2 text-[13.5px] font-semibold text-text">{r.name}</div>
            <dl className="m-0 divide-y divide-border">
              {cols.map(([key, label]) => (
                <div key={key} className="grid gap-1 py-2 text-[13px]">
                  <dt className="text-muted">{label}</dt>
                  <dd className="m-0">
                    <FieldValue state={r[key]} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

/** One metric, closed by default: its name and window on the summary, the six columns inside. */
export function MethodAccordion({ metric }: { readonly metric: MetricMethod }) {
  const rows: Array<[string, FieldState]> = [
    ['Definition', metric.definition],
    ['Calculation method', metric.calculation],
    ['Data source', metric.dataSource],
    ['Time window', metric.timeWindow],
    ['Refresh frequency', metric.refresh],
  ];
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-[18px] py-[12px] text-[13.5px] hover:bg-card2 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-semibold text-text">
          <span aria-hidden="true" className="inline-block text-muted transition-transform group-open:rotate-90">›</span>
          {metric.name}
          {metric.modelled !== undefined && <span className="chip text-[11px]">Modelled</span>}
        </span>
        <span className="hidden text-right text-[12px] text-muted sm:block">
          {metric.timeWindow.kind === 'value' ? metric.timeWindow.text : ''}
        </span>
      </summary>
      <div className="px-[18px] pb-3">
        <dl className="m-0 divide-y divide-border">
          {rows.map(([label, state]) => (
            <div key={label} className="grid gap-1 py-[9px] text-[13px] sm:grid-cols-[170px_1fr] sm:gap-4">
              <dt className="text-muted">{label}</dt>
              <dd className="m-0 leading-[1.55]">
                <FieldValue state={state} />
              </dd>
            </div>
          ))}
        </dl>
        {metric.modelled !== undefined && <p className="m-0 mt-2 text-[12px] text-watch">Modelled: {metric.modelled}</p>}
        {metric.code !== undefined && <p className="m-0 mt-2 font-mono text-[11.5px] text-muted2">Code: {metric.code}</p>}
      </div>
    </details>
  );
}

/** A methodology section: its metrics as accordions in one card. */
export function MethodList({ metrics }: { readonly metrics: readonly MetricMethod[] }) {
  return (
    <div className="card overflow-hidden">
      {metrics.map((m) => (
        <MethodAccordion key={m.name} metric={m} />
      ))}
    </div>
  );
}

/**
 * Open interest, index beside venue, per market: the backend's 5-minute like-for-like check. Lots in
 * each market's own units; the gap is indexed − venue; each side's block is shown, so a gap can be
 * read as trades between the two reads rather than taken on trust.
 */
export function OiReconciliationTable({ reconciliation, nowMs }: { readonly reconciliation: OiReconciliation | undefined; readonly nowMs: number }) {
  if (reconciliation === undefined) {
    return <div className="card mt-3 px-[18px] py-3 text-[13px] text-muted2">Open interest check: not available yet. It runs every 5 minutes.</div>;
  }
  const r = reconciliation;
  const lots = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });
  const age = Math.max(0, Math.round((nowMs - r.atMs) / 60_000));
  const at = new Date(r.atMs).toISOString().slice(11, 16);
  return (
    <div className="card mt-3 overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-[18px] py-[10px]">
        <div className="text-[13.5px] font-semibold text-text">Open interest: index vs venue</div>
        <div className="text-[12px] text-muted">
          Checked {at} UTC ({age < 1 ? 'under a minute' : `${age} min`} ago) · index block {r.indexBlock.toLocaleString('en-US')} · every 5 minutes
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-[11.5px] uppercase tracking-[0.06em] text-muted">
              <th scope="col" className="px-[14px] py-[8px] text-left font-semibold">Market</th>
              <th scope="col" className="px-[14px] py-[8px] text-right font-semibold">Indexed lots</th>
              <th scope="col" className="px-[14px] py-[8px] text-right font-semibold">Venue lots</th>
              <th scope="col" className="px-[14px] py-[8px] text-right font-semibold">Gap</th>
              <th scope="col" className="px-[14px] py-[8px] text-right font-semibold">Index block</th>
              <th scope="col" className="px-[14px] py-[8px] text-right font-semibold">Venue block</th>
            </tr>
          </thead>
          <tbody>
            {r.markets.map((m) => (
              <tr key={m.marketId} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-[14px] py-[8px] text-left font-semibold text-text">{m.symbol}</th>
                <td className="num px-[14px] py-[8px] text-right">{lots(m.indexedLots)}</td>
                <td className="num px-[14px] py-[8px] text-right">{lots(m.venueLots)}</td>
                <td className={`num px-[14px] py-[8px] text-right ${m.gapLots === 0 ? 'text-safe' : 'text-watch'}`}>
                  {m.gapLots === 0 ? 'matches' : `${m.gapLots > 0 ? '+' : '−'}${lots(Math.abs(m.gapLots))} (${gapPct(m.gapShare)})`}
                </td>
                <td className="num px-[14px] py-[8px] text-right text-muted">{r.indexBlock.toLocaleString('en-US')}</td>
                <td className="num px-[14px] py-[8px] text-right text-muted">{m.venueBlock.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-[18px] py-[9px] text-[12px] leading-[1.5] text-muted">
        The venue&rsquo;s reading first, the index&rsquo;s live total straight after, each with its block. A gap is trades that landed between the two reads; the index also trails the chain by its lag.
      </div>
    </div>
  );
}
