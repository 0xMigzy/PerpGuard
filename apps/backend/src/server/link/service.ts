/**
 * Linking a Telegram chat to the Perpl account it owns: the whole policy, in
 * one testable object, with every I/O injected.
 *
 * THE ONE-TIME TOKEN IS TRANSPORT, NOT PROOF. `/link` mints a code and a URL;
 * redeeming it opens a page session for the identity that asked, and nothing
 * more. The PROOF is one of two things the page then collects:
 *
 *   A WALLET SIGNATURE: a Sign-In with Ethereum challenge this backend issued
 *   (walletChallenge.ts), signed in the browser through RainbowKit and
 *   verified here. The backend then asks the Exchange contract on the TRADING network
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
import { InMemoryWalletProofStore, type WalletProofRecord, type WalletProofStore } from './proofs.ts';

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
  /**
   * Wallet -> account on ANOTHER network (mainnet, while trading is testnet),
   * asked only when the trading network has none, so the refusal can name
   * where the wallet's account actually is. Never linked to: acting there is
   * switched off for this deployment.
   */
  readonly lookupElsewhere?: (address: string) => Promise<{ readonly network: string; readonly accountId: number } | undefined>;
  /** Verified wallet ownership, kept. Absent: in memory only. */
  readonly proofs?: WalletProofStore;
  readonly secretFromHex: (hex: string) => import('@perpguard/shared').ApiSecret;
  /** The account the process runs regardless of links; never closed by an unlink. */
  readonly envAccountId: number | undefined;
  /** Where the linking page lives, e.g. https://perpguard.example. */
  readonly webUrl: string;
  /** The trading network's name, for a sentence a person reads ("testnet"). */
  readonly network?: string;
  /** Tells the chat what happened, when a bot is wired. Never carries a key. */
  readonly notify?: (chatId: number, text: string) => Promise<void>;
  readonly logger: { info(message: string): void; warn(message: string): void };
  readonly now?: () => number;
}

