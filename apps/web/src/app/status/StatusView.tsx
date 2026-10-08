'use client';

import { PageHeader } from '@/components/PageHeader.tsx';
import { FieldCard, MethodList, SourcesTable, StatusSection } from '@/components/status/StatusParts.tsx';
import { METRIC_NAMES, SOURCE_NAMES, STATUS_SECTIONS, pendingFields, pendingMetric, pendingSource, type MethodSectionId } from '@/lib/status.ts';

const TITLE = Object.fromEntries(STATUS_SECTIONS.map((s) => [s.id, s.title])) as Record<(typeof STATUS_SECTIONS)[number]['id'], string>;

const methods = (section: MethodSectionId) => METRIC_NAMES[section].map(pendingMetric);

/**
 * DATA & METHODOLOGY. Where every number on the site comes from, how it is
 * computed, how current it is, and what it cannot tell you. Every field is a
 * value, "Not available" or "Awaiting implementation", and says which.
 */
export function StatusView() {
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
        <FieldCard fields={pendingFields('data-status')} />
      </StatusSection>

      <StatusSection id="data-sources" title={TITLE['data-sources']}>
        <SourcesTable rows={SOURCE_NAMES.map(pendingSource)} />
      </StatusSection>

      <StatusSection id="data-coverage" title={TITLE['data-coverage']}>
        <FieldCard fields={pendingFields('data-coverage')} />
      </StatusSection>

      <StatusSection id="metric-methodology" title={TITLE['metric-methodology']} intro="Every metric below is described by the same six things: its name, what it means, how it is calculated, where the data comes from, the window it covers and how often it is refreshed.">
        <FieldCard fields={pendingFields('metric-methodology')} />
      </StatusSection>

      <StatusSection id="trading-metrics" title={TITLE['trading-metrics']}>
        <MethodList metrics={methods('trading-metrics')} />
      </StatusSection>

      <StatusSection id="trader-metrics" title={TITLE['trader-metrics']}>
        <MethodList metrics={methods('trader-metrics')} />
      </StatusSection>

      <StatusSection id="liquidation-metrics" title={TITLE['liquidation-metrics']}>
        <MethodList metrics={methods('liquidation-metrics')} />
      </StatusSection>

      <StatusSection id="risk-methodology" title={TITLE['risk-methodology']}>
        <MethodList metrics={methods('risk-methodology')} />
      </StatusSection>

      <StatusSection id="capital-flow" title={TITLE['capital-flow']}>
        <MethodList metrics={methods('capital-flow')} />
      </StatusSection>

      <StatusSection id="data-quality" title={TITLE['data-quality']}>
        <FieldCard fields={pendingFields('data-quality')} />
      </StatusSection>

      <StatusSection id="infrastructure" title={TITLE.infrastructure}>
        <FieldCard fields={pendingFields('infrastructure')} />
      </StatusSection>

      <StatusSection id="disclaimers" title={TITLE.disclaimers}>
        <FieldCard fields={pendingFields('disclaimers')} />
      </StatusSection>
    </div>
  );
}
