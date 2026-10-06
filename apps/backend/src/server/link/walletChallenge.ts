/**
 * Wallet ownership on the linking page: a signed challenge, verified here.
 *
 * The page connects a wallet (RainbowKit), asks for a challenge naming that
 * address, has the wallet sign it, and posts the message and signature back.
 * The challenge is an EIP-4361 (Sign-In with Ethereum) message built by viem:
 * this site's domain and /link URI, the trading network's chain id, a random
 * nonce, issued-at and a five-minute expiry, and a statement saying in words
 * that the signature moves no funds and places no trade.
 *
 * THE SIGNATURE PROVES OWNERSHIP AND NOTHING ELSE. It never authorises
 * execution: that is the API key, entered separately and sealed.
 *
 * ONE OUTSTANDING CHALLENGE PER PAGE SESSION, CONSUMED BEFORE IT IS CHECKED.
 * Only the exact message this session was issued is accepted, so a message
 * from another session, another site, another chain or an earlier challenge
 * is refused without being trusted for anything; and because it is consumed
 * first, a signature can be used once whether it verifies or not. The address
 * passed on is the one the challenge was issued for AND the signature
 * recovers to, never a field of the request body.
 */
import { randomBytes } from 'node:crypto';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { getAddress, type Address, type Hex } from 'viem';

export const CHALLENGE_TTL_MS = 5 * 60_000;

export interface PendingChallenge {
  readonly message: string;
  readonly address: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
}

/** A place to keep one challenge per page session. */
export interface ChallengeHolder {
  challenge: PendingChallenge | undefined;
}

export interface WalletChallengeOptions {
  /** e.g. https://perpguard.app: its host is the message's domain, plus "/link" its URI. */
  readonly publicWebUrl: string;
  /** The trading network the account lives on. Named in the message so a signature for another chain is useless here. */
  readonly chainId: number;
  /** Verifies a personal_sign signature: EOAs and smart-contract wallets (ERC-1271/6492) alike. */
  readonly verifyMessage: (args: { readonly address: Address; readonly message: string; readonly signature: Hex }) => Promise<boolean>;
  readonly now?: () => number;
  readonly nonce?: () => string;
}

export type ChallengeResult = { readonly ok: true; readonly address: string } | { readonly ok: false; readonly reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]+$/;

export class WalletChallenger {
  readonly #o: WalletChallengeOptions;
  readonly #now: () => number;
  readonly #domain: string;
  readonly #uri: string;

  constructor(options: WalletChallengeOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    const url = new URL(options.publicWebUrl);
    this.#domain = url.host;
    this.#uri = `${url.origin}/link`;
  }

  /** A fresh challenge for `address`, replacing any outstanding one on this session. */
  issue(holder: ChallengeHolder, address: string, telegramName: string | undefined): { readonly message: string } | { readonly error: string } {
    if (!ADDRESS.test(address)) return { error: 'That is not a wallet address.' };
    const now = this.#now();
    const nonce = this.#o.nonce?.() ?? randomBytes(16).toString('hex');
    const expiresAtMs = now + CHALLENGE_TTL_MS;
    const message = createSiweMessage({
      domain: this.#domain,
      address: getAddress(address),
      statement: `Link this wallet to PerpGuard${telegramName === undefined ? '' : ` for Telegram ${telegramName}`}. This signature only proves you own the wallet: it moves no funds and places no trade.`,
      uri: this.#uri,
      version: '1',
      chainId: this.#o.chainId,
      nonce,
      issuedAt: new Date(now),
      expirationTime: new Date(expiresAtMs),
    });
    holder.challenge = { message, address: address.toLowerCase(), nonce, expiresAtMs };
    return { message };
  }

  /** Consumes the session's challenge, then checks the message is that challenge, unexpired, and signed by its address. */
  async verify(holder: ChallengeHolder, message: unknown, signature: unknown): Promise<ChallengeResult> {
    const pending = holder.challenge;
    holder.challenge = undefined; // consumed before anything is trusted: one use, success or not
    if (pending === undefined) return { ok: false, reason: 'no-challenge' };
    if (typeof message !== 'string' || message !== pending.message) return { ok: false, reason: 'not-this-challenge' };
    if (this.#now() >= pending.expiresAtMs) return { ok: false, reason: 'expired' };
    // Belt and braces: the message we issued must still parse as ours.
    const parsed = parseSiweMessage(message);
    if (parsed.domain !== this.#domain || parsed.uri !== this.#uri || parsed.chainId !== this.#o.chainId || parsed.nonce !== pending.nonce) return { ok: false, reason: 'not-this-challenge' };
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return { ok: false, reason: 'bad-signature' };
    let valid = false;
    try {
      valid = await this.#o.verifyMessage({ address: pending.address as Address, message, signature: signature as Hex });
    } catch {
      valid = false;
    }
    return valid ? { ok: true, address: pending.address } : { ok: false, reason: 'bad-signature' };
  }
}
