/**
 * The bot's account half, end to end, LIVE on testnet.
 *
 *   pnpm bot:account-demo [transcript.json]
 *
 * The environment account's real session — real venue, socket, position
 * source, risk loop, executor and reconciliation — behind the real bot, with
 * only Telegram's wire replaced by a recorder. The owner presses Start, opens
 * My positions and a position, adds a custom 0.01 AUSD, changes "Warn me at",
 * reduces the position by a quarter, and opens the Trading Account. Every outcome
 * printed is the executor's reconciled verdict, read off the position.
 *
 * MOVES REAL TESTNET COLLATERAL. Needs an open position on the account with at
 * least 4 lots, so Reduce 25% has something to reduce:
 *   pnpm actions:live --open --no-close --units 4
 * Run it while nothing else signs with the same key: two clients on one key
 * can collide on request ids.
 */
import { writeFileSync } from 'node:fs';
import { PerplVenue, loadAppConfig, loadNetworkConfig, loadPerplCredentials } from '@perpguard/shared';
import { InMemoryAccountSettingsStore, InMemoryIdentityStore, InMemoryLinkStore, PendingActionStore, createBot } from '@perpguard/bot';
import { BOT_INFO, TEST_TOKEN } from '@perpguard/bot/test-support';
import { InMemoryActionLog } from '../actions/index.ts';
import { InMemoryAlertLog } from '../alerts/log.pg.ts';
import type { AlertTransport } from '../alerts/types.ts';
import { MarketFeed } from '../ingest/marketFeed.ts';
import { thresholdsFor } from '../risk/warn.ts';
import { AccountRegistry } from '../sessions/registry.ts';
import { ChatRecorder } from './chatRecorder.ts';

const OUT = process.argv[2];
const OWNER = { from: 900_001, chat: 900_001, name: 'Owner' };
const say = (line: string): void => console.log(line);

const env = process.env as Record<string, string | undefined>;
const app = loadAppConfig(env);
const network = loadNetworkConfig(app.trading.name, env);
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
say(`session for account ${accountId}: positions ${session.positionSource.status().state}, ${session.loop.snapshot().length} open`);

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
});
const rec = new ChatRecorder(bot, OWNER);

await rec.send('/start');
rec.frame('1. The owner presses Start: connected, with the account on the home screen');

await rec.tap('📊 My Positions');
rec.frame('2. My positions');

const position = rec.labels().find((l) => / · /.test(l) && !l.startsWith('⚙'));
if (position === undefined) throw new Error('no open position on the account; open one with `pnpm actions:live --open --no-close --units 4`');
await rec.tap(position);
rec.frame('3. Position detail: actions live');

await rec.tap('Add custom amount');
rec.frame('4. Add custom amount: asked with force_reply');
await rec.send('0.01');
rec.frame('5. The answer is heard: the confirmation, the second tap');
const t0 = Date.now();
await rec.tap('✅ Confirm');
rec.frame(`6. The outcome, reconciled against the position (${Math.round((Date.now() - t0) / 1000)}s)`);

await rec.tap('📊 My Positions');
await rec.tap('← Back');
await rec.tap('⚙️ Settings');
rec.frame('7. Settings: each button shows what it is set to');
await rec.tap(rec.labels().find((l) => l.startsWith('⚠️ Warn me at'))!);
rec.frame('8. Warn me at: three choices');
await rec.tap(rec.labels().find((l) => l.startsWith('Early'))!);
rec.frame(`9. Saved: the loop now warns at ${(session.loop.thresholds.watchEnterPct * 100).toFixed(0)}%`);
await settings.set(accountId, { ...settings.get(accountId), warnLevel: 'normal' });

await rec.tap('← Back');
await rec.tap('← Back');
await rec.tap('📊 My Positions');
const again = rec.labels().find((l) => / · /.test(l) && !l.startsWith('⚙'))!;
await rec.tap(again);
if (rec.labels().includes('Reduce 25%')) {
  await rec.tap('Reduce 25%');
  rec.frame('10. Reduce 25%: the confirmation says the closing price does not move');
  const t1 = Date.now();
  await rec.tap('✅ Confirm');
  rec.frame(`11. Reduced, reconciled against the position (${Math.round((Date.now() - t1) / 1000)}s)`);
  await rec.tap('📊 My Positions');
} else {
  say('  (position too small to reduce by a quarter; skipped)');
  await rec.tap('← Back');
}

// The close-all kill switch is retired (6 Oct 2026); it returns in Phase 20 as "stop automation".
await rec.tap('← Back');
await rec.tap('🔐 Trading Account');
rec.frame('12. Trading Account: the account, its network, and whether it can execute');

if (OUT !== undefined) {
  writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), accountId, frames: rec.frames }, null, 2));
  say(`\ntranscript written to ${OUT}`);
}
await registry.closeAll();
unsubscribe();
venue.disconnect();
