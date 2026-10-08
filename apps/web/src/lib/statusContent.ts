/**
 * The /status page's content: the methodology, read from the code that computes
 * each figure (each entry names it in `code`), and the live fields, built from
 * answers PerpGuard has already computed. PURE: the view fetches, this words.
 *
 * COST RULE. Every input here is a cached answer, a static configuration read or
 * the indexer health every envelope already carries. Nothing on this page may
 * cause a scan; a field that would need one is "Awaiting implementation".
 */
import type { HistoryCurve, IndexerHealth, ProtocolMetrics, ProtocolTreasuryDays, VenueFundingPayload } from '@perpguard/shared';
import type { Envelope, InfrastructureFacts, OpenInterestPayload } from './api.ts';
import { formatAge, formatCount, formatDayLong, formatWhen } from './format.ts';
import { INDEX_START_BLOCK, INDEX_START_LABEL } from './methodology.ts';
import { NOT_AVAILABLE, awaiting, unavailable, value, type DataSourceRow, type FieldState, type MethodSectionId, type MetricMethod, type StatusField } from './status.ts';

/** What the view has fetched. Any of it may be missing; a missing input is said, never guessed. */
export interface StatusInputs {
  readonly nowMs: number;
  /** The history answer (cached, warmed hourly). Its envelope's health is from when it was computed: never read for "now". */
  readonly history?: Envelope<HistoryCurve> | undefined;
  /**
   * The indexer health NOW: the 2-second-cached verdict a freshly built envelope carries (the open
   * interest route builds one per request). A cached answer's envelope keeps the health of when it was
   * computed, which read "index checked 4 min ago" on a synced index.
   */
  readonly health?: IndexerHealth | undefined;
  readonly historyError?: boolean;
  readonly infrastructure?: InfrastructureFacts | undefined;
  /** The All-window metrics, warmed hourly. */
  readonly metricsAll?: Envelope<ProtocolMetrics> | undefined;
  /** The 30-day metrics, warmed hourly: the default view, so its age is the site's. */
  readonly metrics30?: Envelope<ProtocolMetrics> | undefined;
  readonly openInterest?: OpenInterestPayload | undefined;
  readonly treasury?: ProtocolTreasuryDays | undefined;
  readonly venues?: VenueFundingPayload | undefined;
}

const minutes = (ms: number): string => {
  if (ms % 3_600_000 === 0) return ms === 3_600_000 ? 'hourly' : `every ${ms / 3_600_000} hours`;
  if (ms % 60_000 === 0) return ms === 60_000 ? 'every minute' : `every ${ms / 60_000} minutes`;
  return `every ${Math.round(ms / 1000)} s`;
};
const ago = (nowMs: number, atMs: number | undefined): string | undefined => (atMs === undefined ? undefined : `${formatAge(Math.max(0, nowMs - atMs))} ago`);

// ── live fields ─────────────────────────────────────────────────────────────

/** The overall verdict, the way the header's indexer chip reads it. A page that cannot see must never look green. */
export function overallStatus(health: IndexerHealth | undefined, error: boolean): FieldState {
  if (health === undefined) return error ? value('Backend unreachable: nothing on the site is current', { tone: 'bad' }) : NOT_AVAILABLE;
  if (health.serveAsCurrent) return value('Operational: the index is synced and figures are current', { tone: 'ok' });
  if (health.state === 'lagging') return value(`Degraded: the index is lagging${health.reason === undefined ? '' : `. ${health.reason}`}`, { tone: 'warn' });
  return value(`Down: the index is ${health.state}${health.reason === undefined ? '' : `. ${health.reason}`}`, { tone: 'bad' });
}

