import type { Bot, Transformer } from 'grammy';
import { BotError } from 'grammy';

/**
 * ONE BAD UPDATE MUST NEVER STOP THE BOT LISTENING.
 *
 * grammY's default error handler STOPS LONG POLLING on any error a handler
 * throws. On 8 Oct 2026 one stale tap ("query is too old", a 400 from
 * `answerCallbackQuery`) did exactly that: the process kept sending alerts and
 * stopped hearing every command, and nothing in /health said so.
 */

/**
 * A callback query can only be answered for about 15 s. A tap that waited
 * longer (a restart, a slow handler) gets a 400 on the answer, and the answer
 * is only the spinner on the button: the screen the tap asked for must still
 * be shown. So that one refusal is turned into a success, and logged.
 */
export function tolerateStaleCallbackAnswers(log?: (line: string) => void): Transformer {
  return async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method === 'answerCallbackQuery' && !result.ok && result.error_code === 400) {
      log?.(`telegram: callback answer refused (${result.description}); carrying on with the tap`);
      return { ok: true, result: true as never };
    }
    return result;
  };
}

/** Logs a handler's error and KEEPS POLLING. Installed as `bot.catch`. */
export function keepPollingOnError(log?: (line: string) => void): (error: BotError) => void {
  return (error) => {
    const cause = error.error instanceof Error ? error.error.message : String(error.error);
    log?.(`telegram: update ${error.ctx?.update?.update_id ?? '?'} failed and was dropped; still polling: ${cause}`);
  };
}

export function makeResilient(bot: Bot, log?: (line: string) => void): void {
  bot.api.config.use(tolerateStaleCallbackAnswers(log));
  bot.catch(keepPollingOnError(log));
}
