/**
 * GET /api/analytics/copy/:accountId?size=1000 — one leader's last 30 days
 * replayed onto an account of `size` AUSD. Public and read-only like every
 * analytics route: it reads the index and the venues' contexts, and sends
 * nothing anywhere.
 */
import type { FastifyInstance } from 'fastify';
import type { CopyReplayService } from '../copy/service.ts';
import { copyReplayDto } from '../copy/dto.ts';

export const COPY_SIZE_DEFAULT_AUSD = 1_000;
export const COPY_SIZE_MIN_AUSD = 10;
export const COPY_SIZE_MAX_AUSD = 10_000_000;

export function registerCopyRoutes(app: FastifyInstance, options: { readonly service: CopyReplayService; readonly collateralDecimals: number; readonly prefix?: string; readonly now?: () => number }): FastifyInstance {
  const prefix = options.prefix ?? '/api/analytics';
  const now = options.now ?? Date.now;
  app.get<{ Params: { accountId: string }; Querystring: { size?: string } }>(`${prefix}/copy/:accountId`, async (request, reply) => {
    const accountId = Number(request.params.accountId);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) return reply.code(400).send({ error: 'An account id is a whole number.' });
    const rawSize = request.query.size === undefined || request.query.size === '' ? COPY_SIZE_DEFAULT_AUSD : Number(request.query.size);
    if (!Number.isFinite(rawSize) || rawSize < COPY_SIZE_MIN_AUSD || rawSize > COPY_SIZE_MAX_AUSD) {
      return reply.code(400).send({ error: `An account size is between ${COPY_SIZE_MIN_AUSD} and ${COPY_SIZE_MAX_AUSD.toLocaleString('en-US')} AUSD.` });
    }
    // Whole AUSD: a size is a rough figure, and it keeps the replay cache small.
    const sizeCNS = BigInt(Math.floor(rawSize)) * 10n ** BigInt(options.collateralDecimals);
    const answer = await options.service.replay(accountId, sizeCNS);
    return reply.send(copyReplayDto(answer, now()));
  });
  return app;
}
