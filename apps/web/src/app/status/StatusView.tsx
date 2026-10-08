'use client';

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader.tsx';
import { FieldCard, MethodList, SourcesTable, StatusSection } from '@/components/status/StatusParts.tsx';
import { api } from '@/lib/api.ts';
import { STATUS_SECTIONS } from '@/lib/status.ts';
import { DISCLAIMER_FIELDS, conventionFields, coverageFields, dataStatusFields, infrastructureFields, methodology, qualityFields, sourceRows, type StatusInputs } from '@/lib/statusContent.ts';
import { usePoll } from '@/lib/usePoll.ts';

const TITLE = Object.fromEntries(STATUS_SECTIONS.map((s) => [s.id, s.title])) as Record<(typeof STATUS_SECTIONS)[number]['id'], string>;

/**
 * DATA & METHODOLOGY. Where every number on the site comes from, how it is
 * computed, how current it is, and what it cannot tell you. Every field is a
 * value, "Not available" or "Awaiting implementation", and says which.
 *
 * NOTHING HERE CAN CAUSE A SCAN. Every read is an answer already cached (the
 * history, the 30D and All metrics are warmed hourly), static configuration,
 * the indexer health every envelope carries, the Perpl context the backend
 * re-reads at most once a minute, or the venue funding it fetches at most once
 * a minute while read.
 */
export function StatusView() {
  const history = usePoll(api.history, 30_000, 'status-history');
  const infrastructure = usePoll(api.infrastructure, 10 * 60_000, 'status-infrastructure');
  const metricsAll = usePoll(() => api.metrics('all'), 5 * 60_000, 'status-metrics-all');
  const metrics30 = usePoll(() => api.metrics('30d'), 5 * 60_000, 'status-metrics-30d');
  // Polled every 30 s for the health it carries: built per request, so its health is now (cached 2 s).
  const openInterest = usePoll(api.openInterest, 30_000, 'status-oi');
  const treasury = usePoll(api.protocolTreasuryDays, 5 * 60_000, 'status-treasury');
  const venues = usePoll(api.venueFunding, 60_000, 'status-venues');

  // "N s ago" moves on its own between polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const inputs: StatusInputs = {
    nowMs,
    history: history.data,
    historyError: history.error !== undefined && history.data === undefined,
    infrastructure: infrastructure.data?.data,
    metricsAll: metricsAll.data,
    metrics30: metrics30.data,
    health: openInterest.data?.health,
    openInterest: openInterest.data?.data,
    treasury: treasury.data?.data,
    venues: venues.data?.data,
  };
  const methods = useMemo(() => methodology(infrastructure.data?.data), [infrastructure.data]);

  return (
    <div data-ui="terminal">
      <PageHeader title="Data" thin="& Methodology" subtitle="Where every figure on PerpGuard comes from, how it is calculated, how current it is, and what it cannot tell you." />

      <nav aria-label="Sections" className="mb-6 flex flex-wrap gap-2">
        {STATUS_SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="seg no-underline">
            {s.title}
          </a>
        ))}
      </nav>

      <StatusSection id="data-status" title={TITLE['data-status']}>
        <FieldCard fields={dataStatusFields(inputs)} />
      </StatusSection>

      <StatusSection id="data-sources" title={TITLE['data-sources']}>
        <SourcesTable rows={sourceRows(inputs)} />
      </StatusSection>

      <StatusSection id="data-coverage" title={TITLE['data-coverage']}>
        <FieldCard fields={coverageFields(inputs)} />
      </StatusSection>

      <StatusSection
        id="metric-methodology"
        title={TITLE['metric-methodology']}
        intro="Every metric below is described by the same six things: its name, what it means, how it is calculated, where the data comes from, the window it covers and how often it is refreshed. Each names the code that computes it."
      >
        <FieldCard fields={conventionFields(inputs)} />
      </StatusSection>

      <StatusSection id="trading-metrics" title={TITLE['trading-metrics']}>
        <MethodList metrics={methods['trading-metrics']} />
      </StatusSection>

      <StatusSection id="trader-metrics" title={TITLE['trader-metrics']}>
        <MethodList metrics={methods['trader-metrics']} />
      </StatusSection>

      <StatusSection id="liquidation-metrics" title={TITLE['liquidation-metrics']}>
        <MethodList metrics={methods['liquidation-metrics']} />
      </StatusSection>

      <StatusSection id="risk-methodology" title={TITLE['risk-methodology']}>
        <MethodList metrics={methods['risk-methodology']} />
      </StatusSection>

      <StatusSection id="capital-flow" title={TITLE['capital-flow']}>
        <MethodList metrics={methods['capital-flow']} />
      </StatusSection>

      <StatusSection id="data-quality" title={TITLE['data-quality']}>
        <FieldCard fields={qualityFields(inputs)} />
      </StatusSection>

      <StatusSection id="infrastructure" title={TITLE.infrastructure}>
        <FieldCard fields={infrastructureFields(inputs)} />
      </StatusSection>

      <StatusSection id="disclaimers" title={TITLE.disclaimers}>
        <FieldCard fields={DISCLAIMER_FIELDS} />
      </StatusSection>
    </div>
  );
}