export function dataStatusFields(i: StatusInputs): readonly StatusField[] {
  const health = i.health;
  const start = i.history?.data.startsAtMs;
  return [
    { label: 'Overall status', value: overallStatus(health, i.historyError === true) },
    { label: 'Network', value: i.infrastructure === undefined ? NOT_AVAILABLE : value(`Monad ${i.infrastructure.network.name} (chain ${i.infrastructure.network.chainId})`) },
    {
      label: 'Last updated',
      value:
        health === undefined
          ? NOT_AVAILABLE
          : value(`Index checked ${ago(i.nowMs, health.observedAtMs)}${i.metrics30 === undefined ? '' : `; default views computed ${ago(i.nowMs, i.metrics30.computedAtMs)}`}`, {
              title: 'The index is checked against an independent chain head on every read; the default views are recomputed hourly and every other answer at most every five minutes.',
            }),
    },
    { label: 'Latest indexed block', value: health?.latestProcessedBlock === undefined ? NOT_AVAILABLE : value(formatCount(health.latestProcessedBlock)) },
    {
      label: 'Indexing lag',
      value:
        health === undefined
          ? NOT_AVAILABLE
          : value(`${formatCount(health.blocksBehind)} block${health.blocksBehind === 1 ? '' : 's'} behind ${health.headIsIndependent ? 'the chain head (read from the RPC, independently of the indexer)' : 'the head the indexer last saw (no independent head: unverified)'}`, {
              tone: health.serveAsCurrent ? 'ok' : health.state === 'lagging' ? 'warn' : 'bad',
            }),
    },
    {
      label: 'Historical coverage',
      value: value(`Since ${start === undefined ? INDEX_START_LABEL : formatDayLong(start)}: every block from the Exchange's deployment (block ${formatCount(i.history?.data.startBlock ?? INDEX_START_BLOCK)})`),
    },
  ];
}

export function coverageFields(i: StatusInputs): readonly StatusField[] {
  const health = i.health;
  const startBlock = health?.startBlock ?? i.history?.data.startBlock;
  const latest = health?.latestProcessedBlock;
  return [
    {
      label: 'Coverage start',
      value: value(`Block ${formatCount(startBlock ?? INDEX_START_BLOCK)}, ${i.history?.data.startsAtMs === undefined ? INDEX_START_LABEL : formatDayLong(i.history.data.startsAtMs)}: the Perpl Exchange's deployment block on Monad mainnet`),
    },
    { label: 'Coverage end', value: latest === undefined ? NOT_AVAILABLE : value(`Block ${formatCount(latest)}, the latest processed (it advances continuously)`) },
    { label: 'Indexed blocks', value: latest === undefined || startBlock === undefined ? NOT_AVAILABLE : value(formatCount(latest - startBlock + 1), { title: 'Latest processed block minus the start block, plus one.' }) },
    {
      label: 'Total events',
      value:
        health?.eventsProcessed === undefined
          ? NOT_AVAILABLE
          : value(`About ${(health.eventsProcessed / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })} million processed`, {
              title: "The indexer's own counter (Envio's num_events_processed). It is stored as a single-precision number, so it is approximate to about seven significant figures.",
            }),
    },
    {
      label: 'Missing events',
      value: unavailable('No live gap check runs. The index is verified offline against the chain logs (`pnpm verify:logs`), not continuously.'),
    },
    {
      label: 'Backfill status',
      value:
        health?.caughtUpAtMs === undefined
          ? NOT_AVAILABLE
          : value(`Complete: reached the chain head ${formatWhen(health.caughtUpAtMs)} UTC, and has followed it since`, { tone: 'ok' }),
    },
  ];
}

