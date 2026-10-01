/**
 * A stranger using the bot's read-only half, end to end, against LIVE mainnet data.
 *
 *   pnpm watch:demo [transcript.json]
 *
 * Everything in the chain is the real thing — the real grammY bot with its
 * real gate and screens, the real watch store, the real resolver over the
 * real index and the real Exchange contract, the real watch loop over real
 * indexed positions and the venue's real marks, the real alert engine and the
 * real Telegram transport — except Telegram's wire, which is replaced by a
 * recorder that keeps the chat as the stranger would see it: messages in
 * order, edits applied in place, keyboards attached.
 *
 * The accounts are chosen live: the open positions closest to their closing
 * price right now. Nothing is cached from a fixture, and if none of them is
 * close enough to alert on, the transcript shows no alert rather than an
 * invented one.
 *
 * With a path argument, the chat after every step is written there as JSON,
 * for rendering screenshots of what the stranger saw.
 */
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  PerplVenue,
  PostgresAnalytics,
  assessOpenPositions,
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
  StaticSessionRouter,
  StubActionExecutor,
  TelegramAlertTransport,
  createBot,
  encodeCallback,
  encodeNav,
  watchRecipients,
  type RiskView,
  type Route,
} from '@perpguard/bot';
import { BOT_INFO, TEST_TOKEN } from '@perpguard/bot/test-support';
import { AlertEngine } from '../alerts/engine.ts';
import { InMemoryAlertLog } from '../alerts/log.pg.ts';
import { WatchLoop } from '../watch/loop.ts';
import { createWatchResolver } from '../watch/resolve.ts';

const STRANGER = { from: 777_001, chat: 777_001 };
/** Someone who started watching the same account a day ago: the one a real alert is for. */
const EARLIER = { chat: 777_002 };
const OUT = process.argv[2];
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

// ── the chat, as the stranger sees it ───────────────────────────────────────

interface ChatMessage {
  id: number;
  from: 'user' | 'bot';
  text: string;
  html: boolean;
  buttons: Array<Array<{ text: string; url?: string }>>;
  forceReply?: string;
}
type Bot = ReturnType<typeof createBot>;
const chat: ChatMessage[] = [];
const earlierChat: ChatMessage[] = [];
const frames: Array<{ step: string; messages: ChatMessage[]; inputPlaceholder?: string }> = [];
let nextId = 1;
let lastToast: string | undefined;

function install(bot: Bot): void {
  bot.api.config.use(async (_prev: unknown, method: string, raw: unknown) => {
    const p = raw as Record<string, unknown>;
    const markup = p['reply_markup'] as { inline_keyboard?: Array<Array<{ text: string; url?: string }>>; force_reply?: boolean; input_field_placeholder?: string } | undefined;
    const buttons = (markup?.inline_keyboard ?? []).map((row) => row.map((b) => ({ text: b.text, ...(b.url === undefined ? {} : { url: b.url }) })));
    if (method === 'sendMessage' && Number(p['chat_id']) === EARLIER.chat) {
      earlierChat.push({ id: nextId++, from: 'bot', text: String(p['text']), html: p['parse_mode'] === 'HTML', buttons });
      return { ok: true, result: { message_id: nextId, date: 0, chat: { id: EARLIER.chat, type: 'private' }, text: '' } } as never;
    }
    if (method === 'sendMessage' && Number(p['chat_id']) === STRANGER.chat) {
      const id = nextId++;
      chat.push({ id, from: 'bot', text: String(p['text']), html: p['parse_mode'] === 'HTML', buttons, ...(markup?.force_reply ? { forceReply: markup.input_field_placeholder ?? '' } : {}) });
      return { ok: true, result: { message_id: id, date: 0, chat: { id: STRANGER.chat, type: 'private' }, text: String(p['text']) } } as never;
    }
    if (method === 'editMessageText') {
      const target = chat.find((m) => m.id === Number(p['message_id']));
      if (target !== undefined) {
        target.text = String(p['text']);
        target.html = p['parse_mode'] === 'HTML';
        target.buttons = buttons;
      }
      return { ok: true, result: true } as never;
    }
    if (method === 'answerCallbackQuery') {
      lastToast = p['text'] === undefined ? undefined : String(p['text']);
      return { ok: true, result: true } as never;
    }
    return { ok: true, result: { message_id: nextId++, date: 0, chat: { id: 0, type: 'private' }, text: '' } } as never;
  });
}

