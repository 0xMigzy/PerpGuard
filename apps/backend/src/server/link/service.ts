/**
 * Linking a Telegram chat to the Perpl account it owns: the whole policy, in
 * one testable object, with every I/O injected.
 *
 * THE ONE-TIME TOKEN IS TRANSPORT, NOT PROOF. `/link` mints a code and a URL;
 * redeeming it opens a page session for the identity that asked, and nothing
 * more. The PROOF is one of two things the page then collects:
 *
 *   A WALLET SIGNATURE, through Dynamic. The backend verifies the JWT, reads
 *   the wallet off it, and asks the Exchange contract on the TRADING network
 *   which account that wallet owns. That proves ownership. It does NOT give
 *   PerpGuard the ability to act: acting needs an API key signing on the
 *   trading socket. So a wallet proof links the chat only when a session for
 *   that account already exists (the environment account, today), and is
 *   otherwise remembered as "proven, needs a key".
 *
 *   AN API KEY, pasted on the page. The backend signs in with it ONCE, to
 *   learn which account it is for, then opens a session in the registry and
 *   seals the key under the environment key. If the page also holds a wallet
 *   proof, the two must name the same account.
 *
 * ENFORCEMENT IS NOT HERE. Whether a chat may act on a position is re-checked
 * by the bot at the moment of each request against the link store, and by
 * the executor against its own account. This service only writes the link.
 *
 * UNLINK TEARS DOWN. The link row is removed, the sealed key is DELETED, and
 * the session is closed — unless it is the environment account's, which the
 * process owns regardless of who is linked to it.
 */
import type { AccountLookup } from '@perpguard/shared';
import type { IdentityStore, LinkStore, TelegramIdentity } from '@perpguard/bot';
import type { OpenResult } from '../../sessions/registry.ts';
import type { SessionStatus } from '../../sessions/session.ts';
import type { LinkCodeStore } from '../protect/session.ts';
import { KeyRotatedError, type KeyVault, type SealedCredentials } from './crypto.ts';
import type { KeyStore } from './stores.ts';

export interface Probe {
  readonly accountId: number | undefined;
  readonly forwardingAllowed: boolean | undefined;
}

export interface LinkServiceDeps {
  readonly codes: LinkCodeStore;
  readonly identities: IdentityStore;
  readonly links: LinkStore;
  readonly keys: KeyStore;
  /** Absent means keys cannot be stored; the key path says so. */
  readonly vault: KeyVault | undefined;
  readonly registry: {
    open(accountId: number, credentials: { apiKey: string; secret: import('@perpguard/shared').ApiSecret }): OpenResult;
    close(accountId: number): Promise<boolean>;
    get(accountId: number): { status(): SessionStatus } | undefined;
  };
  /** Signs in with a key once and reports whose it is. The caller closes it. */
  readonly probe: (credentials: SealedCredentials) => Promise<Probe>;
  /** Wallet -> account on the TRADING network's Exchange contract. */
  readonly lookupAccount: (address: string) => Promise<AccountLookup>;
  readonly secretFromHex: (hex: string) => import('@perpguard/shared').ApiSecret;
  /** The account the process runs regardless of links; never closed by an unlink. */
  readonly envAccountId: number | undefined;
  /** Where the linking page lives, e.g. https://perpguard.example. */
  readonly webUrl: string;
  /** Tells the chat what happened, when a bot is wired. Never carries a key. */
  readonly notify?: (chatId: number, text: string) => Promise<void>;
  readonly logger: { info(message: string): void; warn(message: string): void };
  readonly now?: () => number;
}

export type WalletProof =
  | { readonly kind: 'linked'; readonly accountId: number }
  | { readonly kind: 'proven-needs-key'; readonly accountId: number; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };

export type KeyProof =
  | { readonly kind: 'linked'; readonly accountId: number; readonly forwardingAllowed: boolean | undefined }
  | { readonly kind: 'refused'; readonly reason: string };

export interface LinkStatus {
  readonly accountId: number;
  readonly proof: 'wallet' | 'key';
  readonly session: SessionStatus | undefined;
  /** Set when the stored key cannot be opened any more and the account must be re-linked. */
  readonly needsRelink?: string;
}

export class LinkService {
  readonly #deps: LinkServiceDeps;
  readonly #now: () => number;
  /** Users whose stored key could not be opened at boot, and why. */
  readonly #needsRelink = new Map<string, string>();