export function sourceRows(i: StatusInputs): readonly DataSourceRow[] {
  const health = i.health;
  const net = i.infrastructure === undefined ? NOT_AVAILABLE : value(`Monad ${i.infrastructure.network.name}`);
  const scan = i.treasury?.scan;
  const venueRow = (name: string, id: 'hyperliquid' | 'binance', collected: string): DataSourceRow => {
    const v = i.venues?.venues[id];
    return {
      name,
      type: value('Public HTTPS API'),
      network: value(`${name.split(' ')[0]} mainnet`),
      collected: value(collected),
      sync: v === undefined ? NOT_AVAILABLE : v.state === 'ok' ? value('Answering', { tone: 'ok' }) : value(`Unavailable${v.error === undefined ? '' : `: ${v.error}`}`, { tone: 'bad' }),
      lastSynced: v?.lastGoodAtMs === undefined ? NOT_AVAILABLE : value(ago(i.nowMs, v.lastGoodAtMs)!, { title: 'Fetched only while someone reads the funding comparison, at most once a minute.' }),
    };
  };
  return [
    {
      name: 'Envio HyperIndex',
      type: value('Event indexer (HyperSync)'),
      network: net,
      collected: value('Every event of the Perpl Exchange proxy: fills, positions, liquidations, funding settlements, deposits and withdrawals, market listings'),
      sync: health === undefined ? NOT_AVAILABLE : value(health.state === 'synced' ? 'Synced' : health.state, { tone: health.serveAsCurrent ? 'ok' : health.state === 'lagging' ? 'warn' : 'bad' }),
      lastSynced: health?.latestProcessedBlock === undefined ? NOT_AVAILABLE : value(`Block ${formatCount(health.latestProcessedBlock)}, checked ${ago(i.nowMs, health.observedAtMs)}`),
    },
    {
      name: 'Monad RPC',
      type: value(i.infrastructure?.rpcProvider === undefined ? 'JSON-RPC' : `JSON-RPC (${i.infrastructure.rpcProvider})`),
      network: net,
      collected: value("The chain head (to measure the index's lag), the Exchange's collateral balance, transaction receipts for trade direction, and each market's insurance fund"),
      sync: health === undefined ? NOT_AVAILABLE : health.headIsIndependent ? value('Answering', { tone: 'ok' }) : value('No independent head this read', { tone: 'warn' }),
      lastSynced: health === undefined ? NOT_AVAILABLE : value(`${ago(i.nowMs, health.observedAtMs)} (chain head)`),
    },
    {
      name: 'Perpl API',
      type: value('Public HTTPS API (GET /v1/pub/context)'),
      network: net,
      collected: value('Markets as traders see them, mark prices, open interest, funding interval and margin parameters'),
      sync: i.openInterest === undefined ? NOT_AVAILABLE : i.openInterest.markets.length > 0 ? value('Answering', { tone: 'ok' }) : value('No markets returned', { tone: 'bad' }),
      lastSynced: i.openInterest?.asOfMs === undefined ? NOT_AVAILABLE : value(`Market state ${ago(i.nowMs, i.openInterest.asOfMs)}`, { title: 'The oldest market state in the latest context read.' }),
    },
    {
      name: 'Perpl Exchange contract (direct reads)',
      type: value('Contract calls and log scans over the RPC'),
      network: net,
      collected: value("The protocol treasury's own deposits and withdrawals (not indexed), used to rebuild the exchange balance, and the reconciliation against the contract's balance"),
      sync:
        scan === undefined
          ? NOT_AVAILABLE
          : scan.lastError !== undefined && (scan.lastErrorAtMs ?? 0) > (scan.scannedAtMs ?? 0)
            ? value(`Last scan failed: ${scan.lastError}`, { tone: 'bad' })
            : value(`Scanned through block ${scan.throughBlock === undefined ? '—' : formatCount(scan.throughBlock)}`, { tone: 'ok' }),
      lastSynced: scan?.scannedAtMs === undefined ? NOT_AVAILABLE : value(`${ago(i.nowMs, scan.scannedAtMs)}, ${minutes(scan.intervalMs)}`),
    },
    venueRow('Hyperliquid API', 'hyperliquid', 'Funding rates and prices, for the cross-venue funding comparison only'),
    venueRow('Binance Futures API', 'binance', 'Funding rates, intervals and prices, for the cross-venue funding comparison only'),
  ];
}

export function conventionFields(i: StatusInputs): readonly StatusField[] {
  const f = i.infrastructure;
  return [
    {
      label: 'Time windows',
      value: value(
        '24H, 7D and 30D are ROLLING: the last 24 hours, 7 days or 30 days up to now. A figure that can only be summed from whole UTC days (trader P&L, round trips, money in and out, fees) says so on its label: "yesterday + today", "last 7 whole days + today". All runs from the index start, Feb 11, 2026.',
      ),
    },
    { label: 'Currency', value: value('Every amount is in AUSD, a dollar stablecoin and the collateral of every Perpl market (6 decimals). "$" on the site means AUSD.') },
    {
      label: 'Refresh frequency',
      value:
        f === undefined
          ? NOT_AVAILABLE
          : value(`Indexed answers are cached and refreshed behind the reader ${minutes(f.cacheTtlMs)}; the default views are recomputed ${minutes(f.warmIntervalMs)}. Every page says how old its oldest answer is once it is past 45 seconds.`),
    },
    { label: 'Rounding', value: value('Figures are shortened for display ("1.2M"); hover a figure for its exact amount where one is shown.') },
  ];
}

