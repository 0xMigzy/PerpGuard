/**
 * The event engine: normalized events in, one message per (event, chat) out.
 *
 *   sources -> publish() -> match -> claim in the ledger -> render -> send
 *
 * NOT ONE POLLER PER USER (spec 62). The sources are one feed poller and the
 * one watch loop; this fans out what they found.
 *
 * A LIQUIDATION IS NOT ALSO A "CLOSE". When a watched position disappears or
 * shrinks because it was liquidated, the position diff sees a close or a
 * reduce at about the time the feed sees the liquidation. Closes and reduces
 * are therefore held for `holdChangesMs`; if a liquidation of that account on
 * that market, at or after the position opened, arrives meanwhile, the change
 * is dropped and the liquidation (which watchers get at any size) says it.
 *
 * THE FEEDS ARE BOUNDED PER CHAT. At most `feedPerMinute` feed alerts a
 * minute reach one chat; the rest are counted and said in one line when the
 * minute is up. A watcher's own wallets are not bounded: five at most, and
 * those are the messages they asked for by name.
 */
import { recipientsFor, type MatchInputs } from './match.ts';
import { renderEvent, type RenderContext, type RenderedEvent } from './render.ts';
import type { DeliveryLedger } from './ledger.ts';
import type { PerpEvent, PositionChangeEvent } from './types.ts';

export type SendResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ChatSender {
  send(chatId: number, message: RenderedEvent): Promise<SendResult>;
}

export interface EventEngineOptions {
  readonly ledger: DeliveryLedger;
  readonly match: MatchInputs;
  readonly sender: ChatSender;
  readonly render: RenderContext;
  readonly logger: { info(message: string): void; warn(message: string): void };
  readonly now?: () => number;
  readonly holdChangesMs?: number;
  readonly feedPerMinute?: number;
}

const FEED_WINDOW_MS = 60_000;
const RECENT_LIQUIDATION_MS = 30 * 60_000;

export class EventEngine {
  readonly #o: EventEngineOptions;
  readonly #now: () => number;
  readonly #hold: number;
  readonly #feedPerMinute: number;
  /** Closes and reduces waiting to see whether a liquidation explains them. */
  #held: Array<{ readonly event: PositionChangeEvent; readonly releaseAtMs: number }> = [];
  /** `account:market` -> liquidation times seen, for the check above. */
  readonly #liquidated = new Map<string, number[]>();
  /** Per chat: when its current minute began, how many feed alerts it got, how many were held back. */
  readonly #flood = new Map<number, { startMs: number; sent: number; skipped: number }>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: EventEngineOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#hold = options.holdChangesMs ?? 20_000;
    this.#feedPerMinute = options.feedPerMinute ?? 10;
  }

  start(everyMs = 5_000): void {
    this.#timer ??= setInterval(() => void this.tick(), everyMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async publish(events: readonly PerpEvent[]): Promise<void> {
    for (const event of events) {
      if (event.kind === 'liquidation') {
        const key = `${event.liquidation.accountId}:${event.liquidation.market.marketId}`;
        this.#liquidated.set(key, [...(this.#liquidated.get(key) ?? []), event.liquidation.atMs]);
      }
      if (event.kind === 'position-closed' || event.kind === 'position-reduced') {
        this.#held.push({ event, releaseAtMs: this.#now() + this.#hold });
        continue;
      }
      await this.#deliver(event);
    }
  }

  /** Releases held changes whose wait is over, and reports flood counts whose minute is up. */
  async tick(): Promise<void> {
    const now = this.#now();
    const due = this.#held.filter((h) => h.releaseAtMs <= now);
    this.#held = this.#held.filter((h) => h.releaseAtMs > now);
    for (const { event } of due) {
      const times = this.#liquidated.get(`${event.accountId}:${event.market.marketId}`) ?? [];
      if (times.some((t) => t >= event.openedAtMs)) {
        this.#o.logger.info(`events: ${event.id} dropped: the liquidation already says it`);
        continue;
      }
      await this.#deliver(event);
    }
    for (const [key, times] of this.#liquidated) {
      const recent = times.filter((t) => t >= now - RECENT_LIQUIDATION_MS);
      if (recent.length === 0) this.#liquidated.delete(key);
      else this.#liquidated.set(key, recent);
    }
    for (const [chatId, f] of this.#flood) {
      if (now - f.startMs < FEED_WINDOW_MS) continue;
      this.#flood.delete(chatId);
      if (f.skipped > 0) {
        await this.#o.sender.send(chatId, {
          html: `…and <b>${f.skipped} more</b> liquidation and large-trade alert${f.skipped === 1 ? '' : 's'} in that minute, not sent so this chat is not flooded. Raise your thresholds to hear only the biggest.`,
          links: [],
        });
      }
    }
  }

  /** How many changes are waiting on the liquidation check. For tests and /health. */
  get heldCount(): number {
    return this.#held.length;
  }

  async #deliver(event: PerpEvent): Promise<void> {
    for (const recipient of recipientsFor(event, this.#o.match)) {
      // Claimed BEFORE the send and kept whatever happens: a duplicate is the failure this prevents.
      // And before the flood check, so a re-read duplicate never uses up a chat's minute.
      let first: boolean;
      try {
        first = await this.#o.ledger.claim(event.id, recipient.chatId);
      } catch (error) {
        this.#o.logger.warn(`events: could not claim ${event.id} for a chat (${error instanceof Error ? error.message : String(error)}); not sent, so it cannot be sent twice`);
        continue;
      }
      if (!first) continue;
      if (recipient.why === 'feed' && !this.#roomFor(recipient.chatId)) continue;
      const result = await this.#o.sender.send(recipient.chatId, renderEvent(event, recipient.why, this.#o.render));
      if (!result.ok) this.#o.logger.warn(`events: ${event.kind} ${event.id} not delivered to a chat: ${result.reason}`);
    }
  }

  /** True when this chat may have one more feed alert this minute; counts the ones it may not. */
  #roomFor(chatId: number): boolean {
    const now = this.#now();
    const f = this.#flood.get(chatId) ?? { startMs: now, sent: 0, skipped: 0 };
    this.#flood.set(chatId, f);
    if (f.sent < this.#feedPerMinute) {
      f.sent += 1;
      return true;
    }
    f.skipped += 1;
    return false;
  }
}
