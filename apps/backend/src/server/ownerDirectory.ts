/**
 * Account id -> owner wallet, for showing a trader as an address and not just
 * "#5303". The index knows the owner only of accounts it saw created (1,366 of
 * 1,556 mainnet accounts it does NOT), so the rest are read off the Exchange
 * contract (`getAccountById`). Owners do not change, so every answer is kept
 * for the life of the process; an account the chain could not answer for is
 * asked again after `retryMs`, never on every read.
 */
export interface OwnerDirectoryOptions {
  readonly fromIndex: (ids: readonly number[]) => Promise<ReadonlyMap<number, string>>;
  readonly fromChain: (id: number) => Promise<string | undefined>;
  readonly concurrency?: number;
  readonly retryMs?: number;
  readonly now?: () => number;
}

export class OwnerDirectory {
  readonly #o: OwnerDirectoryOptions;
  readonly #known = new Map<number, string>();
  readonly #missedAt = new Map<number, number>();

  constructor(options: OwnerDirectoryOptions) {
    this.#o = options;
  }

  async ownersOf(accountIds: readonly number[]): Promise<ReadonlyMap<number, string>> {
    const now = (this.#o.now ?? Date.now)();
    const retry = this.#o.retryMs ?? 10 * 60_000;
    const wanted = [...new Set(accountIds)].filter((id) => !this.#known.has(id) && !((this.#missedAt.get(id) ?? -Infinity) > now - retry));
    if (wanted.length > 0) {
      const indexed = await this.#o.fromIndex(wanted).catch(() => new Map<number, string>());
      for (const [id, owner] of indexed) this.#known.set(id, owner.toLowerCase());
      const left = wanted.filter((id) => !this.#known.has(id));
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.max(1, this.#o.concurrency ?? 8) }, async () => {
          while (cursor < left.length) {
            const id = left[cursor++]!;
            const owner = await this.#o.fromChain(id).catch(() => undefined);
            if (owner === undefined) this.#missedAt.set(id, now);
            else this.#known.set(id, owner.toLowerCase());
          }
        }),
      );
    }
    return new Map(accountIds.filter((id) => this.#known.has(id)).map((id) => [id, this.#known.get(id)!]));
  }
}
