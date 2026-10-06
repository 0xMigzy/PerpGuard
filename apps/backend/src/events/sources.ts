/**
 * The event engine's two sources. Each is ONE loop for the whole bot.
 *
 * `PositionChanges` turns the watch loop's passes into position events by
 * keeping each watched account's last read. An account nobody watches any
 * more is forgotten, so watching it again starts from a fresh baseline rather
 * than reporting everything that changed while nobody was looking.
 *
 * `FeedPoller` reads the index's liquidations and taker fills since its
 * cursor, every `everyMs`. It RE-READS an overlap behind the cursor each time
 * (a late row, a re-org rewrite) and relies on the delivery ledger for "at
 * most once". The cursor is in the index's own time, persisted, so a restart
 * resumes where it was. On its very first start it begins now: history is
 * not news.
 */
import { groupTakerOrders, type ActivityFeed, type FillAction, type TakerFill } from '@perpguard/shared';
import { diffPositions } from './positionDiff.ts';
import type { CursorStore } from './ledger.ts';
import type { EventFreshness, LargeTradeEvent, LiquidationEvent, PerpEvent } from './types.ts';
import type { PositionsPass } from '../watch/loop.ts';
import type { OpenPosition } from '@perpguard/shared';

export interface Publisher {
  publish(events: readonly PerpEvent[]): Promise<void>;
}

export class PositionChanges {
  readonly #last = new Map<number, readonly OpenPosition[]>();
  readonly #publisher: Publisher;

  constructor(publisher: Publisher) {
    this.#publisher = publisher;
  }

  /** One watch-loop pass. Returns the events it published. */
  async observe(pass: PositionsPass): Promise<readonly PerpEvent[]> {
    const watched = new Set(pass.watched);
    for (const accountId of this.#last.keys()) if (!watched.has(accountId)) this.#last.delete(accountId);
    const freshness: EventFreshness = { indexerBlock: pass.indexerBlock, blocksBehind: pass.blocksBehind };
    const events: PerpEvent[] = [];
    for (const [accountId, positions] of pass.reads) {
      events.push(...diffPositions(this.#last.get(accountId), positions, { accountId, seenAtMs: pass.seenAtMs, freshness }));
      this.#last.set(accountId, positions);
    }
    if (events.length > 0) await this.#publisher.publish(events);
    return events;
  }
}

export interface FeedPollerOptions {
  readonly feed: ActivityFeed;
  readonly cursor: CursorStore;
  readonly publisher: Publisher;
  readonly freshness: () => Promise<EventFreshness>;
  /** What a taker's transaction did to its position. Undefined: blank. */
  readonly direction: (txHash: string, accountId: number, marketId: number) => Promise<{ readonly action: FillAction; readonly side: 'long' | 'short' } | undefined>;
  /** Orders below this are nobody's large trade; not resolved, not published. */
  readonly minLargeTradeAusd: number;
  readonly logger: { info(message: string): void; warn(message: string): void };
  readonly now?: () => number;
  readonly everyMs?: number;
  readonly overlapMs?: number;
}

const SOURCE = 'index-feed';
const LIQUIDATION_LIMIT = 1_000;
const FILL_LIMIT = 10_000;

export class FeedPoller {
  readonly #o: FeedPollerOptions;
  readonly #now: () => number;
  readonly #overlap: number;
  /** Ids already published in this process: saves re-resolving the overlap. The ledger is the real guard. */
  readonly #published = new Set<string>();
  #running = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  lastPollAtMs: number | undefined;
  lastError: string | undefined;

  constructor(options: FeedPollerOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#overlap = options.overlapMs ?? 60_000;
  }

  start(): void {
    void this.poll();
    this.#timer ??= setInterval(() => void this.poll(), this.#o.everyMs ?? 15_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One poll. Never throws; never overlaps itself. Returns what it published. */
  async poll(): Promise<readonly PerpEvent[]> {
    if (this.#running) return [];
    this.#running = true;
    try {
      return await this.#poll();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.#o.logger.warn(`events: the index feed could not be read (${this.lastError}); trying again next interval`);
      return [];
    } finally {
      this.#running = false;
      this.lastPollAtMs = this.#now();
    }
  }

  async #poll(): Promise<readonly PerpEvent[]> {
    let cursor = await this.#o.cursor.get(SOURCE);
    if (cursor === undefined) {
      cursor = this.#now();
      await this.#o.cursor.set(SOURCE, cursor);
      this.#o.logger.info('events: the index feed starts now; history is not news');
    }
    const since = cursor - this.#overlap;
    const [liquidations, rawFills, freshness] = await Promise.all([
      this.#o.feed.liquidationsSince(since, LIQUIDATION_LIMIT),
      this.#o.feed.takerFillsSince(since, FILL_LIMIT),
      this.#o.freshness(),
    ]);
    // A full page may end mid-transaction: leave its last moment for the next read.
    const fills = rawFills.length === FILL_LIMIT ? dropLastMoment(rawFills) : rawFills;

    const events: PerpEvent[] = [];
    for (const l of liquidations) {
      if (this.#published.has(l.id)) continue;
      events.push({ kind: 'liquidation', id: l.id, liquidation: l, freshness } satisfies LiquidationEvent);
    }
    for (const order of groupTakerOrders(fills)) {
      if (order.notionalAusd < this.#o.minLargeTradeAusd || this.#published.has(order.id)) continue;
      const direction = await this.#o.direction(order.txHash, order.accountId, order.market.marketId).catch(() => undefined);
      events.push({ kind: 'large-trade', id: order.id, order, direction, freshness } satisfies LargeTradeEvent);
    }
    events.sort((a, b) => atOf(a) - atOf(b));
    if (events.length > 0) await this.#o.publisher.publish(events);
    for (const e of events) this.#published.add(e.id);
    if (this.#published.size > 20_000) this.#published.clear();

    const newest = Math.max(cursor, ...liquidations.map((l) => l.atMs), ...fills.map((f) => f.atMs));
    if (newest > cursor) await this.#o.cursor.set(SOURCE, newest);
    this.lastError = undefined;
    return events;
  }
}

function atOf(event: PerpEvent): number {
  return event.kind === 'liquidation' ? event.liquidation.atMs : event.kind === 'large-trade' ? event.order.atMs : event.seenAtMs;
}

function dropLastMoment(fills: readonly TakerFill[]): readonly TakerFill[] {
  const last = fills[fills.length - 1]!.atMs;
  const kept = fills.filter((f) => f.atMs < last);
  // One moment holding a whole page: keep it rather than stall forever.
  return kept.length === 0 ? fills : kept;
}
