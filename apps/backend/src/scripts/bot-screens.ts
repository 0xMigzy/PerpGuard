/**
 * docs/bot-screens.html, GENERATED from the real bot.
 *
 *   pnpm bot:screens
 *
 * The real `createBot` with only Telegram's wire and the account's session
 * faked (the same fakes the bot's tests use; nothing is sent anywhere). It
 * walks every navigation button from /start, once as the linked owner and
 * once as a stranger, and writes each screen it lands on. The layout document
 * is therefore the bot itself: it cannot drift from what people see.
 *
 * Buttons that change something (unlink, stop watching, a setting, minting a
 * link code) are shown on their screen but not tapped.
 */
import { replayCopy } from '../copy/replay.ts';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InMemoryWatchStore, RateLimiter, StaticSessionRouter, createBot, decodeNav, encodeNav, type Route } from '@perpguard/bot';
import {
  BOT_INFO,
  CONFIGS,
  FakeBalance,
  FakeExecutor,
  FakeView,
  OWNER_CHAT,
  OWNER_ID,
  STRANGER_ID,
  TEST_TOKEN,
  USER_ID,
  callbackUpdate,
  dangerAssessment,
  fakeBot,
  messageUpdate,
  newLinks,
  newStore,
  type TelegramCall,
} from '@perpguard/bot/test-support';
import type { IndexerHealth, TraderRow } from '@perpguard/shared';
import { InMemoryPreferenceStore } from '../events/preferences.ts';
import { InMemoryAutomationStore } from '../rescue/automation.ts';
import { RescueControlService } from '../rescue/control.ts';
import { InMemoryRescueStore } from '../rescue/store.ts';
import { KillSwitch } from '../rescue/killSwitch.ts';
import { ArmSigner } from '../rescue/arming.ts';

const OUT = resolve(import.meta.dirname, '../../../../docs/bot-screens.html');
const STRANGER_CHAT = 7_777;
const CHANGES = new Set(['disconnect', 'unwatch', 'warn-set', 'connect-go', 'watch-id', 'star', 'unstar', 'liq-set', 'big-set', 'warn-preset', 'wallet-alerts', 'rescue-on', 'rescue-stop', 'rescue-resume', 'rescue-lim', 'kill-stop', 'kill-resume', 'close-retry-go']);

/** SAMPLE trader figures: the generator has no index. Labelled as samples on the page. */
const sampleRow = (accountId: number, netPnlAusd: number, depositedAusd: number, roundTrips: number): TraderRow => ({
  accountId, address: '', netPnlAusd, volumeAusd: 0, tradeCount: roundTrips * 2, roundTrips, wins: Math.round(roundTrips * 0.6), losses: Math.round(roundTrips * 0.4),
  winRate: roundTrips >= 10 ? 0.6 : undefined, liquidationCount: 0, rescuableLiquidationCount: 0, marginLostAusd: 0, maxSpareHeldAusd: undefined,
  depositedAusd, withdrawnAusd: 0, netFlowAusd: 0, freeBalanceAusd: 0, openPositionCount: 1, lastActiveAtMs: 0, roiPct: depositedAusd >= 100 ? (netPnlAusd / depositedAusd) * 100 : undefined,
});
const sampleTraders = {
  top: async (kind: 'pnl' | 'roi') => ({
    rows: kind === 'pnl' ? [sampleRow(4886, 66_060, 0, 464), sampleRow(5201, 13_590, 0, 5_621)] : [sampleRow(987, 21_147, 2_045, 24_944), sampleRow(2154, 3_551, 398, 1_428)],
    label: kind === 'pnl' ? 'Net PnL over the 31 UTC days from 2026-09-06 (today so far)' : "Since Perpl launched on 11 Feb 2026: the index starts at the Exchange's deployment",
  }),
  stats: async (accountId: number) => ({ accountId, month: sampleRow(accountId, 1_250, 0, 42), lifetime: sampleRow(accountId, 21_147, 2_045, 24_944) }),
  // A small replay through the REAL replay maths: a BTC win, an ETH loss, HYPE skipped by name.
  copy: async (accountId: number, followerEquityCNS: bigint) => {
    const from = Date.parse('2026-09-07T00:00:00Z');
    const H = 3_600_000;
    const position = (n: number, marketId: number, symbol: string, side: 'long' | 'short', openedH: number, closedH: number, netPnlCNS: bigint) => ({
      key: `s${n}`, market: { marketId, symbol, indexerName: symbol }, side, status: 'closed' as const, lotDecimals: 5, priceDecimals: 1,
      peakLotLNS: 200_000n, lotLNS: 0n, entryPricePNS: 1_000_000n, peakMarginCNS: 20_000_000_000n, netPnlCNS, leverageHdths: 1000n,
      openedAtMs: from + openedH * H, closedAtMs: from + closedH * H,
    });
    const result = replayCopy({
      source: {
        accountId, fromMs: from, toMs: from + 30 * 24 * H, collateralDecimals: 6, equityAtStartCNS: 100_000_000_000n, feesByDay: [], flows: [], closedFromBefore: [], openAtStart: 1, openedInWindow: 3,
        positions: [position(1, 1, 'BTC', 'long', 10, 40, 6_480_000_000n), position(2, 60, 'HYPE', 'short', 50, 60, 900_000_000n), position(3, 2, 'ETH', 'short', 100, 130, -2_100_000_000n)],
      },
      followerEquityCNS,
      actingNetwork: 'testnet',
      actingMarkets: [{ marketId: 16, symbol: 'BTC', sizeDecimals: 5, maxLeverage: 15, takerFeeMicros: 450 }, { marketId: 17, symbol: 'ETH', sizeDecimals: 5, maxLeverage: 12, takerFeeMicros: 450 }],
      markOf: () => undefined,
      cap: 3_000,
    });
    return { computedAtMs: Date.now(), result };
  },
};

