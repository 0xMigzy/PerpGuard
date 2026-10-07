/**
 * COPYING IS ARMED BY A TAP AND ONLY BY A TAP, like Auto top-up
 * (`rescue/arming.ts`): the bot's "Start copying" handler passes who tapped and
 * from which chat; the control checks both are linked and SIGNS the rule over
 * every field that matters, under its own key derived from the server's. A
 * rule written any other way is never acted on.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export interface CopyArmed {
  readonly followerAccountId: number;
  readonly leaderAccountId: number;
  readonly startedAtMs: number;
  readonly armedBy: number | undefined;
  readonly armedChat: number | undefined;
  readonly armedAtMs: number | undefined;
}

const canonical = (r: CopyArmed): string =>
  ['copy-arm-v1', r.followerAccountId, r.leaderAccountId, r.startedAtMs, r.armedBy ?? '', r.armedChat ?? '', r.armedAtMs ?? ''].join('|');

/**
 * The kept-free figure is NOT signed: the person changes it from the status
 * screen without re-arming, and raising or lowering it never makes copying
 * act where it was not armed to. Everything that says WHO copies WHOM is.
 */
export class CopyArmSigner {
  readonly #key: Buffer;
  constructor(secretHex: string) {
    const ikm = Buffer.from(secretHex.trim(), 'hex');
    if (ikm.length < 16) throw new Error('the arming key needs the server key (PERPGUARD_KEY_ENCRYPTION_KEY)');
    this.#key = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'perpguard copy arm v1', 32));
  }
  sign(r: CopyArmed): string {
    return createHmac('sha256', this.#key).update(canonical(r)).digest('hex');
  }
  verify(r: CopyArmed, proof: string | undefined): boolean {
    if (proof === undefined || !/^[0-9a-f]{64}$/.test(proof) || r.armedBy === undefined) return false;
    return timingSafeEqual(Buffer.from(this.sign(r), 'hex'), Buffer.from(proof, 'hex'));
  }
}