export function qualityFields(i: StatusInputs): readonly StatusField[] {
  const r = i.metricsAll?.data.rescues;
  const rec = i.treasury?.scan.reconciliation;
  return [
    {
      label: 'Completeness',
      value:
        r === undefined
          ? NOT_AVAILABLE
          : value(`The index starts at the Exchange's deployment block, so every liquidation can be judged: ${formatCount(r.judgeableCount)} of ${formatCount(r.judgeableCount + r.unknownCount)} since launch.`),
    },
    {
      label: 'Accuracy',
      value:
        rec === undefined
          ? NOT_AVAILABLE
          : value(
              `The exchange balance rebuilt from indexed events is ${rec.gapAusd.toLocaleString('en-US', { maximumFractionDigits: 2 })} AUSD from the contract's own balance at block ${formatCount(rec.atBlock)} (${rec.withinExpected ? 'the known, unexplained gap' : 'OUTSIDE the known gap'}), checked ${ago(i.nowMs, rec.checkedAtMs)}.`,
              { tone: rec.withinExpected ? 'ok' : 'warn' },
            ),
    },
    {
      label: 'Known limitations',
      value: value(
        'No order-book depth or intraday candles. Risk shocks are static. Trade results per round trip are before trading fees (fees are recorded per account per day). Funding across traders in AUSD is not computed: it needs each side’s open interest at every settlement.',
      ),
    },
    {
      label: 'Missing data',
      value: value(
        'The indexed fill has no taker side; direction is read from the same transaction’s position event, and left blank when it has no single answer. About 6% of fills have no paired taker. Per-position fees are not recorded. The amount a liquidation credits back to the account is emitted but not stored.',
      ),
    },
    {
      label: 'Validation checks',
      value: value(
        'Live: the index’s progress is checked against an independent chain head on every read, and the exchange balance is reconciled against the contract every 15 minutes. Offline: the index is checked against the raw chain logs, and the funding unit, open interest history and skew were measured against the venue.',
      ),
    },
  ];
}

export function infrastructureFields(i: StatusInputs): readonly StatusField[] {
  const f = i.infrastructure;
  const health = i.health;
  return [
    { label: 'RPC provider', value: f === undefined ? NOT_AVAILABLE : f.rpcProvider === undefined ? NOT_AVAILABLE : value(f.rpcProvider, { title: 'The provider only. The endpoint and its token are never shown.' }) },
    { label: 'Indexer', value: f === undefined ? NOT_AVAILABLE : value(`${f.indexer}, ${health === undefined ? 'state unknown' : health.state}`) },
    { label: 'Database', value: f === undefined ? NOT_AVAILABLE : value(f.database) },
    {
      label: 'Cache',
      value:
        f === undefined
          ? NOT_AVAILABLE
          : value(`Stale-while-revalidate: an answer is served at once and refreshed behind the reader past ${formatAge(f.cacheTtlMs)}; default views recomputed ${minutes(f.warmIntervalMs)}; indexer health reused for ${formatAge(f.healthTtlMs)}; the Risk snapshot for ${formatAge(f.riskSnapshotTtlMs)}.`),
    },
    {
      label: 'API status',
      value: i.history !== undefined ? value(`Responding (last answer ${ago(i.nowMs, i.history.generatedAtMs)})`, { tone: 'ok' }) : i.historyError === true ? value('Not responding', { tone: 'bad' }) : NOT_AVAILABLE,
    },
    {
      label: 'Update frequency',
      value:
        f === undefined
          ? NOT_AVAILABLE
          : value(`The index follows the chain block by block. Perpl market context ${minutes(f.perplContextTtlMs)} at most; treasury scan ${minutes(f.treasuryScanIntervalMs)}; Hyperliquid and Binance funding ${minutes(f.venueFundingTtlMs)} at most, only while read.`),
    },
  ];
}

