/**
 * The Protect API: the web front door to the actions layer.
 *
 * TWO FRONT DOORS, ONE SET OF RULES. Everything a button here does goes through
 * the same `ActionsExecutor` the Telegram bot uses — the same one-in-flight
 * lease, the same reconciliation, the same refusal to retry — and the
 * confirmation screen is rendered by the bot's own `renderConfirmation`, so a
 * trader reads the same words on the phone and on the page.
 *
 * PRIVATE. Every route except signing in answers 401 without a session cookie,
 * and the session is opened only by a one-time code the bot issued to the
 * linked chat (or the operator minted from their own terminal in dev). The
 * page never learns an account id before that.
 *
 * NOTHING HERE DOES RISK MATHS. Projections come from the loop, stress numbers
 * from the engine, confirmation text from the renderers.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  killSwitchPlan,
  stressTest,
  type ActionAvailability,
  type FeedHealth,
  type MarketRiskConfig,
  type NetworkName,
  type PositionSourceStatus,
  type VenuePosition,
} from '@perpguard/shared';
import {
  customAction,
  describeExecutionOutcome,
  positionEntries,
  renderConfirmation,
  validateCustomAmount,
  type FreeBalanceReading,
} from '@perpguard/bot';
import { scaledToNumber } from '@perpguard/shared';
import { DEFAULT_ALERT_CONFIG, type AlertConfig } from '../../alerts/types.ts';
import { fireKillSwitch, describeKillSwitch } from '../../actions/killSwitch.ts';
import type { ActionCommand, ActionOutcome } from '../../actions/types.ts';
import type { Lease } from '../../actions/inflight.ts';
import type { MarginProjectionResult, RiskAssessment } from '../../risk/types.ts';
import type { RiskThresholds } from '../../risk/types.ts';
import type { SightedBook } from '../../risk/loop.ts';
import type { ActionProgressTracker } from './progress.ts';
import {
  LINK_CODE_TTL_MS,
  SESSION_COOKIE,
  clearSessionCookie,
  parseCookies,
  sessionCookie,
  type LinkCodeStore,
  type PendingIntent,
  type SessionStore,
  type WebPendingActionStore,
} from './session.ts';
import { renderCloseConfirmation, renderKillSwitchConfirmation, toProtectKillSwitch, toProtectOutcome, toProtectPosition, toProtectStress } from './dto.ts';
import type { PrepareRequest, Prepared, ProtectAlerts, ProtectConfig, ProtectFreeBalance, ProtectSession, ProtectSnapshot } from './types.ts';
import type { Session } from './session.ts';
import type { AlertHistory, AlertLogEntry } from '../../alerts/types.ts';
import type { AlertDeliveryStatus } from '../health.ts';

/** What the routes read from the risk side. All synchronous, like the bot's view. */
export interface ProtectView {
  readonly network: NetworkName;
  snapshot(): readonly RiskAssessment[];
  feedStatus(): FeedHealth;
  positionsStatus(): PositionSourceStatus;
  projectAddMargin(marketId: number, amountCNS: bigint): MarginProjectionResult;
  sightedBook(): SightedBook;
  /** The venue's own rows, for size, entry and leverage. */
  positions(): readonly VenuePosition[];
  thresholds(): RiskThresholds;
}