export type WalletProof =
  | { readonly kind: 'linked'; readonly accountId: number }
  | { readonly kind: 'proven-needs-key'; readonly accountId: number; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** What a person is told when their saved key can no longer be used. */
export const RELINK_REASON = 'your saved API key can no longer be read, so PerpGuard has stopped acting on the account';

export type KeyProof =
  | { readonly kind: 'linked'; readonly accountId: number; readonly forwardingAllowed: boolean | undefined }
  | { readonly kind: 'refused'; readonly reason: string };

export interface LinkStatus {
  readonly accountId: number;
  /**
   * HOW IT IS AUTHORISED TO EXECUTE, from records, never inferred: `key` (an
   * API key is sealed for it), `wallet` (a verified wallet, and the deployment
   * runs the account with its own key), `owner` (linked as this deployment's
   * configured owner, with no proof on record).
   */
  readonly proof: 'wallet' | 'key' | 'owner';
  /** Verified ownership of THIS account, if a wallet proved it. */
  readonly wallet: { readonly address: string; readonly provedAtMs: number } | undefined;
  readonly session: SessionStatus | undefined;
  /** Set when the stored key cannot be opened any more and the account must be re-linked. */
  readonly needsRelink?: string;
}

export class LinkService {
  readonly #deps: LinkServiceDeps;
  readonly #now: () => number;
  /** Users whose stored key could not be opened at boot, and why. */
  readonly #needsRelink = new Map<string, string>();
  readonly #proofs: WalletProofStore;

  constructor(deps: LinkServiceDeps) {
    if (deps.codes.purpose !== 'link') throw new Error(`the link service needs a code store made for 'link', not '${deps.codes.purpose}': a code minted for one purpose must never open another`);
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#proofs = deps.proofs ?? new InMemoryWalletProofStore();
  }

  /** The verified wallet this identity proved, kept across page sessions. */
  walletProof(userId: string): WalletProofRecord | undefined {
    return this.#proofs.get(userId);
  }

  /** `/link`: a one-time code and the page that redeems it. */
  mint(userId: string, telegramName?: string): { readonly code: string; readonly url: string; readonly expiresAtMs: number } {
    const minted = this.#deps.codes.mint(userId, telegramName);
    const url = `${this.#deps.webUrl.replace(/\/$/, '')}/link?code=${encodeURIComponent(minted.code)}`;
    return { code: minted.code, url, expiresAtMs: minted.expiresAtMs };
  }

  /** The identity a code was minted for, once. Undefined for a wrong, used or expired code. */
  redeem(code: string): (TelegramIdentity & { readonly telegramName?: string }) | undefined {
    const found = this.#deps.codes.redeem(code);
    if (found === undefined) return undefined;
    const identity = this.#deps.identities.byUserId(found.userId);
    if (identity === undefined) return undefined;
    return found.telegramName === undefined ? identity : { ...identity, telegramName: found.telegramName };
  }

  status(userId: string): LinkStatus | undefined {
    const link = this.#deps.links.byUserId(userId);
    if (link === undefined) return undefined;
    const key = this.#deps.keys.get(userId);
    const needsRelink = this.#needsRelink.get(userId);
    const proof = this.#proofs.get(userId);
    const wallet = proof !== undefined && proof.accountId === link.accountId ? { address: proof.address, provedAtMs: proof.provedAtMs } : undefined;
    return {
      accountId: link.accountId,
      proof: key !== undefined ? 'key' : wallet !== undefined ? 'wallet' : 'owner',
      wallet,
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
    if (wallets.length === 0) return { kind: 'refused', reason: 'That sign-in had no wallet attached. Sign in with the wallet that owns your Perpl account.' };
    const reasons: string[] = [];
    for (const wallet of wallets) {
      const lookup = await this.#deps.lookupAccount(wallet.toLowerCase());
      if (!lookup.found) {
        reasons.push(`${wallet.toLowerCase()}: ${lookup.reason}`);
        continue;
      }
      const accountId = lookup.accountId;
      // OWNERSHIP VERIFIED, and kept: whatever happens next, this is now a fact on record.
      this.#proofs.put({ userId: identity.userId, address: wallet.toLowerCase(), accountId, network: this.#deps.network ?? 'trading', provedAtMs: this.#now() });
      if (this.#deps.registry.get(accountId) !== undefined) {
        const bound = this.#bind(identity, accountId);
        if (!bound.ok) {
          this.#deps.logger.info(`link: ${identity.userId} proved account ${accountId} by wallet but was refused: ${bound.reason}`);
          return { kind: 'refused', reason: bound.reason };
        }
        this.#deps.logger.info(`link: ${identity.userId} proved account ${accountId} by wallet; session already running`);
        await this.#notify(identity.chatId, `Linked to Perpl account ${accountId}: your wallet proved you own it. Alerts here now carry the buttons to act.`);
        return { kind: 'linked', accountId };
      }
      // EVERY OUTCOME IS LOGGED. This one was silent until 6 Oct 2026, so a phone
      // test that ended here left nothing to check it against.
      this.#deps.logger.info(`link: ${identity.userId} proved account ${accountId} by wallet; no session for it yet, so it needs an API key (nothing linked)`);
      return {
        kind: 'proven-needs-key',
        accountId,
        reason:
          `Your wallet owns Perpl account #${accountId}. To use the buttons, PerpGuard also needs an API key for it: paste one below to finish connecting.`,
      };
    }
    // The per-wallet detail is for the log; the person needs one sentence.
    this.#deps.logger.info(`link: ${identity.userId} wallet proof found no account: ${reasons.join(' ')}`);
    const here = this.#deps.network ?? 'this network';
    // NAME WHERE IT IS, when it is somewhere else: "that wallet owns no account" is
    // a false sentence to someone whose account is on the other network.
    for (const wallet of wallets) {
      const elsewhere = await this.#deps.lookupElsewhere?.(wallet.toLowerCase()).catch(() => undefined);
      if (elsewhere !== undefined) {
        this.#deps.logger.info(`link: ${identity.userId}'s wallet owns account ${elsewhere.accountId} on ${elsewhere.network}, not on ${here}`);
        return {
          kind: 'refused',
          reason:
            `This wallet owns Perpl account #${elsewhere.accountId} on ${elsewhere.network}. PerpGuard acts on ${here} only for now, and on ${here} this wallet has no account. ` +
            `Open a ${here} account with it on Perpl, or sign with the wallet that owns your ${here} account.`,
        };
      }
    }
    return { kind: 'refused', reason: `That wallet doesn't own a Perpl account on ${here}. Sign in with the wallet you opened your Perpl account with.` };
  }

  /**
   * A key proof: sign in once to learn whose it is, open the session, seal the
   * key, bind the chat. `provenAccountId` is the wallet proof the page holds,
   * if any; the key must be for the same account.
   */
  async proveKey(identity: TelegramIdentity, credentials: SealedCredentials, provenAccountId: number | undefined): Promise<KeyProof> {
    const vault = this.#deps.vault;
    if (vault === undefined) {
      return { kind: 'refused', reason: 'Connecting with an API key isn\'t available right now. Sign in with your wallet instead.' };
    }
    let secret: import('@perpguard/shared').ApiSecret;
    try {
      secret = this.#deps.secretFromHex(credentials.secretHex);
    } catch {
      // Deliberately without the input: nothing a user pastes here is ever repeated.
      return { kind: 'refused', reason: 'That secret doesn\'t look right: it should be 64 letters and numbers. Paste it exactly as Perpl showed it.' };
    }
    if (credentials.apiKey.trim().length < 16) return { kind: 'refused', reason: 'That API key looks too short. Paste it exactly as Perpl showed it.' };

    let probe: Probe;
    try {
      probe = await this.#deps.probe({ apiKey: credentials.apiKey.trim(), secretHex: credentials.secretHex });
    } catch (error) {
      // The venue's own error is for the log (it never contains the key); the person gets what to do.
      this.#deps.logger.info(`link: ${identity.userId} key probe refused by Perpl: ${error instanceof Error ? error.message : String(error)}`);
      return { kind: 'refused', reason: 'Perpl didn\'t accept that key. Check you copied both the key and its secret, and that the key hasn\'t been revoked.' };
    }
    if (probe.accountId === undefined) {
      return { kind: 'refused', reason: 'That key works, but no Perpl account is attached to it yet. Open your account on Perpl first.' };
    }
    const accountId = probe.accountId;
    // The page's proof, or one KEPT from an earlier visit while it still waits for its key (not yet
    // linked): a key for another account is refused. Once linked, a key for another account is a
    // deliberate switch, as it always was.
    const waiting = this.#deps.links.byUserId(identity.userId) === undefined ? this.#proofs.get(identity.userId)?.accountId : undefined;
    const proven = provenAccountId ?? waiting;
    if (proven !== undefined && proven !== accountId) {
      return { kind: 'refused', reason: `That key is for account #${accountId}, but your wallet owns account #${proven}. Paste a key for account #${proven}.` };
    }

    const opened = this.#deps.registry.open(accountId, { apiKey: credentials.apiKey.trim(), secret });
    if (!opened.ok) {
      this.#deps.logger.warn(`link: could not open a session for account ${accountId}: ${opened.reason}`);
      return { kind: 'refused', reason: 'PerpGuard can\'t connect another account right now. Try again later.' };
    }

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
        (probe.forwardingAllowed === false ? ' One thing first: this account doesn\'t allow trading by API key yet, so the buttons won\'t send. Turn on order forwarding in Perpl with the wallet that owns it.' : ''),
    );
    return { kind: 'linked', accountId, forwardingAllowed: probe.forwardingAllowed };
  }

  /** `/unlink`: the link goes, the key is DELETED, the session is closed (never the environment account's). */
  async unlink(userId: string): Promise<{ readonly ok: boolean; readonly text: string }> {
    const link = this.#deps.links.byUserId(userId);
    if (link === undefined) return { ok: false, text: 'This chat is not linked to any account.' };
    this.#deps.links.unlink(link.telegramUserId);
    const hadKey = this.#deps.keys.delete(userId);
    this.#proofs.delete(userId);
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
        this.#needsRelink.set(stored.userId, RELINK_REASON);
        this.#deps.logger.warn(`link: account ${stored.accountId} for ${stored.userId} not reopened: PERPGUARD_KEY_ENCRYPTION_KEY is not set`);
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
        // The person is told what to do; the cause, key ids and all, is for the log.
        this.#needsRelink.set(stored.userId, RELINK_REASON);
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
    const network = this.#deps.network === 'mainnet' || this.#deps.network === 'testnet' ? this.#deps.network : undefined;
    const result = this.#deps.links.link({ userId: identity.userId, accountId, telegramUserId: identity.telegramUserId, chatId: identity.chatId, linkedAtMs: this.#now(), ...(network === undefined ? {} : { network }) });
    if (result.ok) return { ok: true };
    return { ok: false, reason: result.refusal === 'at-capacity' ? 'PerpGuard can\'t connect another account right now. Try again later.' : 'PerpGuard couldn\'t save the connection. Try again in a moment.' };
  }

  async #notify(chatId: number, text: string): Promise<void> {
    try {
      await this.#deps.notify?.(chatId, text);
    } catch (error) {
      this.#deps.logger.warn(`link: could not tell chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
