/**
 * The linking page's API: the ONLY routes in the web app with a session.
 *
 * `POST /api/link/session { code }` redeems the one-time code the bot handed
 * the chat and opens an HttpOnly cookie session for that Telegram identity.
 * Everything else here needs that cookie. The code is transport: it says who
 * is sitting at the page, and nothing about what they own. The proof comes
 * from `/wallet` (a Dynamic JWT, verified here) or `/key` (an API key, used
 * once to sign in, then sealed).
 *
 * THE KEY NEVER COMES BACK OUT. `/key` answers with the account it linked and
 * nothing of what was pasted; `/me` says a key is stored, never what it is;
 * no route logs a body; a failure in the key path answers with a sentence
 * that contains none of the input. Fastify's own logging is off in this
 * process, and the session store holds identities, not credentials.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NetworkName } from '@perpguard/shared';
import type { TelegramIdentity } from '@perpguard/bot';
import type { DynamicIdentity } from '../protect/dynamic.ts';
import { parseCookies } from '../protect/session.ts';
import type { LinkService, LinkStatus } from './service.ts';

export const LINK_COOKIE = 'pg_link';
export const LINK_SESSION_TTL_MS = 30 * 60_000;

export interface LinkSession {
  readonly token: string;
  readonly identity: TelegramIdentity;
  /** The account a wallet proof established, waiting for a key. */
  provenAccountId: number | undefined;
  readonly expiresAtMs: number;
}

/** Page sessions: short-lived, in memory, holding an identity and at most a proven account id. */
export class LinkSessionStore {
  readonly #sessions = new Map<string, LinkSession>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #nextToken: () => string;

  constructor(options: { now?: () => number; ttlMs?: number; nextToken?: () => string } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? LINK_SESSION_TTL_MS;
    this.#nextToken = options.nextToken ?? (() => randomBytes(32).toString('hex'));
  }

