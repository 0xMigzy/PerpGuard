/**
 * What the bot is allowed to know about free balance, and the one honest thing
 * it may say about it.
 *
 * THE NUMBER IS A FLOOR, NOT THE BALANCE, and that is baked into the type rather
 * than left to the caller to remember. Perpl's account snapshot carries `b`
 * ("Balance") and `lb` ("Locked balance") and the docs do not say whether `b`
 * already excludes what `lb` counts, so the venue reports `b - lb`: exact if
 * `lb` sits inside `b`, understated by `lb` if it sits outside, and never
 * overstated either way. See `freeBalanceFloorCNS` in
 * `packages/shared/src/venues/perpl-trading-socket.ts`.
 *
 * Two consequences run through every use of this, and both are enforced in
 * `custom.ts`:
 *
 *   THE WORDS SAY "AT LEAST". Never "you have", never "your balance is". A floor
 *   rendered as a figure is a lie in the small, and the trader who notices the
 *   discrepancy is the one who stops believing the rest of the message.
 *
 *   IT NEVER REFUSES AN ACTION. An amount over the floor gets a warning and
 *   proceeds. Blocking a legitimate rescue because our own figure was
 *   conservative is a worse failure than letting a genuinely short request be
 *   rejected by the venue, which knows the real number and says so.
 *
 * Synchronous, like {@link RiskView}: something deciding what to tell a trader
 * must not have to await it, and an awaited balance check is one that can hang.
 */

/**
 * A free-balance reading.
 *
 * `known: false` is a first-class answer rather than a zero or an absent field.
 * Zero would be rendered as a real balance of nothing — which reads as "you
 * cannot rescue this position" to the one person who most needs not to be told
 * that wrongly.
 */
export type FreeBalanceReading =
  | {
      readonly known: true;
      /** A FLOOR on spendable AUSD, in micros. Never presented as the balance. */
      readonly floorCNS: bigint;
    }
  | {
      readonly known: false;
      /** Human-readable, safe to render directly. Says what is missing. */
      readonly reason: string;
    };

export interface FreeBalanceView {
  freeBalance(): FreeBalanceReading;
}

/**
 * The reading for a bot with no account session behind it.
 *
 * Used when the venue has no trading socket — the read-only demo wiring, or
 * before sign-in. It says so instead of guessing, and the custom-amount flow
 * carries on without the balance check rather than refusing to work.
 */
export class UnknownFreeBalance implements FreeBalanceView {
  readonly #reason: string;

  constructor(reason = 'I am not signed in to the trading account, so I cannot see your balance.') {
    this.#reason = reason;
  }

  freeBalance(): FreeBalanceReading {
    return { known: false, reason: this.#reason };
  }
}

/**
 * A reading from a venue that reports a floor in micros, or undefined when it has
 * not been told.
 *
 * Takes a function rather than the venue so the bot keeps knowing nothing about
 * Perpl: venue-specific code lives only in `packages/shared/src/venues/`.
 */
export function freeBalanceFrom(
  floorCNS: () => bigint | undefined,
  reasonWhenUnknown = 'I have not had an account snapshot yet, so I cannot see your balance.',
): FreeBalanceView {
  return {
    freeBalance(): FreeBalanceReading {
      const floor = floorCNS();
      if (floor === undefined) return { known: false, reason: reasonWhenUnknown };
      return { known: true, floorCNS: floor };
    },
  };
}