let update = 1;
async function send(bot: Bot, text: string): Promise<void> {
  chat.push({ id: nextId++, from: 'user', text, html: false, buttons: [] });
  await bot.handleUpdate({
    update_id: update++,
    message: {
      message_id: nextId,
      date: 0,
      chat: { id: STRANGER.chat, type: 'private', first_name: 'Stranger' },
      from: { id: STRANGER.from, is_bot: false, first_name: 'Stranger' },
      text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [],
    },
  } as never);
}

/** Tap a button on a message the bot sent, by its label. */
async function tap(bot: Bot, label: string, route?: Route): Promise<void> {
  const host = [...chat].reverse().find((m) => m.from === 'bot' && m.buttons.some((row) => row.some((b) => b.text === label)));
  if (host === undefined) throw new Error(`no button "${label}" on screen`);
  // The recorder keeps labels; the payload comes from the route the screen used.
  const data = route === undefined ? undefined : encodeNav(route);
  if (data === undefined) throw new Error(`tap("${label}") needs its route`);
  await bot.handleUpdate({
    update_id: update++,
    callback_query: {
      id: `cb${update}`,
      from: { id: STRANGER.from, is_bot: false, first_name: 'Stranger' },
      chat_instance: 'ci',
      data,
      message: { message_id: host.id, date: 0, chat: { id: STRANGER.chat, type: 'private', first_name: 'Stranger' }, from: { id: BOT_INFO.id, is_bot: true, first_name: 'PerpGuard' }, text: host.text },
    },
  } as never);
}

function frame(step: string): void {
  const last = chat.at(-1);
  frames.push({ step, messages: structuredClone(chat), ...(last?.forceReply === undefined ? {} : { inputPlaceholder: last.forceReply }) });
  const bot = [...chat].reverse().find((m) => m.from === 'bot');
  say(`\n== ${step}`);
  if (bot !== undefined) {
    say(bot.text.split('\n').map((l) => `   ${l}`).join('\n'));
    for (const row of bot.buttons) say(`   [ ${row.map((b) => b.text).join(' | ')} ]`);
  }
  if (lastToast !== undefined) say(`   (toast: ${lastToast})`);
}

// ── the real stack ──────────────────────────────────────────────────────────

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
  sessions: new StaticSessionRouter([{ accountId: 0, view, executor, balance: { freeBalance: () => ({ known: false, reason: 'demo' }) } as never }]),
  configs: await venue.getRiskConfigs(),
  identities: new InMemoryIdentityStore(),
  watch: {
    store: watchStore,
    resolver,
    limiter: new RateLimiter({ limit: 100, windowMs: 60_000 }),
    indexerHealth: () => loop.lastHealth,
    assessments: (id) => loop.snapshot(id),
    facts: (id) => loop.accountFacts(id),
    configs: () => loop.marketConfigs,
    refresh: () => loop.evaluate(),
  },
  webUrl: env['PUBLIC_WEB_URL'] ?? 'https://perpguard.example',
  botInfo: BOT_INFO,
});
install(bot);
const transport = new TelegramAlertTransport({ api: bot.api, token: TEST_TOKEN, links, store: pending, executor });
const engine = new AlertEngine({
  source: loop,
  configs: await venue.getRiskConfigs(),
  transport,
  log: new InMemoryAlertLog(),
  recipients: (change) => watchRecipients(watchStore, change, Date.now()),
  logger: { error: (m) => console.error(m), warn: (m) => console.warn(m), info: () => {} },
});
engine.start();