export const DISCLAIMER_FIELDS: readonly StatusField[] = [
  {
    label: 'Data accuracy',
    value: value('Every figure is derived from public on-chain events and Perpl’s public API, and can lag or be wrong. Each page shows how current its data is; check the source before relying on a number.'),
  },
  { label: 'Financial disclaimer', value: value('Nothing here is financial advice or an offer to trade. Past results do not predict returns. Leveraged perpetuals can lose more than a position’s margin.') },
  { label: 'Protocol affiliation', value: value('Unofficial analytics. Not affiliated with or endorsed by Perpl or the Monad Foundation.') },
  { label: 'Report an issue', value: value('Open an issue at github.com/0xMigzy/PerpGuard/issues') },
];

// ── methodology ─────────────────────────────────────────────────────────────

const ROLLING = value('Rolling: the last 24 hours, 7 days or 30 days, or All (since Feb 11, 2026)');
const WHOLE_DAYS = value('Whole UTC days from the window’s first day through today so far ("last 7 whole days + today"), or All');
const NOW = value('Now: a level, not a window');
const refreshCached = (f: InfrastructureFacts | undefined): FieldState =>
  f === undefined ? NOT_AVAILABLE : value(`Cached; refreshed behind the reader ${minutes(f.cacheTtlMs)} (default views ${minutes(f.warmIntervalMs)})`);

