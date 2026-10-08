/**
 * The fake world both bot generators drive (`bot-screens.ts`, `bot-map.ts`):
 * the REAL `createBot`, with only Telegram's wire and the account's session
 * faked (the same fakes the bot's tests use). Nothing is sent anywhere.
 */
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
  dangerScenario,
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

export const STRANGER_CHAT = 7_777;
export const CHANGES = new Set<string>(['disconnect', 'unwatch', 'warn-set', 'connect-go', 'connect-key', 'watch-id', 'star', 'unstar', 'liq-set', 'big-set', 'warn-preset', 'wallet-alerts', 'rescue-on', 'rescue-stop', 'rescue-resume', 'rescue-lim', 'kill-stop', 'kill-resume', 'close-retry-go', 'stop-all-go']);

/** SAMPLE trader figures: the generator has no index. Labelled as samples on the page. */
const sampleRow = (accountId: number, netPnlAusd: number, depositedAusd: number, roundTrips: number): TraderRow => ({
  accountId, address: '', netPnlAusd, volumeAusd: 0, tradeCount: roundTrips * 2, roundTrips, wins: Math.round(roundTrips * 0.6), losses: Math.round(roundTrips * 0.4),
  winRate: roundTrips >= 10 ? 0.6 : undefined, liquidationCount: 0, rescuableLiquidationCount: 0, marginLostAusd: 0, maxSpareHeldAusd: undefined,
  depositedAusd, withdrawnAusd: 0, netFlowAusd: 0, freeBalanceAusd: 0, openPositionCount: 1, lastActiveAtMs: 0, roiPct: depositedAusd >= 100 ? (netPnlAusd / depositedAusd) * 100 : undefined,
});
export const sampleTraders = {
  stats: async (accountId: number) => ({ accountId, month: sampleRow(accountId, 1_250, 0, 42), lifetime: sampleRow(accountId, 21_147, 2_045, 24_944) }),
};

/** The one part of Telegram's reply markup this reads. */
export interface Keyboard {
  readonly inline_keyboard?: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly callback_data?: string; readonly url?: string }>>;
}

export interface Shot {
  readonly title: string;
  readonly html: string;
  readonly rows: readonly (readonly { readonly text: string; readonly url?: string; readonly changes?: boolean }[])[];
}

/**
 * `link` and `resolver` add the two pieces the screens document leaves out
 * (it shows no link minting and resolves nothing); the map turns them on so
 * /link and a pasted address are covered too.
 */
/** A top-up that lands the way `t: 6` really does: applied, with the venue reporting it rejected. */
function appliedExecutor(): FakeExecutor {
  const executor = new FakeExecutor();
  executor.outcome = { kind: 'applied', detail: 'The margin is in: I checked the position itself.', venueRejected: true } as never;
  return executor;
}

export function build(options: { readonly link?: boolean; readonly resolver?: boolean } = {}) {
  const { bot, telegram } = fakeBot();
  const view = new FakeView();
  // The document shows the trading network the product ships on.
  Object.defineProperty(view, 'network', { value: 'testnet' });
  // The loop that produced the sample position, so amounts are priced by the real engine.
  const scenario = dangerScenario();
  view.loop = scenario.loop;
  view.assessments = [scenario.assessment];
  const watchStore = new InMemoryWatchStore({ maxPerChat: 10 });
  watchStore.add({ chatId: STRANGER_CHAT, accountId: 4088, label: '#4088', addedAtMs: 0, starred: true });
  // The real control and kill switch over in-memory stores, so the document shows the real screens.
  const automation = new InMemoryAutomationStore();
  const rescueStore = new InMemoryRescueStore();
  const killSwitch = new KillSwitch({ automation, rescueStore, rescueEngine: { inFlightOn: () => false, settleAccount: async () => true }, log: () => {} });
  const built = createBot({
    config: { token: TEST_TOKEN, userId: USER_ID, ownerTelegramUserId: undefined },
    links: newLinks(),
    store: newStore(),
    sessions: new StaticSessionRouter([{ accountId: 710, view, executor: appliedExecutor(), balance: new FakeBalance(), status: () => ({ trading: { state: 'signed-in', forwardingAllowed: true } }) }]),
    ownerAccountId: 710,
    tradingNetwork: 'testnet',
    ...(options.link === true
      ? {
          link: {
            mint: () => ({ url: 'https://perpguard.app/link?code=ABCD-EFGH', expiresAtMs: Date.now() + 5 * 60_000 }),
            unlink: async () => ({ ok: true, text: 'Unlinked from account 710. The session is closed.' }),
          },
        }
      : {}),
    configs: CONFIGS,
    webUrl: 'https://perpguard.app',
    botInfo: bot.botInfo,
    watch: {
      store: watchStore,
      resolver: options.resolver === true ? { resolve: async () => ({ accountId: 4532, address: '0xb7854953a71e45d1033b3d619e76d56391291765', resolvedBy: 'index' as const }) } : { resolve: async () => ({ error: 'not in this document' }) },
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

