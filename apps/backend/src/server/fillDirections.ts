import { directionFor, type AccountFill, type PositionEventDirection } from '@perpguard/shared';

/**
 * Labels each fill with what it did to its account's position ("open long",
 * "reduce short"...), from the position event in the same transaction. The
 * index records the open and close transaction of a position but not the
 * adds and reduces between, and a fill records neither side nor action, so
 * the transaction's receipt is the source.
 *
 * A receipt never changes, so each is kept (up to `maxCached` transactions,
 * oldest dropped first). Only transactions not yet kept are fetched, at most
 * `maxTxs` per call: a page resolves every fill; a 10,000-row export resolves
 * its newest transactions up to the cap and says how many it left blank.
 */
export interface FillDirectionsOptions {
  readonly read: (txHashes: readonly string[]) => Promise<ReadonlyMap<string, readonly PositionEventDirection[]>>;
  readonly maxCached?: number;
}

export class FillDirections {
  readonly #read: FillDirectionsOptions['read'];
  readonly #max: number;
  readonly #cache = new Map<string, readonly PositionEventDirection[]>();

  constructor(options: FillDirectionsOptions) {
    this.#read = options.read;
    this.#max = options.maxCached ?? 200_000;
  }

  /**
   * What one transaction did to one account's position on one market: for a
   * large-trade alert, whose fills carry no side. Undefined when the receipt
   * cannot be read, or holds no single answer: blank, never guessed.
   */
  async directionOf(txHash: string, accountId: number, marketId: number): Promise<{ readonly action: PositionEventDirection['action']; readonly side: PositionEventDirection['side'] } | undefined> {
    const tx = txHash.toLowerCase();
    if (!this.#cache.has(tx)) {
      const found = await this.#read([tx]).catch(() => new Map<string, readonly PositionEventDirection[]>());
      for (const [hash, events] of found) this.#cache.set(hash, events);
      while (this.#cache.size > this.#max) this.#cache.delete(this.#cache.keys().next().value!);
    }
    const events = this.#cache.get(tx);
    const d = events === undefined ? undefined : directionFor(events, accountId, marketId);
    return d === undefined ? undefined : { action: d.action, side: d.side };
  }

  async annotate(accountId: number, fills: readonly AccountFill[], maxTxs: number): Promise<{ readonly fills: readonly AccountFill[]; readonly blank: number; readonly cappedAtTxs: number | undefined }> {
    const txs = [...new Set(fills.map((f) => f.txHash.toLowerCase()))];
    const toRead = txs.filter((tx) => !this.#cache.has(tx)).slice(0, maxTxs);
    const capped = txs.filter((tx) => !this.#cache.has(tx)).length > maxTxs ? maxTxs : undefined;
    if (toRead.length > 0) {
      const found = await this.#read(toRead).catch(() => new Map<string, readonly PositionEventDirection[]>());
      for (const [tx, events] of found) this.#cache.set(tx, events);
      while (this.#cache.size > this.#max) this.#cache.delete(this.#cache.keys().next().value!);
    }
    let blank = 0;
    const out = fills.map((f): AccountFill => {
      const events = this.#cache.get(f.txHash.toLowerCase());
      const d = events === undefined ? undefined : directionFor(events, accountId, f.market.marketId);
      if (d === undefined) {
        blank += 1;
        return f;
      }
      return { ...f, direction: { action: d.action, side: d.side } };
    });
    return { fills: out, blank, cappedAtTxs: capped };
  }
}
