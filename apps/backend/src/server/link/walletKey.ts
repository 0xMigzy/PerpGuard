/**
 * 🔗 CONNECT WITH ONE WALLET SIGNATURE (8 Oct 2026): the key is created for
 * you. Connect the wallet, sign once, and PerpGuard holds a trade-only Perpl
 * API key for the account, sealed exactly as a pasted one is.
 *
 *   start   the backend makes an Ed25519 key pair and asks Perpl for the
 *           enrolment payload for the connected address (no Origin, no
 *           Referer: `postToPerpl`). The typed data goes to the page; the
 *           secret stays here, held for this page session for five minutes.
 *   finish  the wallet's signature is checked against the address (the same
 *           viem verification /link's challenge uses, so smart-contract
 *           wallets work), the key proves possession, Perpl enrols it, and the
 *           result goes through the EXISTING path: `proveWallet` records the
 *           ownership the signature proved, `proveKey` signs in, seals and
 *           links. Nothing about key storage is new.
 *
 * BEHIND THE `wallet-key` SWITCH, checked on every call: off, both refuse in
 * words that point at pasting a key, which keeps working either way.
 */
import type { TelegramIdentity } from '@perpguard/bot';
import { enrollKey, newPerplKeyPair, proofOfPossession, requestKeyPayload, type PerplKeyTypedData, type PerplPoster } from '@perpguard/shared';
import type { KeyObject } from 'node:crypto';
import type { FeatureFlags } from '../featureFlags.ts';
import type { KeyProof, WalletProof } from './service.ts';

export interface WalletKeyDeps {
  readonly flags: FeatureFlags;
  readonly post: PerplPoster;
  /** The TRADING network's REST base, e.g. https://testnet.perpl.xyz/api. */
  readonly restBaseUrl: string;
  readonly chainId: number;
  /** The EIP-712 digest of Perpl's typed data, as the wallet signed it (viem's hashTypedData). */
  readonly digestOf: (typedData: PerplKeyTypedData) => string;
  /** Whether `signature` is `address`'s signature over the typed data. */
  readonly verify: (address: string, typedData: PerplKeyTypedData, signature: string) => Promise<boolean>;
  readonly service: {
    proveWallet(identity: TelegramIdentity, wallets: readonly string[]): Promise<WalletProof>;
    proveKey(identity: TelegramIdentity, credentials: { readonly apiKey: string; readonly secretHex: string }, provenAccountId: number | undefined, options?: { readonly perplLabel?: string }): Promise<KeyProof>;
    /** The key already sealed for this person, opened; undefined when there is none or it cannot be opened. */
    storedCredentials(userId: string): { readonly apiKey: string; readonly secretHex: string } | undefined;
  };
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export type WalletKeyRefusal = 'off' | 'bad-address' | 'expired' | 'bad-signature' | 'no-profile' | 'key-limit' | 'already-enrolled' | 'failed';

export type WalletKeyStart =
  | { readonly kind: 'sign'; readonly typedData: PerplKeyTypedData }
  /** REUSED: the key PerpGuard already holds still signs in for this wallet's account. Nothing was created. */
  | { readonly kind: 'linked'; readonly accountId: number; readonly forwardingAllowed: boolean | undefined; readonly text: string; readonly reused: true }
  | { readonly kind: 'refused'; readonly reason: WalletKeyRefusal; readonly text: string };

export type WalletKeyFinish =
  | { readonly kind: 'linked'; readonly accountId: number; readonly forwardingAllowed: boolean | undefined; readonly text: string }
  | { readonly kind: 'refused'; readonly reason: WalletKeyRefusal | 'not-linked'; readonly text: string };

interface Pending {
  readonly address: string;
  readonly privateKey: KeyObject;
  readonly secretHex: string;
  readonly typedData: PerplKeyTypedData;
  readonly mac: string;
  readonly label: string;
  readonly atMs: number;
}

const HOLD_MS = 5 * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The label a created key carries on the person's Perpl profile: `PerpGuard · 8 Oct 2026` (UTC), so it is easy to find and remove. */
export function walletKeyLabel(nowMs: number): string {
  const d = new Date(nowMs);
  return `PerpGuard · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export class WalletKeyFlow {
  readonly #d: WalletKeyDeps;
  readonly #now: () => number;
  /** One pending creation per page session. */
  readonly #pending = new Map<string, Pending>();

  constructor(deps: WalletKeyDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  enabled(): boolean {
    return this.#d.flags.isOn('wallet-key');
  }

  /** Where the person opens an account or manages keys: the trading network's own site. */
  #site(): string {
    return new URL(this.#d.restBaseUrl).hostname;
  }

  /** The owner's wording (8 Oct 2026). No codes, and always the way out. */
  text(reason: WalletKeyRefusal): string {
    switch (reason) {
      case 'off':
        return 'Creating a key from your wallet isn’t available right now. Paste an API key you already have instead.';
      case 'bad-address':
        return 'Connect your wallet first, then try again.';
      case 'expired':
        return 'That request expired. Try again: it asks your wallet for one new signature.';
      case 'bad-signature':
        return 'That signature couldn’t be confirmed for this wallet, so nothing was created. Try again.';
      case 'no-profile':
        return `This wallet hasn’t used Perpl yet. Open an account at ${this.#site()} first, then come back.`;
      case 'key-limit':
        return `This wallet already has as many Perpl API keys as Perpl allows. Remove one you no longer use at ${this.#site()}/apikeys, then try again.`;
      case 'already-enrolled':
        return 'Perpl says this key is already registered, so nothing new was created. Try again, or paste an API key you already have instead.';
      case 'failed':
        return 'That didn’t work, and nothing was saved. Try again, or paste an API key you already have instead.';
    }
  }

