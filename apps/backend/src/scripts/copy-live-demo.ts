/**
 * COPY TRADING end to end on TESTNET, with a SYNTHETIC leader.
 *
 *   pnpm copy:live-demo        # backend STOPPED: one key, colliding request ids
 *
 * The real copier (engine, decide, executor, reconciliation) against the
 * environment account's real testnet session. The leader is a script: it
 * "opens" MON long and HYPE (not on testnet), then "closes" MON, so the run
 * shows a copied open verified from the position list, a skip by name, and a
 * copied close. MOVES REAL TESTNET COLLATERAL (a few MON at 2x).
 *
 * THE RULE LIVES IN AN IN-MEMORY STORE (owner, 7 Oct 2026: test rules go on a
 * test database), so nothing it arms outlives the script. Refuses to run if
 * the account already holds MON.
 */
import { PerplVenue, loadAppConfig, loadNetworkConfig, loadPerplCredentials, type CopySourcePosition } from '@perpguard/shared';
import { InMemoryActionLog } from '../actions/index.ts';
import { InMemoryAlertLog } from '../alerts/log.pg.ts';
import { MarketFeed } from '../ingest/marketFeed.ts';
import { InMemoryAutomationStore } from '../rescue/automation.ts';
import { AccountRegistry } from '../sessions/registry.ts';
import { CopyArmSigner } from '../copy/live/arming.ts';
import { CopyControlService } from '../copy/live/control.ts';
import { CopyEngine, type CopyNotice } from '../copy/live/engine.ts';
import { renderCopy } from '../copy/live/render.ts';
import { InMemoryCopyStore } from '../copy/live/store.ts';

const env = process.env as Record<string, string | undefined>;
const app = loadAppConfig(env);
const network = loadNetworkConfig(app.trading.name, env);
if (network.chainId !== 10143) throw new Error('testnet only');
const credentials = loadPerplCredentials(env);
const accountId = credentials.accountId;
if (accountId === undefined) throw new Error('PERPL_ACCOUNT_ID is required');
const key = env['PERPGUARD_KEY_ENCRYPTION_KEY'];
if (key === undefined) throw new Error('PERPGUARD_KEY_ENCRYPTION_KEY is required to sign the test rule');
const t0 = Date.now();
const say = (line: string): void => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const venue = new PerplVenue(network, {});
const markets = await venue.getMarkets();
const feed = new MarketFeed(network.name, app.staleMs);
const unsubscribe = await venue.subscribePrices(markets.map((m) => m.symbol), (u) => feed.record(u));
const registry = new AccountRegistry({
  deps: {
    network,
    markets,
    riskConfigs: await venue.getRiskConfigs(),
    feed,
    feedStatus: () => venue.feedStatus(),
    actionLog: new InMemoryActionLog(),
    alertLog: new InMemoryAlertLog(),
    transport: { send: async () => ({ ok: true }) },
    recipients: () => [],
    venueFactory: (c) => new PerplVenue(network, { credentials: c }),
    evaluateIntervalMs: 1_000,
    logger: { info: () => undefined, warn: (m) => say(`  WARN ${m}`) },
  },
});
const opened = registry.open(accountId, { apiKey: credentials.apiKey, secret: credentials.secret });
if (!opened.ok) throw new Error(opened.reason);
const session = opened.session;
for (let i = 0; i < 80 && !(session.positionSource.status().state === 'live' && venue.feedStatus().state === 'connected' && session.balance.freeBalance().known); i += 1) await wait(500);
await wait(2_000);
const mon = markets.find((m) => m.symbol === 'MON')!;
if (session.positionSource.snapshot().some((p) => p.marketId === mon.marketId)) throw new Error('account already holds MON; pick a moment it does not');
const mark = feed.get(mon.marketId)?.markPrice;
if (mark === undefined) throw new Error('no MON mark');
const free = session.balance.freeBalance();
say(`account ${accountId}: free floor ${free.known ? free.floorCNS : '?'}; MON mark ${mark}; positions ${session.positionSource.snapshot().length}`);

const store = new InMemoryCopyStore();
const automation = new InMemoryAutomationStore();
const signer = new CopyArmSigner(key);
const notices: CopyNotice[] = [];
let engine!: CopyEngine;
const control = new CopyControlService({
  store,
  automation,
  signer,
  isLinked: () => true,
  verifyLeader: async () => ({ ok: true, text: '' }),
  positions: () => session.positionSource.snapshot().map((p) => ({ marketId: p.marketId, positionId: p.positionId, side: p.side })),
  busy: (id) => engine.busy(id),
  collateralDecimals: 6,
});

