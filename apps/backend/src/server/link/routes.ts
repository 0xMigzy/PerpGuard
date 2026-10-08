/**
 * The linking page's API: the ONLY routes in the web app with a session.
 *
 * `POST /api/link/session { code }` redeems the one-time code the bot handed
 * the chat and opens an HttpOnly cookie session for that Telegram identity.
 * Everything else here needs that cookie. The code is transport: it says who
 * is sitting at the page, and nothing about what they own. The proof comes
 * from `/challenge` + `/wallet` (a signed Sign-In with Ethereum challenge,
 * verified here: walletChallenge.ts) or `/key` (an API key, used once to sign
 * in, then sealed). A wallet proves ownership only; the key executes.
 *
 * THE KEY NEVER COMES BACK OUT. `/key` answers with the account it linked and
 * nothing of what was pasted; `/me` says a key is stored, never what it is;
 * no route logs a body; a failure in the key path answers with a sentence
 * that contains none of the input. Fastify's own logging is off in this
 * process, and the session store holds identities, not credentials.
 */
import { randomBytes } from 'node:crypto';
import { clientLine, describeClient, sessionTag } from './client.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { NetworkName } from '@perpguard/shared';
import type { TelegramIdentity } from '@perpguard/bot';
import type { ChallengeHolder, WalletChallenger } from './walletChallenge.ts';
import { parseCookies } from '../protect/session.ts';
import type { LinkService, LinkStatus } from './service.ts';
import type { WalletKeyFlow } from './walletKey.ts';

export const LINK_COOKIE = 'pg_link';
export const LINK_SESSION_TTL_MS = 30 * 60_000;

export interface LinkSession extends ChallengeHolder {
  readonly token: string;
  readonly identity: TelegramIdentity;
  /** How the person appears in Telegram, carried from the code. Display only. */
  readonly telegramName: string | undefined;
  /** The account a wallet proof established, waiting for a key. */
  provenAccountId: number | undefined;
  /** A mainnet account this page's signed wallet proved it owns: the one account "Watch it instead" may watch. */
  watchInsteadAccountId?: number | undefined;
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