  #refuse<K extends 'refused'>(reason: WalletKeyRefusal): { readonly kind: K; readonly reason: WalletKeyRefusal; readonly text: string } {
    return { kind: 'refused' as K, reason, text: this.text(reason) };
  }

  async start(sessionKey: string, identity: TelegramIdentity, address: string): Promise<WalletKeyStart> {
    if (!this.enabled()) return this.#refuse('off');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return this.#refuse('bad-address');
    this.#sweep();

    // REUSE BEFORE CREATING (owner, 8 Oct 2026): every created key stays on the person's Perpl profile
    // (Perpl has no API to revoke one) and a profile holds at most 16. If PerpGuard already holds a key for
    // this person that still signs in, and this wallet owns that key's account, connect with it.
    const reused = await this.#reuse(identity, address);
    if (reused !== undefined) return reused;

    const label = walletKeyLabel(this.#now());
    const pair = newPerplKeyPair();
    let payload;
    try {
      payload = await requestKeyPayload(this.#d.post, this.#d.restBaseUrl, { chainId: this.#d.chainId, address, publicKeyHex: pair.publicKeyHex, label });
    } catch (error) {
      this.#d.log(`wallet-key: payload for ${address} did not answer (${error instanceof Error ? error.message : String(error)})`);
      return this.#refuse('failed');
    }
    if (payload.kind === 'failed') {
      this.#d.log(`wallet-key: Perpl refused the payload for ${address}: ${payload.status} ${payload.detail}`);
      return this.#refuse('failed');
    }
    this.#pending.set(sessionKey, { address, privateKey: pair.privateKey, secretHex: pair.secretHex, typedData: payload.typedData, mac: payload.mac, label, atMs: this.#now() });
    this.#d.log(`wallet-key: payload issued for ${address}`);
    return { kind: 'sign', typedData: payload.typedData };
  }

  async finish(sessionKey: string, identity: TelegramIdentity, signature: string): Promise<WalletKeyFinish> {
    if (!this.enabled()) {
      this.#pending.delete(sessionKey);
      return this.#refuse('off');
    }
    const p = this.#pending.get(sessionKey);
    this.#pending.delete(sessionKey); // ONCE: a second finish finds nothing
    if (p === undefined || this.#now() - p.atMs > HOLD_MS) return this.#refuse('expired');
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return this.#refuse('bad-signature');

    // THE SIGNATURE IS THE WALLET'S: checked here before anything is sent, so a forged one never reaches Perpl.
    let valid = false;
    try {
      valid = await this.#d.verify(p.address, p.typedData, signature);
    } catch {
      valid = false;
    }
    if (!valid) {
      this.#d.log(`wallet-key: ${identity.userId} sent a signature that does not verify for ${p.address}`);
      return this.#refuse('bad-signature');
    }

    let enrolled;
    try {
      enrolled = await enrollKey(this.#d.post, this.#d.restBaseUrl, {
        chainId: this.#d.chainId,
        address: p.address,
        typedData: p.typedData,
        mac: p.mac,
        signature,
        popSignature: proofOfPossession(p.privateKey, this.#d.digestOf(p.typedData)),
      });
    } catch (error) {
      this.#d.log(`wallet-key: enroll for ${p.address} did not answer (${error instanceof Error ? error.message : String(error)})`);
      return this.#refuse('failed');
    }
    if (enrolled.kind !== 'enrolled') {
      this.#d.log(`wallet-key: Perpl did not enrol a key for ${p.address}: ${enrolled.kind}${enrolled.kind === 'failed' ? ` (${enrolled.status} ${enrolled.detail})` : ''}`);
      return this.#refuse(enrolled.kind);
    }
    this.#d.log(`wallet-key: Perpl enrolled a key for ${p.address}; linking`);

    // OWNERSHIP, AS THE SIGNATURE PROVED IT: recorded through the same path a signed challenge takes.
    const ownership = await this.#d.service.proveWallet(identity, [p.address]);
    if (ownership.kind === 'linked') {
      // The wallet owns the account this deployment runs: linked already, on the deployment's own key.
      return { kind: 'linked', accountId: ownership.accountId, forwardingAllowed: undefined, text: `Connected to Perpl account #${ownership.accountId}.` };
    }
    const proven = ownership.kind === 'proven-needs-key' ? ownership.accountId : undefined;

    // THE KEY GOES THROUGH THE EXISTING PATH: sign in, seal, link, tell the chat. Nothing about storage is new.
    const keyed = await this.#d.service.proveKey(identity, { apiKey: enrolled.apiKey, secretHex: p.secretHex }, proven, { perplLabel: p.label });
    if (keyed.kind !== 'linked') {
      this.#d.log(`wallet-key: the new key for ${p.address} did not link: ${keyed.reason}`);
      return { kind: 'refused', reason: 'not-linked', text: keyed.reason };
    }
    const forwarding = this.#forwarding(keyed.forwardingAllowed);
    return { kind: 'linked', accountId: keyed.accountId, forwardingAllowed: keyed.forwardingAllowed, text: `Connected to Perpl account #${keyed.accountId}. The key was created for you; there’s nothing to copy or save.${forwarding}` };
  }

  /**
   * The key PerpGuard already holds, if it still signs in for the account THIS wallet owns. Undefined
   * otherwise (none stored, revoked, or for another account): then a new key is created, never a failure.
   */
  async #reuse(identity: TelegramIdentity, address: string): Promise<WalletKeyStart | undefined> {
    const stored = this.#d.service.storedCredentials(identity.userId);
    if (stored === undefined) return undefined;
    // Which account this wallet owns, by the same lookup a signed challenge takes. An env-account owner links at once.
    const ownership = await this.#d.service.proveWallet(identity, [address]);
    if (ownership.kind === 'linked') return { kind: 'linked', accountId: ownership.accountId, forwardingAllowed: undefined, text: `Connected to Perpl account #${ownership.accountId}.`, reused: true };
    if (ownership.kind !== 'proven-needs-key') return undefined;
    // proveKey signs in first: a key that no longer works, or works for another account, is refused here, and a new one follows.
    const keyed = await this.#d.service.proveKey(identity, stored, ownership.accountId);
    if (keyed.kind !== 'linked') {
      this.#d.log(`wallet-key: ${identity.userId}'s stored key cannot be reused (${keyed.reason}); creating a new one`);
      return undefined;
    }
    this.#d.log(`wallet-key: ${identity.userId} reconnected account ${keyed.accountId} with the key PerpGuard already holds; nothing created`);
    return {
      kind: 'linked',
      accountId: keyed.accountId,
      forwardingAllowed: keyed.forwardingAllowed,
      text: `Connected to Perpl account #${keyed.accountId} with the key PerpGuard already holds for it. Nothing new was created.${this.#forwarding(keyed.forwardingAllowed)}`,
      reused: true,
    };
  }

  #forwarding(allowed: boolean | undefined): string {
    return allowed === false
      ? ` One thing left: order forwarding is off for this account, so PerpGuard can’t place orders yet. Turn on One-Click Trading in Perpl’s settings at ${this.#site()}, with this wallet. PerpGuard won’t do it for you.`
      : '';
  }

  #sweep(): void {
    const now = this.#now();
    for (const [k, p] of this.#pending) if (now - p.atMs > HOLD_MS) this.#pending.delete(k);
  }
}
