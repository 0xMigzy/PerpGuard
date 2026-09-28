/**
 * Discover the Perpl `Position` wire shape, by opening one on testnet.
 *
 *   pnpm positions:probe                 # read-only: dump whatever is there
 *   pnpm positions:probe --open          # open 1 unit, capture, leave it open
 *   pnpm positions:probe --open --close  # open, capture, close, capture again
 *
 * WHY THIS EXISTS. `Position` is the one wire object Perpl does not document.
 * types-and-errors.md says the full shapes are "documented alongside the
 * endpoints that return them"; rest.md and websocket.md both say see Types.
 * The reference is circular, the Rust SDK is not published, and the TypeScript
 * docs type position history as `any[]`. CLAUDE.md forbids guessing field
 * names, so the wire is the only source of truth left — and an account with no
 * position receives `mt: 26` with `d: []`, which teaches nothing. Hence a real
 * position, at the smallest size the market can represent.
 *
 * This is the same discovery pattern as perpl-account-scan.ts: report every
 * field with the path it was found at, rather than asserting a shape and
 * silently reading undefined when it is wrong.
 *
 * SAFETY. Testnet only — it refuses to run against mainnet. One size unit
 * (0.00001 BTC, under a dollar of notional). It prints every frame it sends.
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  MT,
  PerplTradingSocket,
  buildClosePositionFrame,
  buildMarketOrderFrame,
  computeLastExecBlock,
  loadNetworkConfig,
  loadPerplCredentials,
  maskApiKey,
  type VenueMarket,
} from '@perpguard/shared';
import { PerplVenue } from '@perpguard/shared';

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', default: 'BTC' },
    /** Size in whole size units of the market. 1 is the exchange minimum. */
    units: { type: 'string', default: '1' },
    side: { type: 'string', default: 'long' },
    leverage: { type: 'string', default: '2' },
    open: { type: 'boolean', default: false },
    close: { type: 'boolean', default: false },
    /** Seconds to listen after each action. */
    listen: { type: 'string', default: '12' },
    out: { type: 'string', default: 'fixtures/positions-testnet.json' },
  },
});

const symbol = values.symbol.toUpperCase();
const side = values.side === 'short' ? 'short' : 'long';
const units = Number(values.units);
const leverage = Number(values.leverage);
const listenMs = Number(values.listen) * 1000;

// Never mainnet. The whole point is that this opens a real position.
const network = loadNetworkConfig('testnet', process.env);
if (network.chainId !== 10143) {
  console.error(`refusing to run against chain ${network.chainId}; this script is testnet only`);
  process.exit(1);
}

const credentials = loadPerplCredentials(process.env);
console.log(`Perpl testnet (chain ${network.chainId}), key ${maskApiKey(credentials.apiKey)}`);

const venue = new PerplVenue(network, { credentials });
const markets = await venue.getMarkets();
const market = markets.find((m) => m.symbol === symbol);
if (market === undefined) {
  console.error(`${symbol} is not listed on testnet. Available: ${markets.map((m) => m.symbol).join(', ')}`);
  process.exit(1);
}

const sizeScaled = units;
const humanSize = units / 10 ** market.sizeDecimals;
console.log(
  `${market.displayName} (market ${market.marketId}), sizeDecimals ${market.sizeDecimals} -> ` +
    `${sizeScaled} unit(s) = ${humanSize} ${symbol}, ttl ${market.orderTtlBlocks} blocks`,
);

const socket = new PerplTradingSocket({
  network,
  apiKey: credentials.apiKey,
  secret: credentials.secret,
});

/** Every frame worth keeping, in arrival order. */
const captured: Array<{ at: string; label: string; frame: unknown }> = [];
let label = 'sign-in';

socket.onMessage((message) => {
  const mt = message['mt'];
  if (mt !== MT.PositionsSnapshot && mt !== MT.PositionsUpdate) return;
  captured.push({ at: new Date().toISOString(), label, frame: message });
  console.log(`\n--- mt ${mt} (${mt === MT.PositionsSnapshot ? 'PositionsSnapshot' : 'PositionsUpdate'}) during ${label} ---`);
  console.log(JSON.stringify(message, null, 2));
});

await socket.connect();
console.log(`signed in: account ${socket.accountId}, fw ${socket.forwardingAllowed}, frozen ${socket.accountFrozen}`);
if (socket.accountId === undefined) {
  console.error('no account id on this key; nothing to do');
  process.exit(1);
}
const accountId = socket.accountId;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
await wait(3000);

/** Head block for `lb`, from the heartbeat once one has arrived. */
async function lastExecBlock(m: VenueMarket): Promise<number> {
  for (let i = 0; i < 20 && socket.headBlock === undefined; i += 1) await wait(500);
  const head = socket.headBlock;
  if (head === undefined) throw new Error('no heartbeat, so no head block for lb');
  return computeLastExecBlock(head, m.orderTtlBlocks, 2);
}