// The open positions closest to their closing price right now, live.
const indexed = await analytics.openPositions();
const oi = await venue.getOpenInterest();
const assessed = assessOpenPositions(
  indexed.map((p) => p.position),
  await venue.getRiskConfigs(),
  new Map(oi.map((m) => [m.marketId, { markPrice: m.markPrice, atMs: m.atMs }])),
);
const priced = assessed
  .map((a, i) => ({ accountId: indexed[i]!.accountId, buffer: a.liqBufferPct }))
  .filter((a): a is { accountId: number; buffer: number } => a.buffer !== undefined && a.buffer > 0)
  .sort((a, b) => a.buffer - b.buffer);
const accounts = [...new Set(priced.map((a) => a.accountId))];
const [first, second] = accounts;
if (first === undefined || second === undefined) throw new Error('the live index has fewer than two priced open positions; nothing to demo');
say(`closest accounts right now: ${accounts.slice(0, 5).join(', ')}`);

// The earlier watcher subscribed to the closest account a day ago, so the
// boot pass's first sight of it is theirs to hear — through the real engine.
watchStore.add({ chatId: EARLIER.chat, accountId: first, label: `#${first}`, addedAtMs: Date.now() - 24 * 60 * 60_000 });
await loop.evaluate();
await engine.drain();

// ── the stranger ────────────────────────────────────────────────────────────

await send(bot, '/start');
frame('1. A stranger presses Start');

await tap(bot, '👁 Watch a wallet', { to: 'watch-ask' });
frame('2. Watch a wallet: asked with force_reply');

await send(bot, String(first));
await engine.drain();
frame(`3. They answer ${first}, and it is heard`);

await send(bot, '0xB7854953A71e45D1033B3d619E76d56391291765');
await engine.drain();
frame('4. They paste a checksummed address without pressing anything');

await send(bot, String(second));
frame(`5. A bare number nobody asked for is offered, not acted on`);
await tap(bot, `👁 Watch #${second}`, { to: 'watch-id', accountId: second });
await engine.drain();
frame(`6. One tap watches #${second}`);

await tap(bot, '← Home', { to: 'home' });
frame('7. Home, returning');

await tap(bot, '📋 My watchlist', { to: 'watchlist' });
frame('8. My watchlist');

await tap(bot, `#${first}`, { to: 'wallet', accountId: first });
frame(`9. Watched wallet #${first}: no actions`);

const burst = chat.filter((m) => m.from === 'bot' && /^[🔴🟠🟢⚪] <b>#/u.test(m.text));
say(`\nfirst-sight alerts sent to the stranger, who had just seen the screens: ${burst.length}`);
say(`alerts the real engine delivered to the earlier watcher of #${first}: ${earlierChat.length}`);
const closestAlert = earlierChat.find((m) => m.text.startsWith('🔴')) ?? earlierChat[0];
if (closestAlert !== undefined) {
  frames.push({ step: `10. A watch alert, as the real engine delivered it to someone watching #${first}`, messages: [structuredClone(closestAlert)] });
  say(closestAlert.text.split('\n').map((l) => `   ${l}`).join('\n'));
}

// A crafted action payload from the same stranger: still refused at the gate.
const crafted = encodeCallback({ kind: 'confirm', token: 'deadbeef', marketId: 1, amountCNS: 1_000_000n });
lastToast = undefined;
await bot.handleUpdate({ update_id: update++, callback_query: { id: 'x', from: { id: STRANGER.from, is_bot: false, first_name: 'S' }, chat_instance: 'ci', data: crafted, message: { message_id: 1, date: 0, chat: { id: STRANGER.chat, type: 'private', first_name: 'S' }, text: '' } } } as never);
say(`crafted action payload answered: ${JSON.stringify(lastToast)}; executor calls: ${executor.calls.length}`);

if (OUT !== undefined) {
  writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), indexer: loop.lastHealth, frames }, null, 2));
  say(`\ntranscript written to ${OUT}`);
}
engine.stop();
await pool.end();
