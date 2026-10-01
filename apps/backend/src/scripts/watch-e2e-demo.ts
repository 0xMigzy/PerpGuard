/**
 * A stranger watching an account, end to end, against LIVE mainnet data.
 *
 *   pnpm watch:demo
 *
 * Everything in the chain is the real thing — the real grammY bot with its
 * real middleware and gate, the real watch store, the real resolver over the
 * real index and the real Exchange contract, the real watch loop over real
 * indexed positions and the venue's real marks, the real alert engine and the
 * real Telegram transport — except Telegram's wire, which is replaced by the
 * same recording fake the bot's tests use, so the script can show exactly
 * what the stranger's chat received and send a crafted tap on their behalf.
 *
 * Nothing here is cached from a test fixture. If the account it watches has
 * no position in WATCH or worse right now, the demo says so rather than
 * inventing one.
 */
import { Pool } from 'pg';
import {
  PerplVenue,
  PostgresAnalytics,
  fetchChainHead,
  loadAppConfig,
  loadNetworkConfig,
  lookupAccountByAddress,
  symbolResolver,
} from '@perpguard/shared';
import {
  InMemoryIdentityStore,
  InMemoryLinkStore,
  InMemoryWatchStore,
  PendingActionStore,
  RateLimiter,
  StubActionExecutor,
  TelegramAlertTransport,
  createBot,
  encodeCallback,
  type RiskView,
} from '@perpguard/bot';
import { BOT_INFO, FakeTelegram, TEST_TOKEN, callbackUpdate, messageUpdate } from '@perpguard/bot/test-support';
import { AlertEngine } from '../alerts/engine.ts';
import { InMemoryAlertLog } from '../alerts/log.pg.ts';
import { WatchLoop } from '../watch/loop.ts';
import { createWatchResolver } from '../watch/resolve.ts';

const STRANGER = { from: 777_001, chat: 777_001 };
const say = (line: string): void => console.log(line);

const env = process.env as Record<string, string | undefined>;
const app = loadAppConfig(env);
const net = loadNetworkConfig(app.analytics.name, env);
const pool = new Pool({ connectionString: env['INDEXER_DATABASE_URL'], max: 2 });
const venue = new PerplVenue(net, {});
const markets = await venue.getMarkets();
const analytics = new PostgresAnalytics({
  client: pool,
  chainId: net.chainId,
  resolveSymbol: symbolResolver(markets.map((m) => ({ marketId: m.marketId, symbol: m.symbol }))),
  chainHead: () => fetchChainHead(net.rpcUrl),
});
const resolver = createWatchResolver({
  analytics,
  lookupOnChain: (address) => lookupAccountByAddress(address, { rpcUrl: net.rpcUrl, exchangeAddress: net.exchangeAddress }),
});

// The accounts most likely to have something to warn about right now: the
// three busiest open books in the live index.
const busiest = (await pool.query(`select trader_id as id from "Position" where status = 'OPEN' group by trader_id order by count(*) desc limit 3`)).rows as Array<{ id: string }>;
const targets = busiest.map((r) => Number(r.id));

