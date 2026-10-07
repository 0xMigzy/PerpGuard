/**
 * HOW MANY PERPL CONNECTIONS DOES THIS BOX GET? (7 Oct 2026)
 *
 *   pnpm probe:connections                 # all phases, testnet
 *   pnpm probe:connections --phase md      # one phase: md | trading | mixed
 *
 * Perpl's WebSocket docs say "~5 connections per IP (market-data and trading
 * combined)". That figure sets how many linked accounts one PerpGuard instance
 * can hold, so it is measured here rather than trusted:
 *
 *   md       public market-data sockets, NO key: does the limit exist per IP?
 *   trading  signed-in trading sockets, all on ONE key: does it bind a key?
 *   mixed    market data and trading together: is it one combined budget?
 *
 * Each phase opens sockets one at a time, a few seconds apart, keeps every one
 * alive with the protocol's own ping, and then HOLDS them all, recording for
 * each socket whether it opened, whether data flowed, and when and how it
 * closed. A connection the server will not keep shows up as refused at the
 * upgrade or closed soon after; the report names which, with the code.
 *
 * RUN WITH THE BACKEND STOPPED. Its own sockets count against the same limit,
 * and going over could drop them. Testnet only. Sends no orders.
 */
import { parseArgs } from 'node:util';
import { loadNetworkConfig, loadPerplCredentials, PerplVenue } from '@perpguard/shared';

const { values } = parseArgs({
  options: {
    phase: { type: 'string', default: 'all' },
    max: { type: 'string', default: '8' },
    spacing: { type: 'string', default: '3000' },
    hold: { type: 'string', default: '75000' },
  },
});
const MAX = Number(values.max);
const SPACING = Number(values.spacing);
const HOLD = Number(values.hold);

const network = loadNetworkConfig('testnet', process.env);
if (network.chainId !== 10143) throw new Error('testnet only');
const t0 = Date.now();
const at = (): string => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (line: string): void => console.log(`[${at()}] ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Probe {
  readonly label: string;
  openedAt?: string;
  firstDataAt?: string;
  frames: number;
  closedAt?: string;
  closeHow?: string;
  stop: () => void;
}

/** A raw public market-data socket: subscribe to heartbeats, ping every 15 s. */
function openMarketData(n: number): Probe {
  const p: Probe = { label: `md#${n}`, frames: 0, stop: () => {} };
  const ws = new WebSocket(network.marketDataWsUrl);
  let ping: ReturnType<typeof setInterval> | undefined;
  ws.addEventListener('open', () => {
    p.openedAt = at();
    ws.send(JSON.stringify({ mt: 5, subs: [{ stream: `heartbeat@${network.chainId}`, subscribe: true }] }));
    ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ mt: 1, t: Date.now() })), 15_000);
    log(`${p.label} open`);
  });
  ws.addEventListener('message', () => {
    p.frames += 1;
    p.firstDataAt ??= at();
  });
  ws.addEventListener('error', (e) => {
    p.closeHow ??= `error before/at open: ${(e as Event & { message?: string }).message ?? "no message"}`;
  });
  ws.addEventListener('close', (e) => {
    if (ping) clearInterval(ping);
    p.closedAt = at();
    p.closeHow = `close code ${e.code}${e.reason ? ` "${e.reason}"` : ''}${p.openedAt === undefined ? ' (never opened)' : ''}`;
    log(`${p.label} CLOSED: ${p.closeHow} after ${p.frames} frame(s)`);
  });
  p.stop = () => ws.close();
  return p;
}

/** A raw connection to the TRADING endpoint that never signs in: does the limit count connections, or signed-in keys? */
function openRawTrading(n: number): Probe {
  const p: Probe = { label: `raw#${n}`, frames: 0, stop: () => {} };
  const ws = new WebSocket(network.tradingWsUrl);
  let ping: ReturnType<typeof setInterval> | undefined;
  ws.addEventListener('open', () => {
    p.openedAt = at();
    ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ mt: 1, t: Date.now() })), 10_000);
  });
  ws.addEventListener('message', () => {
    p.frames += 1;
    p.firstDataAt ??= at();
  });
  ws.addEventListener('close', (e) => {
    if (ping) clearInterval(ping);
    p.closedAt = at();
    p.closeHow = `close code ${e.code}${e.reason ? ` "${e.reason}"` : ''}${p.openedAt === undefined ? ' (never opened)' : ''}`;
    log(`${p.label} CLOSED: ${p.closeHow}`);
  });
  p.stop = () => ws.close();
  return p;
}