  create(identity: TelegramIdentity): LinkSession {
    this.#sweep();
    const session: LinkSession = { token: this.#nextToken(), identity, provenAccountId: undefined, expiresAtMs: this.#now() + this.#ttlMs };
    this.#sessions.set(session.token, session);
    return session;
  }

  get(token: string | undefined): LinkSession | undefined {
    this.#sweep();
    return token === undefined ? undefined : this.#sessions.get(token);
  }

  revoke(token: string): void {
    this.#sessions.delete(token);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [token, session] of this.#sessions) if (session.expiresAtMs <= now) this.#sessions.delete(token);
  }
}

export interface LinkRouteOptions {
  readonly service: LinkService;
  /** Dynamic, when configured. Absent means the page offers the key path only. */
  readonly dynamic?: { verify(token: string): Promise<DynamicIdentity> };
  readonly network: NetworkName;
  readonly envAccountId?: number;
  readonly keyStorageConfigured: boolean;
  readonly sessions?: LinkSessionStore;
  readonly prefix?: string;
  readonly now?: () => number;
}

/** What `/me` serves: everything the page needs, and nothing secret. */
export interface LinkMe {
  readonly identity: { readonly userId: string; readonly telegramUserId: number };
  readonly link: LinkStatus | null;
  readonly provenAccountId: number | null;
  readonly dynamicConfigured: boolean;
  readonly keyStorageConfigured: boolean;
  readonly network: NetworkName;
  readonly envAccountId: number | null;
}

const isSecure = (request: FastifyRequest): boolean => {
  const forwarded = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (proto ?? request.protocol) === 'https';
};

const cookie = (token: string, secure: boolean, maxAgeSec: number): string =>
  `${LINK_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;

export function registerLinkRoutes(app: FastifyInstance, options: LinkRouteOptions): FastifyInstance {
  const prefix = options.prefix ?? '/api/link';
  const sessions = options.sessions ?? new LinkSessionStore(options.now === undefined ? {} : { now: options.now });
  const now = options.now ?? Date.now;
  const { service } = options;

  const me = (session: LinkSession): LinkMe => ({
    identity: { userId: session.identity.userId, telegramUserId: session.identity.telegramUserId },
    link: service.status(session.identity.userId) ?? null,
    provenAccountId: session.provenAccountId ?? null,
    dynamicConfigured: options.dynamic !== undefined,
    keyStorageConfigured: options.keyStorageConfigured,
    network: options.network,
    envAccountId: options.envAccountId ?? null,
  });

  app.post<{ Body: { code?: unknown } }>(`${prefix}/session`, async (request, reply) => {
    const code = typeof request.body?.code === 'string' ? request.body.code : '';
    const identity = code === '' ? undefined : service.redeem(code);
    if (identity === undefined) {
      // Flat, whatever the cause: a wrong, used and expired code read the same.
      return reply.code(401).send({ error: 'That link did not open a session. Send /link to the bot again for a fresh one; each works once, for five minutes.' });
    }
    const session = sessions.create(identity);
    reply.header('set-cookie', cookie(session.token, isSecure(request), (session.expiresAtMs - now()) / 1000));
    return me(session);
  });

  app.delete(`${prefix}/session`, async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[LINK_COOKIE];
    if (token !== undefined) sessions.revoke(token);
    reply.header('set-cookie', cookie('', isSecure(request), 0));
    return { signedOut: true };
  });

  void app.register(async (scope) => {
    scope.addHook('preHandler', async (request, reply) => {
      const session = sessions.get(parseCookies(request.headers.cookie)[LINK_COOKIE]);
      if (session === undefined) return reply.code(401).send({ error: 'No linking session. Open the link the bot sent you; it works once, for five minutes.' });
      (request as FastifyRequest & { linkSession: LinkSession }).linkSession = session;
    });
    const sessionOf = (request: FastifyRequest): LinkSession => (request as FastifyRequest & { linkSession: LinkSession }).linkSession;

    scope.get(`${prefix}/me`, async (request) => me(sessionOf(request)));

    scope.post<{ Body: { dynamicToken?: unknown } }>(`${prefix}/wallet`, async (request, reply) => {
      const session = sessionOf(request);
      if (options.dynamic === undefined) return reply.code(503).send({ error: 'Wallet sign-in is not configured on this deployment.' });
      const token = typeof request.body?.dynamicToken === 'string' ? request.body.dynamicToken : '';
      let identity: DynamicIdentity;
      try {
        identity = await options.dynamic.verify(token);
      } catch (error) {
        return reply.code(401).send({ error: `That sign-in could not be verified: ${error instanceof Error ? error.message : String(error)}` });
      }
      const proof = await service.proveWallet(session.identity, identity.wallets);
      if (proof.kind === 'proven-needs-key') session.provenAccountId = proof.accountId;
      if (proof.kind === 'linked') session.provenAccountId = undefined;
      return { proof, me: me(session) };
    });

    scope.post<{ Body: { apiKey?: unknown; secret?: unknown } }>(`${prefix}/key`, async (request, reply) => {
      const session = sessionOf(request);
      const apiKey = typeof request.body?.apiKey === 'string' ? request.body.apiKey : '';
      const secret = typeof request.body?.secret === 'string' ? request.body.secret : '';
      if (apiKey === '' || secret === '') return reply.code(400).send({ error: 'Both the API key and its secret are needed.' });
      try {
        const proof = await service.proveKey(session.identity, { apiKey, secretHex: secret }, session.provenAccountId);
        if (proof.kind === 'linked') session.provenAccountId = undefined;
        // The reply carries the verdict and the account, never the input.
        return { proof, me: me(session) };
      } catch {
        // No detail: an unexpected error must not echo anything that was posted.
        return reply.code(500).send({ error: 'Linking failed on the server. Nothing you pasted has been stored or shown anywhere; try again or tell the operator.' });
      }
    });

    scope.post(`${prefix}/unlink`, async (request) => {
      const session = sessionOf(request);
      const result = await service.unlink(session.identity.userId);
      session.provenAccountId = undefined;
      return { ...result, me: me(session) };
    });
  });

  return app;
}

export type { LinkStatus } from './service.ts';
export type { FastifyReply };
