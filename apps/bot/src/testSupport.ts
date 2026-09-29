/**
 * A fake Telegram, and the scaffolding the bot tests share.
 *
 * NOTHING HERE OPENS A SOCKET. The fake sits where grammY talks to Telegram — as
 * an API transformer, which is the same seam grammY's own plugins use — so every
 * test exercises the real `Bot`, the real middleware stack, the real command
 * routing and the real error classes. A hand-rolled stub of `ctx` would test the
 * test instead.
 *
 * `botInfo` is supplied so `getMe` is never called: that is the one request
 * grammY makes before any of ours, and it is also the one that would turn a unit
 * test into a network test.
 *
 * The assessments the messages are built from come from THE REAL RISK LOOP, via
 * the alerts layer's own test support. So the amounts and liquidation prices in
 * the expected strings are the engine's output, not a calculator's.
 */
import { Bot, HttpError, type Api } from 'grammy';
import type { ApiResponse, UserFromGetMe } from 'grammy/types';
import type { ActionAvailability } from '@perpguard/shared';
import { DEFAULT_ALERT_CONFIG, type AlertMessage } from '@perpguard/backend/alerts';
import { buildMessage } from '@perpguard/backend/alerts/render';
import { kindFor } from '@perpguard/backend/alerts/rules';
import type { RiskAssessment } from '@perpguard/backend/risk';
import { assessOne, BTC, CONFIGS, FIXTURE_BTC, FIXTURE_BTC_MARK } from '@perpguard/backend/alerts/test-support';
import { PendingActionStore, type ActionExecutor, type ExecuteRequest, type ExecutionOutcome } from './actions.ts';
import { InMemoryLinkStore, type LinkRecord } from './links.ts';
import type { RiskView } from './view.ts';

/** A token shaped like a real one. Never a real one. */
export const TEST_TOKEN = '123456:TEST-TOKEN-do-not-use';

export const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'PerpGuard',
  username: 'perpguard_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export const OWNER_ID = 4242;
export const OWNER_CHAT = 5150;
export const STRANGER_ID = 6060;
export const USER_ID = 'trader-1';

export const OWNER_LINK: LinkRecord = {
  userId: USER_ID,
  telegramUserId: OWNER_ID,
  chatId: OWNER_CHAT,
  linkedAtMs: 1_000_000,
};

export interface TelegramCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Records every API call and answers with whatever it is told to.
 *
 * `script` is consumed one entry per call, so a test can make the first attempt
 * fail with a 429 and the second succeed — which is exactly the retry behaviour
 * the alerts engine depends on.
 */
export class FakeTelegram {
  readonly calls: TelegramCall[] = [];
  readonly script: Array<ApiResponse<unknown> | Error> = [];
  #messageId = 1;

  /** Queue responses, consumed in order. Anything unscripted succeeds. */
  reply(...responses: Array<ApiResponse<unknown> | Error>): this {
    this.script.push(...responses);
    return this;
  }

  /** A Telegram API error response, as grammY will turn into a GrammyError. */
  static error(code: number, description: string, retryAfter?: number): ApiResponse<never> {
    return {
      ok: false,
      error_code: code,
      description,
      ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }),
    };
  }

  /**
   * What grammY raises when the request never reached Telegram.
   *
   * Modelled as the real `HttpError` rather than a bare `Error`, because the
   * classification we are testing keys on the class.
   */
  static network(detail: string): HttpError {
    return new HttpError('Network request for "sendMessage" failed!', new Error(detail));
  }

  /** Calls to one method, in order. */
  of(method: string): readonly TelegramCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The most recent call to one method. */
  last(method: string): TelegramCall {
    const found = [...this.of(method)].pop();
    if (found === undefined) throw new Error(`no ${method} call was made`);
    return found;
  }

  install(api: Api): void {
    api.config.use(async (_prev, method, rawPayload) => {
      const payload = rawPayload as Record<string, unknown>;
      this.calls.push({ method, payload });
      const scripted = this.script.shift();
      // A thrown entry models a transport failure BELOW the API: grammY wraps it
      // in HttpError, which is what a dropped socket produces.
      if (scripted instanceof Error) throw scripted;
      if (scripted !== undefined) return scripted as never;
      return {
        ok: true,
        result: {
          message_id: this.#messageId++,
          date: 0,
          chat: { id: Number(payload['chat_id'] ?? 0), type: 'private' },
          text: String(payload['text'] ?? ''),
        },
      } as never;
    });
  }
}