// The synthetic leader: equity sized so the copy comes to about 5 MON.
const equityNow = (free.known ? free.floorCNS : 0n) + session.view.snapshot().reduce((a, x) => a + (x.marginCNS ?? 0n), 0n);
const leaderEquityCNS = equityNow * 10n;
const leaderLots = 50n; // 50 MON for the leader -> 5 MON for the copy at a 1/10 share
const priceDecimals = 4;
const entry = BigInt(Math.round(mark * 10 ** priceDecimals));
const start = Date.now();
const leaderPos = (key: string, symbol: string, status: 'open' | 'closed'): CopySourcePosition => ({
  key, market: { marketId: symbol === 'MON' ? 9001 : 9002, symbol, indexerName: symbol }, side: 'long', status, lotDecimals: 0, priceDecimals,
  peakLotLNS: leaderLots, lotLNS: status === 'open' ? leaderLots : 0n, entryPricePNS: entry, peakMarginCNS: 1n, netPnlCNS: 0n, leverageHdths: 200n,
  openedAtMs: start + 1_000, closedAtMs: status === 'closed' ? Date.now() : undefined,
});
const leader: { positions: CopySourcePosition[] } = { positions: [] };

engine = new CopyEngine({
  store,
  automation,
  armProblem: (rule) => control.armProblem(rule),
  account: () => ({
    positionsLive: () => session.view.positionsStatus().state === 'live',
    positions: () => {
      const assessed = session.view.snapshot();
      return session.positionSource.snapshot().map((p) => {
        const a = assessed.find((x) => x.marketId === p.marketId);
        return { marketId: p.marketId, positionId: p.positionId, side: p.side, marginCNS: a?.marginCNS, unrealisedPnlCNS: a?.metrics.unrealisedPnlCNS };
      });
    },
    freeFloorCNS: () => {
      const b = session.balance.freeBalance();
      return b.known ? b.floorCNS : undefined;
    },
    execute: (command) => session.executor.execute(command),
  }),
  leader: async () => ({ positions: leader.positions, equityCNS: leaderEquityCNS }),
  indexProblem: async () => undefined,
  actingNetwork: network.name,
  actingMarkets: () => markets,
  markOf: (id) => feed.get(id)?.markPrice,
  collateralDecimals: 6,
  notify: (_id, n) => {
    notices.push(n);
    const r = renderCopy(n, { collateralDecimals: 6, sizeDecimalsOf: (id) => markets.find((m) => m.marketId === id)?.sizeDecimals ?? 0 });
    say(`NOTICE ${n.kind}:\n${r.html.replace(/<[^>]+>/g, '').split('\n').map((l) => `    ${l}`).join('\n')}`);
  },
  logger: { info: (m) => say(`  log: ${m}`), warn: (m) => say(`  WARN ${m}`) },
});

const started = await control.start(accountId, 999_999, 0n, { telegramUserId: 1, chatId: 1 });
say(`start: ${started.ok} ${started.text}`);

say('== the leader opens MON long and HYPE long');
leader.positions = [leaderPos('L-MON', 'MON', 'open'), leaderPos('L-HYPE', 'HYPE', 'open')];
await engine.tick();
const afterOpen = session.positionSource.snapshot().find((p) => p.marketId === mon.marketId);
say(`  position list: MON ${afterOpen === undefined ? 'NONE' : `pid ${afterOpen.positionId} size ${afterOpen.size}`}`);

say('== a second pass: nothing may be sent again');
await engine.tick();

say('== the leader closes MON');
await wait(3_000);
leader.positions = [leaderPos('L-MON', 'MON', 'closed'), leaderPos('L-HYPE', 'HYPE', 'open')];
await engine.tick();
await wait(1_000);
const afterClose = session.positionSource.snapshot().find((p) => p.marketId === mon.marketId);
say(`  position list: MON ${afterClose === undefined ? 'gone (closed)' : `STILL OPEN size ${afterClose.size}`}`);

say('== legs');
for (const l of store.legs(1)) say(`  ${l.symbol} ${l.side}: ${l.status}${l.reason === undefined ? '' : ` (${l.reason})`}${l.sizeLNS === undefined ? '' : `, size ${l.sizeLNS}`}`);
say(`== notices: ${notices.map((n) => n.kind).join(', ')}`);
const stop = await control.stop(accountId);
say(`stop: ${stop.text}`);
await registry.closeAll();
unsubscribe();
venue.disconnect();
process.exit(0);
