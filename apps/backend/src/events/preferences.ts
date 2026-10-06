/**
 * What each chat wants from the feeds. PRESETS ONLY, no custom amounts
 * (owner, 6 Oct 2026), fitted to how Perpl actually trades rather than to the
 * spec's numbers, which would never fire here. Measured over the 30 days to
 * 6 Oct 2026 on mainnet:
 *
 *   liquidations   >= $1K 4.7/day, $5K 1.7, $10K 1.0, $25K 0.4 (largest $60.5K)
 *   taker orders   >= $10K 95.6/day, $20K 9.7, $25K 5.7, $50K 0.4 (largest $57.6K)
 *
 * Defaults: liquidations $10K+, large trades $25K+: about seven alerts a day
 * for someone who has only pressed /start.
 */
import { DEFAULT_WARNING_LEVELS } from './warnings.ts';

export const LIQUIDATION_PRESETS_AUSD = [1_000, 5_000, 10_000, 25_000] as const;
export const LARGE_TRADE_PRESETS_AUSD = [10_000, 20_000, 25_000, 50_000] as const;

/** How often each preset fired on mainnet, per day, over the 30 days to 6 Oct 2026. Shown beside the buttons. */
export const PRESET_FREQUENCY_MEASURED = 'the 30 days to 6 Oct 2026';
export const LIQUIDATIONS_PER_DAY: Readonly<Record<number, number>> = { 1_000: 4.7, 5_000: 1.7, 10_000: 1.0, 25_000: 0.4 };
export const LARGE_TRADES_PER_DAY: Readonly<Record<number, number>> = { 10_000: 95.6, 20_000: 9.7, 25_000: 5.7, 50_000: 0.4 };

export interface AlertPreferences {
  /** Changes on wallets this chat watches: opens, adds, reduces, closes, liquidations. */
  readonly walletAlerts: boolean;
  /** Every liquidation at or above this, on any account. Undefined: off. */
  readonly liquidationMinAusd: number | undefined;
  /** Every taker order at or above this, on any account. Undefined: off. */
  readonly largeTradeMinAusd: number | undefined;
  /** Distances from the closing price to warn at, highest first, for watched wallets. Empty: off. */
  readonly warningLevels: readonly number[];
}

export const DEFAULT_PREFERENCES: AlertPreferences = { walletAlerts: true, liquidationMinAusd: 10_000, largeTradeMinAusd: 25_000, warningLevels: DEFAULT_WARNING_LEVELS };

/** The smallest threshold anyone can pick: below it, no order is worth resolving. */
export const SMALLEST_LARGE_TRADE_AUSD = Math.min(...LARGE_TRADE_PRESETS_AUSD);

export interface PreferenceStore {
  get(chatId: number): AlertPreferences;
  set(chatId: number, preferences: AlertPreferences): Promise<void>;
}

export class InMemoryPreferenceStore implements PreferenceStore {
  readonly #byChat = new Map<number, AlertPreferences>();
  get(chatId: number): AlertPreferences {
    return this.#byChat.get(chatId) ?? DEFAULT_PREFERENCES;
  }
  async set(chatId: number, preferences: AlertPreferences): Promise<void> {
    this.#byChat.set(chatId, preferences);
  }
  /** For the Postgres store's load. */
  seed(chatId: number, preferences: AlertPreferences): void {
    this.#byChat.set(chatId, preferences);
  }
}
