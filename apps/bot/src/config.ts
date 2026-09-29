/**
 * Bot configuration, and the one rule that outranks every other rule in this
 * package: THE TOKEN NEVER LEAVES THIS MODULE AS TEXT.
 *
 * A Telegram bot token is a bearer credential. Anyone holding it can read every
 * message the bot receives and send as the bot — which for PerpGuard means
 * telling a trader their position is fine. It is therefore never logged, never
 * echoed in an error, and never interpolated into a message.
 *
 * That is not achievable by care alone. grammY builds its request URL as
 * `https://api.telegram.org/bot<TOKEN>/sendMessage`, and a network failure deep
 * in `fetch` can surface a message quoting that URL. Its own `sensitiveLogs`
 * flag defaults to off, which keeps it out of grammY's own errors — but the
 * error we hand back to the alerts engine is written into an `alert_log` row and
 * an error-level log line, so it gets {@link redactToken} applied unconditionally
 * rather than on the assumption that upstream got it right.
 */
import { ConfigError } from '@perpguard/shared';

export interface BotConfig {
  /** The bearer token. Never render, never log, never put in an error. */
  readonly token: string;
  /**
   * The app-level user this bot alerts, as the alerts engine names them.
   *
   * Distinct from the Telegram user id on purpose: the alerts engine addresses
   * an app user, and the link table maps that to a chat. Keeping them separate
   * is what makes a second user a row rather than a refactor.
   */
  readonly userId: string;
  /**
   * The only Telegram user permitted to claim the link, when set.
   *
   * Optional, and its absence is a real trade-off worth stating: without it the
   * first `/start` from anyone claims the link and the bot then closes to
   * everyone else. That is fine for a bot whose token is private, and it is how
   * the demo runs. Set it whenever the token might have been seen by anyone
   * else — it turns "first to arrive" into "only this person".
   */
  readonly ownerTelegramUserId: number | undefined;
}

/**
 * Replace the token wherever it appears in a string.
 *
 * Applied to every outbound reason string, including ones we did not write.
 * Takes the token rather than reading it from config so it stays a pure
 * function with no ambient state.
 */
export function redactToken(text: string, token: string): string {
  if (token === '') return text;
  return text.split(token).join('<redacted>');
}

const REQUIRED = 'TELEGRAM_BOT_TOKEN';

/**
 * Read the config from the environment.
 *
 * The missing-token error names the VARIABLE and nothing else. An error message
 * that quotes what it found is how a truncated token ends up in a CI log.
 */
export function loadBotConfig(env: Readonly<Record<string, string | undefined>>): BotConfig {
  const token = env[REQUIRED]?.trim();
  if (token === undefined || token === '') {
    throw new ConfigError(
      `${REQUIRED} is not set. The Telegram bot cannot start without it. ` +
        `Set it in the environment; it is never read from a file or a flag.`,
    );
  }

  const userId = env['PERPGUARD_USER_ID']?.trim();

  const ownerRaw = env['TELEGRAM_OWNER_ID']?.trim();
  let ownerTelegramUserId: number | undefined;
  if (ownerRaw !== undefined && ownerRaw !== '') {
    const parsed = Number(ownerRaw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ConfigError(
        `TELEGRAM_OWNER_ID must be a positive integer Telegram user id, got ` +
          `${JSON.stringify(ownerRaw)}`,
      );
    }
    ownerTelegramUserId = parsed;
  }

  return {
    token,
    userId: userId === undefined || userId === '' ? 'default' : userId,
    ownerTelegramUserId,
  };
}