const watchStore = new InMemoryWatchStore();
const links = new InMemoryLinkStore({ capacity: 1 });
const pending = new PendingActionStore();
const executor = new StubActionExecutor();
const loop = new WatchLoop({
  subscriptions: watchStore,
  profile: (id) => analytics.walletByAccountId(id),
  health: () => analytics.health(),
  marks: () => venue.getOpenInterest(),
  configs: () => venue.getRiskConfigs(),
  staleMs: app.staleMs,
});
const view: RiskView = { network: net.name, snapshot: () => [], feedStatus: () => ({ state: 'connected', reconnectAttempt: 0 }), positionsStatus: () => ({ state: 'live', lastUpdateMs: Date.now(), ageMs: 0 }), projectAddMargin: () => ({ ok: false, reason: 'demo' }) };
const bot = createBot({
  config: { token: TEST_TOKEN, userId: 'operator', ownerTelegramUserId: undefined },
  links,
  store: pending,
  executor,
  view,
  configs: await venue.getRiskConfigs(),
  identities: new InMemoryIdentityStore(),
  watch: { store: watchStore, resolver, limiter: new RateLimiter({ limit: 100, windowMs: 60_000 }), indexerHealth: () => loop.lastHealth },
  botInfo: BOT_INFO,
});
const telegram = new FakeTelegram();
telegram.install(bot.api);
const transport = new TelegramAlertTransport({ api: bot.api, token: TEST_TOKEN, links, store: pending, executor });
const engine = new AlertEngine({
  source: loop,
  configs: await venue.getRiskConfigs(),
  transport,
  log: new InMemoryAlertLog(),
  recipients: (change) => watchStore.watchersOf(change.assessment.watch?.accountId ?? -1).map((s) => ({ userId: `watch:${s.chatId}`, rights: 'watch' as const, chatId: s.chatId })),
  logger: { error: (m) => console.error(m), warn: (m) => console.warn(m), info: () => {} },
});
engine.start();
// One pass before anyone types, as the backend does at boot, so the replies
// can quote which block the index is at.
await loop.evaluate();

const lastReply = (): string => String(telegram.last('sendMessage').payload['text']);

say(`\n== 1. a stranger (telegram user ${STRANGER.from}) says /start`);
await bot.handleUpdate(messageUpdate('/start', STRANGER));
say(lastReply().split('\n').slice(0, 3).join('\n') + '\n   …');

say(`\n== 2. /watch by checksummed address (one the index links)`);
await bot.handleUpdate(messageUpdate('/watch 0xB7854953A71e45D1033B3d619E76d56391291765', STRANGER));
say(lastReply());

say(`\n== 3. /watch by account id: the three busiest open books in the index right now (${targets.join(', ')})`);
for (const target of targets) {
  await bot.handleUpdate(messageUpdate(`/watch ${target}`, STRANGER));
  say(lastReply().split('\n')[0] as string);
}

say(`\n== 4. /watching`);
await bot.handleUpdate(messageUpdate('/watching', STRANGER));
say(lastReply());

say(`\n== 5. the watch loop runs once against the live index and venue`);
const t0 = Date.now();
const produced = await loop.evaluate();
await engine.drain();
const h = loop.lastHealth;
say(`   assessed ${produced.length} position(s) in ${Date.now() - t0}ms; indexer ${h?.state}, ${h?.blocksBehind} blocks behind, at block ${h?.latestProcessedBlock}`);
const alerts = telegram.of('sendMessage').filter((c) => /^Watching .+ · (WATCH|DANGER|PAST LIQUIDATION|SAFE|FEED DOWN|POSITIONS UNTRUSTED) · /.test(String(c.payload['text'])));
say(`   alerts delivered to chat ${STRANGER.chat}: ${alerts.length}`);
for (const call of alerts.slice(0, 3)) {
  say(`   ---- chat_id=${call.payload['chat_id']} reply_markup=${call.payload['reply_markup'] === undefined ? 'NONE' : 'PRESENT'}`);
  say(String(call.payload['text']).split('\n').map((l) => '   ' + l).join('\n'));
}
if (alerts.length === 0) say('   (no position on the watched accounts is in WATCH or worse right now, so there was nothing to send: SAFE on first sight is deliberately silent)');

say(`\n== 6. the stranger sends a hand-crafted action payload`);
const crafted = encodeCallback({ kind: 'confirm', token: 'deadbeef', marketId: 1, amountCNS: 1_000_000n });
telegram.calls.length = 0;
await bot.handleUpdate(callbackUpdate(crafted, STRANGER));
say(`   answered: ${JSON.stringify(telegram.last('answerCallbackQuery').payload['text'])}`);
say(`   executor calls: ${executor.calls.length}; messages sent: ${telegram.of('sendMessage').length}`);

say(`\n== 7. /unwatch ${targets[0]}`);
await bot.handleUpdate(messageUpdate(`/unwatch ${targets[0]}`, STRANGER));
say(lastReply());

engine.stop();
await pool.end();
