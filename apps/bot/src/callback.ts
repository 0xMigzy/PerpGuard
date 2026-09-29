/**
 * What a button carries, and what comes back when it is tapped.
 *
 * Telegram gives a button exactly 64 BYTES of `callback_data`. That is nowhere
 * near enough for a rendered top-up line, so the full {@link AlertAction} lives
 * in a {@link PendingActionStore} and the button carries a short token into it.
 *
 * The token is NOT the whole payload, deliberately. `marketId` and `amountCNS`
 * travel alongside it and are checked against the stored action when the tap
 * arrives. A token collision, a store bug or a reused slot then produces a
 * refusal instead of an action against the wrong position — the failure this
 * cross-check exists to prevent is adding margin to a BTC position because a
 * button for an ETH one was tapped, which is precisely the mistake a trader
 * cannot undo.
 *
 * Every payload carries a VERSION. A button sitting in a chat outlives the
 * process that sent it, so a shape change must be detectable rather than
 * silently misparsed: a decoder that read an old payload under a new shape
 * would produce a plausible marketId and a plausible amount.
 */

/** What a tap is asking for. */
export type CallbackKind =
  /** Show the confirmation screen for this action. Executes nothing. */
  | 'act'
  /** The user confirmed. This is the only kind that may reach the executor. */
  | 'confirm'
  /**
   * The acting venue cannot take this action. The button exists so the option
   * stays visible and so the reason can be shown on tap — it is the Telegram
   * equivalent of a disabled control, and it never executes.
   */
  | 'blocked';

export interface CallbackPayload {
  readonly kind: CallbackKind;
  /** Key into the pending action store. */
  readonly token: string;
  /** Cross-check against the stored action. */
  readonly marketId: number;
  /** Cross-check against the stored action, in AUSD micros. */
  readonly amountCNS: bigint;
}

/** Telegram's hard limit on `callback_data`, in bytes. */
export const CALLBACK_DATA_MAX_BYTES = 64;

const VERSION = '1';
const PREFIX: Readonly<Record<CallbackKind, string>> = {
  act: 'a',
  confirm: 'c',
  blocked: 'x',
};
const KIND_BY_PREFIX = new Map<string, CallbackKind>(
  Object.entries(PREFIX).map(([kind, prefix]) => [prefix, kind as CallbackKind]),
);

/** Tokens are opaque and must not collide with the separator. */
const TOKEN_PATTERN = /^[0-9a-z]{1,16}$/;

/**
 * Build the `callback_data` for one button.
 *
 * THROWS rather than truncates when the result exceeds 64 bytes. Telegram
 * rejects an oversized payload at send time with a 400, so truncating here
 * would turn a loud failure into a button that decodes to a different amount.
 */
export function encodeCallback(payload: CallbackPayload): string {
  if (!TOKEN_PATTERN.test(payload.token)) {
    throw new RangeError(
      `callback token ${JSON.stringify(payload.token)} must be 1-16 lowercase ` +
        `alphanumerics: it is embedded in a colon-separated payload.`,
    );
  }
  if (!Number.isSafeInteger(payload.marketId) || payload.marketId < 0) {
    throw new RangeError(`marketId must be a non-negative integer, got ${payload.marketId}`);
  }
  if (payload.amountCNS < 0n) {
    throw new RangeError(`amountCNS cannot be negative, got ${payload.amountCNS}`);
  }

  const data = `${PREFIX[payload.kind]}${VERSION}:${payload.token}:${payload.marketId}:${payload.amountCNS}`;
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new RangeError(
      `callback data is ${bytes} bytes, over Telegram's ${CALLBACK_DATA_MAX_BYTES}-byte ` +
        `limit: ${data}. Shorten the token or move data into the pending action store.`,
    );
  }
  return data;
}

export type CallbackDecode =
  | { readonly ok: true; readonly payload: CallbackPayload }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a tap back.
 *
 * Never throws and never guesses. Anything unrecognised — an older version, a
 * hand-crafted payload, a truncated one — comes back as a refusal with a reason,
 * because the alternative is acting on a number we reconstructed from something
 * we did not write.
 */
export function decodeCallback(data: string): CallbackDecode {
  const parts = data.split(':');
  if (parts.length !== 4) {
    return { ok: false, reason: `expected 4 colon-separated fields, got ${parts.length}` };
  }
  const [head, token, marketRaw, amountRaw] = parts as [string, string, string, string];

  if (head.length !== 2) return { ok: false, reason: `unrecognised header ${JSON.stringify(head)}` };
  const kind = KIND_BY_PREFIX.get(head[0]!);
  if (kind === undefined) {
    return { ok: false, reason: `unrecognised button kind ${JSON.stringify(head[0])}` };
  }
  if (head[1] !== VERSION) {
    // Said plainly, because it is the ordinary case after a deploy and the user
    // needs to know the fix is `/positions`, not "try again".
    return {
      ok: false,
      reason: `this button was sent by an older version of the bot (payload v${head[1]}, this is v${VERSION})`,
    };
  }
  if (!TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: `malformed token ${JSON.stringify(token)}` };
  }
  if (!/^\d+$/.test(marketRaw)) {
    return { ok: false, reason: `malformed market id ${JSON.stringify(marketRaw)}` };
  }
  if (!/^\d+$/.test(amountRaw)) {
    return { ok: false, reason: `malformed amount ${JSON.stringify(amountRaw)}` };
  }

  const marketId = Number(marketRaw);
  if (!Number.isSafeInteger(marketId)) {
    return { ok: false, reason: `market id ${marketRaw} is out of range` };
  }

  return { ok: true, payload: { kind, token, marketId, amountCNS: BigInt(amountRaw) } };
}
