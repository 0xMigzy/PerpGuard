/**
 * 🚪 Close part of a position, end to end, LIVE on testnet.
 *
 *   pnpm close:part-live [percent] [transcript.json]      # default 1 (%)
 *
 * The environment account's real session (venue, socket, position source, risk
 * loop, executor and reconciliation) and the real close service behind the
 * real bot, with only Telegram's wire replaced by a recorder. The owner opens
 * the position, taps 🚪 Close position, 🎛 Custom %, types the percentage and
 * taps ✅ Confirm. What is printed is the bot's own messages, then the
 * position's size before and after as the position list shows it, and whether
 * the two agree with what the bot said.
 *
 * SENDS ONE REAL REDUCE-ONLY MARKET ORDER ON TESTNET. Run it while nothing
 * else signs with the same key (STOP THE BACKEND FIRST): two clients on one
 * key can collide on request ids.
 */
import { writeFileSync } from 'node:fs';
import { PerplVenue, loadAppConfig, loadNetworkConfig, loadPerplCredentials, priceToPNS, scaleOf } from '@perpguard/shared';
import { InMemoryAccountSettingsStore, InMemoryIdentityStore, InMemoryLinkStore, PendingActionStore, createBot } from '@perpguard/bot';
import { BOT_INFO, TEST_TOKEN } from '@perpguard/bot/test-support';
import { InMemoryActionLog } from '../actions/index.ts';
import { toReconcilable } from '../actions/positionReader.ts';
import { InMemoryAlertLog } from '../alerts/log.pg.ts';
import type { AlertTransport } from '../alerts/types.ts';
import { CloseEverything } from '../emergency/closeAll.ts';
import { estimatePartial } from '../emergency/partial.ts';
import { InMemoryCloseAllRunStore } from '../emergency/store.ts';
import type { OpenPosition } from '../emergency/verify.ts';
import { MarketFeed } from '../ingest/marketFeed.ts';
import { thresholdsFor } from '../risk/warn.ts';
import { AccountRegistry } from '../sessions/registry.ts';
import { ChatRecorder } from './chatRecorder.ts';

const PERCENT = process.argv[2] ?? '1';
const OUT = process.argv[3];
const OWNER = { from: 900_001, chat: 900_001, name: 'Owner' };
const say = (line: string): void => console.log(line);
const plain = (html: string): string => html.replace(/<[^>]+>/g, '');

const env = process.env as Record<string, string | undefined>;
const app = loadAppConfig(env);
const network = loadNetworkConfig(app.trading.name, env);
if (network.name !== 'testnet') throw new Error(`this script acts, and only on testnet; the trading network is ${network.name}`);
const credentials = loadPerplCredentials(env);
if (credentials.accountId === undefined) throw new Error('PERPL_ACCOUNT_ID is required');
const accountId = credentials.accountId;

const venue = new PerplVenue(network, {});
const markets = await venue.getMarkets();
const riskConfigs = await venue.getRiskConfigs();
const feed = new MarketFeed(network.name, app.staleMs);
const unsubscribe = await venue.subscribePrices(markets.map((m) => m.symbol), (u) => feed.record(u));
const silent: AlertTransport = { send: async () => ({ ok: true }) };

const settings = new InMemoryAccountSettingsStore({ onChange: (id, v) => registry.get(id)?.loop.setThresholds(thresholdsFor(v.warnLevel)) });
const registry = new AccountRegistry({
  deps: {
    network,
    markets,
    riskConfigs,
    feed,
    feedStatus: () => venue.feedStatus(),
    actionLog: new InMemoryActionLog(),
    alertLog: new InMemoryAlertLog(),
    transport: silent,
    recipients: () => [],
    venueFactory: (c) => new PerplVenue(network, { credentials: c }),
    evaluateIntervalMs: 1_000,
    thresholdsFor: (id) => thresholdsFor(settings.get(id).warnLevel),
    logger: { info: () => {}, warn: (m) => say(`  WARN ${m}`) },
  },
});
const opened = registry.open(accountId, { apiKey: credentials.apiKey, secret: credentials.secret });
if (!opened.ok) throw new Error(opened.reason);
const session = opened.session;
for (let i = 0; i < 60; i += 1) {
  if (session.positionSource.status().state === 'live' && venue.feedStatus().state === 'connected') break;
  await new Promise((r) => setTimeout(r, 500));
}
await new Promise((r) => setTimeout(r, 2_500));

/** Every open position from the fully loaded list, exactly as the backend builds it for the close service. */
const openPositions = (): OpenPosition[] | undefined => {
  if (session.view.positionsStatus().state !== 'live') return undefined;
  const assessed = session.view.snapshot();
  const out: OpenPosition[] = [];
  for (const p of session.positionSource.snapshot()) {
    const config = riskConfigs.get(p.marketId);
    if (config === undefined || p.positionId === undefined) return undefined;
    const a = assessed.find((x) => x.marketId === p.marketId && x.positionId === p.positionId);
    const priced = a !== undefined && a.state !== 'FEED_DOWN' && a.state !== 'POSITIONS_UNTRUSTED';
    out.push({ marketId: p.marketId, symbol: p.symbol, positionId: p.positionId, side: p.side, sizeLNS: toReconcilable(p, config).sizeLNS, lotDecimals: config.lotDecimals, unrealisedPnlCNS: priced ? a.metrics.unrealisedPnlCNS : undefined });
  }
  return out;
};

