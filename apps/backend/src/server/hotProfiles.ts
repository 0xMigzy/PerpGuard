/**
 * The profiles kept warm so a reader clicking around never waits on a cold
 * one: the busiest accounts (the heaviest to compute: #10's takes ~19 s cold),
 * the default leaderboard's top 50 (net PnL, 30 days: what a visitor opens
 * first), and every account watched in the bot. Saved wallets live only in a
 * visitor's browser, so the server cannot know them.
 *
 * Warmed one at a time, at boot and then every `intervalMs`: never two cycles
 * at once, and a failed source or profile never stops the rest.
 */
export interface HotProfileSources {
  readonly busiest: () => Promise<readonly number[]>;
  readonly leaderboard: () => Promise<readonly number[]>;
  readonly watched: () => readonly number[];
}

/** The union, busiest first, each id once. A source that fails contributes nothing. */
export async function hotProfileIds(sources: HotProfileSources): Promise<readonly number[]> {
  const [busiest, leaders] = await Promise.all([sources.busiest().catch(() => []), sources.leaderboard().catch(() => [])]);
  let watched: readonly number[] = [];
  try {
    watched = sources.watched();
  } catch {
    watched = [];
  }
  return [...new Set([...busiest, ...leaders, ...watched])];
}

export class ProfileWarmer {
  readonly #sources: HotProfileSources;
  readonly #warm: (accountId: number) => Promise<void>;
  readonly #stopped: () => boolean;
  #running = false;

  constructor(options: { readonly sources: HotProfileSources; readonly warm: (accountId: number) => Promise<void>; readonly stopped?: () => boolean }) {
    this.#sources = options.sources;
    this.#warm = options.warm;
    this.#stopped = options.stopped ?? (() => false);
  }

  /** One cycle. 'skipped' while another is running; the count of profiles warmed otherwise. */
  async run(): Promise<number | 'skipped'> {
    if (this.#running) return 'skipped';
    this.#running = true;
    let warmed = 0;
    try {
      for (const id of await hotProfileIds(this.#sources)) {
        if (this.#stopped()) break;
        try {
          await this.#warm(id);
          warmed += 1;
        } catch {
          // One profile failing never stops the others; the next cycle asks again.
        }
      }
      return warmed;
    } finally {
      this.#running = false;
    }
  }
}