  create(identity: TelegramIdentity, telegramName?: string): LinkSession {
    this.#sweep();
    const session: LinkSession = { token: this.#nextToken(), identity, telegramName, provenAccountId: undefined, challenge: undefined, expiresAtMs: this.#now() + this.#ttlMs };
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
  /** Wallet ownership by signed challenge. Absent means the page offers the key path only. */
  readonly wallet?: WalletChallenger;
  readonly network: NetworkName;
  readonly envAccountId?: number;
  readonly keyStorageConfigured: boolean;
  readonly sessions?: LinkSessionStore;
  /** 👁 Watch a proven mainnet account, read-only, in this person's own chat. Absent: no button works. */
  readonly watchInstead?: (identity: TelegramIdentity, accountId: number) => Promise<{ readonly ok: boolean; readonly text: string }>;
  /** 🔗 Connect with one wallet signature: the key is created for you. Behind the `wallet-key` switch. */
  readonly walletKey?: WalletKeyFlow;
  /**
   * EVERY OUTCOME ON THE PAGE LEAVES A LINE: a code redeemed or refused, a
   * challenge issued, a signature refused and why. Never the code, the
   * message, the signature or a key. Until 6 Oct 2026 these were silent, and a
   * phone test that failed here left nothing to check it against.
   */
  readonly logger?: { info(message: string): void };
  readonly prefix?: string;
  readonly now?: () => number;
}

/**
 * What `/me` serves: what the page needs to say, and nothing else. No internal
 * user id and nothing about which account PerpGuard itself runs: a person
 * linking needs to know which Telegram account this is and which network,
 * and that is all.
 */
export interface LinkMe {
  readonly telegram: { readonly name: string | null };
  readonly link: LinkStatus | null;
  readonly provenAccountId: number | null;
  /**
   * OWNERSHIP VERIFIED, as kept: the wallet that signed and the account the
   * Exchange says it owns. Survives the page closing. Null: none on record.
   */
  readonly wallet: { readonly address: string; readonly accountId: number } | null;
  /** Whether the page can prove a wallet (signed challenge). */
  readonly walletSignIn: boolean;
  /** Whether one wallet signature can create the key (the `wallet-key` switch, read now). */
  readonly walletKey: boolean;
  readonly keyStorageConfigured: boolean;
  readonly network: NetworkName;
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
  const log = (line: string): void => options.logger?.info(`link page: ${line}`);

  const me = (session: LinkSession): LinkMe => {
    const link = service.status(session.identity.userId) ?? null;
    const kept = service.walletProof(session.identity.userId);
    return {
    telegram: { name: session.telegramName ?? null },
    link,
    // Proven and not yet linked: from this page, or kept from an earlier visit.
    provenAccountId: link !== null ? null : (session.provenAccountId ?? kept?.accountId ?? null),
    wallet: kept === undefined ? null : { address: kept.address, accountId: kept.accountId },
    walletSignIn: options.wallet !== undefined,
    walletKey: options.walletKey?.enabled() ?? false,
    keyStorageConfigured: options.keyStorageConfigured,
    network: options.network,
    };
  };

  // What the page and the setup guide may offer, with no session: the switch's state, nothing else.
  app.get(`${prefix}/features`, async () => ({ walletKey: options.walletKey?.enabled() ?? false }));

  app.post<{ Body: { code?: unknown } }>(`${prefix}/session`, async (request, reply) => {
    const code = typeof request.body?.code === 'string' ? request.body.code : '';
    const identity = code === '' ? undefined : service.redeem(code);
    if (identity === undefined) {
      const existing = parseCookies(request.headers.cookie)[LINK_COOKIE];
      log(`a code was refused (wrong, used or expired)${existing === undefined ? '' : `; this browser holds session ${sessionTag(existing)}`}; from ${clientLine(request.headers['user-agent'])}`);
      // Flat, whatever the cause: a wrong, used and expired code read the same.
      return reply.code(401).send({ error: 'That link did not open a session. Send /link to the bot again for a fresh one; each works once, for five minutes.' });
    }
    const session = sessions.create(identity, identity.telegramName);
    log(`${identity.userId} opened the page with a code: session ${sessionTag(session.token)}; from ${clientLine(request.headers['user-agent'])}`);
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
      const token = parseCookies(request.headers.cookie)[LINK_COOKIE];
      const session = sessions.get(token);
      if (session === undefined) {
        // THE COOKIE QUESTION, answered in the log: was a cookie sent at all, and from which client?
        log(`${request.method} ${request.url.split('?')[0]} refused: ${token === undefined ? 'NO session cookie was sent' : `a session cookie was sent (${sessionTag(token)}) but it is expired or unknown`}; from ${clientLine(request.headers['user-agent'])}`);
        return reply.code(401).send({ error: 'No linking session. Open the link the bot sent you; it works once, for five minutes.' });
      }
      (request as FastifyRequest & { linkSession: LinkSession }).linkSession = session;
    });
    const sessionOf = (request: FastifyRequest): LinkSession => (request as FastifyRequest & { linkSession: LinkSession }).linkSession;

    scope.get(`${prefix}/me`, async (request) => me(sessionOf(request)));

    // A challenge for the connected wallet: one outstanding per session, five minutes.
    scope.post<{ Body: { address?: unknown } }>(`${prefix}/challenge`, async (request, reply) => {
      const session = sessionOf(request);
      if (options.wallet === undefined) return reply.code(503).send({ error: 'Wallet sign-in isn\'t available right now. Paste an API key instead.' });
      const issued = options.wallet.issue(session, typeof request.body?.address === 'string' ? request.body.address : '', session.telegramName);
      if ('error' in issued) {
        log(`${session.identity.userId} asked for a challenge and was refused: ${issued.error}`);
        return reply.code(400).send({ error: issued.error });
      }
      log(`${session.identity.userId} was issued a wallet challenge (session ${sessionTag(session.token)}; ${describeClient(request.headers['user-agent'])})`);
      return { message: issued.message };
    });

    scope.post<{ Body: { message?: unknown; signature?: unknown } }>(`${prefix}/wallet`, async (request, reply) => {
      const session = sessionOf(request);
      if (options.wallet === undefined) return reply.code(503).send({ error: 'Wallet sign-in isn\'t available right now. Paste an API key instead.' });
      const checked = await options.wallet.verify(session, request.body?.message, request.body?.signature);
      if (!checked.ok) {
        log(`${session.identity.userId} sent a wallet signature that was refused: ${checked.reason} (session ${sessionTag(session.token)}; ${describeClient(request.headers['user-agent'])})`);
        // One sentence whatever the cause; the challenge is spent either way.
        return reply.code(401).send({ error: checked.reason === 'expired' ? 'That signature request expired. Connect and sign again.' : 'That signature couldn\'t be confirmed for this page. Connect and sign again.' });
      }
      // The verified address, never a body field.
      const proof = await service.proveWallet(session.identity, [checked.address]);
      log(`${session.identity.userId} signed and was verified: ${proof.kind}${'accountId' in proof ? ` (account ${proof.accountId})` : ''} (session ${sessionTag(session.token)}; ${describeClient(request.headers['user-agent'])})`);
      if (proof.kind === 'proven-needs-key') session.provenAccountId = proof.accountId;
      if (proof.kind === 'linked') session.provenAccountId = undefined;
      session.watchInsteadAccountId = proof.kind === 'refused' ? proof.watchInstead?.accountId : undefined;
      return { proof, me: me(session) };
    });

    // 👁 WATCH IT INSTEAD: only the mainnet account THIS session's signed wallet
    // proved it owns, never a number from the body. Read-only, into the person's
    // own chat, under the watch tier's usual caps.
    scope.post(`${prefix}/watch-instead`, async (request, reply) => {
      const session = sessionOf(request);
      const accountId = session.watchInsteadAccountId;
      if (accountId === undefined || options.watchInstead === undefined) return reply.code(400).send({ error: 'Sign in with your wallet first: there is no mainnet account proven on this page.' });
      const result = await options.watchInstead(session.identity, accountId);
      log(`${session.identity.userId} chose to watch mainnet account ${accountId} instead: ${result.ok ? 'watching' : result.text} (session ${sessionTag(session.token)})`);
      return reply.code(result.ok ? 200 : 409).send(result.ok ? { ok: true, text: result.text, accountId } : { error: result.text });
    });

    // 🔗 ONE SIGNATURE: Perpl's typed data for the connected wallet. The key's secret stays on the server.
    scope.post<{ Body: { address?: unknown } }>(`${prefix}/wallet-key/start`, async (request, reply) => {
      const session = sessionOf(request);
      const flow = options.walletKey;
      if (flow === undefined) return reply.code(404).send({ error: 'Creating a key from your wallet isn’t available here. Paste an API key you already have instead.' });
      const started = await flow.start(session.token, typeof request.body?.address === 'string' ? request.body.address : '');
      log(`${session.identity.userId} asked to create a key by wallet: ${started.kind === 'sign' ? 'typed data issued' : `refused (${started.reason})`} (session ${sessionTag(session.token)}; ${describeClient(request.headers['user-agent'])})`);
      return started.kind === 'sign' ? { typedData: started.typedData } : reply.code(started.reason === 'off' ? 404 : 400).send({ error: started.text, reason: started.reason });
    });

    scope.post<{ Body: { signature?: unknown } }>(`${prefix}/wallet-key/finish`, async (request, reply) => {
      const session = sessionOf(request);
      const flow = options.walletKey;
      if (flow === undefined) return reply.code(404).send({ error: 'Creating a key from your wallet isn’t available here. Paste an API key you already have instead.' });
      try {
        const done = await flow.finish(session.token, session.identity, typeof request.body?.signature === 'string' ? request.body.signature : '');
        log(`${session.identity.userId} finished creating a key by wallet: ${done.kind === 'linked' ? `linked account ${done.accountId} (forwarding ${done.forwardingAllowed ?? 'unknown'})` : `refused (${done.reason})`} (session ${sessionTag(session.token)})`);
        if (done.kind === 'linked') session.provenAccountId = undefined;
        // The verdict and the account, never the key or its secret.
        return done.kind === 'linked' ? { result: done, me: me(session) } : reply.code(400).send({ error: done.text, reason: done.reason, me: me(session) });
      } catch {
        return reply.code(500).send({ error: 'That didn’t work, and nothing was saved. Try again, or paste an API key you already have instead.' });
      }
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
        return reply.code(500).send({ error: 'Something went wrong on our side. Nothing you pasted was stored or shown anywhere. Try again.' });
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