export function methodology(f: InfrastructureFacts | undefined): Record<MethodSectionId, readonly MetricMethod[]> {
  const cached = refreshCached(f);
  return {
    'trading-metrics': [
      {
        name: 'Trading volume',
        definition: value('The notional of every fill in the window, each match counted once.'),
        calculation: value('Sum of each fill’s notional (size × fill price, in AUSD). Whole UTC days inside the window come from per-day fill sums, the two partial edges are read fill by fill: the same rows as one scan.'),
        dataSource: value('Indexed fills (Trade) from the Perpl Exchange’s events'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts PostgresAnalytics.protocolMetrics → #windowTotals (WINDOW_TOTALS_SQL, DAY_TOTALS_SQL); windowSplit.ts',
      },
      {
        name: 'Open interest',
        definition: value('Open positions on ONE side of the book at the mark: every long lot is matched by a short lot, so one side is the open interest.'),
        calculation: value('Per market, open size × mark price from Perpl’s market state, summed across markets. The history chart is the index’s cumulative lots at each day’s close × that day’s close mark.'),
        dataSource: value('Perpl API (GET /v1/pub/context); history from the index'),
        timeWindow: NOW,
        refresh: f === undefined ? NOT_AVAILABLE : value(`Perpl context re-read ${minutes(f.perplContextTtlMs)} at most`),
        code: 'packages/shared/src/venues/perpl.ts toOpenInterest, PerplVenue.getOpenInterest; apps/web/src/lib/oiHistory.ts',
      },
      {
        name: 'Trades',
        definition: value('The number of fills in the window.'),
        calculation: value('A count of indexed fills, with the same whole-day and edge split as volume.'),
        dataSource: value('Indexed fills (Trade)'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts #windowTotals (WINDOW_TOTALS_SQL)',
      },
      {
        name: 'Active traders',
        definition: value('Distinct accounts with at least one fill, as maker or taker. An account trading three markets is one trader.'),
        calculation: value('Whole UTC days from the per-account day rows with a fill, the edges from the fills themselves, de-duplicated across both.'),
        dataSource: value('Indexed fills (Trade) and per-account days (TraderDay)'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts ACTIVE_TRADERS_SQL via #windowTotals',
      },
      {
        name: 'Funding rates',
        definition: value('The rate one side pays the other at each settlement. Positive means longs pay shorts. Perpl settles about every 43 minutes.'),
        calculation: value('Each settlement’s stored rate ÷ 1,000 = percent per settlement. Tables show the mean per settlement over the window and the latest; the heatmap averages per UTC day (per week at All). APR = the current rate × settlements a year, simple, not compounded, assuming the rate holds.'),
        dataSource: value('Indexed funding settlements (FundingEvent); the interval from the Perpl API, else measured'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts funding, fundingSeries; map.ts fundingUnitsToPct; apps/web/src/lib/funding.ts aprPct',
        modelled: 'APR is the current rate projected over a year, not a forecast.',
      },
      {
        name: 'Trading fees',
        definition: value('Maker plus taker fees paid on Perpl.'),
        calculation: value('The sum of each market’s daily fee total. Taker fees have no finer timestamp than the UTC day, so this is the only exact total. The rolling maker-only part is shown separately as maker fees.'),
        dataSource: value('Indexed per-market days (MarketDay)'),
        timeWindow: WHOLE_DAYS,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts #metricsOver (FEES_SQL), #fees',
      },
    ],
    'trader-metrics': [
      {
        name: 'Realised PnL',
        definition: value('Profit or loss locked in when a position is reduced or closed. Funding is kept separately.'),
        calculation: value('Summed from the account’s day rows; per round trip from the position. Computed by the indexer from the Exchange’s position events.'),
        dataSource: value('Indexed positions and per-account days (Position, TraderDay)'),
        timeWindow: WHOLE_DAYS,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts traderDays (TRADER_DAYS_SQL), roundTrips',
      },
      {
        name: 'Unrealised PnL',
        definition: value('The profit or loss an open position would realise at the current mark.'),
        calculation: value('side × size × (mark − entry), with side +1 for a long and −1 for a short.'),
        dataSource: value('Open positions (from the index on a public profile; from Perpl’s live account stream in the bot), priced at Perpl’s mark'),
        timeWindow: NOW,
        refresh: f === undefined ? NOT_AVAILABLE : value(`Marks from the Perpl context, ${minutes(f.perplContextTtlMs)} at most`),
        code: 'packages/shared/src/risk/liquidation.ts unrealizedPnlCNS; risk/metrics.ts positionMetrics',
      },
      {
        name: 'Net PnL',
        definition: value('Realised PnL plus funding, less trading fees (maker and taker).'),
        calculation: value('realised + funding − fees, one definition in the indexer, summed over the account’s UTC days. Round-trip results, win rate and profit factor are BEFORE fees and are labelled so.'),
        dataSource: value('Indexed per-account days (TraderDay)'),
        timeWindow: WHOLE_DAYS,
        refresh: cached,
        code: 'apps/indexer/src/lib/entities.ts netPnl; packages/shared/src/analytics/pg.ts TRADER_SOURCE_WINDOW',
      },
      {
        name: 'Profitable traders',
        definition: value('Accounts with at least one closed round trip whose net PnL (after fees and funding) is above zero.'),
        calculation: value('Counted among accounts with a fill in the window, over whole UTC days, shown as "x of y".'),
        dataSource: value('Indexed per-account days (TraderDay)'),
        timeWindow: WHOLE_DAYS,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts traderSummarySql',
      },
      {
        name: 'Average PnL',
        definition: unavailable('PerpGuard computes no average PnL. The trader summary computes a median net PnL (withheld under 10 traders), which no page shows today.'),
        calculation: NOT_AVAILABLE,
        dataSource: NOT_AVAILABLE,
        timeWindow: NOT_AVAILABLE,
        refresh: NOT_AVAILABLE,
        code: 'packages/shared/src/analytics/pg.ts traderSummarySql (median_pnl)',
      },
      {
        name: 'Trader rankings',
        definition: value('Top PnL and Top losses (net PnL, at least 10 round trips), Volume, Liquidated (accounts liquidated in the window) and Flows (largest net money in or out).'),
        calculation: value('Each board is one ordering of the per-account figures. Win rate and profit factor are withheld under 10 round trips. ROI is lifetime net PnL over lifetime deposits, withheld under 100 AUSD deposited.'),
        dataSource: value('Indexed per-account days and liquidations (TraderDay, Liquidation)'),
        timeWindow: value('Whole UTC days for P&L and flows; at 24H, volume, trades and liquidations are the rolling 24 hours'),
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts TRADER_RANKING, tradersSql, TRADER_SOURCE_24H',
      },
    ],
    'liquidation-metrics': [
      {
        name: 'Total liquidations',
        definition: value('Positions closed by the Exchange’s liquidation, in the window.'),
        calculation: value('A count of indexed liquidations.'),
        dataSource: value('Indexed liquidations (Liquidation)'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts LIQUIDATION_SQL via #metricsOver',
      },
      {
        name: 'Liquidation value',
        definition: value('The notional liquidated: each liquidation’s size × its execution price, summed.'),
        calculation: value('Sum of each liquidation’s notional. Margin lost (the drop in the position’s deposit) is shown per row and is not a loss of money: part of it is credited back to the account.'),
        dataSource: value('Indexed liquidations (Liquidation)'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts LIQUIDATION_SQL (notional); apps/indexer/src/handlers/liquidations.ts',
      },
      {
        name: 'Preventable liquidations',
        definition: value('"Rescuable": the trader’s free AUSD at the moment of liquidation would have covered the top-up that kept the position above maintenance margin.'),
        calculation: value('Free balance before ≥ margin to survive > 0, where margin to survive is the collateral that would have kept the position exactly at maintenance at the mark it was liquidated at. A position whose entry price the index never saw cannot be judged and is excluded from the denominator.'),
        dataSource: value('Indexed liquidations and the account’s free balance'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'apps/indexer/src/handlers/liquidations.ts (wasRescuable); packages/shared/src/risk/liquidation.ts marginToSurviveCNS',
        modelled: 'A counterfactual: it assumes the trader would have added the margin in time.',
      },
      {
        name: 'Preventable value',
        definition: value('"Potentially avoidable losses": the realised loss (P&L plus funding) of the rescuable liquidations.'),
        calculation: value('Summed once per event; trading and liquidation fees are left out, so it understates. A top-up keeps the position open; it does not undo the price move.'),
        dataSource: value('Indexed liquidations (Liquidation)'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts LIQUIDATION_SQL (rescuable_loss)',
        modelled: 'A counterfactual over the rescuable set.',
      },
      {
        name: 'Liquidation thresholds',
        definition: value('The mark at which a position is liquidated: where its margin falls to the market’s maintenance requirement. Perpl margin is isolated, per position.'),
        calculation: value('Maintenance = entry price × size ÷ the market’s maintenance leverage; liquidation price = entry + side × (maintenance − deposit − funding) ÷ size.'),
        dataSource: value('Positions (index or Perpl API); maintenance margin per market from the Perpl API'),
        timeWindow: NOW,
        refresh: f === undefined ? NOT_AVAILABLE : value(`Market parameters re-read ${minutes(f.perplContextTtlMs)} at most`),
        code: 'packages/shared/src/risk/liquidation.ts maintenanceMarginCNS, liquidationPricePNS',
      },
    ],
    'risk-methodology': [
      {
        name: 'Long/short exposure',
        definition: value('The long side’s share of the isolated margin open on a market, with the number of positions on each side beside it. Never notional: on an order book open size is equal on both sides by construction.'),
        calculation: value('Long margin ÷ (long + short margin), over the index’s open positions.'),
        dataSource: value('Indexed open positions (Position)'),
        timeWindow: NOW,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts MARKET_BREAKDOWN_SQL (long_margin, short_margin)',
      },
      {
        name: 'Liquidation ladder',
        definition: value('Every open position re-priced at each step from −50% to +50% of the mark, in 0.5% steps, and counted as liquidated when it is then past maintenance.'),
        calculation: value('The risk engine’s own position maths applied at the shocked mark, once per position per rung. A fall closes longs and a rise closes shorts; no figure adds the two.'),
        dataSource: value('Indexed open positions, priced with Perpl marks and margin parameters; insurance balances from the contract'),
        timeWindow: NOW,
        refresh: f === undefined ? NOT_AVAILABLE : value(`Snapshot reused for ${formatAge(f.riskSnapshotTtlMs)}`),
        code: 'packages/shared/src/analytics/exposure.ts buildRiskSnapshot, LADDER_MOVES',
        modelled: 'A static price shock.',
      },
      {
        name: 'Stress test',
        definition: value('The ladder’s ±5% and ±10% rungs: positions, notional and loss beyond collateral each move would liquidate, one direction at a time.'),
        calculation: value('Read off the same ladder. "All markets" assumes every market moves together, the worst case rather than the likely one.'),
        dataSource: value('As the ladder'),
        timeWindow: NOW,
        refresh: f === undefined ? NOT_AVAILABLE : value(`Snapshot reused for ${formatAge(f.riskSnapshotTtlMs)}`),
        code: 'packages/shared/src/analytics/exposure.ts buildRiskSnapshot',
        modelled: 'A static shock; it does not model the path, funding, keeper timing or the book.',
      },
      {
        name: 'Positions at risk',
        definition: value('Each open position with the least adverse move that liquidates it; the largest exposed are listed.'),
        calculation: value('The first rung, in the position’s adverse direction, at which it is past maintenance.'),
        dataSource: value('As the ladder'),
        timeWindow: NOW,
        refresh: f === undefined ? NOT_AVAILABLE : value(`Snapshot reused for ${formatAge(f.riskSnapshotTtlMs)}`),
        code: 'packages/shared/src/analytics/exposure.ts buildRiskSnapshot (positions)',
      },
      {
        name: 'Price impact assumptions',
        definition: unavailable('Not modelled. The index has no order book, so no figure estimates slippage or whether the book could absorb a liquidation; every Risk figure is exposure, not realised loss.'),
        calculation: NOT_AVAILABLE,
        dataSource: NOT_AVAILABLE,
        timeWindow: NOT_AVAILABLE,
        refresh: NOT_AVAILABLE,
        code: 'packages/shared/src/analytics/exposure.ts RISK_STATEMENTS',
      },
    ],
    'capital-flow': [
      {
        name: 'Deposits',
        definition: value('AUSD deposited into Perpl accounts in the window.'),
        calculation: value('Sum and count of indexed deposits.'),
        dataSource: value('Indexed collateral flows (CollateralFlow)'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts COLLATERAL_FLOW_SQL via #metricsOver',
      },
      {
        name: 'Withdrawals',
        definition: value('AUSD withdrawn from Perpl accounts in the window.'),
        calculation: value('Sum and count of indexed withdrawals.'),
        dataSource: value('Indexed collateral flows (CollateralFlow)'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts COLLATERAL_FLOW_SQL',
      },
      {
        name: 'Net capital flow',
        definition: value('Deposits minus withdrawals. Not a change in balance, which also moves on P&L, funding, fees and liquidations.'),
        calculation: value('deposited − withdrawn over the same rows.'),
        dataSource: value('Indexed collateral flows (CollateralFlow)'),
        timeWindow: ROLLING,
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts #flowStats',
      },
      {
        name: 'Unique accounts',
        definition: value('Perpl accounts opened since launch.'),
        calculation: value('Accounts counted by the month they were created, summed.'),
        dataSource: value('Indexed accounts (Trader.createdAt)'),
        timeWindow: value('All: since Feb 11, 2026'),
        refresh: cached,
        code: 'packages/shared/src/analytics/pg.ts HISTORY_ACCOUNTS_SQL via history()',
      },
      {
        name: 'Since-launch totals',
        definition: value('Volume, trades, deposits, withdrawals and liquidations from the Exchange’s deployment to now; and the exchange balance rebuilt forward from launch.'),
        calculation: value('The All window of the same queries. The balance is indexed deposits − withdrawals + the protocol treasury’s own deposits − withdrawals, reconciled against the contract at one block.'),
        dataSource: value('The index, and a scan of the treasury’s own events over the RPC'),
        timeWindow: value('All: since Feb 11, 2026'),
        refresh: f === undefined ? NOT_AVAILABLE : value(`Recomputed ${minutes(f.warmIntervalMs)}; treasury scanned ${minutes(f.treasuryScanIntervalMs)}`),
        code: 'packages/shared/src/analytics/pg.ts protocolMetrics("all"); apps/backend/src/exchangeBalance/treasuryScanner.ts',
      },
    ],
  };
}

/** For fields this page will not compute: they would need a new query or new indexing. */
export const AWAITING = awaiting;
