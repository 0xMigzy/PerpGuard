/**
 * The health endpoint.
 *
 * `GET /health` RETURNS 503 WHEN DEGRADED, and that is the point of the file.
 * Most things that poll a health endpoint read the status code and nothing else
 * — a load balancer, a container orchestrator, an uptime checker — so returning
 * 200 with `"status": "DEGRADED"` in the body would let a monitor that has gone
 * blind carry on looking healthy to everything watching it. The body carries the
 * detail for a human; the code carries the verdict for a machine.
 *
 * The report is REBUILT PER REQUEST from a supplied function. Caching it would
 * mean serving a snapshot of how things were, which is the same mistake as
 * serving a frozen price.
 *
 * THE PUBLIC GETS THE VERDICT, THE BOX GETS THE DETAIL. The full report names
 * every linked account ("this account gave PerpGuard its key"), the trading
 * account and its forwarding flag, and that list grows with every user. So a
 * request that came through a proxy (Caddy, or the web app's rewrite) gets the
 * status code, each component's state and the session count, and nothing that
 * names an account. Only a request made on this machine, straight to the
 * port, gets the detail. The status code is identical either way, so a
 * monitor reading only the code is unaffected.
 */
import type { CopyReplayService } from '../copy/service.ts';
import { registerCopyRoutes } from './copyRoutes.ts';
import Fastify, { type FastifyInstance } from 'fastify';
import { isFromThisMachine } from './origin.ts';
import type { Analytics, MarketOpenInterest } from '@perpguard/shared';
import type { HealthReport } from './health.ts';
import { registerAnalyticsRoutes, type AnalyticsRouteOptions } from './analyticsRoutes.ts';
import { registerProtectRoutes, type ProtectRouteOptions } from './protect/routes.ts';
import { registerLinkRoutes, type LinkRouteOptions } from './link/routes.ts';

export interface HealthServerOptions {
  readonly health: () => HealthReport;
  /** Fastify's own logging. Off by default: this process logs its own lines. */
  readonly logger?: boolean;
  /**
   * Mounts the analytics API when supplied.
   *
   * OPTIONAL, because the process must start without it. Analytics needs a
   * database the risk loop does not, and a backend that refused to serve alerts
   * because Postgres was unreachable would have the priorities exactly backwards
   * — `/health` reports the degradation instead.
   */
  readonly analytics?: Analytics;
  /** The open-interest level from the analytics network's venue. See the routes. */
  readonly openInterest?: () => Promise<readonly MarketOpenInterest[]>;
  /** Open positions assessed against the analytics network's venue. See the routes. */
  readonly assessPositions?: AnalyticsRouteOptions['assessPositions'];
  /** Wallet -> account off the analytics chain, for addresses the index cannot link. See the routes. */
  readonly lookupAccountOnChain?: AnalyticsRouteOptions['lookupAccountOnChain'];
  /** The protocol-wide risk snapshot. See the routes. */
  readonly riskSnapshot?: AnalyticsRouteOptions['riskSnapshot'];
  readonly venueFunding?: AnalyticsRouteOptions['venueFunding'];
  readonly protocolTreasuryDays?: AnalyticsRouteOptions['protocolTreasuryDays'];
  readonly fillDirections?: AnalyticsRouteOptions['fillDirections'];
  /** The stale-while-revalidate cache for indexed answers, owned by the process so it can warm it. */
  readonly analyticsCache?: AnalyticsRouteOptions['cache'];
  readonly analyticsWarmedTtlMs?: number;
  /** 🔁 The copy replay (Copy Trading, Half A). Read-only. */
  readonly copyReplay?: { readonly service: CopyReplayService; readonly collateralDecimals: number };
  /** The session-gated Protect API. Absent when there is no risk loop to serve. */
  readonly protect?: ProtectRouteOptions;
  /** The linking page's API: the one place in the web app with a session. */
  readonly link?: LinkRouteOptions;
}

/** The report with everything that names an account removed: verdict, component states, session count. */
export function publicHealth(report: HealthReport): PublicHealthReport {
  const components: Record<string, { readonly state: string; readonly count?: number }> = {};
  for (const [name, c] of Object.entries(report.components)) {
    if (c === undefined) continue;
    components[name] = name === 'sessions' && typeof c['count'] === 'number' ? { state: c.state, count: c['count'] } : { state: c.state };
  }
  return { status: report.status, network: report.network, uptimeMs: report.uptimeMs, startedAt: report.startedAt, at: report.at, components };
}

export interface PublicHealthReport {
  readonly status: HealthReport['status'];
  readonly network: HealthReport['network'];
  readonly uptimeMs: number;
  readonly startedAt: string;
  readonly at: string;
  readonly components: Readonly<Record<string, { readonly state: string; readonly count?: number }>>;
}

export function createHealthApp(options: HealthServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async (request, reply) => {
    const report = options.health();
    // 503 rather than 200-with-a-field. See the note at the top.
    return reply.code(report.status === 'OK' ? 200 : 503).send(isFromThisMachine(request) ? report : publicHealth(report));
  });

  if (options.analytics !== undefined) {
    registerAnalyticsRoutes(app, {
      analytics: options.analytics,
      ...(options.openInterest === undefined ? {} : { openInterest: options.openInterest }),
      ...(options.assessPositions === undefined ? {} : { assessPositions: options.assessPositions }),
      ...(options.lookupAccountOnChain === undefined ? {} : { lookupAccountOnChain: options.lookupAccountOnChain }),
      ...(options.riskSnapshot === undefined ? {} : { riskSnapshot: options.riskSnapshot }),
      ...(options.venueFunding === undefined ? {} : { venueFunding: options.venueFunding }),
      ...(options.protocolTreasuryDays === undefined ? {} : { protocolTreasuryDays: options.protocolTreasuryDays }),
      ...(options.fillDirections === undefined ? {} : { fillDirections: options.fillDirections }),
      ...(options.analyticsCache === undefined ? {} : { cache: options.analyticsCache }),
      ...(options.analyticsWarmedTtlMs === undefined ? {} : { warmedTtlMs: options.analyticsWarmedTtlMs }),
    });
  }

  if (options.copyReplay !== undefined) registerCopyRoutes(app, options.copyReplay);
  if (options.protect !== undefined) registerProtectRoutes(app, options.protect);
  if (options.link !== undefined) registerLinkRoutes(app, options.link);

  // A bare GET / is what a human types first. Point them at the real endpoint
  // rather than returning a 404 that reads like the process is broken.
  app.get('/', async (_request, reply) => {
    const report = options.health();
    return reply
      .code(report.status === 'OK' ? 200 : 503)
      .send({
        service: 'perpguard-backend',
        status: report.status,
        health: '/health',
        ...(options.analytics === undefined ? {} : { analytics: '/api/analytics' }),
      });
  });

  return app;
}
