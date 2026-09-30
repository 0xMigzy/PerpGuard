/**
 * The risk loop's `PositionSource` as a {@link PositionReader}.
 *
 * One job, and it is the boundary that matters: `VenuePosition` carries human
 * `number` margins and sizes, and reconciliation compares money in EXACT
 * INTEGERS. So this is where the conversion happens, once, through the same
 * `numberToScaled` boundary the risk engine uses — never with `Number()`
 * arithmetic, and never twice.
 *
 * ONE POSITION PER MARKET, which is the same key the risk loop tracks on. If the
 * source ever hands over two positions on one market, this reports NEITHER rather
 * than picking: an action reconciled against the wrong one of two positions on the
 * same market would produce a confident verdict about the wrong exposure, and
 * there is no field on the pair that says which one the action went to.
 */
import { numberToScaled, type MarketRiskConfig, type Unsubscribe, type VenuePosition } from '@perpguard/shared';
import type { PositionSource } from '../risk/types.ts';
import type { PositionReader, ReconcilablePosition } from './types.ts';

export interface LoopPositionReaderOptions {
  readonly source: PositionSource;
  /** Keyed by market id. Needed for lot and collateral scaling; never assumed. */
  readonly configs: ReadonlyMap<number, MarketRiskConfig>;
  readonly onAmbiguous?: (marketId: number, count: number) => void;
  readonly onUnscalable?: (marketId: number) => void;
}

export class LoopPositionReader implements PositionReader {
  readonly #source: PositionSource;
  readonly #configs: ReadonlyMap<number, MarketRiskConfig>;
  readonly #onAmbiguous: ((marketId: number, count: number) => void) | undefined;
  readonly #onUnscalable: ((marketId: number) => void) | undefined;

  constructor(options: LoopPositionReaderOptions) {
    this.#source = options.source;
    this.#configs = options.configs;
    this.#onAmbiguous = options.onAmbiguous;
    this.#onUnscalable = options.onUnscalable;
  }

  read(marketId: number): ReconcilablePosition | undefined {
    const matches = this.#source.snapshot().filter((p) => p.marketId === marketId);
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      this.#onAmbiguous?.(marketId, matches.length);
      return undefined;
    }

    const config = this.#configs.get(marketId);
    if (config === undefined) {
      // Without the market's own scaling every integer below would be wrong by a
      // power of ten and look entirely plausible. Refuse rather than guess: the
      // executor turns this into "no position", which stops the action.
      this.#onUnscalable?.(marketId);
      return undefined;
    }
    return toReconcilable(matches[0]!, config);
  }

  status(): ReturnType<PositionSource['status']> {
    return this.#source.status();
  }

  onChange(listener: () => void): Unsubscribe {
    return this.#source.onSnapshot(() => listener());
  }
}

/**
 * The float boundary, crossed once.
 *
 * `numberToScaled` rounds to the precision the market can represent, which is
 * exactly what the risk engine's `fromVenuePosition` does — so the integers this
 * layer compares are the same integers the engine reasons about, and a delta
 * cannot disagree between them.
 */
export function toReconcilable(
  position: VenuePosition,
  config: MarketRiskConfig,
): ReconcilablePosition {
  return {
    marketId: position.marketId,
    symbol: position.symbol,
    positionId: position.positionId,
    side: position.side,
    marginCNS: numberToScaled(position.margin, config.collateralDecimals),
    sizeLNS: numberToScaled(position.size, config.lotDecimals),
  };
}