export interface ProtectRouteOptions {
  readonly userId: string;
  readonly view: ProtectView;
  readonly configs: ReadonlyMap<number, MarketRiskConfig>;
  readonly alerts?: AlertConfig;
  readonly sessions: SessionStore;
  readonly linkCodes: LinkCodeStore;
  readonly pending: WebPendingActionStore;
  readonly progress: ActionProgressTracker;
  readonly freeBalance: () => FreeBalanceReading;
  readonly availability: (symbol: string) => Promise<ActionAvailability>;
  readonly inFlightOn: (marketId: number) => Lease | undefined;
  readonly runner: { execute(command: ActionCommand): Promise<ActionOutcome> };
  readonly accountId: () => number | undefined;
  readonly forwardingAllowed: () => boolean | undefined;
  /** What the Alerts page reads. Absent when no alert engine is wired. */
  readonly alertsView?: {
    recent(userId: string, limit: number): Promise<readonly AlertLogEntry[]>;
    status(): AlertDeliveryStatus;
    /** Link records for this user, chat ids stripped by the caller. */
    linkedAtMs(userId: string): number | undefined;
    botUsername(): string | undefined;
    historyFor(marketId: number): AlertHistory | undefined;
  };
  /** Lets anyone open a READ-ONLY session on the monitored account. Judge-facing; off unless said so. */
  readonly demoEnabled?: boolean;
  /** DEV ONLY: mint a code from the loopback interface. Never on by default. */
  readonly devLinkMint?: boolean;
  readonly now?: () => number;
  readonly logger?: { info(message: string): void; warn(message: string): void };
  readonly prefix?: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function registerProtectRoutes(app: FastifyInstance, options: ProtectRouteOptions): FastifyInstance {
  const prefix = options.prefix ?? '/api/protect';
  const alerts = options.alerts ?? DEFAULT_ALERT_CONFIG;
  const now = options.now ?? Date.now;
  const log = options.logger ?? { info: () => {}, warn: () => {} };

  const isSecure = (request: FastifyRequest): boolean =>
    request.protocol === 'https' || String(request.headers['x-forwarded-proto'] ?? '').startsWith('https');

  const sessionOf = (request: FastifyRequest) => options.sessions.get(parseCookies(request.headers.cookie)[SESSION_COOKIE]);

  // ── dev mint, off the API prefix so the browser's proxy cannot reach it ───
  app.get('/dev/link-code', async (request, reply) => {
    if (options.devLinkMint !== true) return reply.code(404).send({ error: 'not found' });
    if (!LOOPBACK.has(request.ip)) return reply.code(403).send({ error: 'loopback only' });
    const minted = options.linkCodes.mint(options.userId);
    log.info('dev link code minted for the web app');
    return { code: minted.code, expiresAtMs: minted.expiresAtMs, ttlMs: LINK_CODE_TTL_MS };
  });

  // ── what the sign-in card may know before anyone is signed in ─────────────
  app.get(`${prefix}/config`, async (): Promise<ProtectConfig> => ({
    demoEnabled: options.demoEnabled === true,
    network: options.view.network,
  }));

  const describe = (session: Session): ProtectSession => ({
    userId: session.userId,
    network: options.view.network,
    accountId: options.accountId(),
    role: session.role,
    method: session.method,
    wallet: session.wallet,
    ownAccountId: session.ownAccountId,
    expiresAtMs: session.expiresAtMs,
  });

  const open = (reply: FastifyReply, request: FastifyRequest, session: Session): ProtectSession => {
    reply.header('set-cookie', sessionCookie(session.token, { secure: isSecure(request), maxAgeSec: (session.expiresAtMs - now()) / 1000 }));
    return describe(session);
  };

  // ── sign in / out ─────────────────────────────────────────────────────────
  //
  // TWO WAYS IN, ONE SHAPE OUT. A bot code proves the linked person; a demo
  // request proves nothing and gets a read-only look at the monitored account,
  // only where the operator has allowed that. (Wallet sign-in moved to /link,
  // which proves ownership with a signed challenge; no page calls these routes.)
  app.post<{ Body: { code?: unknown; demo?: unknown } }>(`${prefix}/session`, async (request, reply) => {
    const body = request.body ?? {};

    if (body.demo === true) {
      if (options.demoEnabled !== true) return reply.code(403).send({ error: 'Demo mode is off on this backend.' });
      return open(reply, request, options.sessions.create('demo', { role: 'demo', method: 'demo' }));
    }

    const code = typeof body.code === 'string' ? body.code : '';
    // A CODE MINTED FOR ANYONE ELSE OPENS NOTHING HERE. The store is shared
    // with /link, whose codes any Telegram user can mint for their own
    // identity; without this check one of those, posted here instead, was an
    // OWNER session on the environment account (found 6 Oct 2026). It is
    // consumed either way, so it cannot be tried here and then on /link.
    const minted = code === '' ? undefined : options.linkCodes.redeem(code);
    const redeemed = minted !== undefined && minted.userId === options.userId ? minted : undefined;
    if (redeemed === undefined) {
      // Flat, whatever the cause: a wrong, expired and already-used code all
      // read the same to someone probing.
      return reply.code(401).send({ error: 'That code did not sign you in. Ask the bot for a fresh one with /web.' });
    }
    return open(reply, request, options.sessions.create(redeemed.userId, { role: 'owner', method: 'code' }));
  });

  app.delete(`${prefix}/session`, async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token !== undefined) options.sessions.revoke(token);
    reply.header('set-cookie', clearSessionCookie());
    return { signedOut: true };
  });

  // ── everything else is gated ──────────────────────────────────────────────
  void app.register(async (scope) => {
    scope.setReplySerializer((payload) => JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    scope.addHook('preHandler', async (request, reply) => {
      const session = sessionOf(request);
      if (session === undefined) {
        return reply.code(401).send({ error: 'Sign in with a code from the bot (/web) to see this account.' });
      }
      (request as FastifyRequest & { protectSession: Session }).protectSession = session;
    });
    const sessionFor = (request: FastifyRequest): Session => (request as FastifyRequest & { protectSession: Session }).protectSession;
    const userOf = (request: FastifyRequest): string => sessionFor(request).userId;
    /** Demo may look, never act. Enforced here, whatever the page renders. */
    const ownerOnly = (request: FastifyRequest, reply: FastifyReply): boolean => {
      if (sessionFor(request).role === 'owner') return true;
      void reply.code(403).send({ error: 'This is a read-only demo session: it shows PerpGuard\u2019s own test account and cannot act on it. Sign in with the wallet that owns a Perpl account to act on yours.' });
      return false;
    };

    scope.get(`${prefix}/me`, async (request) => describe(sessionFor(request)));

    scope.get(`${prefix}/positions`, async (): Promise<ProtectSnapshot & { readonly notes: readonly string[] }> => {
      const assessments = options.view.snapshot();
      const venueRows = new Map(options.view.positions().map((p) => [p.marketId, p]));
      const notes: string[] = [];
      const positions = [];
      // The renderer orders entries worst first and carries the market id on
      // each message; the assessment is paired back by that id.
      const byMarket = new Map(assessments.map((a) => [a.marketId, a]));
      for (const entry of positionEntries(assessments, options.configs, alerts)) {
        if (!entry.ok) {
          notes.push(entry.reason);
          continue;
        }
        const assessment = byMarket.get(entry.message.marketId);
        const market = options.configs.get(entry.message.marketId);
        if (assessment === undefined || market === undefined) continue;
        let availability: ActionAvailability | undefined;
        try {
          availability = await options.availability(assessment.symbol);
        } catch {
          availability = undefined;
        }
        positions.push(
          toProtectPosition({
            assessment,
            message: entry.message,
            market,
            venuePosition: venueRows.get(assessment.marketId),
            availability,
            inFlight: options.inFlightOn(assessment.marketId),
            alerts,
          }),
        );
      }
      return {
        network: options.view.network,
        accountId: options.accountId(),
        forwardingAllowed: options.forwardingAllowed(),
        feed: options.view.feedStatus(),
        positionsStatus: options.view.positionsStatus(),
        freeBalance: freeBalanceDto(options.freeBalance(), options.configs),
        thresholds: options.view.thresholds(),
        positions,
        notes,
        generatedAtMs: now(),
      };
    });

    // ── the confirmation screen ─────────────────────────────────────────────
    scope.post<{ Body: PrepareRequest }>(`${prefix}/prepare`, async (request, reply) => {
      if (!ownerOnly(request, reply)) return;
      const body = request.body;
      const userId = userOf(request);
      if (typeof body !== 'object' || body === null || typeof body.kind !== 'string') {
        return reply.code(400).send({ error: 'a prepare request names a kind' });
      }

      if (body.kind === 'kill-switch') {
        const book = options.view.sightedBook();
        if (!book.ok) return reply.code(409).send({ error: `I will not plan a kill switch while blind: ${book.reason}` });
        if (book.positions.length === 0) return reply.code(409).send({ error: 'No open positions, so there is nothing to close.' });
        const plan = killSwitchPlan(book.positions, book.markPrices, book.configs);
        const lines = renderKillSwitchConfirmation(plan, book.configs, alerts);
        const parked = options.pending.put(userId, { kind: 'kill-switch' });
        return prepared(parked.token, 'kill-switch', undefined, undefined, lines, parked.expiresAtMs);
      }

      const marketId = Number((body as { marketId?: unknown }).marketId);
      if (!Number.isSafeInteger(marketId)) return reply.code(400).send({ error: 'marketId must be an integer' });
      const assessment = options.view.snapshot().find((a) => a.marketId === marketId);
      const market = options.configs.get(marketId);
      if (assessment === undefined || market === undefined) {
        return reply.code(404).send({ error: `I am not tracking a position on market ${marketId}` });
      }
      const availability = await options.availability(assessment.symbol).catch(() => undefined);
      if (availability === undefined || !availability.actionable) {
        return reply.code(409).send({
          error:
            availability === undefined
              ? 'I could not check whether this market can be acted on, so I will not act on it.'
              : `Not actionable on ${availability.network}: ${availability.reason}`,
        });
      }
      const held = options.inFlightOn(marketId);
      if (held !== undefined) {
        return reply.code(409).send({
          error: `An action on ${assessment.symbol} is already in flight (started ${Math.round((now() - held.claimedAtMs) / 1000)}s ago) and has not settled. Refusing rather than queueing: a second action behind the first is how a top-up lands twice.`,
          inFlight: { idempotencyKey: held.idempotencyKey, sinceMs: held.claimedAtMs },
        });
      }

      if (body.kind === 'close-position') {
        const sighted = options.view.projectAddMargin(marketId, 0n);
        if (!sighted.ok) return reply.code(409).send({ error: `${sighted.reason}. I will not close a position I cannot see.` });
        const lines = renderCloseConfirmation(assessment, market, options.view.positions().find((p) => p.marketId === marketId), alerts);
        const parked = options.pending.put(userId, { kind: 'close-position', marketId, symbol: assessment.symbol, positionId: assessment.positionId });
        return prepared(parked.token, 'close-position', marketId, assessment.symbol, lines, parked.expiresAtMs);
      }

      if (body.kind === 'add-margin') {
        const intent = (body as { intent?: unknown }).intent;
        let action;
        let notes: readonly string[] = [];
        if (intent === 'clear-danger' || intent === 'to-safe') {
          const entry = positionEntries([assessment], options.configs, alerts)[0];
          const found = entry?.ok ? entry.message.actions.find((a) => a.intent === intent) : undefined;
          if (found === undefined) {
            return reply.code(409).send({ error: `${assessment.symbol} has no ${intent} option right now: it already has that room, or I cannot see it.` });
          }
          action = found;
        } else if (intent === 'custom') {
          const amount = String((body as { amount?: unknown }).amount ?? '');
          const current = options.view.projectAddMargin(marketId, 0n);
          if (!current.ok) return reply.code(409).send({ error: current.reason });
          const verdict = validateCustomAmount(amount, { market, freeBalance: options.freeBalance(), notionalCNS: current.projection.notionalCNS });
          if (!verdict.ok) return reply.code(400).send({ error: verdict.message });
          const projected = options.view.projectAddMargin(marketId, verdict.amountCNS);
          if (!projected.ok) return reply.code(409).send({ error: projected.reason });
          action = customAction(projected.projection, market, assessment.positionId, alerts.bufferDecimals);
          notes = verdict.warnings;
        } else {
          return reply.code(400).send({ error: 'intent must be clear-danger, to-safe or custom' });
        }
        const lines = renderConfirmation(action, market, notes).split('\n');
        const parked = options.pending.put(userId, { kind: 'add-margin', action });
        return prepared(parked.token, 'add-margin', marketId, assessment.symbol, lines, parked.expiresAtMs);
      }

      return reply.code(400).send({ error: `unknown kind ${JSON.stringify((body as { kind: unknown }).kind)}` });
    });

    // ── send, once ──────────────────────────────────────────────────────────
    scope.post<{ Body: { token?: unknown } }>(`${prefix}/execute`, async (request, reply) => {
      if (!ownerOnly(request, reply)) return;
      const userId = userOf(request);
      const token = typeof request.body?.token === 'string' ? request.body.token : '';
      // Spent FIRST, before anything is sent: a double click is one submission.
      const entry = token === '' ? undefined : options.pending.take(token, userId);
      if (entry === undefined) {
        return reply.code(404).send({ error: 'That confirmation has expired or was already used. The figures on it were for the mark at the time; open a fresh one.' });
      }
      const key = startAction(entry.intent, token, userId);
      return reply.code(202).send({ idempotencyKey: key });
    });

    scope.get<{ Params: { key: string } }>(`${prefix}/actions/:key`, async (request, reply) => {
      const userId = userOf(request);
      const key = request.params.key;
      // A key names its user first. Another user's key is simply not found.
      if (!key.startsWith(`${userId}:`)) return reply.code(404).send({ error: 'no such action' });
      const progress = options.progress.get(key);
      if (progress === undefined) return reply.code(404).send({ error: 'no such action' });
      return progress;
    });

    // ── the Alerts page ─────────────────────────────────────────────────────
    scope.get<{ Querystring: { limit?: string } }>(`${prefix}/alerts`, async (request, reply): Promise<ProtectAlerts | void> => {
      const view = options.alertsView;
      if (view === undefined) return reply.code(503).send({ error: 'no alert engine is wired to this backend, so there is no alert history to show.' });
      const userId = userOf(request);
      const limit = Number(request.query.limit ?? 50);
      const rows = await view.recent(userId, Number.isFinite(limit) ? limit : 50);
      const status = view.status();
      const cooldowns = options.view.snapshot().map((a) => {
        const h = view.historyFor(a.marketId);
        const bySeverity = h === undefined
          ? []
          : Object.entries(h.lastSentAtMs).map(([severity, at]) => ({
              severity,
              lastSentAtMs: at as number,
              nextAllowedAtMs: (at as number) + (alerts.cooldownMs[severity as keyof typeof alerts.cooldownMs] ?? 0),
            }));
        return { marketId: a.marketId, symbol: a.symbol, lastAlertedSeverity: h?.lastAlertedSeverity, bySeverity };
      });
      const linkedAt = view.linkedAtMs(userId);
      return {
        telegram: {
          linked: linkedAt !== undefined,
          linkedAtMs: linkedAt,
          botUsername: view.botUsername(),
          transportConfigured: status.transportConfigured,
          transportReason: status.transportReason,
        },
        delivery: {
          durableLog: status.durableLog,
          durableReason: status.durableReason,
          delivered: status.delivered,
          failed: status.failed,
          lastDeliveredAtMs: status.lastDeliveredAtMs,
          lastDelivered: status.lastDelivered,
          lastFailureAtMs: status.lastFailureAtMs,
          lastFailure: status.lastFailure,
        },
        rules: { thresholds: options.view.thresholds(), cooldownMs: alerts.cooldownMs, bufferDecimals: alerts.bufferDecimals, cooldowns },
        history: rows.map((r) => ({
          alertKey: r.alertKey,
          marketId: r.marketId,
          symbol: r.symbol,
          kind: r.kind,
          state: r.state,
          previousState: r.previousState,
          text: r.text,
          actions: r.actions.map((a) => a.label),
          attempts: r.attempts,
          outcome: r.outcome,
          lastError: r.lastError,
          createdAtMs: r.createdAtMs,
          deliveredAtMs: r.deliveredAtMs,
        })),
        generatedAtMs: now(),
      };
    });

    // ── the stress test, from the engine ────────────────────────────────────
    scope.post<{ Body: { priceMoveFraction?: unknown } }>(`${prefix}/stress`, async (request, reply) => {
      const move = Number(request.body?.priceMoveFraction);
      if (!Number.isFinite(move) || move < -0.99 || move > 10) {
        return reply.code(400).send({ error: 'priceMoveFraction must be a fraction between -0.99 and 10' });
      }
      const book = options.view.sightedBook();
      if (!book.ok) return { ok: false, reason: book.reason };
      const result = stressTest(book.positions, { kind: 'all', priceMoveFraction: move }, book.markPrices, book.configs);
      return toProtectStress(result, book.configs, freeBalanceDto(options.freeBalance(), options.configs));
    });
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function prepared(token: string, kind: Prepared['kind'], marketId: number | undefined, symbol: string | undefined, lines: readonly string[], expiresAtMs: number): Prepared {
    return { token, kind, marketId, symbol, title: lines[0] ?? '', lines: lines.slice(1), expiresAtMs };
  }

  function words(outcome: ActionOutcome): { text: string; nextStep: string | undefined } {
    const described = describeExecutionOutcome(outcome);
    return { text: described.detail, nextStep: described.kind === 'unknown' ? described.nextStep : undefined };
  }

  /** Start the action in the background and return its progress key. */
  function startAction(intent: PendingIntent, token: string, userId: string): string {
    if (intent.kind === 'kill-switch') {
      const key = `${userId}:kill:web-${token}`;
      options.progress.start(key, 'kill-switch', undefined);
      void (async () => {
        const book = options.view.sightedBook();
        if (!book.ok) {
          options.progress.finish(key, { kind: 'kill-switch', complete: false, text: `Kill switch not fired: ${book.reason}. Nothing was sent.`, lines: [] });
          return;
        }
        options.progress.record({ idempotencyKey: key, stage: 'sending' });
        const result = await fireKillSwitch({
          runner: options.runner,
          userId,
          positions: book.positions,
          markPrices: book.markPrices,
          configs: book.configs,
          positionIds: book.positionIds,
          keyFor: (marketId, order) => `${userId}:${marketId}:close:web-${token}:${order}`,
          logger: log,
        });
        options.progress.finish(key, toProtectKillSwitch(result, describeKillSwitch(result), words));
      })().catch((error: unknown) => {
        log.warn(`kill switch ${key} threw: ${error instanceof Error ? error.message : String(error)}`);
        options.progress.finish(key, { kind: 'kill-switch', complete: false, text: 'The kill switch threw before reporting. Read every position before doing anything else; do not re-fire.', lines: [] });
      });
      return key;
    }

    const command: ActionCommand =
      intent.kind === 'add-margin'
        ? {
            kind: 'add-margin',
            idempotencyKey: `${userId}:${intent.action.marketId}:${intent.action.intent}:web-${token}`,
            userId,
            marketId: intent.action.marketId,
            symbol: intent.action.symbol,
            positionId: intent.action.positionId,
            // VERBATIM. The figure the screen showed is the figure that is sent.
            amountCNS: intent.action.amountCNS,
          }
        : {
            kind: 'close-position',
            idempotencyKey: `${userId}:${intent.marketId}:close:web-${token}`,
            userId,
            marketId: intent.marketId,
            symbol: intent.symbol,
            positionId: intent.positionId,
          };
    const key = command.idempotencyKey;
    options.progress.start(key, intent.kind, command.symbol);
    void options.runner
      .execute(command)
      .then((outcome) => {
        const w = words(outcome);
        // A FRESH TOKEN ONLY ON not-applied: the position was read and had not
        // moved, so sending again cannot land twice. Never on unknown.
        const retry = outcome.kind === 'not-applied' ? options.pending.put(userId, intent).token : undefined;
        options.progress.finish(key, toProtectOutcome(outcome, w.text, w.nextStep, retry));
      })
      .catch((error: unknown) => {
        log.warn(`${key} threw outside the executor: ${error instanceof Error ? error.message : String(error)}`);
        options.progress.finish(key, {
          kind: 'unknown',
          marketId: command.marketId,
          symbol: command.symbol,
          text: 'The action threw before reporting an outcome. I cannot tell you what it did.',
          detail: error instanceof Error ? error.message : String(error),
          nextStep: 'Read the position directly before doing anything else. Do NOT send this again until you have.',
          refusalCode: undefined,
          reported: undefined,
          reconciliation: undefined,
          retryToken: undefined,
        });
      });
    return key;
  }

  return app;
}

function freeBalanceDto(reading: FreeBalanceReading, configs: ReadonlyMap<number, MarketRiskConfig>): ProtectFreeBalance {
  if (!reading.known) return { known: false, reason: reading.reason };
  const decimals = configs.values().next().value?.collateralDecimals ?? 6;
  return { known: true, floorAusd: scaledToNumber(reading.floorCNS, decimals), floorCNS: reading.floorCNS.toString() };
}
