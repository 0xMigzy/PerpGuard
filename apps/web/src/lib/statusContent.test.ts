import assert from 'node:assert/strict';
import { test } from 'node:test';
import { METRIC_NAMES, FIELD_LABELS, SOURCE_NAMES } from './status.ts';
import { coverageFields, dataStatusFields, infrastructureFields, methodology, overallStatus, qualityFields, sourceRows, conventionFields } from './statusContent.ts';

const NOW = Date.UTC(2026, 9, 8, 16, 0, 0);

test('WITH NOTHING FETCHED, every live field says Not available, and nothing is green', () => {
  const i = { nowMs: NOW };
  for (const field of [...dataStatusFields(i), ...infrastructureFields(i)]) {
    if (field.label === 'Historical coverage') continue; // the index start is a fixed fact, pinned in methodology.ts
    assert.equal(field.value.kind === 'value' && field.value.tone === 'ok', false, `${field.label} must not look healthy blind`);
  }
  assert.deepEqual(overallStatus(undefined, false), { kind: 'unavailable' });
  const down = overallStatus(undefined, true);
  assert.equal(down.kind === 'value' && down.tone, 'bad', 'an unreachable backend is said, in red');
});

test('the sections carry exactly the labels and metrics asked for, in order', () => {
  const i = { nowMs: NOW };
  assert.deepEqual(dataStatusFields(i).map((f) => f.label), FIELD_LABELS['data-status']);
  assert.deepEqual(coverageFields(i).map((f) => f.label), FIELD_LABELS['data-coverage']);
  assert.deepEqual(conventionFields(i).map((f) => f.label), FIELD_LABELS['metric-methodology']);
  assert.deepEqual(qualityFields(i).map((f) => f.label), FIELD_LABELS['data-quality']);
  assert.deepEqual(infrastructureFields(i).map((f) => f.label), FIELD_LABELS.infrastructure);
  assert.deepEqual(sourceRows(i).map((r) => r.name), [...SOURCE_NAMES]);
  const m = methodology(undefined);
  for (const [section, names] of Object.entries(METRIC_NAMES)) {
    assert.deepEqual(m[section as keyof typeof m].map((x) => x.name), [...names], section);
  }
});

test('EVERY METRIC NAMES THE CODE THAT COMPUTES IT, so its words can be checked against it', () => {
  for (const metrics of Object.values(methodology(undefined))) {
    for (const metric of metrics) assert.match(metric.code ?? '', /\.(ts|tsx)\b/, `${metric.name} names no file`);
  }
});

test('MODELLED FIGURES ARE LABELLED: the counterfactuals, the shock and the APR', () => {
  const all = Object.values(methodology(undefined)).flat();
  for (const name of ['Preventable liquidations', 'Preventable value', 'Liquidation ladder', 'Stress test', 'Funding rates']) {
    assert.ok(all.find((m) => m.name === name)?.modelled !== undefined, name);
  }
});

test('the RPC is named by provider domain only; a URL never reaches the page', () => {
  const infra = { network: { name: 'mainnet', chainId: 143 }, rpcProvider: 'quiknode.pro', indexer: 'Envio HyperIndex', database: 'PostgreSQL', cacheTtlMs: 300_000, warmIntervalMs: 3_600_000, healthTtlMs: 2_000, riskSnapshotTtlMs: 20_000, treasuryScanIntervalMs: 900_000, venueFundingTtlMs: 60_000, perplContextTtlMs: 60_000 };
  const rpc = infrastructureFields({ nowMs: NOW, infrastructure: infra }).find((f) => f.label === 'RPC provider')!;
  assert.deepEqual(rpc.value.kind === 'value' && rpc.value.text, 'quiknode.pro');
  const text = JSON.stringify([infrastructureFields({ nowMs: NOW, infrastructure: infra }), sourceRows({ nowMs: NOW, infrastructure: infra })]);
  assert.doesNotMatch(text, /https?:\/\//, 'no URL anywhere in the infrastructure or sources');
  assert.match(text, /hourly/, 'the warm interval is read from the configuration');
});

test('the windows are the rolling convention, and whole-day figures say so', () => {
  const windows = conventionFields({ nowMs: NOW }).find((f) => f.label === 'Time windows')!;
  assert.match(windows.value.kind === 'value' ? windows.value.text : '', /ROLLING[\s\S]*last 7 whole days \+ today/);
  const currency = conventionFields({ nowMs: NOW }).find((f) => f.label === 'Currency')!;
  assert.match(currency.value.kind === 'value' ? currency.value.text : '', /AUSD, a dollar stablecoin/);
});

test('"NOW" IS THE FRESH HEALTH, never the one a cached answer was computed with', () => {
  const old = { state: 'synced', blocksBehind: 100, headIsIndependent: true, latestProcessedBlock: 1_000, serveAsCurrent: true, observedAtMs: NOW - 240_000 } as const;
  const fresh = { ...old, latestProcessedBlock: 1_800, observedAtMs: NOW - 1_000 } as const;
  const history = { data: { startsAtMs: undefined, startBlock: 1, months: [] }, health: old, stale: false, computedAtMs: NOW - 240_000, ageMs: 240_000, revalidating: false, generatedAtMs: NOW } as never;
  const block = dataStatusFields({ nowMs: NOW, history, health: fresh }).find((f) => f.label === 'Latest indexed block')!;
  assert.deepEqual(block.value.kind === 'value' && block.value.text, '1,800');
});