if (values.open) {
  label = 'open';
  const frame = buildMarketOrderFrame({
    sn: socket.nextSequenceNumber(),
    rq: socket.reserveRequestId(),
    marketId: market.marketId,
    accountId,
    side,
    sizeScaled,
    leverageHundredths: Math.round(leverage * 100),
    lastExecBlock: await lastExecBlock(market),
  });
  console.log(`\nsending OPEN: ${JSON.stringify(frame)}`);
  const result = await socket.submit({
    frame,
    intent: 'place',
    idempotencyKey: `probe-open-${Date.now()}`,
    // A market order's outcome is its own fill. Correlate on the request id,
    // which the Order carries as `rq`.
    matches: (order) => order['rq'] === frame.rq,
  });
  console.log(`OPEN outcome: ${result.outcome} — ${result.reason}`);
  await wait(listenMs);
}

/**
 * The position this run is responsible for, read out of whatever the socket
 * last said. Deliberately tolerant: the field names are exactly what this
 * script exists to discover, so it looks for a position id under any plausible
 * key and reports what it found rather than assuming one.
 */
function findPosition(): Record<string, unknown> | undefined {
  for (let i = captured.length - 1; i >= 0; i -= 1) {
    const entry = captured[i];
    const d = (entry?.frame as Record<string, unknown> | undefined)?.['d'];
    if (!Array.isArray(d)) continue;
    for (const row of d) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Record<string, unknown>;
      if (r['mkt'] === market?.marketId || r['perpId'] === market?.marketId) return r;
      return r;
    }
  }
  return undefined;
}

if (values.close) {
  label = 'close';
  const position = findPosition();
  if (position === undefined) {
    console.error('\nno position seen, so nothing to close. Leaving the account as it is.');
  } else {
    console.log(`\nclosing position: ${JSON.stringify(position)}`);
    const positionId = pickPositionId(position);
    const size = pickSize(position);
    if (positionId === undefined || size === undefined) {
      console.error(
        'could not read a position id (lp) or a size off the position. ' +
          'Close it by hand at https://testnet.perpl.xyz and record the shape above.',
      );
    } else {
      const frame = buildClosePositionFrame({
        sn: socket.nextSequenceNumber(),
        rq: socket.reserveRequestId(),
        marketId: market.marketId,
        accountId,
        positionSide: side,
        positionId,
        sizeScaled: size,
        lastExecBlock: await lastExecBlock(market),
      });
      console.log(`sending CLOSE: ${JSON.stringify(frame)}`);
      const result = await socket.submit({
        frame,
        intent: 'place',
        idempotencyKey: `probe-close-${Date.now()}`,
        matches: (order) => order['rq'] === frame.rq,
      });
      console.log(`CLOSE outcome: ${result.outcome} — ${result.reason}`);
      await wait(listenMs);
    }
  }
}

/** Candidate position id: `id` is the documented PositionID name. */
function pickPositionId(row: Record<string, unknown>): number | undefined {
  for (const key of ['id', 'pid', 'posId', 'lp']) {
    const value = row[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** Candidate scaled size. */
function pickSize(row: Record<string, unknown>): number | undefined {
  for (const key of ['s', 'lot', 'sz', 'size']) {
    const value = row[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

socket.close();

// ── report ───────────────────────────────────────────────────────────────────

console.log('\n════════ every field seen on a Position, with its path ════════');
const fields = new Map<string, Set<string>>();
for (const entry of captured) {
  const d = (entry.frame as Record<string, unknown>)['d'];
  if (!Array.isArray(d)) continue;
  for (const row of d) {
    if (typeof row !== 'object' || row === null) continue;
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      const seen = fields.get(key) ?? new Set<string>();
      seen.add(`${typeof value}=${JSON.stringify(value)}`);
      fields.set(key, seen);
    }
  }
}
if (fields.size === 0) {
  console.log('none — every mt 26/27 arrived with an empty `d`. Re-run with --open.');
} else {
  for (const [key, values_] of [...fields.entries()].sort()) {
    console.log(`  ${key.padEnd(8)} ${[...values_].join('  |  ')}`);
  }
}

writeFileSync(
  values.out,
  `${JSON.stringify(
    {
      _source: 'scripts/probePositions.ts against Perpl testnet',
      _captured: new Date().toISOString(),
      _network: { name: network.name, chainId: network.chainId },
      _account: accountId,
      _market: {
        marketId: market.marketId,
        symbol: market.symbol,
        priceDecimals: market.priceDecimals,
        sizeDecimals: market.sizeDecimals,
      },
      frames: captured,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwrote ${captured.length} frame(s) to ${values.out}`);