const logLines: string[] = [];
const closer = new CloseEverything({
  killSwitch: { stop: async () => { throw new Error('a partial close never stops automation'); } },
  account: () => ({
    openPositions,
    execute: (command) => session.executor.execute(command),
    exitPrice: (p) => session.venue.closedPositionExitPrice(p.marketId, p.positionId),
    reduceFill: (p) => {
      const reported = session.venue.lastDecreaseFill(p.positionId);
      const config = riskConfigs.get(p.marketId);
      const held = session.positionSource.snapshot().find((x) => x.positionId === p.positionId);
      if (reported === undefined || config === undefined || held === undefined) return undefined;
      return { fill: { exitPricePNS: BigInt(reported.exitPriceRaw), closedLNS: BigInt(reported.closedRaw), feeCNS: reported.feeMicros }, entryPricePNS: priceToPNS(held.entryPrice, config), scale: scaleOf(config) };
    },
  }),
  store: new InMemoryCloseAllRunStore(),
  log: (line) => logLines.push(line),
});

const before = openPositions();
if (before === undefined || before.length === 0) throw new Error('no open position on the account that can be seen');
const target = before[0]!;
const sizeText = (lns: bigint): string => (Number(lns) / 10 ** target.lotDecimals).toString();
say(`account ${accountId} on ${network.name}: ${target.symbol} ${target.side}, size ${sizeText(target.sizeLNS)} (${target.sizeLNS} size units, pid ${target.positionId})`);

const bot = createBot({
  config: { token: TEST_TOKEN, userId: 'owner', ownerTelegramUserId: OWNER.from },
  links: new InMemoryLinkStore({ capacity: 1, ownerTelegramUserId: OWNER.from }),
  store: new PendingActionStore(),
  sessions: registry,
  ownerAccountId: accountId,
  configs: riskConfigs,
  tradingNetwork: network.name,
  identities: new InMemoryIdentityStore(),
  settings,
  webUrl: env['PUBLIC_WEB_URL'] ?? 'https://perpguard.example',
  botInfo: BOT_INFO,
  killSwitch: { stopped: () => false, changedAtMs: () => undefined, stop: async () => { throw new Error('not in this script'); }, resume: async () => ({ wasStopped: false }) },
  emergency: {
    preview: () => openPositions(),
    closeAll: async () => ({ kind: 'nothing-sent', why: 'cannot-see' }),
    closeOne: async () => ({ kind: 'nothing-sent', why: 'cannot-see' }),
    closePosition: async () => ({ kind: 'nothing-sent', why: 'cannot-see' }),
    estimatePartial: (_id, marketId, closeLNS) => {
      const p = openPositions()?.find((x) => x.marketId === marketId);
      const config = riskConfigs.get(marketId);
      const a = session.view.snapshot().find((x) => x.marketId === marketId);
      if (p === undefined) return { realisedCNS: undefined, feeCNS: undefined };
      return estimatePartial({ sizeLNS: p.sizeLNS, closeLNS, unrealisedPnlCNS: p.unrealisedPnlCNS, markPricePNS: a !== undefined && a.markPricePNS > 0n ? a.markPricePNS : undefined, scale: config === undefined ? undefined : scaleOf(config), takerFeeMicros: markets.find((m) => m.marketId === marketId)?.takerFeeMicros });
    },
    reducePosition: (id, marketId, closeLNS, expected, requestId, by) => closer.reducePosition(id, marketId, closeLNS, expected, requestId, by),
  },
});
const rec = new ChatRecorder(bot, OWNER);
const last = (): string => plain(rec.chat().filter((m) => m.from === 'bot').at(-1)?.text ?? '');
const show = (title: string): void => {
  say(`\n--- ${title} ---\n${last()}\n${rec.labels().map((l) => `[ ${l} ]`).join(' ')}`);
  rec.frame(title);
};

await rec.send('/start');
await rec.tap('📊 My positions');
const row = rec.labels().find((l) => l.includes(target.symbol));
if (row === undefined) throw new Error(`My positions does not list ${target.symbol}`);
await rec.tap(row);
show('View position');
await rec.tap('🚪 Close position');
show('🚪 Close position: the options');
await rec.tap('🎛 Custom %');
await rec.send(PERCENT);
show(`Custom % answered with ${PERCENT}: the confirmation (nothing sent yet)`);
if (!rec.labels().includes('✅ Confirm')) throw new Error('no confirmation was offered, so nothing was sent');

const t0 = Date.now();
await rec.tap('✅ Confirm');
show(`✅ Confirm: the result (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

// THE READ-BACK, independently of what the bot said: the position list a few seconds later.
await new Promise((r) => setTimeout(r, 3_000));
const after = openPositions()?.find((p) => p.positionId === target.positionId);
say('\n--- the service\'s own log ---');
for (const line of logLines) say(`  ${line}`);
say('\n--- read back from the position list ---');
say(`  size before: ${sizeText(target.sizeLNS)} (${target.sizeLNS} units)`);
say(`  size after:  ${after === undefined ? 'not in the list' : `${sizeText(after.sizeLNS)} (${after.sizeLNS} units)`}`);
if (after !== undefined) {
  const said = /Size: ([\d.,]+) → ([\d.,]+)/.exec(last());
  say(`  the bot said: ${said === null ? 'no "Size: a → b" line' : `${said[1]} → ${said[2]}`}`);
  say(`  read-back matches what the bot said: ${said !== null && said[2]!.replace(/,/g, '') === sizeText(after.sizeLNS) ? 'YES' : 'NO'}`);
}

if (OUT !== undefined) {
  writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), accountId, percent: PERCENT, frames: rec.frames, log: logLines }, null, 2));
  say(`\ntranscript written to ${OUT}`);
}
await registry.closeAll();
unsubscribe();
venue.disconnect();
process.exit(0);
