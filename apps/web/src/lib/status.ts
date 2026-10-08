/**
 * THE DATA & METHODOLOGY PAGE (/status), its content in one place.
 *
 * Every field is one of three things, and says which:
 *   - a VALUE read from something already computed (a cached answer, /health),
 *   - NOT AVAILABLE: nothing PerpGuard runs can answer it,
 *   - AWAITING IMPLEMENTATION: answerable, but only with a new query or new
 *     indexing, which this page is not allowed to run.
 * Nothing here is invented: an empty field is said to be empty.
 *
 * Methodology text is a reading of the code that computes each figure; every
 * entry names that code in `source` so it can be checked against it.
 */

export type FieldState =
  | { readonly kind: 'value'; readonly text: string; readonly title?: string; readonly tone?: 'ok' | 'warn' | 'bad' }
  | { readonly kind: 'unavailable'; readonly why?: string }
  | { readonly kind: 'awaiting'; readonly why?: string };

export const NOT_AVAILABLE: FieldState = { kind: 'unavailable' };

export const value = (text: string, extra: { readonly title?: string; readonly tone?: 'ok' | 'warn' | 'bad' } = {}): FieldState => ({ kind: 'value', text, ...extra });
export const awaiting = (why?: string): FieldState => (why === undefined ? { kind: 'awaiting' } : { kind: 'awaiting', why });
export const unavailable = (why?: string): FieldState => (why === undefined ? { kind: 'unavailable' } : { kind: 'unavailable', why });

/** One labelled field. */
export interface StatusField {
  readonly label: string;
  readonly value: FieldState;
}

/** One row of a methodology section: the six columns the page shows for every metric. */
export interface MetricMethod {
  readonly name: string;
  readonly definition: FieldState;
  readonly calculation: FieldState;
  readonly dataSource: FieldState;
  readonly timeWindow: FieldState;
  readonly refresh: FieldState;
  /** Where the code is: file and function. Shown small, so a reader can check the words against it. */
  readonly code?: string;
  /** Said when the figure is modelled or estimated rather than read. */
  readonly modelled?: string;
}

/** A metric with nothing filled in yet. */
export const pendingMetric = (name: string): MetricMethod => ({
  name,
  definition: NOT_AVAILABLE,
  calculation: NOT_AVAILABLE,
  dataSource: NOT_AVAILABLE,
  timeWindow: NOT_AVAILABLE,
  refresh: NOT_AVAILABLE,
});

/** One data source, one row of the Data Sources table. */
export interface DataSourceRow {
  readonly name: string;
  readonly type: FieldState;
  readonly network: FieldState;
  readonly collected: FieldState;
  readonly sync: FieldState;
  readonly lastSynced: FieldState;
}

export const pendingSource = (name: string): DataSourceRow => ({
  name,
  type: NOT_AVAILABLE,
  network: NOT_AVAILABLE,
  collected: NOT_AVAILABLE,
  sync: NOT_AVAILABLE,
  lastSynced: NOT_AVAILABLE,
});

/** The sections, in the page's order: titles and anchors in one place. */
export const STATUS_SECTIONS = [
  { id: 'data-status', title: 'Data status' },
  { id: 'data-sources', title: 'Data sources' },
  { id: 'data-coverage', title: 'Data coverage' },
  { id: 'metric-methodology', title: 'Metric methodology' },
  { id: 'trading-metrics', title: 'Trading metrics' },
  { id: 'trader-metrics', title: 'Trader metrics' },
  { id: 'liquidation-metrics', title: 'Liquidation metrics' },
  { id: 'risk-methodology', title: 'Risk methodology' },
  { id: 'capital-flow', title: 'Capital flow methodology' },
  { id: 'data-quality', title: 'Data quality' },
  { id: 'infrastructure', title: 'Infrastructure' },
  { id: 'disclaimers', title: 'Disclaimers' },
] as const;

export type SectionId = (typeof STATUS_SECTIONS)[number]['id'];

/** The metric names each methodology section lists, in order. */
export const METRIC_NAMES = {
  'trading-metrics': ['Trading volume', 'Open interest', 'Trades', 'Active traders', 'Funding rates', 'Trading fees'],
  'trader-metrics': ['Realised PnL', 'Unrealised PnL', 'Net PnL', 'Profitable traders', 'Average PnL', 'Trader rankings'],
  'liquidation-metrics': ['Total liquidations', 'Liquidation value', 'Preventable liquidations', 'Preventable value', 'Liquidation thresholds'],
  'risk-methodology': ['Long/short exposure', 'Liquidation ladder', 'Stress test', 'Positions at risk', 'Price impact assumptions'],
  'capital-flow': ['Deposits', 'Withdrawals', 'Net capital flow', 'Unique accounts', 'Since-launch totals'],
} as const satisfies Partial<Record<SectionId, readonly string[]>>;

export type MethodSectionId = keyof typeof METRIC_NAMES;

/** The key-value sections and their field labels, in order. */
export const FIELD_LABELS = {
  'data-status': ['Overall status', 'Network', 'Last updated', 'Latest indexed block', 'Indexing lag', 'Historical coverage'],
  'metric-methodology': ['Time windows', 'Currency', 'Refresh frequency', 'Rounding'],
  'data-coverage': ['Coverage start', 'Coverage end', 'Indexed blocks', 'Total events', 'Missing events', 'Backfill status'],
  'data-quality': ['Completeness', 'Accuracy', 'Known limitations', 'Missing data', 'Validation checks'],
  infrastructure: ['RPC provider', 'Indexer', 'Database', 'Cache', 'API status', 'Update frequency'],
  disclaimers: ['Data accuracy', 'Financial disclaimer', 'Protocol affiliation', 'Report an issue'],
} as const satisfies Partial<Record<SectionId, readonly string[]>>;

export type FieldSectionId = keyof typeof FIELD_LABELS;

/** Every field of a key-value section, with nothing filled in. */
export function pendingFields(section: FieldSectionId): readonly StatusField[] {
  return FIELD_LABELS[section].map((label) => ({ label, value: NOT_AVAILABLE }));
}

/** The sources the Data Sources table lists. */
export const SOURCE_NAMES = ['Envio HyperIndex', 'Monad RPC', 'Perpl API', 'Perpl Exchange contract (direct reads)', 'Hyperliquid API', 'Binance Futures API'] as const;
