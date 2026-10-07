/**
 * AUTO TOP-UP IS ARMED BY A TAP, AND ONLY BY A TAP (owner, 7 Oct 2026, after
 * a script-armed rule topped up 710 at 01:55 with nobody watching).
 *
 * Arming exists in one place: the bot's handler for the "Turn on auto" tap,
 * from the chat linked to that account. That handler hands the control an
 * `ArmContext` (who tapped, from which chat); the control checks the person
 * and chat are linked to the account, and SIGNS the rule: an HMAC-SHA256 over
 * every field that matters, under a key derived from the server's own
 * encryption key. The engine verifies the signature, and that the person is
 * still linked, before it judges the rule and again right before any send.
 *
 * A rule written any other way (a script, an operator tool, a database insert)
 * carries no valid signature and is NEVER ACTED ON: it is switched off and
 * shown as not armed by you. Rules from before this change carry none.
 *
 * The limit, said once: anyone holding the server's key on this machine could
 * compute a signature. What this closes is every path that does not.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export interface ArmContext {
  readonly telegramUserId: number;
  readonly chatId: number;
}

/** The fields a signature covers. A change to any of them voids it. */
export interface Armed {
  readonly accountId: number;
  readonly marketId: number;
  readonly positionId: number;
  readonly amountCNS: bigint;
  readonly maxRescues: number;
  readonly maxTotalCNS: bigint;
  readonly minRemainingCNS: bigint;
  readonly cooldownMs: number;
  readonly armedBy: number | undefined;
  readonly armedChat: number | undefined;
  readonly armedAtMs: number | undefined;
}

const canonical = (r: Armed): string =>
  ['rescue-arm-v1', r.accountId, r.marketId, r.positionId, String(r.amountCNS), r.maxRescues, String(r.maxTotalCNS), String(r.minRemainingCNS), r.cooldownMs, r.armedBy ?? '', r.armedChat ?? '', r.armedAtMs ?? ''].join('|');

export class ArmSigner {
  readonly #key: Buffer;

  /** `secretHex`: the server's key-encryption key. A separate key is derived from it for this one purpose. */
  constructor(secretHex: string) {
    const ikm = Buffer.from(secretHex.trim(), 'hex');
    if (ikm.length < 16) throw new Error('the arming key needs the server key (PERPGUARD_KEY_ENCRYPTION_KEY)');
    this.#key = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'perpguard rescue arm v1', 32));
  }

  sign(r: Armed): string {
    return createHmac('sha256', this.#key).update(canonical(r)).digest('hex');
  }

  /** True only for a signature this server made over exactly these fields. */
  verify(r: Armed, proof: string | undefined): boolean {
    if (proof === undefined || !/^[0-9a-f]{64}$/.test(proof) || r.armedBy === undefined) return false;
    const want = Buffer.from(this.sign(r), 'hex');
    return timingSafeEqual(want, Buffer.from(proof, 'hex'));
  }
}