/** A bot wired to a fake Telegram, with nothing else changed. */
export function fakeBot(): { readonly bot: Bot; readonly telegram: FakeTelegram } {
  const bot = new Bot(TEST_TOKEN, { botInfo: BOT_INFO });
  const telegram = new FakeTelegram();
  telegram.install(bot.api);
  return { bot, telegram };
}

/** An executor whose availability and outcome are both programmable. */
export class FakeExecutor implements ActionExecutor {
  readonly calls: ExecuteRequest[] = [];
  available: ActionAvailability = { actionable: true, network: 'testnet', marketId: 16 };
  availabilityError: Error | undefined;
  outcome: ExecutionOutcome = {
    kind: 'not-implemented',
    detail: 'Execution lands in the next piece of work. Nothing was sent.',
  };

  async availability(_symbol: string): Promise<ActionAvailability> {
    if (this.availabilityError !== undefined) throw this.availabilityError;
    return this.available;
  }

  async execute(request: ExecuteRequest): Promise<ExecutionOutcome> {
    this.calls.push(request);
    return this.outcome;
  }
}

/** A risk view whose health and contents are set directly by the test. */
export class FakeView implements RiskView {
  network = 'mainnet' as const;
  assessments: readonly RiskAssessment[] = [];
  feed: ReturnType<RiskView['feedStatus']> = { state: 'connected', reconnectAttempt: 0 };
  positions: ReturnType<RiskView['positionsStatus']> = {
    state: 'live',
    lastUpdateMs: 1_000_000,
    ageMs: 500,
  };

  snapshot(): readonly RiskAssessment[] {
    return this.assessments;
  }

  feedStatus(): ReturnType<RiskView['feedStatus']> {
    return this.feed;
  }

  positionsStatus(): ReturnType<RiskView['positionsStatus']> {
    return this.positions;
  }
}

/** Deterministic tokens, so callback payloads are pinned in the expectations. */
export function countingTokens(prefix = 't'): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

export function newStore(nowMs = () => 1_000_000): PendingActionStore {
  return new PendingActionStore({ now: nowMs, nextToken: countingTokens() });
}

export function newLinks(seed: readonly LinkRecord[] = [OWNER_LINK]): InMemoryLinkStore {
  return new InMemoryLinkStore({ capacity: 1, seed });
}

/** The ground-truth DANGER assessment, straight through the real risk loop. */
export function dangerAssessment(): RiskAssessment {
  const { change } = assessOne(FIXTURE_BTC, FIXTURE_BTC_MARK);
  return change.assessment;
}

/** The same, rendered by the alerts layer's own renderer. */
export function dangerMessage(): AlertMessage {
  const assessment = dangerAssessment();
  return buildMessage(assessment, kindFor(assessment.state), {
    alerts: DEFAULT_ALERT_CONFIG,
    market: BTC,
  });
}

// ── update factories ────────────────────────────────────────────────────────

let updateId = 0;

export function messageUpdate(
  text: string,
  options: { readonly from?: number; readonly chat?: number } = {},
): Parameters<Bot['handleUpdate']>[0] {
  const from = options.from ?? OWNER_ID;
  const chat = options.chat ?? OWNER_CHAT;
  return {
    update_id: (updateId += 1),
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chat, type: 'private', first_name: 'T' },
      from: { id: from, is_bot: false, first_name: 'T' },
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }]
        : [],
    },
  } as Parameters<Bot['handleUpdate']>[0];
}

export function callbackUpdate(
  data: string,
  options: { readonly from?: number; readonly chat?: number } = {},
): Parameters<Bot['handleUpdate']>[0] {
  const from = options.from ?? OWNER_ID;
  const chat = options.chat ?? OWNER_CHAT;
  return {
    update_id: (updateId += 1),
    callback_query: {
      id: `cb${updateId}`,
      from: { id: from, is_bot: false, first_name: 'T' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: chat, type: 'private', first_name: 'T' },
        from: { id: BOT_INFO.id, is_bot: true, first_name: 'PerpGuard' },
        text: 'alert',
      },
    },
  } as Parameters<Bot['handleUpdate']>[0];
}

export { BTC, CONFIGS, DEFAULT_ALERT_CONFIG, FIXTURE_BTC, FIXTURE_BTC_MARK, assessOne };
