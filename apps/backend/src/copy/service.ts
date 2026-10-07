/**
 * 🔁 The copy replay as a service: reads the leader's window from the index,
 * the ACTING network's markets from its own context, the leader network's
 * marks for anything still open, and runs the pure replay. Read-only: nothing
 * here can send anything anywhere.
 *
 * Each answer is kept for a minute per (leader, size, window): a 30-day replay
 * of a busy leader is a few thousand rows, and two people asking the same
 * question within a minute get the same answer, with its age.
 */
import type { CopySourceReader, MarketOpenInterest, OpenActivity, VenueMarket } from '@perpguard/shared';
import { replayCopy, type CopyMarket, type ReplayResult } from './replay.ts';

/** More opens than this in the window and the replay is refused whole. */
export const COPY_REPLAY_CAP = 3_000;
export const COPY_REPLAY_DAYS = 30;
/** The windows a replay can be asked for (owner, 7 Oct 2026: 7 days beside 30, toggled). */
export type CopyWindowDays = 7 | 30;
export const COPY_WINDOWS: readonly CopyWindowDays[] = [30, 7];
const DAY_MS = 86_400_000;
const KEEP_MS = 60_000;

export interface CopyReplayServiceOptions {
  readonly source: CopySourceReader;
  readonly actingNetwork: string;
  /** The ACTING network's markets, from its own context. */
  readonly actingMarkets: () => readonly VenueMarket[];
  /** Marks on the LEADER's (analytics) network. */
  readonly marks: () => Promise<readonly MarketOpenInterest[]>;
  readonly now?: () => number;
}

export type CopyReplayAnswer = { readonly computedAtMs: number; readonly result: ReplayResult } | { readonly computedAtMs: number; readonly result: { readonly kind: 'unknown-account'; readonly accountId: number } };

export class CopyReplayService {
  readonly #o: CopyReplayServiceOptions;
  readonly #kept = new Map<string, Promise<CopyReplayAnswer>>();
  readonly #now: () => number;

  constructor(options: CopyReplayServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** A leader's last 30 days onto an account of `followerEquityCNS`. */
  replay(accountId: number, followerEquityCNS: bigint, days: CopyWindowDays = COPY_REPLAY_DAYS): Promise<CopyReplayAnswer> {
    const now = this.#now();
    for (const [key, answer] of this.#kept) {
      void answer.then((a) => {
        if (now - a.computedAtMs > KEEP_MS) this.#kept.delete(key);
      }, () => this.#kept.delete(key));
    }
    const key = `${accountId}:${followerEquityCNS}:${days}`;
    const kept = this.#kept.get(key);
    if (kept !== undefined) return kept;
    const answer = this.#compute(accountId, followerEquityCNS, now, days);
    this.#kept.set(key, answer);
    answer.catch(() => this.#kept.delete(key));
    return answer;
  }

  /** How recently the leader opens positions. */
  activity(accountId: number): Promise<OpenActivity> {
    return this.#o.source.openActivity(accountId, this.#now());
  }

  async #compute(accountId: number, followerEquityCNS: bigint, now: number, days: CopyWindowDays): Promise<CopyReplayAnswer> {
    const fromMs = now - days * DAY_MS;
    const [source, marks] = await Promise.all([
      this.#o.source.copySource(accountId, { fromMs, toMs: now, cap: COPY_REPLAY_CAP }),
      this.#o.marks().catch(() => [] as readonly MarketOpenInterest[]),
    ]);
    if (source === undefined) return { computedAtMs: now, result: { kind: 'unknown-account', accountId } };
    const byId = new Map(marks.map((m) => [m.marketId, m.markPrice]));
    const actingMarkets: CopyMarket[] = this.#o.actingMarkets().map((m) => ({ marketId: m.marketId, symbol: m.symbol, sizeDecimals: m.sizeDecimals, maxLeverage: m.maxLeverage, takerFeeMicros: m.takerFeeMicros }));
    const result = replayCopy({
      source,
      followerEquityCNS,
      actingNetwork: this.#o.actingNetwork,
      actingMarkets,
      markOf: (marketId) => byId.get(marketId),
      cap: COPY_REPLAY_CAP,
    });
    return { computedAtMs: now, result };
  }
}
