/**
 * Turning a Telegram failure into an honest {@link DeliveryResult}.
 *
 * `retryable` IS NOT COSMETIC. The alerts engine reads it to decide whether to
 * keep trying, and both wrong answers cost something real:
 *
 *   A retryable failure reported as permanent DROPS A DANGER ALERT that one more
 *   attempt would have delivered. Telegram's 429 is the ordinary case here — it
 *   is rate limiting, not rejection, and it comes with the wait attached.
 *
 *   A permanent failure reported as retryable burns three attempts and three
 *   backoffs against a chat that will never accept a message — a user who
 *   blocked the bot, a chat that no longer exists — and delays every alert queued
 *   behind it, since the engine serialises deliveries.
 *
 * So the classification is a pure function with its own tests rather than a
 * judgement made inline at a catch site.
 */
import { GrammyError, HttpError } from 'grammy';
import type { DeliveryResult } from '@perpguard/backend/alerts';
import { redactToken } from './config.ts';

/**
 * Telegram error codes we answer by name.
 *
 * 403 is the one that matters most: the user blocked the bot, or removed it from
 * the group. Nothing about that changes by trying again.
 */
const PERMANENT_CODES = new Set([
  400, // Bad Request: chat not found, message is too long, and friends.
  401, // Unauthorized: the token is wrong or revoked.
  403, // Forbidden: bot was blocked by the user / kicked from the chat.
  404, // Not Found: the method or chat is gone.
]);

/**
 * Codes that are explicitly worth another attempt.
 *
 * 429 carries `parameters.retry_after`, which is reported in the reason so the
 * engine's own backoff can be compared against what Telegram asked for.
 */
const RETRYABLE_CODES = new Set([
  420, // Flood.
  429, // Too Many Requests.
  500,
  502,
  503,
  504,
]);

/**
 * Classify anything thrown while sending.
 *
 * An UNRECOGNISED error is retryable. The asymmetry is deliberate: retrying
 * something permanent wastes two attempts, while giving up on something
 * transient loses the alert, and losing the alert is the failure this whole
 * product exists to prevent.
 */
export function classifyTelegramError(error: unknown, token: string): DeliveryResult {
  const redact = (text: string): string => redactToken(text, token);

  if (error instanceof GrammyError) {
    const retryAfter = error.parameters.retry_after;
    const suffix = retryAfter === undefined ? '' : ` (retry after ${retryAfter}s)`;
    const reason = redact(`Telegram ${error.error_code}: ${error.description}${suffix}`);

    if (RETRYABLE_CODES.has(error.error_code)) return { ok: false, reason, retryable: true };
    if (PERMANENT_CODES.has(error.error_code)) return { ok: false, reason, retryable: false };
    // A code we have not met. Treated as retryable for the reason above.
    return { ok: false, reason, retryable: true };
  }

  if (error instanceof HttpError) {
    // The request never reached Telegram: DNS, TLS, a dropped socket. Always
    // worth another attempt. grammY keeps the bot URL out of this by default,
    // and the redaction covers the case where it does not.
    const cause = error.error instanceof Error ? error.error.message : String(error.error);
    return {
      ok: false,
      reason: redact(`network failure talking to Telegram: ${error.message} (${cause})`),
      retryable: true,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, reason: redact(`unexpected send failure: ${message}`), retryable: true };
}
