/**
 * Telegram's wire, replaced by a recorder that keeps a chat as its user would
 * see it: messages in order, edits applied in place, keyboards attached. For
 * the live demo scripts only — everything above the wire is the real bot.
 *
 * Frames are snapshots of one chat after a step, written as JSON for
 * rendering screenshots of exactly what was received.
 */
import type { createBot } from '@perpguard/bot';
import { BOT_INFO } from '@perpguard/bot/test-support';

type Bot = ReturnType<typeof createBot>;

export interface RecordedButton {
  readonly text: string;
  readonly url?: string;
  readonly data?: string;
}

export interface ChatMessage {
  readonly id: number;
  readonly from: 'user' | 'bot';
  text: string;
  html: boolean;
  buttons: RecordedButton[][];
  forceReply?: string;
}

export interface Frame {
  readonly step: string;
  readonly messages: ChatMessage[];
  readonly inputPlaceholder?: string;
}

export class ChatRecorder {
  readonly chats = new Map<number, ChatMessage[]>();
  readonly frames: Frame[] = [];
  lastToast: string | undefined;
  #nextId = 1;
  #update = 1;

  readonly bot: Bot;
  readonly user: { readonly from: number; readonly chat: number; readonly name?: string };

  constructor(bot: Bot, user: { readonly from: number; readonly chat: number; readonly name?: string }) {
    this.bot = bot;
    this.user = user;
    bot.api.config.use(async (_prev: unknown, method: string, raw: unknown) => {
      const p = raw as Record<string, unknown>;
      const markup = p['reply_markup'] as { inline_keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>; force_reply?: boolean; input_field_placeholder?: string } | undefined;
      const buttons = (markup?.inline_keyboard ?? []).map((row) =>
        row.map((b) => ({ text: b.text, ...(b.url === undefined ? {} : { url: b.url }), ...(b.callback_data === undefined ? {} : { data: b.callback_data }) })),
      );
      if (method === 'sendMessage') {
        const id = this.#nextId++;
        this.chat(Number(p['chat_id'])).push({ id, from: 'bot', text: String(p['text']), html: p['parse_mode'] === 'HTML', buttons, ...(markup?.force_reply ? { forceReply: markup.input_field_placeholder ?? '' } : {}) });
        return { ok: true, result: { message_id: id, date: 0, chat: { id: Number(p['chat_id']), type: 'private' }, text: String(p['text']) } } as never;
      }
      if (method === 'editMessageText') {
        for (const messages of this.chats.values()) {
          const target = messages.find((m) => m.id === Number(p['message_id']));
          if (target === undefined) continue;
          target.text = String(p['text']);
          target.html = p['parse_mode'] === 'HTML';
          target.buttons = buttons;
        }
        return { ok: true, result: true } as never;
      }
      if (method === 'answerCallbackQuery') {
        this.lastToast = p['text'] === undefined ? undefined : String(p['text']);
        return { ok: true, result: true } as never;
      }
      return { ok: true, result: true } as never;
    });
  }

  chat(chatId: number = this.user.chat): ChatMessage[] {
    let messages = this.chats.get(chatId);
    if (messages === undefined) {
      messages = [];
      this.chats.set(chatId, messages);
    }
    return messages;
  }

  async send(text: string): Promise<void> {
    this.chat().push({ id: this.#nextId++, from: 'user', text, html: false, buttons: [] });
    await this.bot.handleUpdate({
      update_id: this.#update++,
      message: {
        message_id: this.#nextId,
        date: 0,
        chat: { id: this.user.chat, type: 'private', first_name: this.user.name ?? 'User' },
        from: { id: this.user.from, is_bot: false, first_name: this.user.name ?? 'User' },
        text,
        entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [],
      },
    } as never);
  }

  /** Tap the most recent button with this label, sending exactly the data the bot put on it. */
  async tap(label: string): Promise<void> {
    const host = [...this.chat()].reverse().find((m) => m.from === 'bot' && m.buttons.some((row) => row.some((b) => b.text === label && b.data !== undefined)));
    const button = host?.buttons.flat().find((b) => b.text === label);
    if (host === undefined || button?.data === undefined) throw new Error(`no button "${label}" on screen`);
    await this.bot.handleUpdate({
      update_id: this.#update++,
      callback_query: {
        id: `cb${this.#update}`,
        from: { id: this.user.from, is_bot: false, first_name: this.user.name ?? 'User' },
        chat_instance: 'ci',
        data: button.data,
        message: { message_id: host.id, date: 0, chat: { id: this.user.chat, type: 'private', first_name: 'User' }, from: { id: BOT_INFO.id, is_bot: true, first_name: 'PerpGuard' }, text: host.text },
      },
    } as never);
  }

  /** Labels on the most recent bot message that has buttons. */
  labels(): string[] {
    return ([...this.chat()].reverse().find((m) => m.from === 'bot' && m.buttons.length > 0)?.buttons.flat() ?? []).map((b) => b.text);
  }

  frame(step: string, log: (line: string) => void = console.log): void {
    const messages = structuredClone(this.chat());
    const last = messages.at(-1);
    this.frames.push({ step, messages, ...(last?.forceReply === undefined ? {} : { inputPlaceholder: last.forceReply }) });
    const bot = [...messages].reverse().find((m) => m.from === 'bot');
    log(`\n== ${step}`);
    if (bot !== undefined) {
      log(bot.text.split('\n').map((l) => `   ${l}`).join('\n'));
      for (const row of bot.buttons) log(`   [ ${row.map((b) => b.text).join(' | ')} ]`);
    }
    if (this.lastToast !== undefined) log(`   (toast: ${this.lastToast})`);
  }
}
