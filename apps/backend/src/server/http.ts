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
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Analytics, MarketOpenInterest } from '@perpguard/shared';
import type { HealthReport } from './health.ts';
import { registerAnalyticsRoutes, type AnalyticsRouteOptions } from './analyticsRoutes.ts';

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
}

export function createHealthApp(options: HealthServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async (_request, reply) => {
    const report = options.health();
    // 503 rather than 200-with-a-field. See the note at the top.
    return reply.code(report.status === 'OK' ? 200 : 503).send(report);
  });

  if (options.analytics !== undefined) {
    registerAnalyticsRoutes(app, {
      analytics: options.analytics,
      ...(options.openInterest === undefined ? {} : { openInterest: options.openInterest }),
      ...(options.assessPositions === undefined ? {} : { assessPositions: options.assessPositions }),
    });
  }

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
