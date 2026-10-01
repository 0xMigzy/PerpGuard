/**
 * The single-account case through the NEW plumbing, live on testnet.
 *
 *   pnpm registry:live
 *
 * Opens the environment account's session in a real AccountRegistry — real
 * venue, real socket, real position source, real risk loop, real executor —
 * waits for its positions to go live, and then sends ONE add-margin of 0.01
 * AUSD to its first open position through the session's executor, exactly as
 * a confirmed Telegram tap would. The outcome printed is the executor's
 * reconciled verdict: the position's margin before and after, not the venue's
 * word. Alerts decided along the way are printed as the recipient would see
 * them, through a recording transport.
 *
 * Needs an open position on the account. `pnpm actions:live --open
 * --no-close --units 1` opens a one-lot BTC long on testnet.
 */
import { PerplVenue, loadAppConfig, loadNetworkConfig, loadPerplCredentials, type AlertRecipient as _R } from '@perpguard/shared';
import { InMemoryActionLog } from '../actions/index.ts';
import { InMemoryAlertLog } from '../alerts/log.pg.ts';
import type { AlertMessage, AlertRecipient, AlertTransport, DeliveryResult } from '../alerts/types.ts';
import { MarketFeed } from '../ingest/marketFeed.ts';
import { AccountRegistry } from '../sessions/registry.ts';

const env = process.env as Record<string, string | undefined>;
const app = loadAppConfig(env);
const network = loadNetworkConfig(app.trading.name, env);
const credentials = loadPerplCredentials(env);
if (credentials.accountId === undefined) throw new Error('PERPL_ACCOUNT_ID is required');
const accountId = credentials.accountId;
const say = (line: string): void => console.log(line);

const venue = new PerplVenue(network, {});
const markets = await venue.getMarkets();
const riskConfigs = await venue.getRiskConfigs();
const feed = new MarketFeed(network.name, app.staleMs);
const unsubscribe = await venue.subscribePrices(markets.map((m) => m.symbol), (u) => feed.record(u));

const delivered: Array<{ recipient: AlertRecipient; message: AlertMessage }> = [];
const transport: AlertTransport = {
  async send(recipient, message): Promise<DeliveryResult> {
    delivered.push({ recipient, message });
    return { ok: true };
  },
};

const registry = new AccountRegistry({
  deps: {
    network,
    markets,
    riskConfigs,
    feed,
    feedStatus: () => venue.feedStatus(),
    actionLog: new InMemoryActionLog(),
    alertLog: new InMemoryAlertLog(),
    transport,
    recipients: (id) => [{ userId: `owner-of-${id}`, rights: 'act' }],
    venueFactory: (c) => new PerplVenue(network, { credentials: c }),
    evaluateIntervalMs: 1_000,
    logger: { info: (m) => say(`  log: ${m}`), warn: (m) => say(`  WARN ${m}`) },
  },
});

say(`== opening the environment session for account ${accountId} in a registry of max ${registry.maxSessions}`);
const opened = registry.open(accountId, { apiKey: credentials.apiKey, secret: credentials.secret });
if (!opened.ok) throw new Error(opened.reason);
const session = opened.session;
for (let i = 0; i < 60; i += 1) {
  if (session.positionSource.status().state === 'live' && venue.feedStatus().state === 'connected') break;
  await new Promise((r) => setTimeout(r, 500));
}
const status = session.status();
say(`  trading ${status.trading.state} as account ${status.trading.accountId}, forwarding ${status.trading.forwardingAllowed}; positions ${status.positions.state}`);
await new Promise((r) => setTimeout(r, 2_500));
const assessments = session.loop.snapshot();
say(`  ${assessments.length} position(s) assessed: ${assessments.map((a) => `${a.symbol} ${a.side} ${a.state} buffer ${a.liqBufferPct === undefined ? '-' : (a.liqBufferPct * 100).toFixed(1) + '%'} (account ${a.accountId})`).join('; ') || 'none'}`);
say(`  alerts decided and delivered so far: ${delivered.length}${delivered.map((d) => ` -> ${d.recipient.userId} [${d.recipient.rights}] "${d.message.title}" actions=${d.message.actions.length} account=${d.message.accountId}`).join('')}`);

const target = assessments.find((a) => a.positionId !== undefined);
if (target === undefined) {
  say('  no open position with a venue id on this account; open one with `pnpm actions:live --open --no-close --units 1` and run again');
} else {
  const amountCNS = 10_000n; // 0.01 AUSD
  say(`== add-margin ${amountCNS} micros to ${target.symbol} (pid ${target.positionId}) through the session's executor`);
  const t0 = Date.now();
  const outcome = await session.executor.execute({
    kind: 'add-margin',
    idempotencyKey: `registry-live-${Date.now()}`,
    userId: `owner-of-${accountId}`,
    accountId,
    marketId: target.marketId,
    symbol: target.symbol,
    positionId: target.positionId,
    amountCNS,
  });
  say(`  outcome after ${Date.now() - t0}ms: ${outcome.kind}`);
  say(`  ${outcome.detail}`);
  if ('reported' in outcome && outcome.reported !== undefined) say(`  venue reported: ${outcome.reported.status}${outcome.reported.reason === undefined ? '' : ` (${outcome.reported.reason})`}`);

  say(`== the same command addressed to another account is refused by this session`);
  const wrong = await session.executor.execute({ kind: 'add-margin', idempotencyKey: `registry-live-wrong-${Date.now()}`, userId: 'x', accountId: accountId + 1, marketId: target.marketId, symbol: target.symbol, positionId: target.positionId, amountCNS });
  say(`  ${wrong.kind}${wrong.kind === 'refused' ? ` (${wrong.code}): ${wrong.detail}` : ''}`);
}

await registry.closeAll();
unsubscribe();
venue.disconnect();
say('== session closed');