/** The one part of Telegram's reply markup this reads. */
interface Keyboard {
  readonly inline_keyboard?: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly callback_data?: string; readonly url?: string }>>;
}

interface Shot {
  readonly title: string;
  readonly html: string;
  readonly rows: readonly (readonly { readonly text: string; readonly url?: string; readonly changes?: boolean }[])[];
}

function build() {
  const { bot, telegram } = fakeBot();
  const view = new FakeView();
  // The document shows the trading network the product ships on.
  Object.defineProperty(view, 'network', { value: 'testnet' });
  view.assessments = [dangerAssessment()];
  const watchStore = new InMemoryWatchStore({ maxPerChat: 5 });
  watchStore.add({ chatId: STRANGER_CHAT, accountId: 4088, label: '#4088', addedAtMs: 0, starred: true });
  // The real control and kill switch over in-memory stores, so the document shows the real screens.
  const automation = new InMemoryAutomationStore();
  const rescueStore = new InMemoryRescueStore();
  const killSwitch = new KillSwitch({ automation, rescueStore, rescueEngine: { inFlightOn: () => false, settleAccount: async () => true }, log: () => {} });
  const built = createBot({
    config: { token: TEST_TOKEN, userId: USER_ID, ownerTelegramUserId: undefined },
    links: newLinks(),
    store: newStore(),
    sessions: new StaticSessionRouter([{ accountId: 710, view, executor: new FakeExecutor(), balance: new FakeBalance(), status: () => ({ trading: { state: 'signed-in', forwardingAllowed: true } }) }]),
    ownerAccountId: 710,
    tradingNetwork: 'testnet',
    configs: CONFIGS,
    webUrl: 'https://perpguard.app',
    botInfo: bot.botInfo,
    watch: {
      store: watchStore,
      resolver: { resolve: async () => ({ error: 'not in this document' }) },
      limiter: new RateLimiter({ limit: 1_000, windowMs: 60_000 }),
      indexerHealth: () => ({ state: 'synced', blocksBehind: 140, latestProcessedBlock: 111_124_139, serveAsCurrent: true }) as unknown as IndexerHealth,
      preferences: new InMemoryPreferenceStore(),
      traders: sampleTraders,
    },
    // The real control over in-memory stores, so the document shows the real Rescue screens.
    rescue: new RescueControlService({ store: rescueStore, automation, collateralDecimals: 6, signer: new ArmSigner('00'.repeat(32)), isLinked: () => true, alertPctOf: () => 5, snapshot: () => view.assessments }),
    // Previewed from the sample position; nothing in the document closes anything.
    emergency: {
      preview: () => view.assessments.map((a) => ({ marketId: a.marketId, symbol: a.symbol, positionId: a.positionId ?? 1, side: a.side ?? 'long', sizeLNS: a.lotLNS ?? 0n, lotDecimals: CONFIGS.get(a.marketId)?.lotDecimals ?? 0, unrealisedPnlCNS: a.metrics.unrealisedPnlCNS })),
      closeAll: async () => ({ kind: 'nothing-sent' as const, why: 'already-flat' as const }),
      closeOne: async () => ({ kind: 'nothing-sent' as const, why: 'already-flat' as const }),
    },
    killSwitch: {
      stopped: (id) => automation.automationStopped(id),
      changedAtMs: (id) => killSwitch.changedAtMs(id),
      stop: (id, by) => killSwitch.stop(id, by),
      resume: (id, by) => killSwitch.resume(id, by),
    },
  });
  telegram.install(built.api);
  return { bot: built, telegram };
}

/** The screen a tap produced: the last message WITH buttons (a force_reply question that follows has none). */
function screenOf(calls: readonly TelegramCall[]): TelegramCall {
  const shown = calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  return [...shown].reverse().find((c) => (c.payload['reply_markup'] as Keyboard | undefined)?.inline_keyboard !== undefined) ?? shown.at(-1)!;
}