  constructor(deps: LinkServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** `/link`: a one-time code and the page that redeems it. */
  mint(userId: string): { readonly code: string; readonly url: string; readonly expiresAtMs: number } {
    const minted = this.#deps.codes.mint(userId);
    const url = `${this.#deps.webUrl.replace(/\/$/, '')}/link?code=${encodeURIComponent(minted.code)}`;
    return { code: minted.code, url, expiresAtMs: minted.expiresAtMs };
  }

  /** The identity a code was minted for, once. Undefined for a wrong, used or expired code. */
  redeem(code: string): TelegramIdentity | undefined {
    const found = this.#deps.codes.redeem(code);
    if (found === undefined) return undefined;
    return this.#deps.identities.byUserId(found.userId);
  }

  status(userId: string): LinkStatus | undefined {
    const link = this.#deps.links.byUserId(userId);
    if (link === undefined) return undefined;
    const key = this.#deps.keys.get(userId);
    const needsRelink = this.#needsRelink.get(userId);
    return {
      accountId: link.accountId,
      proof: key === undefined ? 'wallet' : 'key',
      session: this.#deps.registry.get(link.accountId)?.status(),
      ...(needsRelink === undefined ? {} : { needsRelink }),
    };
  }

  /**
   * A wallet proof: which of the token's wallets owns a Perpl account on the
   * trading network. Links when a session for that account is already
   * running; otherwise proves and asks for a key.
   */
  async proveWallet(identity: TelegramIdentity, wallets: readonly string[]): Promise<WalletProof> {
    if (wallets.length === 0) return { kind: 'refused', reason: 'the sign-in carried no wallet, so there is nothing to look up. Connect a wallet that owns the Perpl account.' };
    const reasons: string[] = [];
    for (const wallet of wallets) {
      const lookup = await this.#deps.lookupAccount(wallet.toLowerCase());
      if (!lookup.found) {
        reasons.push(`${wallet.toLowerCase()}: ${lookup.reason}`);
        continue;
      }
      const accountId = lookup.accountId;
      if (this.#deps.registry.get(accountId) !== undefined) {
        const bound = this.#bind(identity, accountId);
        if (!bound.ok) return { kind: 'refused', reason: bound.reason };
        this.#deps.logger.info(`link: ${identity.userId} proved account ${accountId} by wallet; session already running`);
        await this.#notify(identity.chatId, `Linked to Perpl account ${accountId}: your wallet proved you own it. Alerts here now carry the buttons to act.`);
        return { kind: 'linked', accountId };
      }
      return {
        kind: 'proven-needs-key',
        accountId,
        reason:
          `Your wallet owns Perpl account ${accountId}. That proves ownership, but PerpGuard can only act on an account it can sign for: ` +
          `paste an API key for account ${accountId} below and the link completes.`,
      };
    }
    return { kind: 'refused', reason: `none of the signed-in wallets owns a Perpl account on this network. ${reasons.join(' ')}` };
  }

  /**
   * A key proof: sign in once to learn whose it is, open the session, seal the
   * key, bind the chat. `provenAccountId` is the wallet proof the page holds,
   * if any; the key must be for the same account.
   */
  async proveKey(identity: TelegramIdentity, credentials: SealedCredentials, provenAccountId: number | undefined): Promise<KeyProof> {
    const vault = this.#deps.vault;
    if (vault === undefined) {
      return { kind: 'refused', reason: 'this deployment has no PERPGUARD_KEY_ENCRYPTION_KEY, so it cannot store an API key. Ask the operator to set one, or link by wallet to an account PerpGuard already runs.' };
    }
    let secret: import('@perpguard/shared').ApiSecret;
    try {
      secret = this.#deps.secretFromHex(credentials.secretHex);
    } catch {
      // Deliberately without the input: nothing a user pastes here is ever repeated.
      return { kind: 'refused', reason: 'the secret is not a 32-byte hex string. Paste the API key secret exactly as Perpl showed it.' };
    }
    if (credentials.apiKey.trim().length < 16) return { kind: 'refused', reason: 'the API key looks too short. Paste the key exactly as Perpl showed it.' };

    let probe: Probe;
    try {
      probe = await this.#deps.probe({ apiKey: credentials.apiKey.trim(), secretHex: credentials.secretHex });
    } catch (error) {
      return { kind: 'refused', reason: `Perpl did not accept that key: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (probe.accountId === undefined) {
      return { kind: 'refused', reason: 'that key signed in, but Perpl reported no account for it. A key only works once its account exists on chain.' };
    }
    const accountId = probe.accountId;
    if (provenAccountId !== undefined && provenAccountId !== accountId) {
      return { kind: 'refused', reason: `your wallet proved account ${provenAccountId}, but this key signs for account ${accountId}. Paste a key for account ${provenAccountId}.` };
    }

    const opened = this.#deps.registry.open(accountId, { apiKey: credentials.apiKey.trim(), secret });
    if (!opened.ok) return { kind: 'refused', reason: opened.reason };

    // SEALED, then stored; the plaintext goes nowhere else from here.
    this.#deps.keys.put({ userId: identity.userId, accountId, blob: vault.seal({ apiKey: credentials.apiKey.trim(), secretHex: credentials.secretHex }), storedAtMs: this.#now() });
    this.#needsRelink.delete(identity.userId);
    const bound = this.#bind(identity, accountId);
    if (!bound.ok) {
      this.#deps.keys.delete(identity.userId);
      if (accountId !== this.#deps.envAccountId && !opened.already) await this.#deps.registry.close(accountId);
      return { kind: 'refused', reason: bound.reason };
    }
    this.#deps.logger.info(`link: ${identity.userId} linked account ${accountId} by API key (forwarding ${probe.forwardingAllowed ?? 'unknown'})`);
    await this.#notify(
      identity.chatId,
      `Linked to Perpl account ${accountId} with an API key. Alerts here now carry the buttons to act.` +
        (probe.forwardingAllowed === false ? ' NOTE: this account has order forwarding OFF, so every action would be refused until its owner wallet calls allowOrderForwarding(true).' : ''),
    );
    return { kind: 'linked', accountId, forwardingAllowed: probe.forwardingAllowed };
  }

  /** `/unlink`: the link goes, the key is DELETED, the session is closed (never the environment account's). */
  async unlink(userId: string): Promise<{ readonly ok: boolean; readonly text: string }> {
    const link = this.#deps.links.byUserId(userId);
    if (link === undefined) return { ok: false, text: 'This chat is not linked to any account.' };
    this.#deps.links.unlink(link.telegramUserId);
    const hadKey = this.#deps.keys.delete(userId);
    this.#needsRelink.delete(userId);
    let closed = false;
    if (link.accountId !== this.#deps.envAccountId && this.#deps.links.byAccountId(link.accountId).length === 0) {
      closed = await this.#deps.registry.close(link.accountId);
    }
    this.#deps.logger.info(`link: ${userId} unlinked account ${link.accountId}; key ${hadKey ? 'deleted' : 'none stored'}; session ${closed ? 'closed' : 'kept'}`);
    return {
      ok: true,
      text:
        `Unlinked from account ${link.accountId}. ` +
        (hadKey ? 'The API key you pasted has been deleted. ' : '') +
        (closed ? 'Its session is closed: no more alerts, nothing can act on it from here. ' : '') +
        'You can still /watch it, read-only.',
    };
  }

  /**
   * At boot: reopen a session for every stored key. A key sealed under a
   * rotated environment key is reported, the link is kept, and the user is
   * told to re-link the next time they ask for anything.
   */
  async reopenAll(): Promise<void> {
    const vault = this.#deps.vault;
    for (const stored of this.#deps.keys.list()) {
      if (vault === undefined) {
        this.#needsRelink.set(stored.userId, 'PERPGUARD_KEY_ENCRYPTION_KEY is not set, so the stored API key cannot be opened; re-link to continue');
        continue;
      }
      try {
        const credentials = vault.open(stored.blob);
        const opened = this.#deps.registry.open(stored.accountId, { apiKey: credentials.apiKey, secret: this.#deps.secretFromHex(credentials.secretHex) });
        if (!opened.ok) this.#deps.logger.warn(`link: could not reopen account ${stored.accountId} for ${stored.userId}: ${opened.reason}`);
      } catch (error) {
        const reason =
          error instanceof KeyRotatedError
            ? `the environment key was rotated (stored key sealed with ${error.sealedWith}, current ${error.current}); re-link to continue`
            : `the stored API key could not be opened (${error instanceof Error ? error.message : String(error)}); re-link to continue`;
        this.#needsRelink.set(stored.userId, reason);
        this.#deps.logger.warn(`link: account ${stored.accountId} for ${stored.userId} not reopened: ${reason}`);
      }
    }
  }

  needsRelink(userId: string): string | undefined {
    return this.#needsRelink.get(userId);
  }

  /** One account per user: a new link replaces the old one. */
  #bind(identity: TelegramIdentity, accountId: number): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const existing = this.#deps.links.byTelegramUserId(identity.telegramUserId);
    if (existing !== undefined && existing.accountId !== accountId) this.#deps.links.unlink(identity.telegramUserId);
    if (existing !== undefined && existing.accountId === accountId) return { ok: true };
    const result = this.#deps.links.link({ userId: identity.userId, accountId, telegramUserId: identity.telegramUserId, chatId: identity.chatId, linkedAtMs: this.#now() });
    if (result.ok) return { ok: true };
    return { ok: false, reason: result.refusal === 'at-capacity' ? 'PerpGuard has no room for another linked account right now.' : `the link was refused (${result.refusal}).` };
  }

  async #notify(chatId: number, text: string): Promise<void> {
    try {
      await this.#deps.notify?.(chatId, text);
    } catch (error) {
      this.#deps.logger.warn(`link: could not tell chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
