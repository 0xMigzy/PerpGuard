/**
 * Prints every Perpl market with its id and scaling, for both networks.
 *
 *   pnpm markets
 *
 * This is the Day 1 acceptance check: it proves config loads, the context
 * endpoint parses, and — by showing the same asset with a different id and
 * sometimes different scaling on each network — why neither may ever be
 * hard-coded.
 */
import {
  NETWORKS,
  PerplVenue,
  loadNetworkConfig,
  maintenanceMarginRatioFromConfig,
  microsToBps,
  priceFromRaw,
  type NetworkName,
  type VenueMarket,
} from '@perpguard/shared';

interface Row {
  readonly market: VenueMarket;
  /** Mark price descaled with this market's own priceDecimals. */
  readonly markPrice: number;
}

const COLUMNS = [
  ['id', 5],
  ['inst', 5],
  ['symbol', 7],
  ['display', 10],
  ['pdec', 5],
  ['sdec', 5],
  ['mark', 14],
  ['maxLev', 7],
  ['mmr', 7],
  ['makerBp', 8],
  ['takerBp', 8],
  ['fund', 6],
  ['open', 5],
] as const satisfies ReadonlyArray<readonly [string, number]>;

function pad(value: string, width: number, align: 'left' | 'right' = 'right'): string {
  return align === 'left' ? value.padEnd(width) : value.padStart(width);
}

function header(): string {
  return COLUMNS.map(([name, width], i) => pad(name, width, i === 2 || i === 3 ? 'left' : 'right')).join('  ');
}

function formatRow({ market, markPrice }: Row): string {
  const cells: string[] = [
    String(market.marketId),
    String(market.instanceId),
    market.symbol,
    market.displayName,
    String(market.priceDecimals),
    String(market.sizeDecimals),
    // Deliberately printed at the market's own precision, to show the scaling
    // round-trip rather than a fixed number of places.
    markPrice.toFixed(market.priceDecimals),
    `${market.maxLeverage}x`,
    `${(market.maintenanceMarginRatio * 100).toFixed(2)}%`,
    microsToBps(market.makerFeeMicros).toFixed(2),
    microsToBps(market.takerFeeMicros).toFixed(2),
    `${Math.round(market.fundingIntervalSec / 60)}m`,
    market.isOpen ? 'yes' : 'NO',
  ];
  return cells
    .map((cell, i) => pad(cell, COLUMNS[i]![1], i === 2 || i === 3 ? 'left' : 'right'))
    .join('  ');
}

async function loadRows(network: NetworkName): Promise<{ rows: Row[]; restBaseUrl: string; chainId: number; collateral: string }> {
  const config = loadNetworkConfig(network, process.env);
  const venue = new PerplVenue(config);

  // One context fetch serves both the markets and the mark prices below.
  const [markets, context, collateralToken] = await Promise.all([
    venue.getMarkets(),
    venue.getContext(),
    venue.getCollateralToken(),
  ]);

  const stateById = new Map(context.markets.map((m) => [m.id, m.state]));
  const rows = markets
    .map((market) => {
      const state = stateById.get(market.marketId);
      return {
        market,
        markPrice: state === undefined ? Number.NaN : priceFromRaw(state.mrk, market),
      };
    })
    .sort((a, b) => a.market.symbol.localeCompare(b.market.symbol));

  return {
    rows,
    restBaseUrl: config.restBaseUrl,
    chainId: config.chainId,
    collateral: `${collateralToken.symbol} (${collateralToken.decimals} decimals) ${collateralToken.address}`,
  };
}

function printCrossNetwork(byNetwork: Map<NetworkName, Row[]>): void {
  const [first, second] = NETWORKS;
  const a = byNetwork.get(first) ?? [];
  const b = byNetwork.get(second) ?? [];
  const bBySymbol = new Map(b.map((row) => [row.market.symbol, row.market]));

  const shared = a
    .map((row) => ({ left: row.market, right: bBySymbol.get(row.market.symbol) }))
    .filter((pair): pair is { left: VenueMarket; right: VenueMarket } => pair.right !== undefined);

  console.log(`\nSame asset, both networks (${first} vs ${second})`);
  console.log(
    `  ${pad('symbol', 7, 'left')}  ${pad('id', 11)}  ${pad('instance', 10)}  ${pad('pdec', 8)}  ${pad('sdec', 8)}  name`,
  );
  for (const { left, right } of shared) {
    const idCell = `${left.marketId} -> ${right.marketId}`;
    const instCell = `${left.instanceId} -> ${right.instanceId}`;
    const pdecCell = `${left.priceDecimals} -> ${right.priceDecimals}`;
    const sdecCell = `${left.sizeDecimals} -> ${right.sizeDecimals}`;
    const flags: string[] = [];
    if (left.marketId !== right.marketId) flags.push('id differs');
    if (left.priceDecimals !== right.priceDecimals) flags.push('price scaling differs');
    if (left.sizeDecimals !== right.sizeDecimals) flags.push('size scaling differs');
    console.log(
      `  ${pad(left.symbol, 7, 'left')}  ${pad(idCell, 11)}  ${pad(instCell, 10)}  ${pad(pdecCell, 8)}  ${pad(sdecCell, 8)}  ` +
        `${left.displayName} / ${right.displayName}${flags.length > 0 ? `  <- ${flags.join(', ')}` : ''}`,
    );
  }

  const onlyOn = (from: Row[], other: Map<string, VenueMarket>): string[] =>
    from.map((r) => r.market.symbol).filter((s) => !other.has(s));
  const aBySymbol = new Map(a.map((row) => [row.market.symbol, row.market]));
  const mainOnly = onlyOn(a, bBySymbol);
  const testOnly = onlyOn(b, aBySymbol);
  if (mainOnly.length > 0) console.log(`  ${first} only: ${mainOnly.join(', ')}`);
  if (testOnly.length > 0) console.log(`  ${second} only: ${testOnly.join(', ')}`);
}

async function main(): Promise<void> {
  const byNetwork = new Map<NetworkName, Row[]>();

  for (const network of NETWORKS) {
    const { rows, restBaseUrl, chainId, collateral } = await loadRows(network);
    byNetwork.set(network, rows);

    console.log(`\n=== ${network} — chain ${chainId} — ${restBaseUrl} ===`);
    console.log(`collateral: ${collateral}`);
    console.log(`${rows.length} markets, all fields below read from GET /v1/pub/context\n`);
    console.log(header());
    for (const row of rows) console.log(formatRow(row));
  }

  printCrossNetwork(byNetwork);

  // The maintenance margin ratio is decoded, not read directly. Restate the
  // derivation so a reader can check it against the venue UI.
  console.log(
    `\nmmr is derived: maintenance_margin 2500 -> 100/2500 = ${(maintenanceMarginRatioFromConfig(2500) * 100).toFixed(2)}% ` +
      `(matches fixtures/position1.json for BTC)`,
  );
}

await main();