async function walk(who: { readonly from: number; readonly chat: number }, label: string): Promise<Shot[]> {
  const { bot, telegram } = build();
  const shots: Shot[] = [];
  const seen = new Set<string>();
  const record = (title: string): Route[] => {
    const call = screenOf(telegram.calls);
    const markup = call.payload['reply_markup'] as Keyboard | undefined;
    const routes: Route[] = [];
    const rows = (markup?.inline_keyboard ?? []).map((row) =>
      row.map((b) => {
        const button = b;
        const route = button.callback_data === undefined ? undefined : decodeNav(button.callback_data);
        if (route !== undefined && !CHANGES.has(route.to)) routes.push(route);
        return { text: button.text, ...(button.url === undefined ? {} : { url: button.url }), ...(route !== undefined && CHANGES.has(route.to) ? { changes: true } : {}) };
      }),
    );
    shots.push({ title: `${label} · ${title}`, html: String(call.payload['text']), rows });
    return routes;
  };
  await bot.handleUpdate(messageUpdate('/start', who));
  seen.add('home');
  const queue = record('/start');
  while (queue.length > 0) {
    const route = queue.shift()!;
    const key = JSON.stringify(route);
    if (route.to === 'home' || seen.has(key)) continue;
    seen.add(key);
    await bot.handleUpdate(callbackUpdate(encodeNav(route), who));
    queue.push(...record(route.to));
  }
  return shots;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Telegram HTML is already escaped and uses only b, i and a; keep those, show line breaks. */
const telegramHtml = (html: string): string => html.replace(/\n/g, '<br>');

function page(sections: ReadonlyArray<{ readonly heading: string; readonly note: string; readonly shots: readonly Shot[] }>): string {
  const phone = (s: Shot) => `
    <figure class="phone">
      <figcaption>${esc(s.title)}</figcaption>
      <div class="chat"><div class="bubble">${telegramHtml(s.html)}</div>
      ${s.rows.map((row) => `<div class="row">${row.map((b) => `<span class="btn${b.url === undefined ? '' : ' url'}${b.changes === true ? ' changes' : ''}">${esc(b.text)}${b.url === undefined ? '' : ' ↗'}</span>`).join('')}</div>`).join('')}
      </div>
    </figure>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PerpGuard Bot Screens</title>
<style>
:root{--page:#07080D;--card:#0F1118;--border:#1C1F2A;--text:#ECEAFB;--muted:#8A8FA3;--accent:#A48BFF;
  --tg-bg:#0E1621;--tg-bub:#1E2C3A;--tg-btn:#28394A;--tg-link:#6AB3F3;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:24px;margin:0 0 6px}h2{font-size:16px;margin:36px 0 4px}
p{color:var(--muted);max-width:76ch;margin:0 0 6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-top:14px}
.phone{margin:0;border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden}
figcaption{padding:8px 12px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border)}
.chat{background:var(--tg-bg);padding:12px}
.bubble{background:var(--tg-bub);border-radius:12px;padding:9px 11px;font-size:13.5px;overflow-wrap:anywhere}
.row{display:flex;gap:4px;margin-top:4px}
.btn{flex:1;text-align:center;background:var(--tg-btn);border-radius:8px;padding:7px 6px;font-size:12.5px}
.btn.url{color:var(--tg-link)}.btn.changes{outline:1px dashed #F5B93C55}
</style></head><body><div class="wrap">
<h1>PerpGuard bot screens</h1>
<p>Generated by <code>pnpm bot:screens</code> from the real bot: every screen reachable by tapping, from /start. Telegram and the account's session are faked; nothing here is a mock-up. A dashed button changes something and was not tapped.</p>
<p>What is not on the menu yet is not built yet: Liquidation Rescue, Copy Trading and the Kill Switch (stop automation) arrive with their phases. Trader figures (Top Traders, the Watchlist, a trader's card) are SAMPLE values here: the generator has no index.</p>
${sections.map((s) => `<h2>${esc(s.heading)}</h2><p>${esc(s.note)}</p><div class="grid">${s.shots.map(phone).join('')}</div>`).join('\n')}
</div></body></html>
`;
}

const owner = await walk({ from: OWNER_ID, chat: OWNER_CHAT }, 'Owner');
const stranger = await walk({ from: STRANGER_ID, chat: STRANGER_CHAT }, 'Anyone');
writeFileSync(
  OUT,
  page([
    { heading: 'Anyone: no wallet, no link', note: 'A stranger watching one account. Every screen is read-only; the Trading Account says Not connected and names the network.', shots: stranger },
    { heading: 'The linked owner', note: 'Account #710 on testnet with one BTC long close to its closing price. Money buttons go through a confirmation; nothing on these screens sends on the first tap.', shots: owner },
  ]),
);
console.log(`wrote ${OUT}: ${stranger.length} public screens, ${owner.length} owner screens`);