/** A signed-in trading socket on the environment key, through the venue's own sign-in. */
function openTrading(n: number, credentials: ReturnType<typeof loadPerplCredentials>): Probe {
  const p: Probe = { label: `trading#${n}`, frames: 0, stop: () => {} };
  const venue = new PerplVenue(network, { credentials, logger: { log: () => {}, warn: () => {} } });
  void venue
    .connectTrading()
    .then((socket) => {
      p.openedAt = at();
      log(`${p.label} signed in as account ${socket.accountId}`);
      socket.onMessage(() => {
        p.frames += 1;
        p.firstDataAt ??= at();
      });
      socket.onClose((error) => {
        p.closedAt = at();
        p.closeHow = error.message;
        log(`${p.label} CLOSED: ${error.message} after ${p.frames} frame(s)`);
      });
      p.stop = () => venue.disconnect();
    })
    .catch((error: unknown) => {
      p.closedAt = at();
      p.closeHow = `sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
      log(`${p.label} ${p.closeHow}`);
    });
  return p;
}

async function phase(name: string, open: (i: number) => Probe, count: number): Promise<void> {
  console.log(`\n── phase ${name}: ${count} connection(s), ${SPACING} ms apart, then held ${HOLD / 1000} s ──`);
  const probes: Probe[] = [];
  for (let i = 1; i <= count; i++) {
    probes.push(open(i));
    await sleep(SPACING);
  }
  // Hold, and report data flow halfway: a socket that is open but silent is not a working socket.
  await sleep(HOLD / 2);
  const before = probes.map((p) => p.frames);
  await sleep(HOLD / 2);
  console.log(`\n${name}: result`);
  for (const [i, p] of probes.entries()) {
    const flowing = p.closedAt === undefined && (p.frames > before[i]! || p.label.startsWith('raw'));
    console.log(
      `  ${p.label.padEnd(11)} opened ${p.openedAt ?? 'NEVER'}  frames ${String(p.frames).padStart(5)}  ` +
        `${p.closedAt === undefined ? (flowing ? 'ALIVE, data flowing' : 'open but SILENT in the second half') : `closed ${p.closedAt}: ${p.closeHow}`}`,
    );
  }
  const alive = probes.filter((p, i) => p.closedAt === undefined && (p.frames > before[i]! || p.label.startsWith('raw'))).length;
  console.log(`  => ${alive} of ${count} alive and flowing at the end`);
  for (const p of probes) p.stop();
  await sleep(5_000);
}

const which = values.phase;
if (which === 'all' || which === 'md') await phase('md (public, no key)', openMarketData, MAX);
if (which === 'all' || which === 'trading') {
  const credentials = loadPerplCredentials(process.env);
  await phase('trading (signed in, one key)', (i) => openTrading(i, credentials), MAX);
}
if (which === 'all' || which === 'mixed') {
  const credentials = loadPerplCredentials(process.env);
  await phase('mixed (3 md, then trading)', (i) => (i <= 3 ? openMarketData(i) : openTrading(i, credentials)), Math.min(MAX, 7));
}
if (which === 'keyfull') {
  // Fill the key first (signed-in sockets until refused), keep them, then try raw unsigned connections on top.
  const credentials = loadPerplCredentials(process.env);
  const held: Probe[] = [];
  for (let i = 1; i <= MAX; i++) {
    held.push(openTrading(i, credentials));
    await sleep(SPACING);
  }
  await sleep(5_000);
  const signedIn = held.filter((h) => h.openedAt !== undefined && h.closedAt === undefined).length;
  console.log(`\nkey filled: ${signedIn} of ${MAX} signed-in sockets alive; ${held.filter((h) => /too many/.test(h.closeHow ?? '')).length} refused with "too many"`);
  await phase('raw unsigned trading-endpoint connections, ON TOP of the full key', openRawTrading, 8);
  console.log(`signed-in sockets still alive after the raw phase: ${held.filter((h) => h.openedAt !== undefined && h.closedAt === undefined).length}`);
  for (const h of held) h.stop();
  await sleep(3_000);
}
process.exit(0);
