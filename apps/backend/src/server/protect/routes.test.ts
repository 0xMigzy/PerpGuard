/**
 * The Protect API through Fastify's inject. The tests that matter: nothing
 * leaks to an anonymous visitor, the confirmation is the bot's own text, and
 * an sr 32 top-up is shown as APPLIED with the venue's "Failed" beside it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { ActionAvailability, MarketRiskConfig, VenuePosition } from '@perpguard/shared';
import type { ActionCommand, ActionOutcome } from '../../actions/types.ts';
import type { RiskAssessment } from '../../risk/types.ts';
import { DEFAULT_THRESHOLDS } from '../../risk/types.ts';
import { ActionProgressTracker } from './progress.ts';
import { registerProtectRoutes, type ProtectView } from './routes.ts';
import { LinkCodeStore, SessionStore, WebPendingActionStore } from './session.ts';

const NOW = 1_790_000_000_000;
const BTC: MarketRiskConfig = { marketId: 16, symbol: 'BTC', priceDecimals: 1, lotDecimals: 5, collateralDecimals: 6, maintenanceMargin: 2500, initialMargin: 5000 };

const assessment = (over: Partial<RiskAssessment> = {}): RiskAssessment => ({
  marketId: 16, symbol: 'BTC', side: 'long', positionId: 4242, state: 'DANGER', previousState: 'WATCH', lastKnownState: 'DANGER',
  liqBufferPct: 0.0266, liquidationPricePNS: 817_701n, markPricePNS: 840_073n,
  topUp: {
    clearDanger: { amountCNS: 561_460_000n, targetBufferPct: 0.04, resultingBufferPct: 0.04, resultingLiquidationPricePNS: 806_471n },
    toSafe: { amountCNS: 2_661_500_000n, targetBufferPct: 0.09, resultingBufferPct: 0.09, resultingLiquidationPricePNS: 764_467n },
  },
  marginToSurviveCNS: 0n,
  metrics: { notionalCNS: 42_003_650_000n, entryNotionalCNS: 42_014_750_000n, unrealisedPnlCNS: -11_100_000n, maintenanceMarginCNS: 1_680_590_000n, maintenanceMarginRatio: 0.04, equityCNS: 2_799_230_000n, liquidationPricePNS: 817_701n, liqBufferPct: 0.0266, pnlPctOfMargin: -0.004, isLiquidatable: false, marginToSurviveCNS: 0n },
  feed: 'connected', positions: 'live', positionsAgeMs: 500, priceAgeMs: 168, priceIsOld: false, heldOnStalePrice: false, reason: 'buffer 2.66% fell to DANGER', atMs: NOW,
  ...over,
});

const venuePosition: VenuePosition = { venue: 'perpl', network: 'testnet', symbol: 'BTC', marketId: 16, positionId: 4242, side: 'long', size: 0.5, entryPrice: 84_029.5, margin: 2_810.33, marginMode: 'isolated', leverage: 15, fundingAccrued: 0 };

const command = (): ActionCommand => ({ kind: 'add-margin', idempotencyKey: 'k', userId: 'trader-1', marketId: 16, symbol: 'BTC', positionId: 4242, amountCNS: 562_000_000n });

const SR32_APPLIED = (cmd: ActionCommand): ActionOutcome => ({
  kind: 'applied', command: cmd, at: NOW,
  reported: { status: 'rejected', reason: 'st 7 Failed, sr 32 OrderDescIdTooLow', venueRef: 'rq-12' },
  reconciliation: { verdict: 'applied', field: 'margin', requested: 562_000_000n, before: 2_810_330_000n, after: 3_372_330_000n, delta: 562_000_000n, detail: 'margin is now 3372330000 (was 2810330000): 562000000 micros applied, 562000000 requested — LANDED' },
  detail: 'add-margin on BTC LANDED: margin is now 3372330000 (was 2810330000). The venue reported it as rejected — rejected (st 7 Failed, sr 32 OrderDescIdTooLow) — which for this order type is the normal report for a top-up that worked. The position is the evidence; nothing was re-sent.',
});
const NOT_APPLIED = (cmd: ActionCommand): ActionOutcome => ({
  kind: 'not-applied', command: cmd, at: NOW,
  reported: { status: 'forwarded', reason: undefined, venueRef: 'rq-13' },
  reconciliation: { verdict: 'not-applied', field: 'margin', requested: 562_000_000n, before: 2_810_330_000n, after: 2_810_330_000n, delta: 0n, detail: 'margin is unchanged' },
  detail: 'add-margin on BTC did not land: margin is unchanged. The venue reported forwarded.',
});
const UNKNOWN = (cmd: ActionCommand): ActionOutcome => ({
  kind: 'unknown', command: cmd, at: NOW,
  reported: { status: 'timeout', reason: 'no mt 24', venueRef: undefined },
  reconciliation: { verdict: 'unknown', field: 'margin', requested: 562_000_000n, before: 2_810_330_000n, after: 2_820_000_000n, delta: 9_670_000n, detail: 'margin moved by 9670000 micros but 562000000 were requested' },
  detail: 'add-margin on BTC cannot be resolved. The venue reported timeout (no mt 24).',
  nextStep: 'Read the position and its history before anything else. Do NOT send this action again on the strength of this outcome.',
});

interface Harness {
  readonly app: ReturnType<typeof Fastify>;
  readonly progress: ActionProgressTracker;
  readonly codes: LinkCodeStore;
  readonly executed: ActionCommand[];
}

function harness(options: {
  assessments?: readonly RiskAssessment[];
  outcome?: (cmd: ActionCommand) => ActionOutcome;
  availability?: ActionAvailability;
  inFlight?: boolean;
  blind?: boolean;
  devLinkMint?: boolean;
  demoEnabled?: boolean;
} = {}): Harness {
  const app = Fastify({ logger: false });
  const progress = new ActionProgressTracker({ now: () => NOW });
  const codes = new LinkCodeStore({ now: () => NOW, nextCode: () => 'ABCD-EFGH' });
  const executed: ActionCommand[] = [];
  const assessments = options.assessments ?? [assessment()];
  const view: ProtectView = {
    network: 'testnet',
    snapshot: () => assessments,
    feedStatus: () => ({ state: 'connected', reconnectAttempt: 0 }),
    positionsStatus: () => ({ state: 'live', lastUpdateMs: NOW - 500, ageMs: 500 }),
    projectAddMargin: (marketId, amountCNS) =>
      options.blind
        ? { ok: false, reason: 'I cannot currently see BTC: the price feed is disconnected' }
        : { ok: true, projection: { marketId, symbol: 'BTC', side: 'long', amountCNS, notionalCNS: 42_003_650_000n, markPricePNS: 840_073n, resultingBufferPct: amountCNS === 0n ? 0.0266 : 0.05, resultingLiquidationPricePNS: 800_000n } },
    sightedBook: () =>
      options.blind
        ? { ok: false, reason: 'I cannot currently see BTC' }
        : { ok: true, positions: [{ marketId: 16, symbol: 'BTC', side: 'long', lotLNS: 50_000n, entryPricePNS: 840_295n, depositCNS: 2_810_330_000n, fundingCNS: 0n }], markPrices: new Map([[16, 840_073n]]), configs: new Map([[16, BTC]]), positionIds: new Map([[16, 4242]]) },
    positions: () => [venuePosition],
    thresholds: () => DEFAULT_THRESHOLDS,
  };
  registerProtectRoutes(app, {
    userId: 'trader-1',
    view,
    configs: new Map([[16, BTC], [32, { ...BTC, marketId: 32, symbol: 'ETH', priceDecimals: 2 }]]),
    sessions: new SessionStore({ now: () => NOW, nextToken: () => 'session-token' }),
    linkCodes: codes,
    pending: new WebPendingActionStore({ now: () => NOW }),
    progress,
    freeBalance: () => ({ known: true, floorCNS: 4_120_000_000n }),
    availability: async () => options.availability ?? { actionable: true, network: 'testnet', marketId: 16 },
    inFlightOn: () => (options.inFlight ? { marketId: 16, idempotencyKey: 'trader-1:16:clear-danger:tg-abc', claimedAtMs: NOW - 3_000 } : undefined),
    runner: {
      execute: async (cmd) => {
        executed.push(cmd);
        progress.record({ idempotencyKey: cmd.idempotencyKey, stage: 'sending' });
        const outcome = (options.outcome ?? SR32_APPLIED)(cmd);
        if (outcome.kind !== 'refused') progress.record({ idempotencyKey: cmd.idempotencyKey, stage: 'reconciling', reported: outcome.reported });
        return outcome;
      },
    },
    accountId: () => 710,
    forwardingAllowed: () => true,
    devLinkMint: options.devLinkMint ?? false,
    demoEnabled: options.demoEnabled ?? false,
    alertsView: {
      recent: async () => [
        { alertKey: '16:DANGER:1', userId: 'trader-1', marketId: 16, symbol: 'BTC', kind: 'danger', state: 'DANGER', previousState: 'WATCH', text: 'DANGER · BTC long', actions: [{ type: 'add-margin', intent: 'clear-danger', marketId: 16, symbol: 'BTC', positionId: 4242, amountCNS: 562_000_000n, label: 'Add 562 → buffer 4.0%, liquidation 80,647.1' }], attempts: 1, outcome: 'delivered', lastError: undefined, createdAtMs: NOW - 10_000, deliveredAtMs: NOW - 9_000 },
      ],
      status: () => ({ transportConfigured: true, durableLog: true, delivered: 3, failed: 0, lastDeliveredAtMs: NOW - 9_000, lastDelivered: 'BTC DANGER' }),
      linkedAtMs: () => NOW - 60_000,
      botUsername: () => 'PerpGuardBot',
      historyFor: () => ({ marketId: 16, lastSentAtMs: { DANGER: NOW - 10_000 }, lastAlertedSeverity: 'DANGER', watchAlertedThisEntry: false, announcedOutages: [] }),
    },
    now: () => NOW,
  });
  return { app, progress, codes, executed };
}

const COOKIE = 'pg_session=session-token';
async function signIn(h: Harness): Promise<string> {
  h.codes.mint('trader-1');
  const r = await h.app.inject({ method: 'POST', url: '/api/protect/session', payload: { code: 'abcd-efgh' } });
  assert.equal(r.statusCode, 200);
  return r.headers['set-cookie'] as string;
}
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

test('an anonymous visitor gets 401 from every gated route and learns nothing', async () => {
  const h = harness();
  for (const [method, url] of [['GET', '/api/protect/me'], ['GET', '/api/protect/positions'], ['POST', '/api/protect/prepare'], ['POST', '/api/protect/execute'], ['GET', '/api/protect/actions/x'], ['POST', '/api/protect/stress']] as const) {
    const r = await h.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    assert.equal(r.statusCode, 401, `${method} ${url}`);
    assert.doesNotMatch(r.payload, /710|BTC|4242/, 'no account detail in a refusal');
  }
  await h.app.close();
});

test('a link code opens an HttpOnly session once; a wrong or reused code is a flat 401', async () => {
  const h = harness();
  const bad = await h.app.inject({ method: 'POST', url: '/api/protect/session', payload: { code: 'nope' } });
  assert.equal(bad.statusCode, 401);
  const cookie = await signIn(h);
  assert.match(cookie, /^pg_session=session-token; Path=\/; HttpOnly; SameSite=Lax/);
  const reuse = await h.app.inject({ method: 'POST', url: '/api/protect/session', payload: { code: 'ABCD-EFGH' } });
  assert.equal(reuse.statusCode, 401, 'one use');
  const me = await h.app.inject({ method: 'GET', url: '/api/protect/me', headers: { cookie: COOKIE } });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), { userId: 'trader-1', network: 'testnet', accountId: 710, role: 'owner', method: 'code', expiresAtMs: NOW + 12 * 3_600_000 });
  const out = await h.app.inject({ method: 'DELETE', url: '/api/protect/session', headers: { cookie: COOKIE } });
  assert.match(out.headers['set-cookie'] as string, /Max-Age=0/);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/protect/me', headers: { cookie: COOKIE } })).statusCode, 401);
  await h.app.close();
});

test('positions carry the bot\'s option labels, the buffer in words, and a negative buffer as past liquidation', async () => {
  const h = harness({ assessments: [assessment(), assessment({ marketId: 32, symbol: 'ETH', side: 'short', positionId: 7, state: 'PAST_LIQUIDATION', liqBufferPct: -0.014, topUp: undefined })] });
  await signIn(h);
  const r = await h.app.inject({ method: 'GET', url: '/api/protect/positions', headers: { cookie: COOKIE } });
  assert.equal(r.statusCode, 200);
  const body = r.json() as { accountId: number; positions: Array<Record<string, unknown>>; freeBalance: { floorAusd: number }; notes: string[] };
  assert.equal(body.accountId, 710);
  assert.equal(body.freeBalance.floorAusd, 4120);
  const [eth, btc] = body.positions;
  assert.equal(eth!['symbol'], 'ETH', 'worst first');
  assert.equal(eth!['bufferText'], 'past liquidation');
  assert.equal(eth!['liqBufferPct'], -0.014, 'signed, so the page can never print it as a small number by accident');
  assert.equal(btc!['bufferText'], 'buffer 2.7%');
  assert.equal(btc!['size'], 0.5);
  assert.equal(btc!['leverage'], 15);
  const options = btc!['options'] as Array<{ intent: string; label: string; amountCNS: string }>;
  assert.equal(options[0]!.label, 'Add 562 → buffer 4.0%, liquidation 80,647.1');
  assert.equal(options[0]!.amountCNS, '562000000', 'the CEILED figure the label shows');
  assert.equal(options[1]!.label, 'Add 2,662 → buffer 9.0%, liquidation 76,446.7');
  assert.match(body.notes.length === 0 ? 'ok' : body.notes[0]!, /ok|configuration/);
  await h.app.close();
});

test('the confirmation is the bot\'s own text, ending with "Nothing has been sent yet."', async () => {
  const h = harness();
  await signIn(h);
  const r = await h.app.inject({ method: 'POST', url: '/api/protect/prepare', headers: { cookie: COOKIE }, payload: { kind: 'add-margin', marketId: 16, intent: 'clear-danger' } });
  assert.equal(r.statusCode, 200);
  const p = r.json() as { title: string; lines: string[]; token: string };
  assert.equal(p.title, 'Confirm — add margin to BTC');
  assert.equal(p.lines[0], 'Add 562 → buffer 4.0%, liquidation 80,647.1');
  assert.equal(p.lines[1], 'Exact amount sent: 562.000000 AUSD.');
  assert.equal(p.lines.at(-1), 'Nothing has been sent yet.');

  const custom = await h.app.inject({ method: 'POST', url: '/api/protect/prepare', headers: { cookie: COOKIE }, payload: { kind: 'add-margin', marketId: 16, intent: 'custom', amount: '5,000' } });
  const c = custom.json() as { lines: string[] };
  assert.equal(c.lines[0], 'Add 5,000 → buffer 5.0%, liquidation 80,000.0');
  assert.ok(c.lines.some((l) => /more than your free balance/.test(l)), 'the floor warns and does not refuse');
  assert.equal(c.lines.at(-1), 'Nothing has been sent yet.');

  const typo = await h.app.inject({ method: 'POST', url: '/api/protect/prepare', headers: { cookie: COOKIE }, payload: { kind: 'add-margin', marketId: 16, intent: 'custom', amount: 'lots' } });
  assert.equal(typo.statusCode, 400);
  await h.app.close();
});

test('an in-flight action refuses a second confirmation screen and names what is running', async () => {
  const h = harness({ inFlight: true });
  await signIn(h);
  const r = await h.app.inject({ method: 'POST', url: '/api/protect/prepare', headers: { cookie: COOKIE }, payload: { kind: 'add-margin', marketId: 16, intent: 'clear-danger' } });
  assert.equal(r.statusCode, 409);
  assert.match((r.json() as { error: string }).error, /already in flight .* Refusing rather than queueing/);
  const snap = await h.app.inject({ method: 'GET', url: '/api/protect/positions', headers: { cookie: COOKIE } });
  const btc = (snap.json() as { positions: Array<{ inFlight?: { idempotencyKey: string } }> }).positions[0]!;
  assert.equal(btc.inFlight?.idempotencyKey, 'trader-1:16:clear-danger:tg-abc', 'the page can say it was started from Telegram');
  const closed = harness({ availability: { actionable: false, network: 'testnet', code: 'market-closed', reason: 'the venue has BTC closed' } });
  await signIn(closed);
  const c = await closed.app.inject({ method: 'POST', url: '/api/protect/prepare', headers: { cookie: COOKIE }, payload: { kind: 'close-position', marketId: 16 } });
  assert.equal(c.statusCode, 409);
  await h.app.close();
  await closed.app.close();
});

test('sr 32: the venue says Failed, the position says applied, and the page gets BOTH with no retry', async () => {
  const h = harness();
  await signIn(h);
  const prep = (await h.app.inject({ method: 'POST', url: '/api/protect/prepare', headers: { cookie: COOKIE }, payload: { kind: 'add-margin', marketId: 16, intent: 'clear-danger' } })).json() as { token: string };
  const exec = await h.app.inject({ method: 'POST', url: '/api/protect/execute', headers: { cookie: COOKIE }, payload: { token: prep.token } });
  assert.equal(exec.statusCode, 202);
  const { idempotencyKey } = exec.json() as { idempotencyKey: string };
  assert.match(idempotencyKey, /^trader-1:16:clear-danger:web-/);
  const again = await h.app.inject({ method: 'POST', url: '/api/protect/execute', headers: { cookie: COOKIE }, payload: { token: prep.token } });
  assert.equal(again.statusCode, 404, 'a double click is one submission');
  await settle();
  assert.equal(h.executed[0]!.kind === 'add-margin' && h.executed[0]!.amountCNS, 562_000_000n, 'sent verbatim');
  const r = await h.app.inject({ method: 'GET', url: `/api/protect/actions/${idempotencyKey}`, headers: { cookie: COOKIE } });
  const p = r.json() as { stage: string; reported: { status: string; reason: string }; outcome: { kind: string; text: string; retryToken?: string; reconciliation: { verdict: string; before: string; after: string } } };
  assert.equal(p.stage, 'settled');
  assert.equal(p.reported.status, 'rejected');
  assert.match(p.reported.reason, /sr 32/);
  assert.equal(p.outcome.kind, 'applied');
  assert.equal(p.outcome.reconciliation.verdict, 'applied');
  assert.equal(p.outcome.reconciliation.after, '3372330000');
  assert.match(p.outcome.text, /^Done — the margin is in/);
  assert.equal(p.outcome.retryToken, undefined);
  await h.app.close();
});

test('not-applied earns a fresh token; unknown gets a next step and never a token', async () => {
  for (const [outcome, expectToken] of [[NOT_APPLIED, true], [UNKNOWN, false]] as const) {
    const h = harness({ outcome });
    await signIn(h);
    const prep = (await h.app.inject({ method: 'POST', url: '/api/protect/prepare', headers: { cookie: COOKIE }, payload: { kind: 'add-margin', marketId: 16, intent: 'to-safe' } })).json() as { token: string };
    const { idempotencyKey } = (await h.app.inject({ method: 'POST', url: '/api/protect/execute', headers: { cookie: COOKIE }, payload: { token: prep.token } })).json() as { idempotencyKey: string };
    await settle();
    const p = (await h.app.inject({ method: 'GET', url: `/api/protect/actions/${idempotencyKey}`, headers: { cookie: COOKIE } })).json() as { outcome: { kind: string; retryToken?: string; nextStep?: string } };
    assert.equal(p.outcome.retryToken !== undefined, expectToken, p.outcome.kind);
    if (!expectToken) assert.match(p.outcome.nextStep!, /Do NOT send this action again/);
    if (expectToken) {
      const r = await h.app.inject({ method: 'POST', url: '/api/protect/execute', headers: { cookie: COOKIE }, payload: { token: p.outcome.retryToken } });
      assert.equal(r.statusCode, 202, 'Send again is a fresh action with a fresh key');
      assert.notEqual((r.json() as { idempotencyKey: string }).idempotencyKey, idempotencyKey);
    }
    await h.app.close();
  }
});

test('the alerts view serves history, delivery counts and link state, never a chat id', async () => {
  const h = harness();
  await signIn(h);
  const r = await h.app.inject({ method: 'GET', url: '/api/protect/alerts?limit=5', headers: { cookie: COOKIE } });
  assert.equal(r.statusCode, 200);
  const a = r.json() as { telegram: Record<string, unknown>; delivery: { delivered: number }; rules: { cooldowns: Array<{ symbol: string; bySeverity: Array<{ severity: string; nextAllowedAtMs: number }> }> }; history: Array<{ symbol: string; actions: string[]; outcome: string }> };
  assert.equal(a.telegram['linked'], true);
  assert.equal(a.telegram['linkedAtMs'], NOW - 60_000);
  assert.equal(a.telegram['botUsername'], 'PerpGuardBot');
  assert.equal('chatId' in a.telegram, false, 'the chat id never leaves the link store');
  assert.equal(a.delivery.delivered, 3);
  assert.equal(a.history[0]!.symbol, 'BTC');
  assert.deepEqual(a.history[0]!.actions, ['Add 562 → buffer 4.0%, liquidation 80,647.1']);
  assert.equal(a.history[0]!.outcome, 'delivered');
  assert.equal(a.rules.cooldowns[0]!.symbol, 'BTC');
  assert.equal(a.rules.cooldowns[0]!.bySeverity[0]!.severity, 'DANGER');
  assert.equal(a.rules.cooldowns[0]!.bySeverity[0]!.nextAllowedAtMs, NOW - 10_000 + 15 * 60_000);
  assert.equal(JSON.stringify(a).includes('4242'), false, 'no position id in the alerts view');
  await h.app.close();
});

test('the stress test comes from the engine, and refuses while blind', async () => {
  const h = harness();
  await signIn(h);
  const r = await h.app.inject({ method: 'POST', url: '/api/protect/stress', headers: { cookie: COOKIE }, payload: { priceMoveFraction: -0.05 } });
  const s = r.json() as { ok: boolean; perPosition: Array<{ symbol: string; survives: boolean; bufferAfterPct: number }>; liquidatedCount: number };
  assert.equal(s.ok, true);
  assert.equal(s.perPosition[0]!.symbol, 'BTC');
  assert.equal(s.perPosition[0]!.survives, false, 'a 2.7% buffer does not survive a 5% fall');
  assert.equal(s.liquidatedCount, 1);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/protect/stress', headers: { cookie: COOKIE }, payload: { priceMoveFraction: 'x' } })).statusCode, 400);
  const blind = harness({ blind: true });
  await signIn(blind);
  const b = (await blind.app.inject({ method: 'POST', url: '/api/protect/stress', headers: { cookie: COOKIE }, payload: { priceMoveFraction: -0.05 } })).json() as { ok: boolean; reason: string };
  assert.equal(b.ok, false);
  await h.app.close();
  await blind.app.close();
});

test('the dev mint is 404 unless enabled, and loopback only when it is', async () => {
  const off = harness();
  assert.equal((await off.app.inject({ method: 'GET', url: '/dev/link-code' })).statusCode, 404);
  const on = harness({ devLinkMint: true });
  assert.equal((await on.app.inject({ method: 'GET', url: '/dev/link-code', remoteAddress: '10.0.0.7' })).statusCode, 403);
  const minted = await on.app.inject({ method: 'GET', url: '/dev/link-code', remoteAddress: '127.0.0.1' });
  assert.equal(minted.statusCode, 200);
  assert.equal((minted.json() as { code: string }).code, 'ABCD-EFGH');
  await off.app.close();
  await on.app.close();
});

// ── demo sessions ───────────────────────────────────────────────────────────

test('the public config says what the card may offer and nothing about the account', async () => {
  const h = harness({ demoEnabled: true });
  const r = await h.app.inject({ method: 'GET', url: '/api/protect/config' });
  assert.deepEqual(r.json(), { demoEnabled: true, network: 'testnet' });
  await h.app.close();
});

test('an anonymous demo session needs demo mode on, may look, and may never act', async () => {
  const off = harness();
  assert.equal((await off.app.inject({ method: 'POST', url: '/api/protect/session', payload: { demo: true } })).statusCode, 403);
  const on = harness({ demoEnabled: true });
  const r = await on.app.inject({ method: 'POST', url: '/api/protect/session', payload: { demo: true } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual((({ role, method, userId }) => ({ role, method, userId }))(r.json() as { role: string; method: string; userId: string }), { role: 'demo', method: 'demo', userId: 'demo' });
  const me = await on.app.inject({ method: 'GET', url: '/api/protect/me', headers: { cookie: COOKIE } });
  assert.equal((me.json() as { role: string }).role, 'demo');
  const look = await on.app.inject({ method: 'GET', url: '/api/protect/positions', headers: { cookie: COOKIE } });
  assert.equal(look.statusCode, 200, 'a demo may look');
  const act = await on.app.inject({ method: 'POST', url: '/api/protect/prepare', headers: { cookie: COOKIE }, payload: { kind: 'add-margin', marketId: 16, intent: 'clear-danger' } });
  assert.equal(act.statusCode, 403, 'a demo may not act');
  assert.match((act.json() as { error: string }).error, /read-only demo/);
  const exec = await on.app.inject({ method: 'POST', url: '/api/protect/execute', headers: { cookie: COOKIE }, payload: { token: 'anything' } });
  assert.equal(exec.statusCode, 403);
  await off.app.close();
  await on.app.close();
});

test('SECURITY: a code minted for another identity (a /link code) opens no session here, and is used up', async () => {
  const h = harness();
  h.codes.mint('tg:4242');
  const r = await h.app.inject({ method: 'POST', url: '/api/protect/session', payload: { code: 'abcd-efgh' } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.headers['set-cookie'], undefined);
  const gated = await h.app.inject({ method: 'GET', url: '/api/protect/positions' });
  assert.equal(gated.statusCode, 401);
  assert.equal(h.codes.redeem('abcd-efgh'), undefined, 'consumed: it cannot then be redeemed on /link');
});
